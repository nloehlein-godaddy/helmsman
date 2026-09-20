import { openPersistence } from '../persistence';
import { openTaskSourceStore, writeTaskSource } from './store';
import type { SourceBindingV1, TaskSourceProviderV1 } from '../../../src/plugins/tasks';
export const binding: SourceBindingV1 = { providerId: 'example.tasks/local', pluginId: 'example.tasks', artifactHash: 'a'.repeat(64), contractVersion: 1, connectionId: null, credentialHandle: null };
export function fixture(layout: 'documents' | 'legacy-todos' = 'documents') {
  const persistence = openPersistence(':memory:'); const store = openTaskSourceStore(persistence);
  const input = { provisioningKey: 'local', label: 'Local', identityEvidence: { version: 1 as const, level: 'verified' as const, authority: { protocol: 'helmsman.local-collection/v1', authorityId: '00000000-0000-4000-8000-000000000002', identityFormat: 'helmsman.local-task/v1' }, verifiedAt: '2026-09-20T00:00:00.000Z', proof: null }, storageLayout: layout, collectionId: '00000000-0000-4000-8000-000000000002', binding, settings: {}, allowedRepos: ['owner/project'] };
  const provisioned = store.provision(input); persistence.transaction(() => writeTaskSource(store, { ...provisioned.source, conversionReady: true }));
  return { persistence, store, input, source: store.source(provisioned.source.id)!, instance: provisioned.instance };
}
export const provider: TaskSourceProviderV1 = { async identify() { throw new Error('unused'); }, async list() { return { items: [], nextCursor: null }; }, async lookup() { return null; }, async load() { return null; }, async planClaim() { return { kind: 'none', reason: 'test' }; }, async planCompletion() { return { kind: 'none', reason: 'test' }; }, async planAbort() { return { kind: 'none', reason: 'test' }; }, async validateAdoption() { throw new Error('unused'); }, effects: {} };
