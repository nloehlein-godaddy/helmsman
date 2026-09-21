import { describe, expect, it, vi } from 'vitest';
import { PluginPanelRegistry } from './panels';

const contract = { id: 'helmsman/helm-panel', version: 1 as const };
const manifest = { manifestVersion: 2, id: 'example.backlog', version: '1.0.0', sdkVersion: 1, pages: [],
  panels: [{ id: 'panel', title: 'Backlog', contract, requires: [] }] };

describe('panel contributions', () => {
  it('discovers compatible panels and removes only the matching registration', () => {
    const registry = new PluginPanelRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const remove = registry.register(manifest);
    expect(registry.discover([contract]).map(panel => panel.contributionId)).toEqual(['example.backlog/panel']);
    expect(registry.discover([{ id: 'other/panel', version: 1 }])).toEqual([]);
    expect(() => registry.register(manifest)).toThrow(/already/);
    remove();
    registry.register(manifest);
    remove();
    expect(registry.get('example.backlog/panel')).not.toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('captures immutable module methods and rejects accessors without invoking them', () => {
    const registry = new PluginPanelRegistry();
    const module = { mount: vi.fn(() => ({ update() {}, dispose() {} })) };
    const original = module.mount;
    const remove = registry.registerModule('example.backlog/panel', module);
    module.mount = vi.fn();
    registry.getModule('example.backlog/panel')?.mount(document.createElement('div'), {} as never);
    expect(original).toHaveBeenCalledOnce();
    expect(module.mount).not.toHaveBeenCalled();
    remove();
    expect(registry.getModule('example.backlog/panel')).toBeNull();
    const getter = vi.fn();
    expect(() => registry.registerModule('example.backlog/panel', Object.defineProperty({}, 'mount', { get: getter }) as never)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
