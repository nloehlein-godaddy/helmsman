import { expect, it, vi } from 'vitest';
import { createHostTaskEditService } from './task-edit-service';
import { LOCAL_TASK_EDITOR_V1, type TaskEditEnvelopeV1 } from './task-edit';

const selection = { version: 1 as const, sourceId: '00000000-0000-4000-8000-000000000111', instanceId: 'instance-one', instanceRevision: 1, repo: 'org/project' };
const envelope: TaskEditEnvelopeV1 = { version: 1, selection, sourceRevision: 1, editor: LOCAL_TASK_EDITOR_V1, target: null,
  value: { title: '', description: '', acceptanceCriteria: '', repo: selection.repo, priority: 'P2', state: 'todo' },
  commands: { create: { commandId: 'create', available: true, reason: null }, update: null, delete: null }, destinationRepos: [selection.repo], relatedRun: null };
function setup() {
  const lifetime = new AbortController(); const fetcher = vi.fn<typeof fetch>(); let scope = { repo: selection.repo, active: true, epoch: 1, signal: new AbortController().signal };
  const service = createHostTaskEditService(lifetime.signal, { scope: () => scope, fetch: fetcher });
  return { service, fetcher, lifetime, change() { scope = { ...scope, repo: 'org/other', epoch: 2 }; } };
}
it('discovers declared editor contracts without exposing provider configuration', async () => {
  const f = setup(); f.fetcher.mockResolvedValue(Response.json({ version: 1, repo: selection.repo,
    sources: [{ selection, label: 'Tasks', availability: 'available', editors: [{ ...LOCAL_TASK_EDITOR_V1, commands: { create: 'create', update: 'update', delete: 'delete' } }] }] }));
  expect(await f.service.discover()).toMatchObject({ status: 'available', value: { sources: [{ editors: [LOCAL_TASK_EDITOR_V1] }] } });
  expect(f.fetcher.mock.calls[0]?.[0]).toContain('/api/task-edit?repo=org%2Fproject');
});
it('validates public create/load identity and preserves explicit locked state', async () => {
  const f = setup(); f.fetcher.mockResolvedValueOnce(Response.json(envelope));
  expect(await f.service.create({ selection, editor: LOCAL_TASK_EDITOR_V1 })).toMatchObject({ status: 'available', value: envelope });
  const ref = { sourceId: selection.sourceId, externalId: 'TODO-1' };
  const document = { ...envelope, target: { ref, revision: '1' }, commands: { create: null, update: { commandId: 'update', available: false, reason: 'Active claim' }, delete: null } };
  f.fetcher.mockResolvedValueOnce(Response.json(document));
  expect(await f.service.load({ selection, editor: LOCAL_TASK_EDITOR_V1, ref })).toMatchObject({ status: 'available', value: document });
  f.fetcher.mockResolvedValueOnce(Response.json({ ...document, target: { ref: { ...ref, externalId: 'TODO-2' }, revision: '1' } }));
  expect(await f.service.load({ selection, editor: LOCAL_TASK_EDITOR_V1, ref })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
});
it('rejects foreign scope before fetching and late responses after scope changes', async () => {
  const f = setup();
  expect(await f.service.create({ selection: { ...selection, repo: 'org/other' }, editor: LOCAL_TASK_EDITOR_V1 })).toEqual({ status: 'unavailable', reason: 'forbidden' });
  expect(f.fetcher).not.toHaveBeenCalled();
  let release!: (response: Response) => void; f.fetcher.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const pending = f.service.create({ selection, editor: LOCAL_TASK_EDITOR_V1 }); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  f.change(); release(Response.json(envelope)); await rejected;
});
it('passes provider filters as immutable read input and exposes missing tasks independently', async () => {
  const f = setup(); f.fetcher.mockResolvedValueOnce(Response.json({ selection, items: [], nextCursor: null, total: 0 }));
  const query = { selection, editor: LOCAL_TASK_EDITOR_V1, filter: { state: 'todo', search: 'Needle' }, cursor: null, limit: 10 };
  expect(await f.service.list(query)).toMatchObject({ status: 'available', value: { items: [] } });
  expect(JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body))).toEqual(query);
  f.fetcher.mockResolvedValueOnce(Response.json(null));
  expect(await f.service.load({ selection, editor: LOCAL_TASK_EDITOR_V1, ref: { sourceId: selection.sourceId, externalId: 'TODO-1' } })).toEqual({ status: 'available', value: null });
});
it('rejects suspended and invalid requests through the declared Promise interface', async () => {
  const f = setup(); f.lifetime.abort();
  const discovery = f.service.discover(); expect(discovery).toBeInstanceOf(Promise); await expect(discovery).rejects.toMatchObject({ name: 'AbortError' });
  const invalid = f.service.create({ selection: { ...selection, instanceRevision: 0 }, editor: LOCAL_TASK_EDITOR_V1 });
  expect(invalid).toBeInstanceOf(Promise); await expect(invalid).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
});
