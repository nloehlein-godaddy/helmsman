// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import type { CompositionLayoutV1, PanelLayoutInstanceV1 } from './composition';
import { CompositionLayoutConflictError, CompositionLayoutValidationError, migrateLegacyCompositionLayout,
  openCompositionLayoutStore, parseCompositionLayout, type CompositionLayoutStore, type CompositionLayoutStoreOptions } from './composition-layout';

function instance(instanceId: string, contributionId = 'example.backlog/panel'): PanelLayoutInstanceV1 {
  return { instanceId, contributionId, hidden: false, scope: { kind: 'inherit' }, state: {} };
}
function layout(): CompositionLayoutV1 {
  return { version: 1, compositionId: 'helmsman/helm', revision: 0, instances: [instance('one')],
    columns: [[{ instances: ['one'], activeInstanceId: 'one', collapsed: false }]] };
}
const stores: CompositionLayoutStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function channels() {
  const endpoints = new Set<{ listeners: Set<(event: MessageEvent) => void> }>();
  const factory: NonNullable<CompositionLayoutStoreOptions['channelFactory']> = () => {
    const endpoint = { listeners: new Set<(event: MessageEvent) => void>() }; endpoints.add(endpoint);
    return {
      postMessage(data) { for (const target of endpoints) if (target !== endpoint) for (const listener of target.listeners) listener({ data } as MessageEvent); },
      addEventListener(_type, listener) { endpoint.listeners.add(listener); },
      removeEventListener(_type, listener) { endpoint.listeners.delete(listener); },
      close() { endpoints.delete(endpoint); },
    };
  };
  return { factory, endpoints };
}
function fixture() {
  const indexedDB = new IDBFactory(); const bus = channels(); const databaseName = 'layouts';
  async function open(input: Partial<CompositionLayoutStoreOptions> = {}) {
    const store = await openCompositionLayoutStore({ indexedDB, databaseName, compositionId: 'helmsman/helm', initialLayout: layout(), channelFactory: bus.factory, ...input });
    stores.push(store); return store;
  }
  async function inspect(table: string) {
    return new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result; const transaction = database.transaction(table, 'readonly');
        const read = transaction.objectStore(table).get('helmsman/helm');
        transaction.oncomplete = () => { database.close(); resolve(read.result); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    });
  }
  return { indexedDB, bus, open, inspect };
}

