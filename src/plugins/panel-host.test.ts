import { afterEach, describe, expect, it, vi } from 'vitest';
import * as apiClient from '../data/api-client';
import { PluginPanelHost, type PanelHostOptions } from './panel-host';
import type { PluginPanelContext, PluginPanelInstance, PluginPanelState } from './composition';
import type { PluginPageServices, PluginPageState } from './sdk';

const state = (overrides: Partial<PluginPageState> = {}): PluginPageState => ({
  repo: 'org/first', themeId: 'default', pirateMode: true, visible: true, pane: null, ...overrides,
});
const hosts: PluginPanelHost[] = [];
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const services = {} as PluginPageServices;
function setup(instance: PluginPanelInstance = { update() {}, dispose() {} }, options: Partial<PanelHostOptions> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  let context!: PluginPanelContext;
  const cleanup = vi.fn();
  const host = new PluginPanelHost(container, { mount(_container, supplied) {
    context = supplied; context.onDispose(cleanup); return instance;
  } }, state(), null, { instanceId: 'first', services: () => services,
    navigate: vi.fn(), saveState: async () => {}, errorMessage: () => 'Panel failed', ...options });
  hosts.push(host);
  return { host, container, context, cleanup };
}
afterEach(() => { hosts.splice(0).forEach(host => host.dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('panel lifecycle', () => {
  it('selects presentation with effective scope and suspends stale callbacks without remounting', async () => {
    const selectPresentation = vi.fn(); const update = vi.fn();
    const { host, context } = setup({ update, dispose() {} }, { selectPresentation }); await settle();
    const locator = { version: 1 as const, kind: 'run' as const, repo: 'org/first', runId: 'run-1' };
    const activity = context.activity;
    host.update(state({ presentation: locator })); await settle();
    host.update(state({ presentation: { ...locator } })); await settle();
    expect(update).toHaveBeenCalledTimes(1); expect(context.activity).toBe(activity);
    context.selectPresentation?.(locator); expect(selectPresentation).toHaveBeenLastCalledWith(locator, 'org/first');
    host.update(state({ repo: 'org/override' }));
    expect(() => context.selectPresentation?.(locator)).toThrow('outside');
    const overridden = { ...locator, repo: 'org/override' };
    context.selectPresentation?.(overridden); expect(selectPresentation).toHaveBeenLastCalledWith(overridden, 'org/override');
    host.update(state({ repo: 'org/override', visible: false }));
    expect(() => context.selectPresentation?.(overridden)).toThrow('inactive');
    host.dispose(); expect(() => context.selectPresentation?.(null)).toThrow('inactive');
  });

  it('invalidates scope immediately and delivers a new scope while an old update is hung', async () => {
    const states: PluginPanelState[] = [];
    const { host, context } = setup({ update(value) {
      states.push(value);
      if (value.repo === 'org/second') return new Promise<void>(() => {});
    }, dispose() {} });
    await settle();
    const original = context.activity;
    host.update(state({ repo: 'org/second' }));
    const second = context.activity;
    host.update(state({ repo: 'org/third' }));
    expect(original.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(context.activity.repo).toBe('org/third');
    expect(states.map(value => value.repo)).toEqual(['org/second', 'org/third']);
    expect(context.signal.aborted).toBe(false);
  });

  it('suspends hidden instances without losing their lifetime or drafts', async () => {
    const dispose = vi.fn();
    const refresh = vi.fn();
    const { host, context } = setup({ update() {}, dispose, refresh });
    await settle();
    const before = context.activity;
    host.update(state({ visible: false }));
    expect(before.signal.aborted).toBe(true);
    expect(context.activity.active).toBe(false);
    expect(context.activity.signal.aborted).toBe(true);
    await host.refresh();
    expect(refresh).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    host.update(state());
    expect(context.activity.signal.aborted).toBe(false);
    await host.refresh();
    expect(refresh).toHaveBeenCalledOnce();
    host.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(context.signal.aborted).toBe(true);
  });

  it('contains only current failures and releases cleanup exactly once', async () => {
    let reject!: (error: Error) => void;
    const dispose = vi.fn();
    const { host, container, cleanup } = setup({ update(value) {
      if (value.repo === 'org/second') return new Promise<void>((_resolve, fail) => { reject = fail; });
      if (value.repo === 'org/failure') throw new Error('failed');
    }, dispose });
    await settle();
    host.update(state({ repo: 'org/second' }));
    host.update(state({ repo: 'org/third' }));
    reject(new Error('obsolete'));
    await settle();
    expect(cleanup).not.toHaveBeenCalled();
    host.update(state({ repo: 'org/failure' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Panel failed');
    host.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('releases a hung refresh when scope changes and permits fresh refresh', async () => {
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>(() => {})).mockResolvedValue(undefined);
    const { host } = setup({ update() {}, dispose() {}, refresh });
    await settle();
    const pending = host.refresh();
    await settle();
    host.update(state({ repo: 'org/second' }));
    await pending;
    await host.refresh();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

it('provides immutable mounted contribution identity independently of instance or header state', async () => {
  const { host, context } = setup(undefined, { contributionId: 'example.pr/panel' }); await settle();
  expect(context.contributionId).toBe('example.pr/panel'); expect(Object.isFrozen(context)).toBe(true);
  host.update(state({ repo: 'org/second', visible: false })); await settle();
  expect(context.contributionId).toBe('example.pr/panel');
});

it('replays changed stale panel reads from cache while explicit refresh forces the network', async () => {
  let now = 0; let version = 1;
  const transport = vi.fn(async () => Response.json({ version }));
  const client = apiClient.createApiClient({ fetch: transport, now: () => now });
  vi.spyOn(apiClient, 'createApiReadScope').mockImplementation(client.createReadScope);
  let fetcher!: typeof fetch; const values: number[] = [];
  const refresh = vi.fn(async () => {
    const response = await fetcher('/api/run-read?repo=org%2Ffirst&kind=all&limit=10');
    values.push((await response.json()).version);
  });
  const { host, context } = setup({ update() {}, dispose() {}, refresh }, { services: (_lifetime, _activity, supplied) => { fetcher = supplied!; return services; } });
  await host.refresh(); await host.refresh(false);
  expect(values).toEqual([1, 1]); expect(transport).toHaveBeenCalledTimes(1);
  now = 6000; version = 2;
  await host.refresh(false);
  await vi.waitFor(() => expect(values.at(-1)).toBe(2));
  expect(transport).toHaveBeenCalledTimes(2);
  version = 3; await context.refresh?.();
  expect(values.at(-1)).toBe(3); expect(transport).toHaveBeenCalledTimes(3);
});

it('does not replay cache changes after the panel becomes inactive', async () => {
  let changed!: () => void;
  const fetcher = vi.fn<typeof fetch>();
  vi.spyOn(apiClient, 'createApiReadScope').mockImplementation((_signal, update) => { changed = update; return { fetch: fetcher, fresh: operation => operation() }; });
  const refresh = vi.fn(); const { host } = setup({ update() {}, dispose() {}, refresh }); await settle();
  host.update(state({ visible: false })); changed(); await settle(); expect(refresh).not.toHaveBeenCalled();
  host.dispose(); changed(); await settle(); expect(refresh).not.toHaveBeenCalled();
});

it('replays one cache update after an in-progress panel refresh settles', async () => {
  let changed!: () => void; let complete!: () => void;
  vi.spyOn(apiClient, 'createApiReadScope').mockImplementation((_signal, update) => { changed = update; return { fetch: vi.fn<typeof fetch>(), fresh: operation => operation() }; });
  const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; })).mockResolvedValue(undefined);
  const { host } = setup({ update() {}, dispose() {}, refresh });
  const pending = host.refresh(false); await settle();
  changed(); changed(); expect(refresh).toHaveBeenCalledTimes(1);
  complete(); await pending;
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
});

it('follows an in-progress background read with one fresh read for an explicit refresh', async () => {
  const fresh = vi.fn();
  vi.spyOn(apiClient, 'createApiReadScope').mockReturnValue({ fetch: vi.fn<typeof fetch>(), fresh: async operation => { fresh(); return operation(); } });
  let complete!: () => void;
  const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; })).mockResolvedValue(undefined);
  const { host, context } = setup({ update() {}, dispose() {}, refresh });
  const background = host.refresh(false); await settle();
  const first = context.refresh?.(); const second = context.refresh?.(); complete();
  await Promise.all([background, first, second]);
  expect(refresh).toHaveBeenCalledTimes(2); expect(fresh).toHaveBeenCalledOnce();
});
