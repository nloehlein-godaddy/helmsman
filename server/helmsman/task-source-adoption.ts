import type { SourceCallContextV1, SourceInstanceV1, SourceReadHttpV1 } from '../../src/plugins/tasks';
import { parseTaskRepo, parseTaskSnapshotV1 } from '../../src/plugins/tasks';
import { persistenceHash, PersistenceConflictError, stableJson } from './persistence';
import { createSourceAdoptionCoordinator } from './task-sources/adoption';
import type { LocalSourceAdapter } from './task-sources/local-records';
import type { SourceResolutionPurpose, TaskSourceRegistry } from './task-sources/registry';
import type { TaskSourceStore } from './task-sources/store';

export function createTaskSourceAdoptionService(options: {
  store: TaskSourceStore; registry: TaskSourceRegistry; local: LocalSourceAdapter;
  http(instance: SourceInstanceV1, repo: string | null, signal: AbortSignal, purpose: SourceResolutionPurpose, authorize: () => void): SourceReadHttpV1;
}) {
  const { store, registry, local } = options;
  function context(instance: SourceInstanceV1, repo: string | null, signal: AbortSignal, purpose: SourceResolutionPurpose = 'admission'): SourceCallContextV1 {
    const authorize = () => {
      signal.throwIfAborted();
      const source = store.source(instance.sourceId);
      const current = store.instance(instance.id);
      if (!source?.conversionReady || source.identityEvidence.level !== 'verified' || !current
        || stableJson(current) !== stableJson(instance) || stableJson(source.identityEvidence.authority) !== stableJson(instance.authority)
        || purpose === 'obligation' && source.currentInstanceId !== instance.id
        || repo === null || !instance.allowedRepos.includes(parseTaskRepo(repo))) throw new PersistenceConflictError('Source adoption scope changed');
      registry.resolve(instance, purpose);
    };
    authorize();
    const registration = registry.resolve(instance, purpose);
    const records = registration.declaration.access.includes('local-records') ? local.forContext(instance, repo, signal) : null;
    const http = registration.declaration.access.includes('connection-http') ? options.http(instance, repo, signal, purpose, authorize) : null;
    const checked = async <T>(operation: () => Promise<T>) => { authorize(); const value = await operation(); authorize(); return value; };
    return Object.freeze({ instance, repo, signal,
      local: records ? Object.freeze({ describeCollection: () => checked(() => records.describeCollection()),
        list: (input: Parameters<typeof records.list>[0]) => checked(() => records.list(input)), get: (id: string) => checked(() => records.get(id)) }) : null,
      http: http ? Object.freeze({ get: (input: Parameters<typeof http.get>[0]) => checked(() => http.get(input)) }) : null });
  }
  const coordinator = createSourceAdoptionCoordinator({ store, registry, context });
  function current(sourceId: string) {
    const source = store.source(sourceId);
    const instance = source && store.instance(source.currentInstanceId);
    if (!source || !instance || !source.conversionReady || source.identityEvidence.level !== 'verified' || !source.identityEvidence.authority) throw new PersistenceConflictError('Source adoption requires verified identity and completed conversion');
    return { source, instance };
  }
  return {
    candidates(sourceId: string) {
      const { source, instance } = current(sourceId);
      return { sourceId, sourceRevision: source.revision, currentInstanceId: instance.id,
        candidates: registry.list().filter(item => item.declaration.identityFormats.includes(source.identityEvidence.authority!.identityFormat)
          && (source.storageLayout === 'remote' ? item.declaration.access.includes('connection-http') : item.declaration.access.includes('local-records'))
          && (item.binding.providerId !== instance.binding.providerId || item.binding.artifactHash !== instance.binding.artifactHash))
          .map(item => ({ providerId: item.binding.providerId, artifactHash: item.binding.artifactHash })) };
    },
    async validate(input: { sourceId: string; sourceRevision: number; providerId: string; artifactHash: string; repo: string; actor: string; reason: string }, signal: AbortSignal) {
      const { source, instance } = current(input.sourceId);
      if (source.revision !== input.sourceRevision || !instance.allowedRepos.includes(parseTaskRepo(input.repo))) throw new PersistenceConflictError('Source adoption selection changed');
      const registration = registry.list().find(item => item.binding.providerId === input.providerId && item.binding.artifactHash === input.artifactHash);
      if (!registration) throw new PersistenceConflictError('Candidate task source provider is unavailable');
      const candidate = store.provision({ provisioningKey: `adoption:${persistenceHash({ sourceId: source.id, instance, binding: registration.binding })}`,
        label: instance.label, identityEvidence: source.identityEvidence, storageLayout: source.storageLayout,
        ...(source.collectionId ? { collectionId: source.collectionId } : {}), settings: instance.settings, allowedRepos: instance.allowedRepos,
        binding: { ...registration.binding, connectionId: instance.binding.connectionId, credentialHandle: instance.binding.credentialHandle } }).instance;
      const records = context(candidate, input.repo, signal).local;
      const probes = records ? (await records.list({ repo: input.repo, cursor: null, limit: 100 })).records.map(record => ({ ref: record.ref, revision: record.revision })) : [];
      if (!records) {
        const aliases = store.persistence.sql.prepare("SELECT externalId,json_extract(evidence, '$.revision') AS revision FROM source_aliases WHERE sourceId=? AND json_extract(evidence, '$.repo')=? ORDER BY externalId,revision DESC LIMIT 100").all(source.id, input.repo) as { externalId: string; revision: unknown }[];
        const snapshots = store.persistence.sql.prepare("SELECT hash FROM source_task_snapshots WHERE json_extract(json, '$.task.ref.sourceId')=? AND json_extract(json, '$.task.repo')=? ORDER BY rowid DESC LIMIT 100").all(source.id, input.repo) as { hash: string }[];
        const baselines = new Map<string, string | null>();
        for (const alias of aliases) {
          const revision = typeof alias.revision === 'string' && alias.revision ? alias.revision : null;
          if (!baselines.has(alias.externalId) || baselines.get(alias.externalId) === null) baselines.set(alias.externalId, revision);
        }
        for (const row of snapshots) {
          const snapshot = store.taskSnapshot(row.hash);
          if (snapshot && (!baselines.has(snapshot.task.ref.externalId) || baselines.get(snapshot.task.ref.externalId) === null)) baselines.set(snapshot.task.ref.externalId, snapshot.task.revision);
        }
        let incumbent = null;
        try { incumbent = registry.resolve(instance, 'obligation'); } catch { /* Recorded observations remain usable when the original artifact is unavailable. */ }
        const provider = registry.resolve(candidate, 'admission').provider;
        for (const [externalId, recordedRevision] of [...baselines].slice(0, 100)) {
          const ref = { sourceId: source.id, externalId };
          let revision = recordedRevision;
          if (incumbent) {
            const observed = parseTaskSnapshotV1(await incumbent.provider.load(ref, context(instance, input.repo, signal, 'obligation')), { sourceId: source.id, repo: input.repo });
            if (observed.ref.externalId !== ref.externalId) throw new PersistenceConflictError('Original source returned another work item');
            revision = observed.revision;
          }
          if (!revision) throw new PersistenceConflictError('Source adoption needs a recorded revision; restore the recorded provider and refresh its verified observation');
          const task = parseTaskSnapshotV1(await provider.load(ref, context(candidate, input.repo, signal)), { sourceId: source.id, repo: input.repo });
          if (task.ref.externalId !== ref.externalId) throw new PersistenceConflictError('Source adoption probe returned another work item');
          if (task.revision !== revision) throw new PersistenceConflictError('Source adoption revision differs from its original observation; restore the recorded provider and refresh its verified observation');
          probes.push({ ref, revision });
        }
      }
      const validation = await coordinator.validate({ sourceId: source.id, instanceId: candidate.id, expectedSourceRevision: source.revision,
        actor: input.actor, reason: input.reason, repo: input.repo, signal, probes });
      if (stableJson(store.instance(instance.id)) !== stableJson(instance)) throw new PersistenceConflictError('Previous source configuration changed during adoption validation');
      return { validationId: validation.id, sourceId: source.id, instanceId: candidate.id, evidenceHash: validation.evidenceHash };
    },
    commit(validationId: string) {
      const source = coordinator.adopt(validationId);
      return { sourceId: source.id, currentInstanceId: source.currentInstanceId, revision: source.revision };
    },
  };
}
