import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { initialCompositionLayout } from './app-composition';
import { HELM_PAGE_SLOT } from './builtins';
import { openCompositionLayoutStore, type CompositionLayoutStore } from './composition-layout';

const stores: CompositionLayoutStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('Helm default composition', () => {
  it('does not populate unrelated composition contracts with Helm panels', async () => {
    const compositionId = 'example.workspace/page';
    const store = await openCompositionLayoutStore({ indexedDB: new IDBFactory(), compositionId,
      initialLayout: initialCompositionLayout(compositionId) });
    stores.push(store);
    expect(await store.read()).toMatchObject({ compositionId, instances: [], columns: [] });
  });

  it('starts a fresh installation with all eight extracted panels in the original two columns', async () => {
    const store = await openCompositionLayoutStore({ indexedDB: new IDBFactory(), compositionId: HELM_PAGE_SLOT,
      initialLayout: initialCompositionLayout(HELM_PAGE_SLOT) });
    stores.push(store);
    const layout = await store.read();
    expect(layout.columns.map(column => column.flatMap(stack => stack.instances))).toEqual([
      ['underway', 'newrun', 'backlog', 'running', 'repoprs'], ['recent', 'activity', 'shipped'],
    ]);
    expect(layout.instances.map(instance => instance.contributionId)).toEqual([
      'helmsman.underway/panel', 'helmsman.newrun/panel', 'helmsman.backlog/panel', 'helmsman.running/panel',
      'helmsman.repoprs/panel', 'helmsman.recent/panel', 'helmsman.activity/panel', 'helmsman.shipped/panel',
    ]);
  });
  it('preserves migrated duplicates, unavailable entries, collapsed stacks and intentionally removed defaults on reopen', async () => {
    const indexedDB = new IDBFactory();
    const options = { indexedDB, compositionId: HELM_PAGE_SLOT, initialLayout: initialCompositionLayout(HELM_PAGE_SLOT),
      legacy: { rackRaw: JSON.stringify([[{ panels: ['backlog', 'retired', 'backlog'], active: 'retired', collapsed: true }], []]) } };
    const first = await openCompositionLayoutStore(options); stores.push(first);
    const migrated = await first.read(); first.close();
    const second = await openCompositionLayoutStore({ ...options, legacy: { rackRaw: null } }); stores.push(second);
    expect(await second.read()).toEqual(migrated);
    expect(migrated.instances).toHaveLength(3);
    expect(migrated.instances.map(instance => instance.instanceId)).toEqual(['legacy-0-0-0', 'legacy-0-0-1', 'legacy-0-0-2']);
    expect(migrated.columns[0]?.[0]).toMatchObject({ activeInstanceId: 'legacy-0-0-1', collapsed: true });
    expect(migrated.instances.some(instance => instance.contributionId === 'helmsman.newrun/panel')).toBe(false);
  });
});
