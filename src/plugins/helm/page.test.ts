import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompositionLayoutV1, CompositionServiceV1, PluginPageModule, PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, PluginPageServices, TaskReadTaskV1 } from '@helmsman/plugin-sdk';
import helm from './page';
import workspace from '../helm-alternative/page';
import backlog from '../backlog/panel';
import taskTable from '../backlog-alternative/panel';

const sourceId = '11111111-1111-4111-8111-111111111111';
const repo = 'owner/project';
const state = { repo, themeId: 'dark', pirateMode: false, visible: true, pane: null };
async function fixture(page: PluginPageModule = helm, panel: PluginPanelModule = backlog) {
  const container = document.createElement('div'); document.body.append(container);
  const lifetime = new AbortController();
  let layout: CompositionLayoutV1 = { version: 1, compositionId: 'helmsman/helm-page', revision: 1, instances: [{ instanceId: 'first', contributionId: 'example.test/panel', hidden: false, scope: { kind: 'inherit' }, state: { 'example.missing/panel': { version: 2, value: { draft: 'kept' } } } }], columns: [[{ instances: ['first'], activeInstanceId: 'first', collapsed: false }]] };
  const listeners = new Set<() => void>();
  const childInstances: PluginPanelInstance[] = [];
  const source = { version: 1 as const, sourceId, instanceId: 'source-one', instanceRevision: 1, repo, label: 'Local tasks', availability: 'available' as const };
  const task: TaskReadTaskV1 = { version: 1, ref: { sourceId, externalId: 'TODO-1' }, repo, revision: 'r1', displayKey: 'TODO-1', title: 'Read public services', state: 'ready', priority: null, url: null, requirements: { description: '', acceptanceCriteria: [], links: [] } };
  const tasks: NonNullable<PluginPageServices['tasks']> = { version: 1,
    discover: vi.fn<NonNullable<PluginPageServices['tasks']>['discover']>(async () => ({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source] } }] } })),
    list: vi.fn<NonNullable<PluginPageServices['tasks']>['list']>(async () => ({ status: 'available', value: { selection: source, items: [task], nextCursor: null } })), load: vi.fn() };
  const services: PluginPageServices = { version: 1, runCommands: { version: 1, pending: vi.fn(async () => []), submit: vi.fn(), receipt: vi.fn(), acknowledge: vi.fn() }, tasks, usage: { query: vi.fn() }, outcomes: { summary: vi.fn(), assessment: vi.fn() }, pricing: { estimate: vi.fn() } };
  const updates = vi.fn(async (next: CompositionLayoutV1, expected: number) => {
    if (expected !== layout.revision) throw new Error('Conflict');
    layout = { ...next, revision: expected + 1 }; for (const listener of listeners) listener(); return layout;
  });
  const mounts = vi.fn(async (instanceId: string, target: HTMLElement) => {
    expect(container.contains(target)).toBe(true);
    target.dataset.testPanel = instanceId;
    const controller = new AbortController();
    const instance = layout.instances.find(value => value.instanceId === instanceId)!;
    let childState: PluginPanelState = { ...state, instanceId, activity: { repo, epoch: 1, active: true, signal: controller.signal }, savedState: instance.state[instance.contributionId] ?? null };
    const context: PluginPanelContext = { state: childState, activity: childState.activity, signal: controller.signal, services, navigate: vi.fn(), onDispose: vi.fn(), saveState: vi.fn(async () => {}) };
    const child = await panel.mount(target, context); childInstances.push(child);
    return { instanceId, setActive(active: boolean) { if (childState.activity.active !== active) { childState = { ...childState, activity: { ...childState.activity, active } }; void child.update(childState); } }, async refresh() { await child.refresh?.(); }, dispose() { controller.abort(); void child.dispose(); } };
  });
  const composition: CompositionServiceV1 = { version: 1, compositionId: layout.compositionId, discover: () => [{ id: 'panel', contributionId: 'example.test/panel', pluginId: 'example.test', title: 'Tasks', contract: { id: 'helmsman/helm-panel', version: 1 }, requires: [] }],
    readLayout: vi.fn(async () => layout), updateLayout: updates, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, mount: mounts };
  const instance = await page.mount(container, { state, composition, signal: lifetime.signal, onDispose: vi.fn(), navigate: vi.fn(), services });
  return { container, instance, lifetime, tasks, composition, mounts, updates, listeners, childInstances, get layout() { return layout; } };
}
afterEach(() => { document.body.replaceChildren(); });