describe('composition layout validation and raw migration', () => {
  it('preserves several maximum-sized Unicode editor drafts while bounding UTF-8 instance and total layout storage', async () => {
    const draft = { description: '界'.repeat(20_000), acceptance: '界'.repeat(20_000) };
    const state = { 'example.tasks/panel': { version: 1, value: { drafts: Array.from({ length: 4 }, () => draft) } } };
    const f = fixture(); const store = await f.open(); const current = await store.read();
    const saved = await store.update({ ...current, instances: [{ ...current.instances[0]!, state }] }, current.revision);
    store.close();
    expect(await (await f.open()).read()).toEqual(saved);
    const oversized = { owner: { version: 1, value: '界'.repeat(350_000) } };
    expect(() => parseCompositionLayout({ ...layout(), instances: [{ ...instance('one'), state: oversized }] })).toThrow(/large/);
    const instances = Array.from({ length: 10 }, (_, i) => ({ ...instance(`draft-${i}`), state }));
    const aggregate = { ...layout(), instances, columns: [instances.map(item => ({ instances: [item.instanceId], activeInstanceId: item.instanceId, collapsed: false }))] };
    expect(() => parseCompositionLayout(aggregate)).toThrow(/large/);
  });
  it('preserves unknown contributions, duplicate panel instances, explicit scope and versioned opaque state', () => {
    const value = { ...layout(), instances: [instance('one'), { ...instance('two'), hidden: true, scope: { kind: 'galleon', repo: 'owner/repo' },
      state: { 'example.backlog/panel': { version: 7, value: { draft: 'Keep me', cursor: null } } } }],
    columns: [[{ instances: ['one', 'two'], activeInstanceId: 'two', collapsed: true }]] };
    expect(parseCompositionLayout(value)).toEqual(value);
  });
  it.each([
    { ...layout(), instances: [instance('one'), instance('one')] },
    { ...layout(), columns: [[{ instances: ['one', 'one'], activeInstanceId: 'one', collapsed: false }]] },
    { ...layout(), columns: [] },
    { ...layout(), columns: [[{ instances: ['missing'], activeInstanceId: 'missing', collapsed: false }]] },
    { ...layout(), instances: [{ ...instance('one'), scope: { kind: 'galleon', repo: '../repo' } }] },
    { ...layout(), instances: [{ ...instance('one'), state: { owner: { version: 0, value: null } } }] },
    { ...layout(), instances: [{ ...instance('one'), state: { owner: { version: 1, value: 'x'.repeat(1024 * 1024) } } }] },
  ])('rejects invalid layout identity, placement, scope, or unbounded state', value => {
    expect(() => parseCompositionLayout(value)).toThrow(CompositionLayoutValidationError);
  });
  it('rejects getters without invoking plugin code and bounds cyclic JSON', () => {
    const getter = vi.fn(); const value = { ...layout(), get extra() { return getter(); } };
    expect(() => parseCompositionLayout(value)).toThrow(CompositionLayoutValidationError); expect(getter).not.toHaveBeenCalled();
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(() => parseCompositionLayout({ ...layout(), instances: [{ ...instance('one'), state: { owner: { version: 1, value: circular } } }] })).toThrow(CompositionLayoutValidationError);
  });
  it('migrates raw stacks without deduplicating unknown entries or reinserting removed defaults', () => {
    const migrated = migrateLegacyCompositionLayout(layout(), {
      rackRaw: JSON.stringify([[{ panels: ['backlog', 'retired panel', 'backlog'], active: 'retired panel', collapsed: true }], []]),
      scopesRaw: JSON.stringify({ backlog: { kind: 'galleon', repo: 'owner/repo' }, 'retired panel': null }),
      stateRaw: JSON.stringify({ backlog: { 'example.backlog/panel': { version: 4, value: { draft: 'saved' } } } }),
    });
    expect(migrated.revision).toBe(1);
    expect(migrated.instances.map(item => item.contributionId)).toEqual(['helmsman.backlog/panel', 'helmsman.unavailable/legacy-0-0-1', 'helmsman.backlog/panel']);
    expect(new Set(migrated.instances.map(item => item.instanceId)).size).toBe(3);
    expect(migrated.columns).toEqual([[{ instances: ['legacy-0-0-0', 'legacy-0-0-1', 'legacy-0-0-2'], activeInstanceId: 'legacy-0-0-1', collapsed: true }], []]);
    expect(migrated.instances[0]?.scope).toEqual({ kind: 'galleon', repo: 'owner/repo' });
    expect(migrated.instances[1]?.scope).toEqual({ kind: 'all' });
    expect(migrated.instances[2]?.state).toEqual({ 'example.backlog/panel': { version: 4, value: { draft: 'saved' } } });
  });
  it('retains explicitly empty layouts and maps the old myprs alias', () => {
    expect(migrateLegacyCompositionLayout(layout(), { rackRaw: '[]' })).toMatchObject({ instances: [], columns: [] });
    const migrated = migrateLegacyCompositionLayout(layout(), { rackRaw: '[[{"panels":["myprs"],"active":"myprs"}]]' });
    expect(migrated.instances[0]?.contributionId).toBe('helmsman.repoprs/panel');
    expect(migrateLegacyCompositionLayout(layout(), { rackRaw: null })).toEqual({ ...layout(), revision: 1 });
  });
  it('fails visibly on malformed raw data instead of replacing it with default layout', () => {
    expect(() => migrateLegacyCompositionLayout(layout(), { rackRaw: '{broken' })).toThrow(CompositionLayoutValidationError);
    expect(() => migrateLegacyCompositionLayout(layout(), { rackRaw: '[[null]]' })).toThrow(CompositionLayoutValidationError);
  });
});

