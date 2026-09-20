import { randomUUID } from 'node:crypto';
import { parseSourceAdoptionEvidenceV1, type SourceAdoptionProposalV1, type SourceInstanceV1, type SourceAdoptionEvidenceV1 } from '../../../src/plugins/tasks';
import { persistenceHash, stableJson, PersistenceConflictError } from '../persistence';
import type { SourceContextFactory } from './admission';
import type { TaskSourceRegistry } from './registry';
import { readTaskSource, writeTaskSource, type TaskSourceStore, type TaskSourceRecord } from './store';

export interface SourceAdoptionValidation {
  readonly id: string;
  readonly sourceRevision: number;
  readonly collectionRevision: number;
  readonly instance: SourceInstanceV1;
  readonly previousInstance: SourceInstanceV1;
  readonly proposal: SourceAdoptionProposalV1;
  readonly evidence: SourceAdoptionEvidenceV1;
  readonly evidenceHash: string;
  readonly actor: string;
  readonly reason: string;
}
export function createSourceAdoptionCoordinator(options: { store: TaskSourceStore; registry: TaskSourceRegistry; context: SourceContextFactory }) {
  const { store, registry } = options;
  return {
    async validate(input: { sourceId: string; instanceId: string; expectedSourceRevision: number; actor: string; reason: string; repo: string; signal: AbortSignal; probes: SourceAdoptionProposalV1['probes'] }): Promise<SourceAdoptionValidation> {
      const source = readTaskSource(store, input.sourceId); const proposed = store.instance(input.instanceId); const previous = store.instance(source.currentInstanceId);
      if (!proposed || !previous || proposed.sourceId !== source.id || !source.conversionReady || source.revision !== input.expectedSourceRevision) throw new PersistenceConflictError('Source adoption configuration changed');
      if (source.identityEvidence.level !== 'verified' || proposed.identityLevel !== 'verified' || !source.identityEvidence.authority || !proposed.authority || stableJson(source.identityEvidence.authority) !== stableJson(proposed.authority)) throw new PersistenceConflictError('Source adoption requires matching verified authority');
      if (!input.actor?.trim() || !input.reason?.trim() || input.actor.length > 240 || input.reason.length > 2048) throw new PersistenceConflictError('Source adoption actor and reason are required');
      if (!proposed.allowedRepos.includes(input.repo)) throw new PersistenceConflictError('Source adoption probe scope is unauthorized');
      if (!Array.isArray(input.probes) || input.probes.length > 100 || input.probes.some(probe => probe?.ref?.sourceId !== source.id || typeof probe.revision !== 'string' || !probe.revision)) throw new PersistenceConflictError('Source adoption probes are invalid');
      const ids = new Set(input.probes.map(probe => probe.ref.externalId)); if (ids.size !== input.probes.length) throw new PersistenceConflictError('Source adoption probes are duplicated');
      const registration = registry.resolve(proposed, 'admission');
      const context = options.context(proposed, input.repo, input.signal, 'admission');
      if (source.storageLayout !== 'remote') {
        if (!context.local) throw new PersistenceConflictError('Local source adoption requires its public record service');
        const sample = await context.local.list({ repo: input.repo, cursor: null, limit: 100 });
        if (sample.records.some(record => !input.probes.some(probe => probe.ref.externalId === record.ref.externalId && probe.revision === record.revision))) throw new PersistenceConflictError('Source adoption omits required host-selected probes');
        for (const probe of input.probes) { const record = await context.local.get(probe.ref.externalId); if (!record || record.revision !== probe.revision) throw new PersistenceConflictError('Source adoption probe revision changed'); }
      }
      const proposal: SourceAdoptionProposalV1 = { sourceId: source.id, expectedSourceRevision: source.revision, previousBinding: previous.binding, proposedBinding: proposed.binding, expectedAuthority: source.identityEvidence.authority, identityFormat: source.identityEvidence.authority.identityFormat, storageSchema: source.storageLayout === 'remote' ? null : 'helmsman.local-task/v1', probes: input.probes };
      input.signal.throwIfAborted(); const evidence = parseSourceAdoptionEvidenceV1(await registration.provider.validateAdoption(proposal, context)); input.signal.throwIfAborted();
      if (!evidence.compatible || evidence.authority.level !== 'verified' || stableJson(evidence.authority.authority) !== stableJson(proposal.expectedAuthority) || evidence.identityFormat !== proposal.identityFormat || proposal.storageSchema && !evidence.readableSchemas.includes(proposal.storageSchema)) throw new PersistenceConflictError('Source provider adoption is incompatible');
      if (source.storageLayout !== 'remote') {
        const proof = evidence.authority.proof && typeof evidence.authority.proof === 'object' && !Array.isArray(evidence.authority.proof) ? evidence.authority.proof as Record<string, unknown> : null;
        if (evidence.authority.authority?.authorityId !== source.collectionId || proof?.collectionId !== source.collectionId || proof.evidenceId !== persistenceHash({ sourceId: source.id, collectionId: source.collectionId }) || proof.revision !== source.collectionRevision) throw new PersistenceConflictError('Local source adoption identity proof does not match host collection evidence');
      }
      if (evidence.probeResults.length !== input.probes.length || evidence.probeResults.some(probe => !probe.matches || probe.ref.sourceId !== source.id || !ids.has(probe.ref.externalId)) || new Set(evidence.probeResults.map(probe => probe.ref.externalId)).size !== ids.size) throw new PersistenceConflictError('Source adoption probe evidence is incomplete');
      return store.persistence.transaction(() => {
        const current = readTaskSource(store, source.id); const currentInstance = store.instance(proposed.id);
        if (current.revision !== source.revision || current.collectionRevision !== source.collectionRevision || !currentInstance || stableJson(currentInstance) !== stableJson(proposed) || stableJson(store.instance(previous.id)) !== stableJson(previous) || registry.resolve(proposed, 'admission') !== registration) throw new PersistenceConflictError('Source adoption changed during validation');
        const validation: SourceAdoptionValidation = { id: randomUUID(), sourceRevision: source.revision, collectionRevision: source.collectionRevision, instance: proposed, previousInstance: previous, proposal, evidence, evidenceHash: persistenceHash(evidence), actor: input.actor, reason: input.reason };
        store.persistence.sql.prepare('INSERT INTO source_adoption_validations VALUES (?,?)').run(validation.id, stableJson(validation)); return validation;
      });
    },
    adopt(validationId: string): TaskSourceRecord {
      return store.persistence.transaction(() => {
        const prior = store.persistence.sql.prepare('SELECT json FROM source_adoptions WHERE id=?').get(validationId) as { json: string } | undefined;
        if (prior) return JSON.parse(prior.json) as TaskSourceRecord;
        const row = store.persistence.sql.prepare('SELECT json FROM source_adoption_validations WHERE id=?').get(validationId) as { json: string } | undefined;
        if (!row) throw new PersistenceConflictError('Registered source adoption validation is required');
        const validation = JSON.parse(row.json) as SourceAdoptionValidation; const source = readTaskSource(store, validation.proposal.sourceId); const instance = store.instance(validation.instance.id);
        if (persistenceHash(validation.evidence) !== validation.evidenceHash || source.revision !== validation.sourceRevision || source.collectionRevision !== validation.collectionRevision || !instance || stableJson(instance) !== stableJson(validation.instance) || !validation.previousInstance || stableJson(store.instance(validation.previousInstance.id)) !== stableJson(validation.previousInstance)) throw new PersistenceConflictError('Source adoption validation is stale');
        registry.resolve(instance, 'admission');
        if (instance.desiredEnabled !== validation.previousInstance.desiredEnabled) store.configureInstance({ instanceId: instance.id,
          expectedRevision: instance.revision, desiredEnabled: validation.previousInstance.desiredEnabled });
        const next = { ...source, currentInstanceId: instance.id, revision: source.revision + 1 }; writeTaskSource(store, next);
        store.persistence.sql.prepare('INSERT INTO source_adoptions VALUES (?,?)').run(validationId, stableJson(next)); return next;
      });
    },
  };
}
