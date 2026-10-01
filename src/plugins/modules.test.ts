import { describe, expect, it, vi } from 'vitest';
import { PluginManifestError } from './manifest';
import { PluginPageModules } from './modules';
import type { PluginPageContext, PluginPageInstance, PluginPageModule } from './sdk';

const pageId = 'example.costs/summary';
const instance = (): PluginPageInstance => ({ update: vi.fn(), dispose: vi.fn() });
const module = (): PluginPageModule => ({ mount: vi.fn(() => instance()) });

describe('plugin page modules', () => {
  it('registers without executing code and exposes a stable frozen wrapper', () => {
    const catalog = new PluginPageModules();
    const input = module();
    catalog.register(pageId, input);
    const registered = catalog.get(pageId);
    expect(registered).not.toBe(input);
    expect(catalog.get(pageId)).toBe(registered);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(input.mount).not.toHaveBeenCalled();
    expect(catalog.get('missing.plugin/page')).toBeNull();
  });

  it('captures the original method while retaining its receiver and arguments', () => {
    const catalog = new PluginPageModules();
    const mounted = instance();
    class PageModule implements PluginPageModule {
      readonly result = mounted;
      mount() { return this.result; }
    }
    const input = new PageModule();
    const original = vi.spyOn(input, 'mount');
    catalog.register(pageId, input);
    input.mount = vi.fn(() => instance());
    const container = {} as HTMLElement;
    const context = {} as PluginPageContext;
    expect(catalog.get(pageId)?.mount(container, context)).toBe(mounted);
    expect(original).toHaveBeenCalledWith(container, context);
    expect(input.mount).not.toHaveBeenCalled();
    const prototypeModule = new PageModule();
    catalog.register('example.costs/other', prototypeModule);
    expect(catalog.get('example.costs/other')?.mount(container, context)).toBe(mounted);
  });

  it('rejects duplicates without changing the active module or notifying listeners', () => {
    const catalog = new PluginPageModules();
    catalog.register(pageId, module());
    const registered = catalog.get(pageId);
    const listener = vi.fn();
    catalog.subscribe(listener);
    expect(() => catalog.register(pageId, module())).toThrow(/already registered/);
    expect(catalog.get(pageId)).toBe(registered);
    expect(listener).not.toHaveBeenCalled();
  });

  it('gives each hot registration a new identity and ignores stale disposers', () => {
    const catalog = new PluginPageModules();
    const listener = vi.fn();
    catalog.subscribe(listener);
    const input = module();
    const dispose = catalog.register(pageId, input);
    const first = catalog.get(pageId);
    dispose();
    dispose();
    expect(catalog.get(pageId)).toBeNull();
    const disposeReplacement = catalog.register(pageId, input);
    const replacement = catalog.get(pageId);
    expect(replacement).not.toBe(first);
    dispose();
    expect(catalog.get(pageId)).toBe(replacement);
    disposeReplacement();
    expect(catalog.get(pageId)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it.each(['', 'summary', '../summary', 'Example.costs/page', 'example.costs/page/child'])('rejects invalid contribution ID %s', id => {
    const catalog = new PluginPageModules();
    expect(() => catalog.register(id, module())).toThrow(PluginManifestError);
    expect(catalog.get(id)).toBeNull();
  });

  it.each([null, undefined, {}, { mount: null }, { mount: true }, { mount: 'function' }])('rejects invalid module %j', input => {
    const catalog = new PluginPageModules();
    const listener = vi.fn();
    catalog.subscribe(listener);
    expect(() => catalog.register(pageId, input as unknown as PluginPageModule)).toThrow(PluginManifestError);
    expect(catalog.get(pageId)).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects mount accessors without executing them', () => {
    const catalog = new PluginPageModules();
    const getter = vi.fn(() => vi.fn(() => instance()));
    const input = Object.defineProperty({}, 'mount', { get: getter }) as PluginPageModule;
    expect(() => catalog.register(pageId, input)).toThrow(PluginManifestError);
    expect(getter).not.toHaveBeenCalled();
    expect(catalog.get(pageId)).toBeNull();
  });

  it('isolates listener failures and retains independent subscriptions', () => {
    const catalog = new PluginPageModules();
    catalog.subscribe(() => { throw new Error('broken listener'); });
    const listener = vi.fn();
    const disposeOne = catalog.subscribe(listener);
    const disposeTwo = catalog.subscribe(listener);
    const unregister = catalog.register(pageId, module());
    expect(listener).toHaveBeenCalledTimes(2);
    disposeOne();
    disposeOne();
    unregister();
    expect(listener).toHaveBeenCalledTimes(3);
    disposeTwo();
    catalog.register(pageId, module());
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid subscriptions', () => {
    expect(() => new PluginPageModules().subscribe(null as unknown as () => void)).toThrow(PluginManifestError);
  });
});

it('preserves optional attention with its receiver and accepts an explicitly undefined hook', async () => {
  const registry = new PluginPageModules(); const snapshot = { version: 1 as const, keys: ['question'] };
  const input = { mount: vi.fn(), snapshot, attention() { return this.snapshot; } };
  registry.register('example.questions/page', input); input.attention = () => ({ version: 1, keys: [] });
  expect(await registry.get('example.questions/page')?.attention?.({} as import('./sdk').PluginPageAttentionContext)).toBe(snapshot);
  registry.register('example.old/page', { mount: vi.fn(), attention: undefined }); expect(registry.get('example.old/page')?.attention).toBeUndefined();
});
