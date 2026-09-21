import { createHash } from 'node:crypto';
import { clarificationId } from '../../src/plugins/clarification-validation';
import { isContributionId } from '../../src/plugins/manifest';
import { parseTaskRepo } from '../../src/plugins/tasks';
import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { parseCampaignCommandV1, parseCampaignCommandReceiptV1, parseCampaignDetailSnapshotV1, parseCampaignListSnapshotV1, parseCampaignPreviewV1, parseCampaignReceiptQueryV1,
  type CampaignCommandV1, type CampaignCommandValueV1, type CampaignCommandReceiptV1, type CampaignWorkflow, type CampaignReceiptQueryV1 } from '../../src/plugins/campaigns';
import { CampaignConflictError, CampaignValidationError, type CampaignStore } from './campaigns';
import { clarificationScope, ClarificationServiceError } from './clarification-service-common';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistenceHash, PersistenceValidationError, type Persistence } from './persistence';

export interface CampaignPublicOptions {
  readonly persistence: Persistence;
  readonly store: CampaignStore;
  repos(): readonly string[];
  workflows(): readonly CampaignWorkflow[];
  authorize(caller: string): void;
}
const DDL = `CREATE TABLE public_campaign_receipts (
  caller TEXT NOT NULL, requestId TEXT NOT NULL, command TEXT NOT NULL, receipt TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(caller,requestId)
)`;
interface ReceiptRow { command: string; receipt: string; hash: string }
export function createCampaignPublicService(options: CampaignPublicOptions) {
  const { persistence, store } = options; const { sql } = persistence;
  if (store.database !== sql) throw new PersistenceValidationError('Campaign mutations and receipts require the same database connection');
  migrateOwned(sql, { owner: 'core.public-campaign-receipts', version: 1, checksum: persistenceHash(DDL), tables: ['public_campaign_receipts'], validateLegacy: () => null,
    apply: () => sql.exec(DDL), validateCurrent: () => validateTableColumns(sql, 'public_campaign_receipts', ['caller', 'requestId', 'command', 'receipt', 'hash']) });
  function scope(caller: string, repo: string | null, scopeRepo: string | null) {
    if (!isContributionId(caller)) throw new ClarificationServiceError(403, 'forbidden'); options.authorize(caller);
    if (repo === null && scopeRepo !== null) throw new ClarificationServiceError(403, 'forbidden');
    return clarificationScope(options.repos(), scopeRepo, repo);
  }
  function detail(repo: string, campaignId: string) {
    const campaign = store.get(campaignId);
    if (!campaign || campaign.repo !== repo) throw new ClarificationServiceError(404, 'not-found');
    const value = { campaign, phases: store.phases(campaignId).map(phase => ({ phase, tasks: store.tasks(phase.id) })) };
    return parseCampaignDetailSnapshotV1({ version: 1, revision: persistenceHash(value), ...value });
  }
  function saved(caller: string, requestId: string) {
    const row = sql.prepare('SELECT command,receipt,hash FROM public_campaign_receipts WHERE caller=? AND requestId=?').get(caller, requestId) as ReceiptRow | undefined;
    if (!row) return null;
    const command = parseCampaignCommandV1(JSON.parse(row.command)); const receipt = parseCampaignCommandReceiptV1(JSON.parse(row.receipt), command);
    if (command.requestId !== requestId || row.hash !== persistenceHash({ caller, command, receipt })) throw new PersistenceValidationError('Campaign receipt integrity failed');
    return { command, receipt };
  }
  function mutate(command: CampaignCommandV1): CampaignCommandValueV1 {
    if (command.action === 'create') {
      if (!options.workflows().some(item => item?.ref === command.workflowRef)) throw new CampaignConflictError('Campaign workflow is unavailable');
      return { kind: 'created', campaign: store.create({ repo: command.repo, name: command.name, workflowRef: command.workflowRef, concurrency: command.concurrency }) };
    }
    const current = detail(command.repo, command.target.campaignId);
    if (current.revision !== command.target.revision) throw new CampaignConflictError('Campaign changed; refresh before submitting a new command');
    switch (command.action) {
      case 'add-phase': return { kind: 'phase', phase: store.createPhase(current.campaign.id, { name: command.name }) };
      case 'preview': {
        if (!current.phases.some(item => item.phase.id === command.phaseId)) throw new CampaignConflictError('Phase does not belong to this campaign');
        return { kind: 'preview', preview: store.previewImport({ phaseId: command.phaseId, repo: command.repo, format: command.format, content: command.content, allowedRepos: options.repos() }) };
      }
      case 'confirm': {
        const preview = store.preview(command.previewId);
        if (!preview) throw new CampaignConflictError('Import preview is unavailable');
        const pinned = parseCampaignPreviewV1(preview);
        if (pinned.campaignId !== current.campaign.id || !current.phases.some(item => item.phase.id === pinned.phaseId) || pinned.digest !== command.digest || createHash('sha256').update(JSON.stringify(pinned.records)).digest('hex') !== pinned.digest) throw new CampaignConflictError('Import preview does not match the confirmed campaign and digest');
        if (pinned.records.some(record => !options.repos().includes(record.repo))) throw new CampaignConflictError('An imported galleon is no longer configured; create a new preview');
        return { kind: 'imported', tasks: store.confirmImport(pinned.id) };
      }
      case 'phase': {
        const phase = current.phases.find(item => item.phase.id === command.phaseId);
        if (!phase) throw new CampaignConflictError('Phase does not belong to this campaign');
        if (command.operation === 'start' || command.operation === 'resume') {
          if (!options.workflows().some(item => item?.ref === current.campaign.workflowRef)) throw new CampaignConflictError('Campaign workflow is unavailable');
          if (phase.tasks.some(task => !options.repos().includes(task.record.repo))) throw new CampaignConflictError('A task galleon is no longer configured');
        }
        return { kind: 'phase', phase: store.setPhaseState(command.phaseId, command.operation) };
      }
      case 'retry-task': {
        const task = current.phases.flatMap(phase => phase.tasks).find(item => item.id === command.taskId);
        if (!task || task.attempt !== command.expectedAttempt) throw new CampaignConflictError('Task does not match the retained campaign and attempt');
        if (!options.repos().includes(task.record.repo)) throw new CampaignConflictError('Task galleon is no longer configured');
        return { kind: 'retried', task: store.retryTask(task.id) };
      }
    }
  }
  return Object.freeze({
    list(caller: string, input: { version: 1; repo: string | null }, scopeRepo: string | null) {
      if (input?.version !== 1) throw new ClarificationServiceError(400, 'invalid-response');
      const repo = input.repo === null ? null : parseTaskRepo(input.repo); const allowed = scope(caller, repo, scopeRepo);
      return parseCampaignListSnapshotV1({ version: 1, repo, campaigns: store.list(repo).filter(campaign => campaign && allowed.includes(campaign.repo)), workflows: options.workflows() });
    },
    detail(caller: string, input: { version: 1; repo: string; campaignId: string }, scopeRepo: string | null) {
      if (input?.version !== 1) throw new ClarificationServiceError(400, 'invalid-response');
      const repo = parseTaskRepo(input.repo); const campaignId = clarificationId(input.campaignId); scope(caller, repo, scopeRepo);
      return persistence.transaction(() => detail(repo, campaignId));
    },
    submit(caller: string, value: CampaignCommandV1, scopeRepo: string | null): CampaignCommandReceiptV1 {
      const command = parseCampaignCommandV1(value); scope(caller, command.repo, scopeRepo);
      return persistence.transaction(() => {
        const prior = saved(caller, command.requestId);
        if (prior) {
          if (JSON.stringify(prior.command) !== JSON.stringify(command)) throw new ClarificationServiceError(409, 'conflict');
          return prior.receipt;
        }
        const { requestId, ...input } = command; let receipt: CampaignCommandReceiptV1;
        try {
          receipt = persistence.transaction(() => {
            const result = mutate(command);
            if (command.action !== 'create') detail(command.repo, command.target.campaignId);
            else parseCampaignListSnapshotV1({ version: 1, repo: null, campaigns: store.list().filter(campaign => options.repos().includes(campaign.repo)), workflows: options.workflows() });
            return parseCampaignCommandReceiptV1({ version: 1, requestId, input, status: 'succeeded', result, reason: null }, command);
          });
        } catch (error) {
          if (!(error instanceof CampaignConflictError || error instanceof CampaignValidationError || error instanceof ClarificationServiceError || error instanceof SourceContractValidationError)) throw error;
          const reason = error instanceof SourceContractValidationError ? 'Campaign data exceeds the supported contract limits' : error.message;
          receipt = parseCampaignCommandReceiptV1({ version: 1, requestId, input, status: 'rejected', result: null, reason }, command);
        }
        sql.prepare('INSERT INTO public_campaign_receipts VALUES (?,?,?,?,?)').run(caller, requestId, JSON.stringify(command), JSON.stringify(receipt), persistenceHash({ caller, command, receipt }));
        return receipt;
      });
    },
    receipt(caller: string, value: CampaignReceiptQueryV1, scopeRepo: string | null): CampaignCommandReceiptV1 | null {
      const query = parseCampaignReceiptQueryV1(value); scope(caller, query.repo, scopeRepo); const prior = saved(caller, query.requestId);
      if (!prior) return null;
      if (prior.command.repo !== query.repo) throw new ClarificationServiceError(404, 'not-found'); return prior.receipt;
    },
  });
}
export type CampaignPublicService = ReturnType<typeof createCampaignPublicService>;