describe('durable composition layouts', () => {
  it('uses an IndexedDB transaction to reject one of two concurrent stale writes', async () => {
    const f = fixture(); const [first, second] = await Promise.all([f.open(), f.open()]);
    const [left, right] = await Promise.all([first.read(), second.read()]);
    const results = await Promise.allSettled([
      first.update({ ...left, instances: left.instances.map(item => ({ ...item, hidden: true })) }, left.revision),
      second.update({ ...right, columns: right.columns.map(column => column.map(stack => ({ ...stack, collapsed: true }))) }, right.revision),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(CompositionLayoutConflictError);
    expect(await first.read()).toEqual(await second.read());
    expect((await first.read()).revision).toBe(2);
  });
  it('publishes local and cross-window notifications only after committed writes', async () => {
    const f = fixture(); const first = await f.open(); const second = await f.open();
    const local = vi.fn(); const remote = vi.fn(); first.subscribe(local); const stop = second.subscribe(remote);
    const current = await first.read(); const updated = await first.update(current, current.revision);
    expect(local).toHaveBeenCalledTimes(1); expect(remote).toHaveBeenCalledTimes(1);
    expect(await second.read()).toEqual(updated);
    await expect(second.update(current, current.revision)).rejects.toBeInstanceOf(CompositionLayoutConflictError);
    expect(remote).toHaveBeenCalledTimes(1);
    stop(); await first.update(updated, updated.revision); expect(remote).toHaveBeenCalledTimes(1);
    second.close(); expect(f.bus.endpoints.size).toBe(1);
  });
  it('preserves each unavailable instance state across close/reopen and does not merge new defaults', async () => {
    const f = fixture(); const first = await f.open(); const current = await first.read();
    const unavailable = { ...instance('missing', 'external.missing/panel'), hidden: true, scope: { kind: 'all' as const },
      state: { 'external.missing/panel': { version: 3, value: { draft: 'unsaved work' } } } };
    const saved = await first.update({ ...current, instances: [unavailable], columns: [[{ instances: ['missing'], activeInstanceId: 'missing', collapsed: true }]] }, current.revision);
    first.close(); const reopened = await f.open(); expect(await reopened.read()).toEqual(saved);
    const removed = await reopened.update({ ...saved, instances: [], columns: [] }, saved.revision);
    reopened.close(); expect(await (await f.open()).read()).toEqual(removed);
  });
  it('atomically archives original legacy strings once and leaves their unknown fields intact', async () => {
    const f = fixture();
    const legacy = { rackRaw: ' [ [ { "panels": ["unknown old panel"], "active": "unknown old panel", "custom": {"future":true} } ] ] ',
      scopesRaw: '{"unknown old panel":null}', stateRaw: '{"unknown old panel":{"owner":{"version":2,"value":"saved"}}}' };
    const first = await f.open({ legacy }); const saved = await first.read();
    expect(await f.inspect('migrations')).toEqual({ ...legacy, compositionId: 'helmsman/helm', version: 1 });
    first.close(); const second = await f.open({ legacy: { rackRaw: '[]' } });
    expect(await second.read()).toEqual(saved);
    expect(await f.inspect('migrations')).toEqual({ ...legacy, compositionId: 'helmsman/helm', version: 1 });
  });
  it('rolls back failed migration and permits a repaired raw layout to be migrated later', async () => {
    const f = fixture(); await expect(f.open({ legacy: { rackRaw: '[null]' } })).rejects.toBeInstanceOf(CompositionLayoutValidationError);
    expect(await f.inspect('layouts')).toBeUndefined(); expect(await f.inspect('migrations')).toBeUndefined();
    const repaired = await f.open({ legacy: { rackRaw: '[]' } }); expect((await repaired.read()).instances).toEqual([]);
  });
  it('rejects foreign compositions, stale embedded revisions and closed storage without changing persisted data', async () => {
    const f = fixture(); const store = await f.open(); const current = await store.read();
    await expect(store.update({ ...current, compositionId: 'other/composition' }, 1)).rejects.toBeInstanceOf(CompositionLayoutValidationError);
    await expect(store.update({ ...current, revision: 2 }, 1)).rejects.toBeInstanceOf(CompositionLayoutValidationError);
    expect(await store.read()).toEqual(current);
    store.close(); await expect(store.read()).rejects.toThrow('closed');
    expect(() => store.subscribe(() => {})).toThrow('closed');
  });
  it('retains transactional writes when notifications are unavailable', async () => {
    const f = fixture(); const store = await f.open({ channelFactory: () => { throw new Error('unavailable'); } });
    const current = await store.read(); const saved = await store.update(current, current.revision);
    expect(await store.read()).toEqual(saved);
  });
  it('aborts a disposed panel write after it is queued and before its transaction commits', async () => {
    const f = fixture(); const store = await f.open(); const current = await store.read();
    const notify = vi.fn(); store.subscribe(notify);
    const controller = new AbortController();
    const put = IDBObjectStore.prototype.put;
    const interception = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      if (this.name === 'layouts') controller.abort();
      return request;
    });
    try {
      await expect(store.update({ ...current, instances: [], columns: [] }, current.revision, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    } finally { interception.mockRestore(); }
    expect(await store.read()).toEqual(current); expect(notify).not.toHaveBeenCalled();
    await expect(store.update(current, current.revision, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect((await store.update(current, current.revision)).revision).toBe(2);
  });
});
