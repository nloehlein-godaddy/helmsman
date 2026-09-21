import { isContributionId } from '../../src/plugins/manifest';
import type { PluginJson } from '../../src/plugins/backend';
import { parseTaskRepo } from '../../src/plugins/tasks';
import { parseSourceAdminCommandV1, parseSourceAdminReceiptQueryV1, parseSourceAdminReceiptV1, parseSourceAdminSnapshotV1, parseSourceAdminValidationInputV1, parseSourceAdminValidationV1,
  type SourceAdminCommandV1, type SourceAdminInputV1, type SourceAdminMutationResultV1, type SourceAdminReceiptV1, type SourceAdminReceiptQueryV1, type SourceAdminTargetV1, type SourceAdminValidationV1 } from '../../src/plugins/source-admin';
import { parseSourceSettingFieldsV1, validateSourceSettingV1 } from '../../src/plugins/source-settings';
import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson } from './persistence';
import type { TaskSourceRegistry } from './task-sources/registry';
import type { TaskSourceStore } from './task-sources/store';
import type { TaskSourceService } from './task-source-service';
import type { TaskSourceSchedule } from './task-source-schedule';
import type { AutoClaimScheduler } from './scheduler';
import { awaitSourceResult } from './source-await';

export class SourceAdminAccessError extends Error {}
export interface SourceAdminServerOptions {
  store: TaskSourceStore; registry: TaskSourceRegistry; service: TaskSourceService; schedule: TaskSourceSchedule; scheduler: AutoClaimScheduler;
  repos(): readonly string[]; authorize(caller: string): void;
}
const schema = `CREATE TABLE public_source_admin_receipts (caller TEXT NOT NULL,requestId TEXT NOT NULL,hash TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(caller,requestId));
CREATE TABLE public_source_admin_runtime_intents (caller TEXT NOT NULL,requestId TEXT NOT NULL,hash TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(caller,requestId));
CREATE TABLE public_source_admin_validations (caller TEXT NOT NULL,validationId TEXT NOT NULL,hash TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(caller,validationId));`;
export function createSourceAdminService(options: SourceAdminServerOptions) {
  const { store, registry, service, schedule, scheduler } = options; const { sql } = store.persistence;
  const runtimeReceipts = new Map<string, SourceAdminReceiptV1>();
  migrateOwned(sql, { owner: 'core.public-source-admin', version: 1, checksum: persistenceHash(schema), tables: ['public_source_admin_receipts', 'public_source_admin_validations', 'public_source_admin_runtime_intents'],
    validateLegacy: () => null, apply: database => database.exec(schema), validateCurrent(database) {
      validateTableColumns(database, 'public_source_admin_receipts', ['caller', 'requestId', 'hash', 'json']);
      validateTableColumns(database, 'public_source_admin_runtime_intents', ['caller', 'requestId', 'hash', 'json']);
      validateTableColumns(database, 'public_source_admin_validations', ['caller', 'validationId', 'hash', 'json']);
    } });
  function authorize(caller: string): void { if (!isContributionId(caller)) throw new SourceAdminAccessError('Source administration caller required'); options.authorize(caller); }
  function permitted(repo: string | null): void { if (repo !== null && !options.repos().includes(parseTaskRepo(repo))) throw new SourceAdminAccessError('Galleon is unavailable'); }
  function target(input: SourceAdminTargetV1, repo: string | null) {
    permitted(repo); const source = store.source(input.sourceId); const instance = store.instance(input.instanceId);
    if (!source?.conversionReady || source.currentInstanceId !== input.instanceId || source.revision !== input.sourceRevision
      || !instance || instance.sourceId !== source.id || instance.revision !== input.instanceRevision
      || repo !== null && !instance.allowedRepos.includes(repo)) throw new PersistenceConflictError('Source configuration changed');
    return { source, instance };
  }
  function runtimeIntent(caller: string, query: SourceAdminReceiptQueryV1): Extract<SourceAdminCommandV1, { kind: 'runtime' }> | null {
    const row = sql.prepare('SELECT hash,json FROM public_source_admin_runtime_intents WHERE caller=? AND requestId=?').get(caller, query.requestId) as { hash: string; json: string } | undefined;
    if (!row) return null; const command = parseSourceAdminCommandV1(JSON.parse(row.json));
    if (command.kind !== 'runtime' || command.requestId !== query.requestId || command.repo !== query.repo || persistenceHash(command) !== row.hash) throw new PersistenceConflictError('Runtime command identity changed');
    return command;
  }
  function saveReceipt(caller: string, result: SourceAdminReceiptV1): SourceAdminReceiptV1 {
    store.persistence.transaction(() => {
      const row = sql.prepare('SELECT hash,json FROM public_source_admin_receipts WHERE caller=? AND requestId=?').get(caller, result.requestId) as { hash: string; json: string } | undefined;
      if (row) { if (row.hash !== persistenceHash(result) || row.json !== stableJson(result)) throw new PersistenceConflictError('Administration receipt changed'); return; }
      sql.prepare('INSERT INTO public_source_admin_receipts VALUES (?,?,?,?)').run(caller, result.requestId, persistenceHash(result), stableJson(result));
    });
    return result;
  }
  function expired(command: Extract<SourceAdminCommandV1, { kind: 'runtime' }>): SourceAdminReceiptV1 {
    const { requestId, ...input } = command;
    return parseSourceAdminReceiptV1({ version: 1, requestId, input, status: 'expired', result: null,
      message: 'The scheduler process restarted. The previous toggle outcome is unknown; this command cannot change the current process.' }, command);
  }
  function lookupReceipt(caller: string, raw: unknown): SourceAdminReceiptV1 | null {
    authorize(caller); const query = parseSourceAdminReceiptQueryV1(raw);
    const row = sql.prepare('SELECT hash,json FROM public_source_admin_receipts WHERE caller=? AND requestId=?').get(caller, query.requestId) as { hash: string; json: string } | undefined;
    if (row) {
      const result = parseSourceAdminReceiptV1(JSON.parse(row.json), query);
      if (persistenceHash(result) !== row.hash) throw new PersistenceConflictError('Source administration receipt integrity failed'); return result;
    }
    const intent = runtimeIntent(caller, query);
    if (intent) {
      const runtime = runtimeReceipts.get(stableJson([caller, query.requestId]));
      if (runtime) return saveReceipt(caller, parseSourceAdminReceiptV1(runtime, intent));
      if (scheduler.runtime(intent.repo).epoch !== intent.epoch) return saveReceipt(caller, expired(intent));
      return null;
    }
    permitted(query.repo); return null;
  }
  function toggle(command: Extract<SourceAdminCommandV1, { kind: 'runtime' }>, caller: string): SourceAdminReceiptV1 {
    const { requestId, ...input } = command;
    let result: SourceAdminReceiptV1;
    if (scheduler.runtime(command.repo).epoch !== command.epoch) result = expired(command);
    else {
      let runtime;
      try { runtime = scheduler.compareAndSetEnabled(command); }
      catch (error) {
        if (!(error instanceof PersistenceConflictError)) throw error;
        result = parseSourceAdminReceiptV1({ version: 1, requestId, input, status: 'rejected', result: null, message: 'The automatic start revision changed. Reload before trying a new command.' }, command);
      }
      if (runtime) result = parseSourceAdminReceiptV1({ version: 1, requestId, input, status: 'succeeded', result: { kind: 'runtime', runtime }, message: null }, command);
    }
    runtimeReceipts.set(stableJson([caller, requestId]), result!);
    const saved = saveReceipt(caller, result!); runtimeReceipts.delete(stableJson([caller, requestId])); return saved;
  }
  function projection(repo: string | null) {
    permitted(repo); const repos = repo === null ? [...options.repos()] : [repo];
    const sources = store.instances().filter(instance => repo === null || instance.allowedRepos.includes(repo)).map(instance => {
      const source = store.source(instance.sourceId); if (!source) throw new PersistenceConflictError('Source authority unavailable');
      let available = false; try { service.assertScope(instance, repo, 'admission'); available = true; } catch { /* Disabled and retained sources remain visible. */ }
      let fields = parseSourceSettingFieldsV1({}); try { fields = parseSourceSettingFieldsV1(registry.resolve(instance, 'obligation').declaration.settingsFields ?? {}); } catch { /* Missing artifacts do not expose settings. */ }
      const settings: Record<string, PluginJson> = Object.create(null);
      for (const [key, field] of Object.entries(fields)) if (Object.hasOwn(instance.settings, key)) settings[key] = validateSourceSettingV1(field.schema, instance.settings[key]);
      const replacements: { mode: 'adoption' | 'refresh'; providerId: string; artifactHash: string }[] = [];
      if (source.currentInstanceId === instance.id) for (const mode of ['adoption', 'refresh'] as const) {
        try { for (const candidate of service[mode].candidates(source.id).candidates) replacements.push({ ...candidate, mode }); } catch { /* Replacement modes have independent authority requirements. */ }
      }
      return { target: { sourceId: source.id, sourceRevision: source.revision, instanceId: instance.id, instanceRevision: instance.revision }, label: instance.label,
        providerId: instance.binding.providerId, identityLevel: instance.identityLevel, current: source.currentInstanceId === instance.id, available,
        desiredEnabled: instance.desiredEnabled, allowedRepos: instance.allowedRepos, settingsFields: fields, settings, replacements };
    });
    return parseSourceAdminSnapshotV1({ version: 1, repo, repos, sources,
      schedules: repos.map(repo => { const selected = schedule.selections(repo); return { repo, revision: selected.revision, instanceIds: selected.instanceIds }; }),
      runtimes: repos.map(repo => scheduler.runtime(repo)) }, repo);
  }
  function apply(input: SourceAdminInputV1, caller: string): SourceAdminMutationResultV1 {
    permitted(input.repo);
    if (input.kind === 'configure') {
      const { instance } = target(input.target, input.repo);
      let fields = parseSourceSettingFieldsV1({});
      try { fields = parseSourceSettingFieldsV1(registry.resolve(instance, 'obligation').declaration.settingsFields ?? {}); }
      catch (error) { if (Object.keys(input.changes.settings).length) throw error; }
      if (input.changes.allowedRepos.some(repo => !options.repos().includes(repo))) throw new SourceAdminAccessError('Configured galleon is unavailable');
      const settings: Record<string, PluginJson> = { ...instance.settings };
      for (const key of Object.keys(fields)) delete settings[key];
      for (const [key, value] of Object.entries(input.changes.settings)) {
        const field = fields[key]; if (!field) throw new PersistenceValidationError('Setting is not declared editable'); settings[key] = validateSourceSettingV1(field.schema, value);
      }
      const configured = store.configureInstance({ instanceId: instance.id, expectedRevision: instance.revision, ...input.changes, settings });
      return { kind: 'configured', target: { ...input.target, instanceRevision: configured.revision } };
    }
    if (input.kind === 'schedule') {
      const selected = schedule.select(input.repo, input.instanceIds, input.expectedRevision);
      return { kind: 'scheduled', schedule: { repo: selected.repo, revision: selected.revision, instanceIds: selected.instanceIds } };
    }
    if (input.kind === 'runtime') throw new PersistenceConflictError('Runtime commands require a durable reservation');
    const validation = input.validation;
    const row = sql.prepare('SELECT hash,json FROM public_source_admin_validations WHERE caller=? AND validationId=?').get(caller, validation.validationId) as { hash: string; json: string } | undefined;
    if (!row || row.hash !== persistenceHash(validation) || stableJson(validation) !== row.json) throw new PersistenceConflictError('Exact recorded replacement evidence is required');
    target(validation.target, input.repo);
    const result = service[validation.mode].commit(validation.validationId);
    return { kind: 'replaced', sourceId: result.sourceId, currentInstanceId: result.currentInstanceId, sourceRevision: result.revision };
  }
  function settle(command: SourceAdminCommandV1, caller: string): SourceAdminReceiptV1 {
    const { requestId, ...input } = command;
    try {
      return store.persistence.transaction(() => parseSourceAdminReceiptV1({ version: 1, requestId, input, status: 'succeeded', result: apply(input, caller), message: null }, command));
    } catch (error) {
      if (!(error instanceof PersistenceConflictError || error instanceof PersistenceValidationError || error instanceof SourceContractValidationError || error instanceof SourceAdminAccessError)) throw error;
      return parseSourceAdminReceiptV1({ version: 1, requestId, input, status: 'rejected', result: null, message: 'Source administration preconditions changed or the requested configuration is invalid. Reload before trying a new command.' }, command);
    }
  }
  return {
    snapshot(caller: string, repo: string | null) { authorize(caller); return projection(repo); },
    receipt(caller: string, raw: unknown): SourceAdminReceiptV1 | null {
      const result = store.persistence.transaction(() => lookupReceipt(caller, raw));
      if (result) runtimeReceipts.delete(stableJson([caller, result.requestId])); return result;
    },
    async validateReplacement(caller: string, raw: unknown, signal: AbortSignal): Promise<SourceAdminValidationV1> {
      authorize(caller); const input = parseSourceAdminValidationInputV1(raw); target(input.target, input.repo); signal.throwIfAborted();
      const proof = await awaitSourceResult(service[input.mode].validate({ sourceId: input.target.sourceId, sourceRevision: input.target.sourceRevision,
        providerId: input.providerId, artifactHash: input.artifactHash, repo: input.repo, actor: input.actor, reason: input.reason }, signal), signal);
      signal.throwIfAborted(); authorize(caller); target(input.target, input.repo);
      const validation = parseSourceAdminValidationV1({ ...input, validationId: proof.validationId, instanceId: proof.instanceId, evidenceHash: proof.evidenceHash });
      store.persistence.transaction(() => {
        signal.throwIfAborted(); target(input.target, input.repo);
        sql.prepare('INSERT INTO public_source_admin_validations VALUES (?,?,?,?)').run(caller, validation.validationId, persistenceHash(validation), stableJson(validation));
      });
      return validation;
    },
    submit(caller: string, raw: unknown): SourceAdminReceiptV1 {
      authorize(caller); const command = parseSourceAdminCommandV1(raw);
      const result = store.persistence.transaction(() => {
        const query = { repo: command.repo, requestId: command.requestId };
        const previous = lookupReceipt(caller, query); if (previous) return parseSourceAdminReceiptV1(previous, command);
        const intent = runtimeIntent(caller, query);
        if (intent) {
          if (stableJson(intent) !== stableJson(command)) throw new PersistenceConflictError('Runtime command identity changed');
          throw new PersistenceConflictError('Runtime command outcome is unresolved; it cannot be applied again');
        }
        permitted(command.repo);
        if (command.kind === 'runtime') {
          if (runtimeReceipts.size >= 1024) throw new PersistenceConflictError('Automatic start recovery capacity reached for this process');
          sql.prepare('INSERT INTO public_source_admin_runtime_intents VALUES (?,?,?,?)').run(caller, command.requestId, persistenceHash(command), stableJson(command));
          return null;
        }
        return saveReceipt(caller, settle(command, caller));
      });
      if (result) { runtimeReceipts.delete(stableJson([caller, command.requestId])); return result; }
      if (command.kind !== 'runtime') throw new PersistenceConflictError('Runtime reservation is missing');
      return toggle(command, caller);
    },
  };
}
export type SourceAdminServerService = ReturnType<typeof createSourceAdminService>;