describe.each([['shipped Helm', helm], ['independent Helm', workspace]] as const)('%s public composition', (_name, page) => {
  it.each([['shipped backlog', backlog], ['independent backlog', taskTable]] as const)('mounts %s using only host composition and task reads', async (_label, panel) => {
    const f = await fixture(page, panel);
    await vi.waitFor(() => expect(f.container.textContent).toContain('Read public services'));
    expect(f.mounts).toHaveBeenCalledTimes(1); expect(f.tasks.discover).toHaveBeenCalled();
    await f.instance.update({ ...state, themeId: 'light' });
    expect(f.mounts).toHaveBeenCalledTimes(1);
    f.lifetime.abort(); expect(f.listeners.size).toBe(0);
  });
  it('reveals a deep-linked instance once while preserving subsequent explicit hiding', async () => {
    const f = await fixture(page); await vi.waitFor(() => expect(f.mounts).toHaveBeenCalledTimes(1));
    await f.composition.updateLayout({ ...f.layout, instances: f.layout.instances.map(value => ({ ...value, hidden: true })), columns: f.layout.columns.map(column => column.map(stack => ({ ...stack, collapsed: true }))) }, f.layout.revision);
    await vi.waitFor(() => expect(f.container.textContent).toContain('Show'));
    await f.instance.update({ ...state, panelInstance: 'first' });
    await vi.waitFor(() => expect(f.layout.instances[0]?.hidden).toBe(false));
    expect(f.layout.columns[0]?.[0]?.collapsed).toBe(false);
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-helm-focus') ?? document.activeElement?.getAttribute('data-workspace-instance')).toBe(page === helm ? 'first:tab' : 'first'));
    await f.composition.updateLayout({ ...f.layout, instances: f.layout.instances.map(value => ({ ...value, hidden: true })) }, f.layout.revision);
    await f.instance.update({ ...state, panelInstance: 'first' });
    expect(f.layout.instances[0]?.hidden).toBe(true);
    const saves = f.updates.mock.calls.length;
    await f.instance.update({ ...state, panelInstance: 'missing-instance' });
    expect(f.updates).toHaveBeenCalledTimes(saves); expect(f.layout.instances).toHaveLength(1); f.lifetime.abort();
  });
  it('ignores a stale layout read after a newer revision added another instance', async () => {
    const f = await fixture(page); await vi.waitFor(() => expect(f.mounts).toHaveBeenCalledTimes(1));
    const old = f.layout;
    await f.composition.updateLayout({ ...old, instances: [...old.instances, { ...old.instances[0]!, instanceId: 'second' }], columns: [[...old.columns[0]!, { instances: ['second'], activeInstanceId: 'second', collapsed: false }]] }, old.revision);
    await vi.waitFor(() => expect(f.mounts).toHaveBeenCalledTimes(2));
    vi.mocked(f.composition.readLayout).mockResolvedValueOnce(old);
    await f.instance.refresh?.();
    expect(f.container.querySelector('[data-test-panel="second"]')).not.toBeNull(); f.lifetime.abort();
  });
});

