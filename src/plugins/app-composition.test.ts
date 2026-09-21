import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AppCompositionFactory, initialCompositionLayout } from './app-composition';
import { appPages, HELM_PAGE_SLOT, helmManifest } from './builtins';
import { openCompositionLayoutStore, type CompositionLayoutStore } from './composition-layout';

const stores: CompositionLayoutStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('Helm default composition', () => {
  it('retries denied task preference initialization on remount and preserves initialized state after storage becomes inaccessible', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const unregister = appPages.register({ manifestVersion: 2, id: 'example.task-migration', version: '1.0.0', sdkVersion: 1, panels: [], pages: [{
      id: 'page', title: 'Triage', slots: [], panes: [], composition: { id: 'helmsman/triage-page', version: 1, accepts: [{ id: 'helmsman/triage-panel', version: 1 }], initialLayout: {
        instances: [{ instanceId: 'triage', contributionId: 'helmsman.triage/panel' }],
        columns: [[{ instances: ['triage'], activeInstanceId: 'triage', collapsed: false }]],
      } },
    }] });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(key => {
      if (key.startsWith('helmsman.triage')) throw new DOMException('Preferences denied', 'SecurityError');
      return null;
    });
    const factory = new AppCompositionFactory();
    const create = () => factory.create('example.task-migration/page', document.createElement('div'),
      { repo: 'org/project', themeId: 'default', pirateMode: false, visible: true, pane: null }, vi.fn())!;
    let host = create();
    try {
      await expect(host.service.readLayout()).rejects.toThrow('Preferences denied'); host.dispose();
      getItem.mockImplementation(key => key === 'helmsman.triageFilters' ? '{"priorities":[],"days":7}' : null);
      host = create(); const layout = await host.service.readLayout();
      expect(layout.instances[0]?.state['helmsman.triage/panel']?.value).toMatchObject({ priorities: [], days: 7 });
      host.dispose(); factory.dispose();
      getItem.mockImplementation(() => { throw new DOMException('Preferences denied', 'SecurityError'); });
      const reopened = new AppCompositionFactory();
      const restored = reopened.create('example.task-migration/page', document.createElement('div'),
        { repo: null, themeId: 'default', pirateMode: false, visible: true, pane: null }, vi.fn())!;
      try { expect(await restored.service.readLayout()).toEqual(layout); } finally { restored.dispose(); reopened.dispose(); }
    } finally { host.dispose(); factory.dispose(); getItem.mockRestore(); unregister(); vi.unstubAllGlobals(); }
  });
  it('seeds an authored composition once and preserves intentional removal when defaults change', async () => {
    const compositionId = 'example.tasks/page';
    const definition = { id: compositionId, version: 1 as const, accepts: [], initialLayout: {
      instances: [{ instanceId: 'editor', contributionId: 'example.tasks/editor' }],
      columns: [[{ instances: ['editor'], activeInstanceId: 'editor', collapsed: false }]],
    } };
    const indexedDB = new IDBFactory();
    const first = await openCompositionLayoutStore({ indexedDB, compositionId, initialLayout: initialCompositionLayout(definition) });
    stores.push(first);
    const seeded = await first.read();
    expect(seeded.instances[0]).toEqual({ instanceId: 'editor', contributionId: 'example.tasks/editor', hidden: false,
      scope: { kind: 'inherit' }, state: {} });
    const removed = await first.update({ ...seeded, instances: [], columns: [] }, seeded.revision);
    first.close();
    const second = await openCompositionLayoutStore({ indexedDB, compositionId, initialLayout: initialCompositionLayout(definition) });
    stores.push(second);
    expect(await second.read()).toEqual(removed);
  });
  it('does not populate unrelated composition contracts with Helm panels', async () => {
    const compositionId = 'example.workspace/page';
    const store = await openCompositionLayoutStore({ indexedDB: new IDBFactory(), compositionId,
      initialLayout: initialCompositionLayout({ id: compositionId, version: 1, accepts: [] }) });
    stores.push(store);
    expect(await store.read()).toMatchObject({ compositionId, instances: [], columns: [] });
  });

  it('starts a fresh installation with all eight extracted panels in the original two columns', async () => {
    const store = await openCompositionLayoutStore({ indexedDB: new IDBFactory(), compositionId: HELM_PAGE_SLOT,
      initialLayout: initialCompositionLayout(helmManifest.pages[0]!.composition!) });
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
    const options = { indexedDB, compositionId: HELM_PAGE_SLOT, initialLayout: initialCompositionLayout(helmManifest.pages[0]!.composition!),
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
