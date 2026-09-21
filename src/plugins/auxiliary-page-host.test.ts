import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuxiliaryPageHost } from './auxiliary-page-host';
import { PluginPageRegistry } from './registry';
import { PluginPageModules } from './modules';
import type { PluginPageContext, PluginPageState } from './sdk';

const slot = 'example/auxiliary';
const state = (overrides: Partial<PluginPageState> = {}): PluginPageState => ({ repo: 'org/a', visible: true, themeId: 'default', pirateMode: true, pane: null, ...overrides });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const hosts: AuxiliaryPageHost[] = [];
function setup() {
  const registry = new PluginPageRegistry([{ id: slot, alias: '/auxiliary', defaultContributionId: 'example.viewer/page' }]);
  const modules = new PluginPageModules(); const contexts: PluginPageContext[] = [];
  const update = vi.fn(); const dispose = vi.fn();
  const mount = vi.fn((_element: HTMLElement, context: PluginPageContext) => { contexts.push(context); return { update, dispose }; });
  registry.register({ manifestVersion: 1, id: 'example.viewer', version: '1.0.0', sdkVersion: 1, pages: [{ id: 'page', title: 'Viewer', slots: [slot], panes: [] }] });
  const removeModule = modules.register('example.viewer/page', { mount });
  const options = { slotId: slot, registry, modules, navigate: vi.fn(), selectPresentation: vi.fn(),
    loadingMessage: () => 'Loading', errorMessage: () => 'Failed', unavailableMessage: () => 'Selected viewer unavailable' };
  const host = new AuxiliaryPageHost(state(), options); hosts.push(host);
  const first = document.createElement('section'); const second = document.createElement('section'); document.body.append(first, second);
  return { host, registry, modules, contexts, update, dispose, mount, options, first, second, removeModule };
}
afterEach(() => { hosts.splice(0).forEach(host => host.dispose()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe('auxiliary page lifecycle', () => {
  it('contains a failing page without retrying on unrelated DOM mutations', async () => {
    const f = setup(); f.host.rehome(f.first); await settle(); f.removeModule();
    const broken = vi.fn(() => { throw new Error('Failed mount'); });
    f.modules.register('example.viewer/page', { mount: broken }); await settle();
    expect(broken).toHaveBeenCalledOnce(); expect(f.host.element.textContent).toBe('Failed');
    document.body.append(document.createElement('p')); await settle();
    expect(broken).toHaveBeenCalledOnce(); expect(f.host.element.textContent).toBe('Failed');
  });

  it('retains one mounted session when rehomed and revokes activity on detachment', async () => {
    const f = setup(); await settle();
    expect(f.mount).not.toHaveBeenCalled();
    f.host.rehome(f.first); await settle();
    const element = f.host.element.querySelector('[data-plugin-page]');
    expect(f.contexts[0]?.state.visible).toBe(true);
    const input = document.createElement('textarea'); input.value = 'preserved draft'; element?.append(input); input.focus(); input.setSelectionRange(2, 7, 'backward');
    f.host.rehome(f.second); await settle();
    expect(document.activeElement).toBe(input); expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 7, 'backward']);
    expect(f.host.element.querySelector('[data-plugin-page]')).toBe(element); expect(f.mount).toHaveBeenCalledOnce();
    f.second.remove(); await settle();
    expect(f.update).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    expect(() => f.contexts[0]?.selectPresentation?.(null)).toThrow('inactive');
    document.body.append(f.second); await settle();
    expect(f.update).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    f.host.update(state({ visible: false })); await settle();
    expect(() => f.contexts[0]?.selectPresentation?.(null)).toThrow('inactive');
  });
  it('parks before shell replacement without cancelling active reads or losing focus', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: unknown, options?: RequestInit) => {
      signal = options?.signal ?? undefined; return new Promise<Response>(() => {});
    }));
    const f = setup(); f.host.rehome(f.first); await settle();
    const pending = f.contexts[0]?.services?.runs?.load({ version: 1, repo: 'org/a', runId: 'run-1' });
    const cancelled = expect(pending).rejects.toThrow();
    expect(signal?.aborted).toBe(false);
    const field = document.createElement('textarea'); field.value = 'retained'; f.host.element.append(field); field.focus(); field.setSelectionRange(1, 5);
    f.host.park(); f.first.replaceChildren();
    f.host.update(state({ pane: 'details' })); f.host.rehome(f.second); await settle();
    expect(signal?.aborted).toBe(false); expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([1, 5]); expect(f.mount).toHaveBeenCalledOnce();
    f.host.park(); f.second.replaceChildren(); await settle();
    expect(signal?.aborted).toBe(true); await cancelled;
    expect(f.dispose).not.toHaveBeenCalled();
  });

  it('honors explicit canonical contributions independently of the selected slot and never falls back', async () => {
    const f = setup(); const canonical = vi.fn((_element: HTMLElement, _context: PluginPageContext) => ({ update: vi.fn(), dispose: vi.fn() }));
    const remove = f.registry.register({ manifestVersion: 1, id: 'example.canonical', version: '1.0.0', sdkVersion: 1,
      pages: [{ id: 'page', title: 'Canonical', slots: [slot], panes: ['logs'] }] });
    f.modules.register('example.canonical/page', { mount: canonical });
    f.host.update(state({ pane: 'logs', panelInstance: 'viewer', presentation: { version: 1, kind: 'run', repo: 'org/b', runId: 'run-1' } }),
      { contributionId: 'example.canonical/page', scopeRepo: 'org/b' });
    f.host.rehome(f.first); await settle();
    expect(canonical).toHaveBeenCalledOnce(); expect(f.mount).not.toHaveBeenCalled();
    expect(canonical.mock.calls[0]?.[1]).toMatchObject({ state: { repo: 'org/b', pane: 'logs', panelInstance: 'viewer' } });
    f.registry.restoreSelection(slot, 'example.missing/page'); await settle(); expect(canonical).toHaveBeenCalledOnce();
    remove(); await settle(); expect(f.host.element.textContent).toBe('Selected viewer unavailable'); expect(f.mount).not.toHaveBeenCalled();
    f.registry.select(slot, null);
    f.host.update(state(), { contributionId: null, scopeRepo: 'org/a' }); await settle();
    expect(f.mount).toHaveBeenCalledOnce();
  });
  it('captures an explicit panel scope without changing the header and resets it when the header changes', async () => {
    const f = setup(); f.host.rehome(f.first); await settle();
    const locator = { version: 1 as const, kind: 'run' as const, repo: 'org/b', runId: 'run-1' };
    f.host.select(locator, 'org/b'); await settle();
    expect(f.update).toHaveBeenLastCalledWith(expect.objectContaining({ repo: 'org/b', presentation: locator }));
    f.host.update(state({ pirateMode: false })); await settle();
    expect(f.update).toHaveBeenLastCalledWith(expect.objectContaining({ repo: 'org/b', presentation: locator, pirateMode: false }));
    f.contexts[0]?.selectPresentation?.(locator);
    expect(f.options.selectPresentation).toHaveBeenLastCalledWith(locator, 'org/b');
    f.host.update(state({ repo: 'org/c' })); await settle();
    expect(f.update).toHaveBeenLastCalledWith(expect.objectContaining({ repo: 'org/c', presentation: null }));
    expect(() => f.host.select(locator, 'org/c')).toThrow('outside');
  });
  it('shows a missing selected replacement without falling back and revokes removed modules', async () => {
    const f = setup(); f.host.rehome(f.first); await settle();
    f.registry.restoreSelection(slot, 'example.missing/page'); await settle();
    expect(f.host.element.textContent).toBe('Selected viewer unavailable'); expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.contexts[0]?.signal.aborted).toBe(true);
    f.registry.select(slot, null); await settle(); expect(f.mount).toHaveBeenCalledTimes(2);
    f.removeModule(); await settle(); expect(f.host.element.textContent).toBe('Selected viewer unavailable');
    expect(f.contexts[1]?.signal.aborted).toBe(true);
  });
});
