import { randomUUID } from 'node:crypto';
import { getLocalGit, localGitCheckoutIdentity, mutateLocalGit, type LocalGitOptions } from '../local-git';
import { isContributionId } from '../../src/plugins/manifest';
import { clarificationBoolean } from '../../src/plugins/clarification-validation';
import { parseTaskRepo } from '../../src/plugins/tasks';
import { parseLocalGitControlCommandV1, parseLocalGitControlReceiptV1, parseLocalGitPreviewV1, parseLocalGitReceiptQueryV1, parseLocalGitSnapshotV1, parseLocalGitTargetV1,
  type LocalGitControlCommandV1, type LocalGitControlReceiptV1, type LocalGitReceiptQueryV1, type LocalGitSnapshotV1, type LocalGitTargetV1 } from '../../src/plugins/local-git';
import { clarificationScope, ClarificationServiceError } from './clarification-service-common';
import { persistenceHash, PersistenceValidationError, type Persistence } from './persistence';
import { migrateOwned, validateTableColumns } from './migrations';

export interface LocalGitServerOptions {
  readonly persistence: Persistence; readonly agentsRoot: string;
  repos(): readonly string[]; authorize(caller: string): void; activeWorktreePaths?(): string[];
  readonly protectedBranches?: LocalGitOptions['protectedBranches'];
  readonly mutateWorktree?: LocalGitOptions['mutateWorktree'];
  readonly protectOperation?: (repo: string, operation: LocalGitControlCommandV1['operation']) => void;
  readonly read?: typeof getLocalGit; readonly mutate?: typeof mutateLocalGit; readonly identity?: typeof localGitCheckoutIdentity;
}
const DDL = `CREATE TABLE local_git_control_receipts (
  caller TEXT NOT NULL, requestId TEXT NOT NULL, command TEXT NOT NULL, receipt TEXT NOT NULL, owner TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(caller,requestId)
)`;
interface Row { command: string; receipt: string; owner: string; hash: string }
export function createLocalGitService(options: LocalGitServerOptions) {
  const { persistence } = options; const { sql } = persistence; const owner = randomUUID(); const active = new Set<string>(); let queued = 0;
  const read = options.read ?? getLocalGit; const mutate = options.mutate ?? mutateLocalGit; const identity = options.identity ?? localGitCheckoutIdentity;
  const gitOptions: LocalGitOptions = { activeWorktreePaths: options.activeWorktreePaths, protectedBranches: options.protectedBranches, mutateWorktree: options.mutateWorktree };
  migrateOwned(sql, { owner: 'core.local-git-control-receipts', version: 1, checksum: persistenceHash(DDL), tables: ['local_git_control_receipts'], validateLegacy: () => null,
    apply: () => sql.exec(DDL), validateCurrent: () => validateTableColumns(sql, 'local_git_control_receipts', ['caller', 'requestId', 'command', 'receipt', 'owner', 'hash']) });
  const key = (caller: string, requestId: string) => JSON.stringify([caller, requestId]);
  function scope(caller: string, repo: string, scopeRepo: string | null) {
    if (!isContributionId(caller)) throw new ClarificationServiceError(403, 'forbidden'); options.authorize(caller); clarificationScope(options.repos(), scopeRepo, repo);
  }
  function row(caller: string, requestId: string): Row | null {
    const saved = sql.prepare('SELECT command,receipt,owner,hash FROM local_git_control_receipts WHERE caller=? AND requestId=?').get(caller, requestId) as Row | undefined;
    if (!saved) return null;
    const command = parseLocalGitControlCommandV1(JSON.parse(saved.command)); const receipt = parseLocalGitControlReceiptV1(JSON.parse(saved.receipt), command);
    if (command.requestId !== requestId || saved.hash !== persistenceHash({ caller, command, receipt, owner: saved.owner })) throw new PersistenceValidationError('Local Git receipt integrity failed');
    return saved;
  }
  function receiptOf(caller: string, saved: Row): LocalGitControlReceiptV1 {
    const receipt = parseLocalGitControlReceiptV1(JSON.parse(saved.receipt));
    return saved.owner === owner && active.has(key(caller, receipt.requestId)) && receipt.status === 'recovery-required'
      ? parseLocalGitControlReceiptV1({ ...receipt, status: 'pending', reason: null }) : receipt;
  }
  function match(saved: Row, command: LocalGitControlCommandV1) { if (saved.command !== JSON.stringify(command)) throw new ClarificationServiceError(409, 'conflict'); }
  function makeReceipt(command: LocalGitControlCommandV1, status: LocalGitControlReceiptV1['status'], reason: string | null, result: LocalGitSnapshotV1 | null = null) {
    const { requestId, ...input } = command; return parseLocalGitControlReceiptV1({ version: 1, requestId, input, status, reason, result }, command);
  }
  function insert(caller: string, command: LocalGitControlCommandV1, receipt: LocalGitControlReceiptV1) {
    sql.prepare('INSERT INTO local_git_control_receipts VALUES (?,?,?,?,?,?)').run(caller, command.requestId, JSON.stringify(command), JSON.stringify(receipt), owner, persistenceHash({ caller, command, receipt, owner }));
  }
  async function snapshot(repo: string) {
    const before = await identity(options.agentsRoot, repo).catch(() => null);
    const response = await read(options.agentsRoot, repo, [...options.repos()], gitOptions);
    const after = await identity(options.agentsRoot, repo).catch(() => null);
    if (!response?.json || response.json.repo !== repo) throw new ClarificationServiceError(503, 'service-unavailable');
    if (!response.json.error && (before === null || before !== after)) throw new ClarificationServiceError(409, 'conflict');
    const { cleanup: _cleanup, ...data } = response.json;
    return { binding: after, value: parseLocalGitSnapshotV1({ version: 1, ...data, revision: persistenceHash({ data, binding: after }) }) };
  }
  async function current(caller: string, target: LocalGitTargetV1, scopeRepo: string | null) {
    scope(caller, target.repo, scopeRepo); const observed = await snapshot(target.repo); scope(caller, target.repo, scopeRepo);
    if (observed.value.error || observed.binding === null || observed.value.revision !== target.revision) throw new ClarificationServiceError(409, 'conflict'); return observed;
  }
  return Object.freeze({
    async snapshot(caller: string, input: { version: 1; repo: string }, scopeRepo: string | null) {
      if (input?.version !== 1) throw new ClarificationServiceError(400, 'invalid-response'); const repo = parseTaskRepo(input.repo); scope(caller, repo, scopeRepo);
      const result = await snapshot(repo); scope(caller, repo, scopeRepo); return result.value;
    },
    async preview(caller: string, input: { target: LocalGitTargetV1; force: boolean }, scopeRepo: string | null) {
      const target = parseLocalGitTargetV1(input?.target); const force = clarificationBoolean(input?.force); scope(caller, target.repo, scopeRepo);
      const result = await mutate(options.agentsRoot, target.repo, [...options.repos()], { action: 'preview-delete-untracked-branches', force }, { ...gitOptions, beforeMutation: async () => { await current(caller, target, scopeRepo); } });
      await current(caller, target, scopeRepo);
      if (result.status !== 200 || result.json.error || !result.json.cleanup) throw new ClarificationServiceError(409, 'conflict');
      return parseLocalGitPreviewV1({ version: 1, target, cleanup: result.json.cleanup }, target);
    },
    async control(caller: string, value: LocalGitControlCommandV1, scopeRepo: string | null): Promise<LocalGitControlReceiptV1> {
      const command = parseLocalGitControlCommandV1(value); scope(caller, command.target.repo, scopeRepo);
      const existing = row(caller, command.requestId); if (existing) { match(existing, command); return receiptOf(caller, existing); }
      if (queued >= 256) throw new ClarificationServiceError(503, 'service-unavailable'); queued++;
      let admitted = false; let effect = false; let binding: string | null = null; let replay: LocalGitControlReceiptV1 | null = null;
      const uncertain = makeReceipt(command, 'recovery-required', 'Inspect local Git state before acknowledging; this request will not run again');
      let outcome = uncertain;
      try {
        const result = await mutate(options.agentsRoot, command.target.repo, [...options.repos()], command.operation, { ...gitOptions,
          async beforeMutation() {
            const saved = row(caller, command.requestId);
            if (saved) { match(saved, command); replay = receiptOf(caller, saved); throw new ClarificationServiceError(409, 'conflict'); }
            const observed = await current(caller, command.target, scopeRepo); binding = observed.binding;
            persistence.transaction(() => {
              const saved = row(caller, command.requestId);
              if (saved) { match(saved, command); replay = receiptOf(caller, saved); throw new ClarificationServiceError(409, 'conflict'); }
              insert(caller, command, uncertain); admitted = true; active.add(key(caller, command.requestId));
            });
          },
          async beforeEffect() {
            scope(caller, command.target.repo, scopeRepo);
            if (!admitted || binding === null || await identity(options.agentsRoot, command.target.repo) !== binding) throw new ClarificationServiceError(409, 'conflict');
            if (!effect) await current(caller, command.target, scopeRepo);
            scope(caller, command.target.repo, scopeRepo); options.protectOperation?.(command.target.repo, command.operation); effect = true;
          },
        });
        if (replay) return replay;
        if (result?.status === 200 && result.json?.error === null) {
          if (!admitted || binding === null || await identity(options.agentsRoot, command.target.repo) !== binding) throw new ClarificationServiceError(409, 'conflict');
          const refreshed = await snapshot(command.target.repo);
          if (refreshed.binding !== binding || refreshed.value.error) throw new ClarificationServiceError(409, 'conflict');
          outcome = makeReceipt(command, 'succeeded', null, refreshed.value);
        } else if (!effect) outcome = makeReceipt(command, 'rejected', result?.json?.error?.slice(0, 2000) || 'Local Git action was rejected before dispatch');
      } catch {
        if (replay) return replay;
        if (!effect) outcome = makeReceipt(command, 'rejected', 'Local Git target changed or the action could not be admitted');
      } finally { active.delete(key(caller, command.requestId)); queued--; }
      return persistence.transaction(() => {
        const saved = row(caller, command.requestId);
        if (saved) {
          match(saved, command);
          if (!admitted) return receiptOf(caller, saved);
          sql.prepare('UPDATE local_git_control_receipts SET receipt=?,hash=? WHERE caller=? AND requestId=?').run(JSON.stringify(outcome), persistenceHash({ caller, command, receipt: outcome, owner }), caller, command.requestId);
        } else insert(caller, command, outcome);
        return outcome;
      });
    },
    receipt(caller: string, value: LocalGitReceiptQueryV1, scopeRepo: string | null) {
      const query = parseLocalGitReceiptQueryV1(value); scope(caller, query.repo, scopeRepo); const saved = row(caller, query.requestId);
      if (!saved) return null; const result = receiptOf(caller, saved); if (result.input.target.repo !== query.repo) throw new ClarificationServiceError(404, 'not-found'); return result;
    },
    inspect(caller: string, value: LocalGitControlCommandV1, scopeRepo: string | null) {
      const command = parseLocalGitControlCommandV1(value); scope(caller, command.target.repo, scopeRepo);
      return persistence.transaction(() => {
        const saved = row(caller, command.requestId); if (saved) { match(saved, command); return receiptOf(caller, saved); }
        const receipt = makeReceipt(command, 'recovery-required', 'No local Git dispatch was recorded. This request is blocked from dispatch; inspect local state before acknowledging');
        insert(caller, command, receipt); return receipt;
      });
    },
  });
}
export type LocalGitServerService = ReturnType<typeof createLocalGitService>;
