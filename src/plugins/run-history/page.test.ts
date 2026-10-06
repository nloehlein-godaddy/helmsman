import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompositionLayoutV1, CompositionServiceV1, PluginPageState } from '@helmsman/plugin-sdk';
import page from './page';

const state: PluginPageState = { repo: 'owner/project', themeId: 'dark', pirateMode: false, visible: true, pane: null };
const lifetimes: AbortController[] = [];
afterEach(() => { lifetimes.splice(0).forEach(value => value.abort()); document.body.replaceChildren(); });
async function fixture(empty = false, options: { state?: PluginPageState; hidden?: boolean; collapsed?: boolean } = {}) {
  const container = document.createElement('div'); document.body.append(container); const lifetime = new AbortController(); lifetimes.push(lifetime);
  let layout: CompositionLayoutV1 = { version: 1, compositionId: 'helmsman/run-history-page', revision: 1,
    instances: empty ? [] : [{ instanceId: 'run-history', contributionId: 'helmsman.run-history/panel', hidden: options.hidden ?? false, scope: { kind: 'inherit' }, state: {} }],
    columns: empty ? [] : [[{ instances: ['run-history'], activeInstanceId: 'run-history', collapsed: options.collapsed ?? false }]] };
  const listeners = new Set<() => void>(); const active = vi.fn(); const dispose = vi.fn(); const refresh = vi.fn(async () => {});
  const mount = vi.fn<CompositionServiceV1['mount']>(async (instanceId, node) => { expect(container.contains(node)).toBe(true); node.textContent = 'Mounted run panel'; return { instanceId, setActive: active, dispose, refresh }; });
  const updateLayout = vi.fn<CompositionServiceV1['updateLayout']>(async (next, expected) => { if (expected !== layout.revision) throw new Error('Conflict'); layout = { ...next, revision: expected + 1 }; listeners.forEach(listener => listener()); return layout; });
  const composition: CompositionServiceV1 = { version: 1, compositionId: layout.compositionId, readLayout: vi.fn(async () => layout), updateLayout, mount,
    discover: () => [{ id: 'panel', title: 'Run history', pluginId: 'helmsman.run-history', contributionId: 'helmsman.run-history/panel', contract: { id: 'helmsman/run-history-panel', version: 1 }, requires: [] }], subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const instance = await page.mount(container, { state: options.state ?? state, signal: lifetime.signal, composition, onDispose: vi.fn(), navigate: vi.fn() });
  return { container, instance, composition, mount, active, dispose, refresh, lifetime, listeners, get layout() { return layout; } };
}
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find(value => value.getAttribute('aria-label') === label || value.textContent === label)!;
describe('Run history composition page', () => {
  it('mounts through the public composition service and retains the instance through refresh/theme changes', async () => {
    const f = await fixture(); await vi.waitFor(() => expect(f.mount).toHaveBeenCalledOnce());
    await f.instance.update({ ...state, themeId: 'light' }); await f.instance.refresh?.();
    expect(f.mount).toHaveBeenCalledOnce(); expect(f.refresh).toHaveBeenCalledOnce();
    await f.instance.update({ ...state, visible: false }); expect(f.active).toHaveBeenLastCalledWith(false);
    f.lifetime.abort(); expect(f.dispose).toHaveBeenCalledOnce(); expect(f.listeners.size).toBe(0);
  });
  it('preserves deliberately empty layouts until a user adds an implementation', async () => {
    const f = await fixture(true); await vi.waitFor(() => expect(f.container.textContent).toContain('No visible panels. Choose Edit page'));
    expect(f.composition.updateLayout).not.toHaveBeenCalled(); expect(f.mount).not.toHaveBeenCalled();
    button(f.container, 'Edit page').click(); button(f.container, 'Add panel').click(); await vi.waitFor(() => expect(f.mount).toHaveBeenCalledOnce());
    expect(f.layout.instances[0]).toMatchObject({ contributionId: 'helmsman.run-history/panel', state: {}, scope: { kind: 'inherit' } });
  });
  it('reveals and focuses a hidden collapsed route target while retaining its instance', async () => {
    const f = await fixture(false, { hidden: true, collapsed: true, state: { ...state, pane: 'new', panelContribution: 'helmsman.run-history/panel', panelRouteState: { 'helmsman.run-history/panel': { version: 1, value: { pane: 'new' } } } } });
    await vi.waitFor(() => expect(f.layout.instances[0]?.hidden).toBe(false)); expect(f.layout.columns[0]?.[0]).toMatchObject({ activeInstanceId: 'run-history', collapsed: false });
    await vi.waitFor(() => expect(f.active).toHaveBeenLastCalledWith(true)); expect(document.activeElement?.getAttribute('data-panel-instance')).toBe('run-history'); expect(f.layout.instances).toHaveLength(1);
    expect(f.composition.updateLayout).toHaveBeenCalledOnce(); await f.instance.refresh?.(); expect(f.composition.updateLayout).toHaveBeenCalledOnce();
  });
  it('preserves the panel-specific focus when page route reveal redraws its wrapper', async () => {
    const f = await fixture(); await vi.waitFor(() => expect(f.mount).toHaveBeenCalledOnce()); const content = f.container.querySelector<HTMLElement>('[data-panel-instance="run-history"]')!; const search = document.createElement('input'); content.replaceChildren(search); search.focus();
    await f.instance.update({ ...state, panelContribution: 'helmsman.run-history/panel', panelRouteState: { 'helmsman.run-history/panel': { version: 1, value: { pane: 'list' } } } }); expect(document.activeElement).toBe(search);
  });
  it('retries failed route reveal only when the operator refreshes', async () => {
    const f = await fixture(false, { hidden: true, collapsed: true }); await vi.waitFor(() => expect(f.mount).toHaveBeenCalledOnce()); const update = vi.mocked(f.composition.updateLayout); update.mockRejectedValueOnce(new Error('Temporarily unavailable'));
    await f.instance.update({ ...state, panelContribution: 'helmsman.run-history/panel' }); await vi.waitFor(() => expect(f.container.textContent).toContain('could not be revealed')); expect(f.layout.instances[0]?.hidden).toBe(true); expect(update).toHaveBeenCalledOnce();
    await f.instance.refresh?.(); expect(update).toHaveBeenCalledOnce(); button(f.container, 'Refresh page').click(); await vi.waitFor(() => expect(f.layout.instances[0]?.hidden).toBe(false)); expect(update).toHaveBeenCalledTimes(2); expect(f.layout.columns[0]?.[0]?.collapsed).toBe(false);
  });
  it('honors exact missing instances without falling back to a matching contribution', async () => {
    const f = await fixture(false, { hidden: true, state: { ...state, panelInstance: 'missing', panelContribution: 'helmsman.run-history/panel' } });
    await vi.waitFor(() => expect(f.container.textContent).toContain('requested panel (missing)')); expect(f.layout.instances[0]?.hidden).toBe(true); expect(f.composition.updateLayout).not.toHaveBeenCalled(); expect(f.layout.instances).toHaveLength(1);
  });
  it('reports absent route targets in deliberately empty layouts without injecting defaults', async () => {
    const f = await fixture(true, { state: { ...state, panelContribution: 'helmsman.run-history/panel' } });
    await vi.waitFor(() => expect(f.container.textContent).toContain('requested panel (helmsman.run-history/panel)')); expect(f.composition.updateLayout).not.toHaveBeenCalled(); expect(f.mount).not.toHaveBeenCalled();
  });
  it('lets explicit user hiding win over refresh until another route visit', async () => {
    const routed = { ...state, pane: 'list', panelContribution: 'helmsman.run-history/panel', panelRouteState: { 'helmsman.run-history/panel': { version: 1, value: { pane: 'list' } } } };
    const f = await fixture(false, { state: routed }); await vi.waitFor(() => expect(f.mount).toHaveBeenCalledOnce()); button(f.container, 'Edit page').click(); button(f.container, 'Hide Run history').click(); await vi.waitFor(() => expect(f.layout.instances[0]?.hidden).toBe(true));
    await f.instance.refresh?.(); expect(f.layout.instances[0]?.hidden).toBe(true); await f.instance.update(state); await f.instance.update(routed); await vi.waitFor(() => expect(f.layout.instances[0]?.hidden).toBe(false));
  });
  it('hides and explicitly restores a panel without deleting its saved drafts', async () => {
    const f = await fixture(); await vi.waitFor(() => expect(f.mount).toHaveBeenCalledOnce());
    button(f.container, 'Edit page').click(); button(f.container, 'Hide Run history').click(); await vi.waitFor(() => expect(f.layout.instances[0]?.hidden).toBe(true));
    await vi.waitFor(() => expect(f.active).toHaveBeenLastCalledWith(false)); expect(f.dispose).not.toHaveBeenCalled();
    button(f.container, 'Show Run history').click(); await vi.waitFor(() => expect(f.layout.instances[0]?.hidden).toBe(false));
    await vi.waitFor(() => expect(f.active).toHaveBeenLastCalledWith(true)); expect(f.mount).toHaveBeenCalledOnce();
  });
});