describe('shipped Helm composition controls', () => {
  it('gives duplicate instances distinguishable groups and action names while preserving the targeted state', async () => {
    const f = await fixture(); await vi.waitFor(() => expect(f.mounts).toHaveBeenCalledTimes(1));
    await f.composition.updateLayout({ ...f.layout, instances: [...f.layout.instances, { ...f.layout.instances[0]!, instanceId: 'second' }], columns: [[{ instances: ['first', 'second'], activeInstanceId: 'first', collapsed: false }]] }, f.layout.revision);
    await vi.waitFor(() => expect(f.container.querySelectorAll('.helm-config-row[role="group"]')).toHaveLength(2));
    const groups = [...f.container.querySelectorAll('.helm-config-row[role="group"]')];
    expect(groups.map(row => row.getAttribute('aria-label'))).toEqual(['Tasks · first', 'Tasks · second']);
    for (const row of groups) {
      expect(row.getAttribute('role')).toBe('group');
      for (const control of row.querySelectorAll('button, input, select')) expect(control.getAttribute('aria-label')).toContain(row.getAttribute('aria-label'));
    }
    const removals = [...f.container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Remove · "]')];
    expect(removals.map(control => control.getAttribute('aria-label'))).toEqual(['Remove · Tasks · first', 'Remove · Tasks · second']);
    removals[1]!.click(); await vi.waitFor(() => expect(f.layout.instances.map(value => value.instanceId)).toEqual(['first']));
    expect(f.layout.instances[0]?.state['example.missing/panel']).toEqual({ version: 2, value: { draft: 'kept' } }); f.lifetime.abort();
  });
  it('duplicates, hides and stacks without overwriting other implementation state', async () => {
    const f = await fixture(); await vi.waitFor(() => expect(f.container.textContent).toContain('Read public services'));
    const click = (label: string) => { const value = Array.from(f.container.querySelectorAll('button')).find(button => button.textContent === label); if (!value) throw new Error(`Missing ${label}`); value.click(); };
    click('Duplicate'); await vi.waitFor(() => expect(f.layout.instances).toHaveLength(2));
    expect(f.layout.instances[0]?.state).toEqual({ 'example.missing/panel': { version: 2, value: { draft: 'kept' } } });
    await vi.waitFor(() => expect(f.mounts).toHaveBeenCalledTimes(2));
    click('Hide'); await vi.waitFor(() => expect(f.layout.instances[0]?.hidden).toBe(true));
    expect(f.container.querySelector<HTMLElement>('[data-panel-instance="first"]')?.hidden).toBe(true);
    const select = f.container.querySelector<HTMLSelectElement>('[aria-label^="Stack with panel · "]')!; select.value = f.layout.instances[1]!.instanceId;
    click('Stack'); await vi.waitFor(() => expect(f.layout.columns[0]?.[0]?.instances).toHaveLength(2));
    expect(f.layout.instances[0]?.state['example.missing/panel']).toEqual({ version: 2, value: { draft: 'kept' } });
    f.lifetime.abort();
  });
  it('reports compare-and-swap conflict without discarding saved layout', async () => {
    const f = await fixture(); await vi.waitFor(() => expect(f.container.textContent).toContain('Read public services'));
    f.updates.mockRejectedValueOnce(new Error('Conflict'));
    Array.from(f.container.querySelectorAll('button')).find(button => button.textContent === 'Remove')?.click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Review the current layout and retry'));
    expect(f.layout.instances).toHaveLength(1); expect(f.layout.instances[0]?.state).toHaveProperty('example.missing/panel'); f.lifetime.abort();
  });
  it('disposes late panel mounts after page disposal', async () => {
    const f = await fixture(); await vi.waitFor(() => expect(f.mounts).toHaveBeenCalledTimes(1));
    const dispose = vi.fn(); let finish!: (value: Awaited<ReturnType<CompositionServiceV1['mount']>>) => void;
    f.mounts.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    Array.from(f.container.querySelectorAll('button')).find(button => button.textContent === 'Duplicate')?.click();
    await vi.waitFor(() => expect(f.mounts).toHaveBeenCalledTimes(2)); f.lifetime.abort();
    finish({ instanceId: 'late', setActive: vi.fn(), refresh: vi.fn(), dispose });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });
  it('retains unsaved scope text and focus through a presentation refresh', async () => {
    const f = await fixture(); await vi.waitFor(() => expect(f.mounts).toHaveBeenCalledTimes(1));
    const scope = f.container.querySelector<HTMLSelectElement>('[aria-label^="Scope for Tasks · "]')!;
    scope.value = 'galleon'; scope.dispatchEvent(new Event('change'));
    const repo = f.container.querySelector<HTMLInputElement>('[aria-label^="Panel repository · "]')!;
    repo.value = 'owner/draft-project'; repo.dispatchEvent(new Event('input')); repo.focus();
    await f.instance.update({ ...state, themeId: 'light' });
    const updated = f.container.querySelector<HTMLInputElement>('[aria-label^="Panel repository · "]')!;
    expect(updated.value).toBe('owner/draft-project'); expect(updated.hidden).toBe(false); expect(document.activeElement).toBe(updated);
    expect(f.layout.instances[0]?.scope).toEqual({ kind: 'inherit' }); f.lifetime.abort();
  });
  it('navigates a stack with arrow keys and keeps the selected tab focused', async () => {
    const f = await fixture(); await vi.waitFor(() => expect(f.mounts).toHaveBeenCalledTimes(1));
    await f.composition.updateLayout({ ...f.layout, instances: [...f.layout.instances, { ...f.layout.instances[0]!, instanceId: 'second' }], columns: [[{ instances: ['first', 'second'], activeInstanceId: 'first', collapsed: false }]] }, f.layout.revision);
    await vi.waitFor(() => expect(f.container.querySelectorAll('[role="tab"]')).toHaveLength(2));
    const first = f.container.querySelector<HTMLButtonElement>('[role="tab"]')!; first.focus(); first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await vi.waitFor(() => expect(f.layout.columns[0]?.[0]?.activeInstanceId).toBe('second'));
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-helm-focus')).toBe('second:tab')); f.lifetime.abort();
  });
});

describe.each([['shipped Helm', helm], ['independent Helm', workspace]] as const)('%s migrated panel locators', (_name, page) => {
  it.each(['legacy-pane', null])('reveals the first matching contribution when instance %s is absent', async panelInstance => {
    const f = await fixture(page);
    await vi.waitFor(() => expect(f.mounts).toHaveBeenCalledTimes(1));
    await f.composition.updateLayout({ ...f.layout, instances: [
      { ...f.layout.instances[0]!, hidden: true },
      { ...f.layout.instances[0]!, instanceId: 'duplicate', hidden: true },
    ], columns: [[{ instances: ['first', 'duplicate'], activeInstanceId: 'duplicate', collapsed: true }]] }, f.layout.revision);
    await f.instance.update({ ...state, panelInstance, panelContribution: 'example.test/panel' });
    await vi.waitFor(() => expect(f.layout.instances[0]?.hidden).toBe(false));
    expect(f.layout.instances[1]?.hidden).toBe(true);
    expect(f.layout.columns[0]?.[0]).toMatchObject({ activeInstanceId: 'first', collapsed: false });
    expect(f.layout.instances[0]?.state).toHaveProperty('example.missing/panel');
    f.lifetime.abort();
  });
  it('prefers an exact instance and reacts to a changed contribution with the same missing locator', async () => {
    const f = await fixture(page); await vi.waitFor(() => expect(f.mounts).toHaveBeenCalledTimes(1));
    await f.composition.updateLayout({ ...f.layout, instances: [
      { ...f.layout.instances[0]!, hidden: true },
      { ...f.layout.instances[0]!, instanceId: 'second', contributionId: 'example.second/panel', hidden: true },
    ], columns: [[{ instances: ['first', 'second'], activeInstanceId: 'first', collapsed: false }]] }, f.layout.revision);
    await f.instance.update({ ...state, panelInstance: 'second', panelContribution: 'example.test/panel' });
    await vi.waitFor(() => expect(f.layout.instances[1]?.hidden).toBe(false));
    expect(f.layout.instances[0]?.hidden).toBe(true);
    await f.instance.update({ ...state, panelInstance: 'missing', panelContribution: 'example.second/panel' });
    await f.instance.update({ ...state, panelInstance: 'missing', panelContribution: 'example.test/panel' });
    await vi.waitFor(() => expect(f.layout.instances[0]?.hidden).toBe(false));
    expect(f.layout.columns[0]?.[0]?.activeInstanceId).toBe('first'); f.lifetime.abort();
  });
  it('reports a missing panel without inserting it into saved layout', async () => {
    const f = await fixture(page); await vi.waitFor(() => expect(f.mounts).toHaveBeenCalledTimes(1));
    const before = structuredClone(f.layout);
    await f.instance.update({ ...state, panelInstance: 'newrun', panelContribution: 'helmsman.newrun/panel' });
    expect(f.container.querySelector('[role="status"]')?.textContent).toContain('Your saved layout is kept');
    expect(f.layout).toEqual(before); expect(f.updates).not.toHaveBeenCalled(); f.lifetime.abort();
  });
});

describe('Helm movement controls', () => {
  it('preserves panel state and control focus while moving between columns', async () => {
    const f = await fixture(); await vi.waitFor(() => expect(f.mounts).toHaveBeenCalledTimes(1));
    const stateBefore = structuredClone(f.layout.instances[0]?.state);
    const move = f.container.querySelector<HTMLButtonElement>('[data-helm-focus="first:move-right"]')!;
    move.focus(); move.click();
    await vi.waitFor(() => expect(f.layout.columns[1]?.[0]?.instances).toEqual(['first']));
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-helm-focus')).toBe('first:move-right'));
    expect(f.layout.instances[0]?.state).toEqual(stateBefore);
    expect(f.mounts).toHaveBeenCalledTimes(1);
    await f.instance.refresh?.();
    expect(f.layout.columns[1]?.[0]?.instances).toEqual(['first']); f.lifetime.abort();
  });
});
