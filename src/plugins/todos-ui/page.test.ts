import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompositionLayoutV1, CompositionServiceV1, PluginPageState } from '@helmsman/plugin-sdk';
import page from './page';

const state: PluginPageState = { repo: 'owner/project', themeId: 'dark', pirateMode: false, visible: true, pane: null };
const lifetimes: AbortController[] = [];
afterEach(() => { lifetimes.splice(0).forEach(value => value.abort()); document.body.replaceChildren(); });
async function fixture(empty = false) {
  const container = document.createElement('div'); document.body.append(container); const lifetime = new AbortController(); lifetimes.push(lifetime);
  let layout: CompositionLayoutV1 = { version: 1, compositionId: 'helmsman/todos-page', revision: 1,
    instances: empty ? [] : [{ instanceId: 'todos', contributionId: 'helmsman.todos-ui/panel', hidden: false, scope: { kind: 'inherit' }, state: {} }],
    columns: empty ? [] : [[{ instances: ['todos'], activeInstanceId: 'todos', collapsed: false }]] };
  const listeners = new Set<() => void>(); const active = vi.fn(); const dispose = vi.fn(); const refresh = vi.fn(async () => {});
  const mount = vi.fn<CompositionServiceV1['mount']>(async (instanceId, node) => { expect(container.contains(node)).toBe(true); node.textContent = 'Mounted editor'; return { instanceId, setActive: active, dispose, refresh }; });
  const updateLayout = vi.fn<CompositionServiceV1['updateLayout']>(async (next, expected) => { if (expected !== layout.revision) throw new Error('Conflict'); layout = { ...next, revision: expected + 1 }; listeners.forEach(listener => listener()); return layout; });
  const composition: CompositionServiceV1 = { version: 1, compositionId: layout.compositionId, readLayout: vi.fn(async () => layout), updateLayout, mount,
    discover: () => [{ id: 'panel', title: 'Todo editor', pluginId: 'helmsman.todos-ui', contributionId: 'helmsman.todos-ui/panel', contract: { id: 'helmsman/todos-panel', version: 1 }, requires: [] }], subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const instance = await page.mount(container, { state, signal: lifetime.signal, composition, onDispose: vi.fn(), navigate: vi.fn() });
  return { container, instance, composition, mount, active, dispose, refresh, lifetime, listeners, get layout() { return layout; } };
}
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find(value => value.textContent === label)!;
describe('Todos composition page', () => {
  it('mounts through the public composition service and retains the instance through refresh/theme changes', async () => {
    const f = await fixture(); await vi.waitFor(() => expect(f.mount).toHaveBeenCalledOnce());
    await f.instance.update({ ...state, themeId: 'light' }); await f.instance.refresh?.();
    expect(f.mount).toHaveBeenCalledOnce(); expect(f.refresh).toHaveBeenCalledOnce();
    await f.instance.update({ ...state, visible: false }); expect(f.active).toHaveBeenLastCalledWith(false);
    f.lifetime.abort(); expect(f.dispose).toHaveBeenCalledOnce(); expect(f.listeners.size).toBe(0);
  });
  it('preserves deliberately empty layouts until a user adds an implementation', async () => {
    const f = await fixture(true); await vi.waitFor(() => expect(f.container.textContent).toContain('Add a panel to view'));
    expect(f.composition.updateLayout).not.toHaveBeenCalled(); expect(f.mount).not.toHaveBeenCalled();
    button(f.container, 'Add panel').click(); await vi.waitFor(() => expect(f.mount).toHaveBeenCalledOnce());
    expect(f.layout.instances[0]).toMatchObject({ contributionId: 'helmsman.todos-ui/panel', state: {}, scope: { kind: 'inherit' } });
  });
  it('hides and explicitly restores a panel without deleting its saved drafts', async () => {
    const f = await fixture(); await vi.waitFor(() => expect(f.mount).toHaveBeenCalledOnce());
    button(f.container, 'Hide Todo editor').click(); await vi.waitFor(() => expect(f.layout.instances[0]?.hidden).toBe(true));
    await vi.waitFor(() => expect(f.active).toHaveBeenLastCalledWith(false)); expect(f.dispose).not.toHaveBeenCalled();
    button(f.container, 'Open Todo editor').click(); await vi.waitFor(() => expect(f.layout.instances[0]?.hidden).toBe(false));
    await vi.waitFor(() => expect(f.active).toHaveBeenLastCalledWith(true)); expect(f.mount).toHaveBeenCalledOnce();
  });
});
