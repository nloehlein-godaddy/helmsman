import { randomUUID } from 'node:crypto';
import { parseSourceIdentityEvidenceV1, parseSourceInstanceV1, parseTaskPageV1, parseTaskRepo, parseTaskSnapshotV1, type SourceCallContextV1, type SourceInstanceV1, type SourceReadHttpV1, type WorkRefV1 } from '../../src/plugins/tasks';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistedJson, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson } from './persistence';
import type { SourceConnectionRecord } from './task-source-connections';
import type { SourceResolutionPurpose, TaskSourceRegistry } from './task-sources/registry';
import { writeTaskSource, type TaskSourceRecord, type TaskSourceStore } from './task-sources/store';

export interface TaskSourceRefreshOptions {
  connection(instance: SourceInstanceV1): SourceConnectionRecord | null;
  identityFormat(instance: SourceInstanceV1): string | null;
}
interface RefreshValidation {
  id: string; source: TaskSourceRecord; previous: SourceInstanceV1; candidate: SourceInstanceV1;
  connection: SourceConnectionRecord; identityFormat: string; actor: string; reason: string;
  evidence: { identity: ReturnType<typeof parseSourceIdentityEvidenceV1>; probes: { ref: WorkRefV1; repo: string; revision: string }[]; emptyRepos: string[] };
}
const schema = `CREATE TABLE source_refresh_validations (id TEXT PRIMARY KEY, evidenceHash TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE source_refreshes (id TEXT PRIMARY KEY, json TEXT NOT NULL);`;
export function createTaskSourceRefreshService(options: TaskSourceRefreshOptions & {
  store: TaskSourceStore; registry: TaskSourceRegistry;
  http(instance: SourceInstanceV1, repo: string | null, signal: AbortSignal, purpose: SourceResolutionPurpose, authorize: () => void): SourceReadHttpV1;
}) {
  const { store, registry } = options;
  migrateOwned(store.persistence.sql, { owner: 'core.source-refresh', version: 1, checksum: persistenceHash(schema), tables: ['source_refresh_validations', 'source_refreshes'],
    validateLegacy: () => null, apply: database => database.exec(schema),
    validateCurrent(database) { validateTableColumns(database, 'source_refresh_validations', ['id', 'evidenceHash', 'json']); validateTableColumns(database, 'source_refreshes', ['id', 'json']); } });
  function current(sourceId: string) {
    const source = store.source(sourceId); const instance = source && store.instance(source.currentInstanceId);
    if (!source?.conversionReady || !instance || source.storageLayout !== 'remote' || source.identityEvidence.level !== 'operator-seeded'
      || source.identityEvidence.authority !== null || instance.identityLevel !== 'operator-seeded' || instance.authority !== null
      || instance.binding.pluginId !== 'helmsman.jira' || instance.binding.providerId !== 'helmsman.jira/issues') throw new PersistenceConflictError('Artifact refresh requires an operator-seeded Jira source');
    const identityFormat = options.identityFormat(instance); const connection = options.connection(instance);
    if (identityFormat !== 'jira.issue-id/v1' || !connection || connection.kind !== 'jira' || connection.id !== instance.binding.connectionId
      || connection.credentialHandle !== instance.binding.credentialHandle || connection.authorityId !== null) throw new PersistenceConflictError('Original source identity and connection verification are unavailable');
    return { source, instance, identityFormat, connection };
  }
  function registered(previous: SourceInstanceV1, artifactHash: string, identityFormat: string) {
    const registration = registry.list().find(item => item.binding.pluginId === previous.binding.pluginId && item.binding.providerId === previous.binding.providerId
      && item.binding.contractVersion === previous.binding.contractVersion && item.binding.artifactHash === artifactHash
      && item.binding.artifactHash !== previous.binding.artifactHash && item.declaration.identityFormats.includes(identityFormat)
      && item.declaration.access.includes('connection-http') && !item.declaration.access.includes('local-records'));
    if (!registration) throw new PersistenceConflictError('Same-provider artifact refresh candidate is unavailable');
    return registration;
  }
  function unchanged(validation: Pick<RefreshValidation, 'source' | 'previous' | 'connection' | 'identityFormat' | 'candidate'>) {
    const now = current(validation.source.id);
    if (stableJson(now.source) !== stableJson(validation.source) || stableJson(now.instance) !== stableJson(validation.previous)
      || stableJson(now.connection) !== stableJson(validation.connection) || now.identityFormat !== validation.identityFormat) throw new PersistenceConflictError('Source artifact refresh validation is stale');
    return registered(validation.previous, validation.candidate.binding.artifactHash, validation.identityFormat);
  }
  return {
    candidates(sourceId: string) {
      const { source, instance, identityFormat } = current(sourceId);
      return { mode: 'refresh' as const, sourceId, sourceRevision: source.revision, currentInstanceId: instance.id,
        candidates: registry.list().filter(item => { try { return registered(instance, item.binding.artifactHash, identityFormat) === item; } catch { return false; } })
          .map(item => ({ providerId: item.binding.providerId, artifactHash: item.binding.artifactHash })) };
    },
    async validate(input: { sourceId: string; sourceRevision: number; providerId: string; artifactHash: string; repo: string; actor: string; reason: string }, signal: AbortSignal) {
      signal.throwIfAborted();
      if (typeof input.actor !== 'string' || !input.actor.trim() || input.actor.length > 240 || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2048) throw new PersistenceValidationError('Artifact refresh requires an operator actor and reason');
      const { source, instance: previous, identityFormat, connection } = current(input.sourceId);
      if (source.revision !== input.sourceRevision || previous.binding.providerId !== input.providerId || !previous.allowedRepos.includes(parseTaskRepo(input.repo))) throw new PersistenceConflictError('Source artifact refresh selection changed');
      const registration = registered(previous, input.artifactHash, identityFormat);
      const candidate = parseSourceInstanceV1({ ...previous, id: randomUUID(), revision: 1, binding: { ...previous.binding, artifactHash: registration.binding.artifactHash } });
      const base = { source, previous, candidate, connection, identityFormat };
      const authorize = () => { signal.throwIfAborted(); unchanged(base); };
      function context(repo: string): SourceCallContextV1 {
        if (!previous.allowedRepos.includes(parseTaskRepo(repo))) throw new PersistenceConflictError('Recorded source probe galleon is unauthorized');
        const broker = options.http(candidate, repo, signal, 'admission', authorize);
        return Object.freeze({ instance: candidate, repo, signal, local: null, http: Object.freeze({ async get(request: Parameters<SourceReadHttpV1['get']>[0]) { authorize(); const response = await broker.get(request); authorize(); return response; } }) });
      }
      const primary = context(input.repo);
      const subject = await primary.http!.get({ path: '/rest/api/3/myself', query: {} });
      if (subject.status !== 200 || !subject.body || typeof subject.body !== 'object' || Array.isArray(subject.body) || ('accountId' in subject.body ? subject.body.accountId : null) !== connection.subject) throw new PersistenceConflictError('Pinned source connection subject verification failed');
      const identity = parseSourceIdentityEvidenceV1(await registration.provider.identify(primary)); authorize();
      if (identity.authority && identity.authority.identityFormat !== identityFormat) throw new PersistenceConflictError('Source artifact refresh identity format changed');
      const known = new Map<string, { ref: WorkRefV1; repo: string }>();
      const aliases = store.persistence.sql.prepare('SELECT externalId,evidence FROM source_aliases WHERE sourceId=? ORDER BY externalId,displayKey').all(source.id) as { externalId: string; evidence: string }[];
      for (const alias of aliases) {
        const evidence = persistedJson(JSON.parse(alias.evidence));
        const repo = evidence && typeof evidence === 'object' && !Array.isArray(evidence) && 'repo' in evidence ? evidence.repo : null;
        if (typeof repo !== 'string') throw new PersistenceConflictError('Recorded source probe scope is unavailable');
        known.set(`${repo}:${alias.externalId}`, { ref: { sourceId: source.id, externalId: alias.externalId }, repo: parseTaskRepo(repo) });
      }
      const snapshots = store.persistence.sql.prepare("SELECT hash FROM source_task_snapshots WHERE json_extract(json,'$.task.ref.sourceId')=? ORDER BY hash").all(source.id) as { hash: string }[];
      for (const row of snapshots) { const task = store.taskSnapshot(row.hash)?.task; if (task) known.set(`${task.repo}:${task.ref.externalId}`, { ref: task.ref, repo: task.repo }); }
      if ([...known.values()].some(item => !previous.allowedRepos.includes(item.repo))) throw new PersistenceConflictError('Recorded source probe galleon is unauthorized');
      const probes: RefreshValidation['evidence']['probes'] = []; const emptyRepos: string[] = [];
      if (!known.size) {
        for (const repo of previous.allowedRepos) {
          const page = parseTaskPageV1(await registration.provider.list({ repo, state: null, cursor: null, limit: 100 }, context(repo)), { sourceId: source.id, repo }); authorize();
          if (!page.items.length && page.nextCursor !== null) throw new PersistenceConflictError('Source artifact refresh empty-page proof is incomplete');
          if (!page.items.length) emptyRepos.push(repo);
          for (const task of page.items) known.set(`${repo}:${task.ref.externalId}`, { ref: task.ref, repo });
        }
      }
      for (const probe of [...known.values()].sort((a, b) => `${a.repo}:${a.ref.externalId}`.localeCompare(`${b.repo}:${b.ref.externalId}`)).slice(0, 100)) {
        const task = parseTaskSnapshotV1(await registration.provider.load(probe.ref, context(probe.repo)), { sourceId: source.id, repo: probe.repo }); authorize();
        if (task.ref.externalId !== probe.ref.externalId) throw new PersistenceConflictError('Source artifact refresh probe returned another canonical item');
        probes.push({ ref: task.ref, repo: task.repo, revision: task.revision });
      }
      const validation: RefreshValidation = { id: randomUUID(), ...base, actor: input.actor, reason: input.reason, evidence: { identity, probes, emptyRepos } };
      const evidenceHash = persistenceHash(validation);
      store.persistence.transaction(() => { authorize(); store.persistence.sql.prepare('INSERT INTO source_refresh_validations VALUES (?,?,?)').run(validation.id, evidenceHash, stableJson(validation)); });
      return { validationId: validation.id, sourceId: source.id, instanceId: candidate.id, evidenceHash };
    },
    commit(validationId: string) {
      return store.persistence.transaction(() => {
        const row = store.persistence.sql.prepare('SELECT evidenceHash,json FROM source_refresh_validations WHERE id=?').get(validationId) as { evidenceHash: string; json: string } | undefined;
        if (!row) throw new PersistenceConflictError('Registered artifact refresh validation is required');
        const validation = persistedJson(JSON.parse(row.json)) as unknown as RefreshValidation;
        if (validation.id !== validationId || persistenceHash(validation) !== row.evidenceHash) throw new PersistenceConflictError('Source artifact refresh evidence integrity failed');
        const prior = store.persistence.sql.prepare('SELECT json FROM source_refreshes WHERE id=?').get(validationId) as { json: string } | undefined;
        if (prior) {
          const source = store.source(validation.source.id);
          if (source?.currentInstanceId !== validation.candidate.id) throw new PersistenceConflictError('Source selection changed after artifact refresh');
          return { sourceId: source.id, currentInstanceId: source.currentInstanceId, revision: source.revision };
        }
        unchanged(validation);
        const candidate = parseSourceInstanceV1(validation.candidate);
        const expected = { ...validation.previous, id: candidate.id, revision: 1, binding: { ...validation.previous.binding, artifactHash: candidate.binding.artifactHash } };
        if (stableJson(candidate) !== stableJson(expected)) throw new PersistenceConflictError('Source artifact refresh cannot change provider identity or configuration');
        store.persistence.sql.prepare('INSERT INTO task_source_instances VALUES (?,?,?)').run(candidate.id, candidate.sourceId, stableJson(candidate));
        const next = { ...validation.source, revision: validation.source.revision + 1, currentInstanceId: candidate.id };
        writeTaskSource(store, next);
        store.persistence.sql.prepare('INSERT INTO source_refreshes VALUES (?,?)').run(validationId, stableJson({ validationId, evidenceHash: row.evidenceHash, actor: validation.actor, reason: validation.reason, sourceId: next.id, previousInstanceId: validation.previous.id, currentInstanceId: candidate.id }));
        return { sourceId: next.id, currentInstanceId: candidate.id, revision: next.revision };
      });
    },
  };
}
