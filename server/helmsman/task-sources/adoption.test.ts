import { afterEach, describe, expect, it } from 'vitest';
import { alternativeSource } from '../../../src/plugins/local-tasks-alternative/source';
import { todosProvider } from '../../../src/plugins/todos/provider';
import { fixture, binding } from './fixtures.test-support';
import { createSourceAdoptionCoordinator } from './adoption';
import { openLocalSourceAdapter } from './local-records';
import { createTaskSourceRegistry } from './registry';
import type { Persistence } from '../persistence';
const opened: Persistence[] = [];
function setup() {
  const f = fixture(); opened.push(f.persistence); const local = openLocalSourceAdapter(f.store);
  const registry = createTaskSourceRegistry({ eligible: () => true }); const declaration = { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: ['create', 'update', 'delete'], access: ['local-records' as const] };
  registry.publish([registry.stage(binding, declaration, todosProvider)]);
  const replacement = { ...binding, pluginId: 'example.alternative', providerId: 'example.alternative/collection', artifactHash: 'b'.repeat(64) };
  registry.publish([registry.stage(replacement, declaration, alternativeSource)]);
  const candidate = f.store.provision({ ...f.input, provisioningKey: 'alternative', binding: replacement });
  const context = (instance: typeof f.instance, repo: string, signal: AbortSignal) => ({ instance, repo, signal, http: null, local: local.forContext(instance, repo, signal) });
  return { ...f, local, registry, candidate: candidate.instance, adoption: createSourceAdoptionCoordinator({ ...f, registry, context }) };
}
afterEach(() => { for (const item of opened.splice(0)) item.close(); });
describe('source adoption', () => {
  it('adopts independently implemented compatible local provider without changing existing claim bindings', async () => {
    const f = setup(); const original = f.store.reserveWork({ ref: { sourceId: f.source.id, externalId: 'TODO-1' }, admissionId: 'existing', runId: 'existing', instanceId: f.instance.id, expectedInstanceRevision: 1, expectedSourceRevision: 1 });
    const validation = await f.adoption.validate({ sourceId: f.source.id, instanceId: f.candidate.id, expectedSourceRevision: 1, actor: 'operator', reason: 'replace provider', repo: 'owner/project', signal: new AbortController().signal, probes: [] });
    expect(f.adoption.adopt(validation.id).currentInstanceId).toBe(f.candidate.id); expect(f.store.claim(original.id)?.instance.binding).toEqual(binding);
    expect(f.adoption.adopt(validation.id).revision).toBe(2);
  });
  it('rejects omitted probes, caller-invented receipts, and changes after registered validation', async () => {
    const f = setup(); const data = { version: 1, title: 'Task', description: 'Do it', acceptanceCriteria: '', priority: 'P2', state: 'todo' };
    const task = f.local.applyCommand({ requestId: 'create', commandId: 'create', commandInput: data, instance: f.instance, repo: 'owner/project', plan: { kind: 'create', repo: 'owner/project', schema: 'helmsman.local-task/v1', data } })!;
    const input = { sourceId: f.source.id, instanceId: f.candidate.id, expectedSourceRevision: 1, actor: 'operator', reason: 'replace provider', repo: 'owner/project', signal: new AbortController().signal, probes: [] };
    await expect(f.adoption.validate(input)).rejects.toThrow(/omits/); expect(() => f.adoption.adopt('invented')).toThrow(/Registered/);
    const validation = await f.adoption.validate({ ...input, probes: [{ ref: task.ref, revision: task.revision }] });
    f.store.configureInstance({ instanceId: f.candidate.id, expectedRevision: 1, desiredEnabled: false }); expect(() => f.adoption.adopt(validation.id)).toThrow(/stale/);
  });
});
