import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginCompositionHost } from './composition-host';
import { PluginPanelRegistry } from './panels';
import { CompositionLayoutConflictError } from './composition-layout';
import type { CompositionLayoutV1, PluginPanelContext, PluginPanelModule, PluginPanelState } from './composition';

const hosts: PluginCompositionHost[] = [];
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const contract = { id: 'helmsman/helm-panel', version: 1 as const };
const manifest = { manifestVersion: 2, id: 'example.backlog', version: '1.0.0', sdkVersion: 1,
  pages: [], panels: [{ id: 'panel', title: 'Backlog', contract, requires: [{ id: 'helmsman/task-read', version: 1 }] }] };
const page = { repo: 'org/header', themeId: 'default', pirateMode: true, visible: true, pane: null };

function setup(module: PluginPanelModule) {
  const registry = new PluginPanelRegistry();
  const unregister = registry.register(manifest);
  registry.registerModule('example.backlog/panel', module);
  let layout: CompositionLayoutV1 = { version: 1, compositionId: 'helmsman/helm-page', revision: 1,
    instances: ['first', 'second'].map((instanceId, index) => ({ instanceId,
      contributionId: 'example.backlog/panel', hidden: false, scope: index ? { kind: 'galleon', repo: 'org/override' } : { kind: 'inherit' }, state: {} })),
    columns: [[{ instances: ['first'], activeInstanceId: 'first', collapsed: false },
      { instances: ['second'], activeInstanceId: 'second', collapsed: false }]] };
  const owner = document.createElement('div');
  const first = document.createElement('section');
  const second = document.createElement('section');
  owner.append(first, second); document.body.append(owner);
  const read = vi.fn(async () => layout);
  const update = vi.fn(async (next: CompositionLayoutV1, expected: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (expected !== layout.revision) throw new CompositionLayoutConflictError('Conflict');
    layout = { ...next, revision: layout.revision + 1 }; return layout;
  });
  const host = new PluginCompositionHost(page, { definition: { id: 'helmsman/helm-page', version: 1, accepts: [contract] },
    registry, container: owner, navigate: vi.fn(), layout: {
      read, update, subscribe: () => () => {},
    } });
  hosts.push(host);
  return { host, first, second, registry, unregister, current: () => layout, read, update };
}

afterEach(() => { hosts.splice(0).forEach(host => host.dispose()); document.body.replaceChildren(); });

describe('page-owned composition', () => {
  it.each(['terminal', 'campaigns'] as const)('mounts a %s service consumer through the public composition boundary', async service => {
    let context: PluginPanelContext | undefined;
    const { host, first, registry, unregister } = setup({ mount(_element, value) {
      context = value; return { update() {}, dispose() {} };
    } });
    unregister();
    registry.register({ ...manifest, panels: [{ ...manifest.panels[0], requires: [{ id: `helmsman/${service}`, version: 1 }] }] });
    await host.service.mount('first', first); await settle();
    expect(context?.services[service]?.version).toBe(1);
    expect(context?.state.repo).toBe('org/header');
  });

  it('updates header hints while preserving an explicit panel scope and its active reads', async () => {
    const states: PluginPanelState[] = [];
    const { host, second } = setup({ mount(_element, context) {
      states.push(context.state); return { update(state) { states.push(state); }, dispose() {} };
    } });
    await host.service.mount('second', second); await settle();
    const initial = states.at(-1)!;
    expect(initial).toMatchObject({ repo: 'org/override', headerRepo: 'org/header' });
    host.update({ ...page, repo: null }); await settle();
    expect(states.at(-1)).toMatchObject({ repo: 'org/override', headerRepo: null });
    expect(states.at(-1)?.activity).toBe(initial.activity);
    expect(initial.activity.signal.aborted).toBe(false);
  });

  it('delivers current persisted state after a conflict without requiring a broadcast', async () => {
    let context!: PluginPanelContext;
    const observed: PluginPanelState[] = [];
    const { host, first, current, update } = setup({ mount(_element, value) {
      context = value; return { update(state) { observed.push(state); }, dispose() {} };
    } });
    await host.service.mount('first', first);
    const external = { version: 1, value: { draft: 'Saved by another tab' } };
    await update({ ...current(), instances: current().instances.map((instance, index) => index ? instance
      : { ...instance, state: { 'example.backlog/panel': external } }) }, current().revision);
    await expect(context.compareAndSetState!(null, { version: 1, value: 'Stale replacement' })).rejects.toThrow('Saved panel state changed');
    expect(observed.at(-1)?.savedState).toEqual(external);
    expect(current().instances[0]?.state['example.backlog/panel']).toEqual(external);
    expect(current().revision).toBe(2);
  });

  it('compares caller state before saving and preserves newer drafts, other panels and opaque owners', async () => {
    const contexts: PluginPanelContext[] = [];
    const { host, first, second, current } = setup({ mount(_element, context) {
      contexts.push(context); return { update() {}, dispose() {} };
    } });
    await host.service.mount('first', first); await host.service.mount('second', second);
    const initial = { version: 1, value: { draft: 'Initial', result: null } };
    const newer = { version: 1, value: { draft: 'Newer', result: 'Retained receipt' } };
    await contexts[0]!.compareAndSetState!(null, initial);
    await contexts[1]!.saveState({ version: 1, value: { draft: 'Other panel' } });
    await host.service.updateLayout({ ...current(), instances: current().instances.map((instance, index) => index ? instance
      : { ...instance, state: { ...instance.state, 'example.absent/panel': { version: 7, value: 'Keep opaque state' } } }) }, current().revision);
    await contexts[0]!.compareAndSetState!({ value: { result: null, draft: 'Initial' }, version: 1 }, newer);
    await expect(contexts[0]!.compareAndSetState!(initial, null)).rejects.toThrow('Saved panel state changed');
    expect(current().instances[0]?.state).toEqual({ 'example.backlog/panel': newer, 'example.absent/panel': { version: 7, value: 'Keep opaque state' } });
    expect(current().instances[1]?.state['example.backlog/panel']).toEqual({ version: 1, value: { draft: 'Other panel' } });
    await contexts[0]!.compareAndSetState!(newer, null);
    expect(current().instances[0]?.state).toEqual({ 'example.absent/panel': { version: 7, value: 'Keep opaque state' } });
  });

  it('admits only one concurrent state replacement from the same baseline', async () => {
    let context!: PluginPanelContext;
    const { host, first, current } = setup({ mount(_element, value) {
      context = value; return { update() {}, dispose() {} };
    } });
    await host.service.mount('first', first);
    const results = await Promise.allSettled(['First', 'Second'].map(draft => context.compareAndSetState!(null, { version: 1, value: { draft } })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(current().revision).toBe(2);
    expect(current().instances[0]?.state['example.backlog/panel']).toEqual({ version: 1, value: { draft: 'First' } });
  });

  it('captures state inputs before asynchronous storage and aborts a disposed caller', async () => {
    let context!: PluginPanelContext;
    const { host, first, read, current } = setup({ mount(_element, value) {
      context = value; return { update() {}, dispose() {} };
    } });
    await host.service.mount('first', first);
    const baseline = { version: 1, value: { draft: 'Original' } };
    await context.saveState(baseline);
    const next = { version: 1, value: { draft: 'Selected' } };
    let finish!: (layout: CompositionLayoutV1) => void;
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = context.compareAndSetState!(baseline, next);
    baseline.value.draft = 'Mutated expected'; next.value.draft = 'Mutated next';
    finish(current()); await saving;
    expect(current().instances[0]?.state['example.backlog/panel']).toEqual({ version: 1, value: { draft: 'Selected' } });
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const cancelled = context.compareAndSetState!({ version: 1, value: { draft: 'Selected' } }, null);
    host.dispose(); finish(current());
    await expect(cancelled).rejects.toThrow();
    expect(current().instances[0]?.state['example.backlog/panel']).toEqual({ version: 1, value: { draft: 'Selected' } });
  });

  it('rejects accessor-backed state without executing getters or reading storage', async () => {
    let context!: PluginPanelContext;
    const { host, first, read } = setup({ mount(_element, value) {
      context = value; return { update() {}, dispose() {} };
    } });
    await host.service.mount('first', first); read.mockClear();
    const getter = vi.fn(() => 'Unexpected');
    const value = { version: 1, value: Object.defineProperty({}, 'draft', { enumerable: true, get: getter }) };
    await expect(context.compareAndSetState!(null, value)).rejects.toThrow();
    await expect(context.compareAndSetState!(value, null)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });

  it('persists explicit panel scope changes without changing the header or other panels and cancels prior reads', async () => {
    const contexts: PluginPanelContext[] = [];
    const { host, first, second, current } = setup({ mount(_element, context) {
      contexts.push(context); return { update() {}, dispose() {} };
    } });
    await host.service.mount('first', first); await host.service.mount('second', second);
    await contexts[0]!.saveState({ version: 1, value: { draft: 'Keep me' } });
    const activity = contexts[0]!.activity;
    await contexts[0]!.setScope!({ kind: 'galleon', repo: 'org/draft' });
    expect(activity.signal.aborted).toBe(true);
    expect(contexts.map(context => context.activity.repo)).toEqual(['org/draft', 'org/override']);
    expect(current().instances[0]?.state).toEqual({ 'example.backlog/panel': { version: 1, value: { draft: 'Keep me' } } });
    host.update({ ...page, repo: 'org/next' });
    expect(contexts[0]!.activity.repo).toBe('org/draft');
    await contexts[0]!.setScope!({ kind: 'inherit' });
    expect(contexts[0]!.activity.repo).toBe('org/next');
    expect(page.repo).toBe('org/header');
    await expect(contexts[0]!.setScope!({ kind: 'galleon', repo: '../invalid' })).rejects.toThrow();
    host.dispose();
    await expect(contexts[0]!.setScope!({ kind: 'all' })).rejects.toThrow(/inactive/);
  });

  it('rejects a pending scope selection when the header scope changes before storage returns', async () => {
    let context!: PluginPanelContext;
    const { host, first, read, current } = setup({ mount(_element, value) {
      context = value; return { update() {}, dispose() {} };
    } });
    await host.service.mount('first', first);
    let finish!: (value: CompositionLayoutV1) => void;
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = context.setScope!({ kind: 'galleon', repo: 'org/draft' });
    host.update({ ...page, repo: 'org/next' });
    finish(current());
    await expect(pending).rejects.toThrow();
    expect(current().instances[0]?.scope).toEqual({ kind: 'inherit' });
    expect(context.activity.repo).toBe('org/next');
  });
  it('delivers ephemeral route state only to the selected instance and contribution without saving it', async () => {
    const states = new Map<string, PluginPanelState>();
    const { host, first, second, current, update } = setup({ mount(_element, context) {
      states.set(context.state.instanceId, context.state);
      return { update(state) { states.set(state.instanceId, state); }, dispose() {} };
    } });
    const routeState = { version: 1, value: { legacyTicket: 'TASK-42' } };
    host.update({ ...page, pullRequest: { version: 1, repo: 'org/pr', number: 42, mode: 'review' }, terminal: { version: 1, surface: 'surface:15', pane: 'screen' }, panelInstance: 'first', panelRouteState: {
      'example.backlog/panel': routeState, 'other.plugin/panel': { version: 1, value: 'private' },
    } });
    await host.service.mount('first', first); await host.service.mount('second', second); await settle();
    expect(states.get('first')?.routeState).toEqual(routeState);
    expect(states.get('second')?.routeState).toBeNull();
    expect(states.get('first')?.pullRequest).toEqual({ version: 1, repo: 'org/pr', number: 42, mode: 'review' });
    expect(states.get('second')?.pullRequest).toBeNull();
    expect(states.get('first')?.terminal).toEqual({ version: 1, surface: 'surface:15', pane: 'screen' });
    expect(states.get('second')?.terminal).toBeNull();
    expect(states.get('first')?.panelRouteState).toBeUndefined();
    host.update({ ...page, panelInstance: 'first', panelRouteState: {
      'example.backlog/panel': { version: 1, value: { legacyTicket: 'TASK-43' } },
    } });
    await settle();
    expect(states.get('first')?.routeState?.value).toEqual({ legacyTicket: 'TASK-43' });
    host.update({ ...page, panelInstance: 'backlog', panelContribution: 'example.backlog/panel',
      panelRouteState: { 'example.backlog/panel': routeState } }); await settle();
    expect(states.get('first')?.routeState).toEqual(routeState);
    expect(states.get('second')?.routeState).toBeNull();
    host.update({ ...page, panelInstance: 'missing', panelRouteState: { 'example.backlog/panel': routeState } }); await settle();
    expect(states.get('first')?.routeState).toBeNull();
    host.update({ ...page, panelInstance: 'second', panelContribution: 'example.backlog/panel',
      panelRouteState: { 'example.backlog/panel': routeState } }); await settle();
    expect(states.get('first')?.routeState).toBeNull();
    expect(states.get('second')?.routeState).toEqual(routeState);
    host.update(page); await settle();
    expect(states.get('first')?.routeState).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(current().instances.every(instance => Object.keys(instance.state).length === 0)).toBe(true);
  });

  it('isolates duplicate instance scopes and immediately cancels only changed effective scope', async () => {
    const contexts: PluginPanelContext[] = [];
    const { host, first, second } = setup({ mount(_element, context) {
      contexts.push(context); return { update() {}, dispose() {} };
    } });
    await host.service.mount('first', first); await host.service.mount('second', second);
    const inherited = contexts[0]!.activity;
    const overridden = contexts[1]!.activity;
    host.update({ ...page, repo: 'org/next' });
    expect(inherited.signal.aborted).toBe(true);
    expect(overridden.signal.aborted).toBe(false);
    expect(contexts.map(context => context.activity.repo)).toEqual(['org/next', 'org/override']);
    expect(page.repo).toBe('org/header');
  });

  it('retains unavailable selections and state, disposes on disable and remounts on re-enable', async () => {
    const contexts: PluginPanelContext[] = [];
    const dispose = vi.fn();
    const { host, first, unregister, registry, current } = setup({ mount(_element, context) {
      contexts.push(context); return { update() {}, dispose };
    } });
    await host.service.mount('first', first); await settle();
    await contexts[0]!.saveState({ version: 1, value: { filter: 'ready' } });
    unregister();
    expect(contexts[0]!.signal.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(first.textContent).toContain('unavailable');
    expect(current().instances[0]?.contributionId).toBe('example.backlog/panel');
    registry.register(manifest);
    await settle();
    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.state.savedState).toEqual({ version: 1, value: { filter: 'ready' } });
  });

  it('suspends collapsed and inactive stacked instances while retaining their lifetimes', async () => {
    const contexts: PluginPanelContext[] = [];
    const dispose = vi.fn();
    const { host, first, second, current } = setup({ mount(_element, context) {
      contexts.push(context); return { update() {}, dispose };
    } });
    const handle = await host.service.mount('first', first); await host.service.mount('second', second);
    let layout = current();
    await host.service.updateLayout({ ...layout, columns: [[{ instances: ['first', 'second'], activeInstanceId: 'second', collapsed: false }]] }, layout.revision);
    expect(contexts.map(context => context.activity.active)).toEqual([false, true]);
    handle.setActive(true);
    expect(contexts[0]?.activity.active).toBe(false);
    layout = current();
    await host.service.updateLayout({ ...layout, columns: [[{ instances: ['first', 'second'], activeInstanceId: 'second', collapsed: true }]] }, layout.revision);
    expect(contexts.map(context => context.activity.active)).toEqual([false, false]);
    expect(contexts.every(context => !context.signal.aborted)).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('rejects sibling containers and stale writes, and retains another implementation state on replacement', async () => {
    let context!: PluginPanelContext;
    const { host, first, current } = setup({ mount(_element, value) { context = value; return { update() {}, dispose() {} }; } });
    await expect(host.service.mount('first', document.createElement('div'))).rejects.toThrow('belong');
    await host.service.mount('first', first);
    await context.saveState({ version: 1, value: { draft: true } });
    const layout = current();
    await host.service.updateLayout({ ...layout, instances: layout.instances.map(instance => instance.instanceId === 'first'
      ? { ...instance, contributionId: 'missing.panel/panel' } : instance) }, layout.revision);
    expect(context.signal.aborted).toBe(true);
    expect(current().instances[0]?.state['example.backlog/panel']).toEqual({ version: 1, value: { draft: true } });
    await expect(host.service.updateLayout(layout, layout.revision)).rejects.toThrow('Conflict');
    await expect(context.saveState({ version: 1, value: null })).rejects.toThrow();
  });

  it('fences a paused save from a disposed generation after the same contribution is enabled again', async () => {
    const contexts: PluginPanelContext[] = [];
    const f = setup({ mount(_element, context) { contexts.push(context); return { update() {}, dispose() {} }; } });
    await f.host.service.mount('first', f.first);
    let release!: (layout: CompositionLayoutV1) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const stale = contexts[0]!.saveState({ version: 1, value: 'stale draft' });
    const rejected = expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    f.unregister(); f.registry.register(manifest);
    expect(contexts).toHaveLength(2);
    await contexts[1]!.saveState({ version: 1, value: 'new draft' });
    release(f.current()); await rejected;
    expect(f.current().instances[0]?.state['example.backlog/panel']).toEqual({ version: 1, value: 'new draft' });
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.update.mock.calls[0]?.[2]).toBe(contexts[1]!.signal);
  });

  it('rejects equal and nested containers without detaching an existing active panel', async () => {
    let context!: PluginPanelContext;
    const f = setup({ mount(element, supplied) { context = supplied; element.textContent = 'Existing panel'; return { update() {}, dispose() {} }; } });
    await f.host.service.mount('first', f.first);
    await expect(f.host.service.mount('second', f.first)).rejects.toThrow('overlap');
    const child = document.createElement('section'); f.first.append(child);
    await expect(f.host.service.mount('second', child)).rejects.toThrow('overlap');
    const parent = document.createElement('section'); f.first.before(parent); parent.append(f.first);
    await expect(f.host.service.mount('second', parent)).rejects.toThrow('overlap');
    expect(f.first.textContent).toContain('Existing panel');
    expect(context.activity.signal.aborted).toBe(false);
  });

  it('exposes scoped domain services to panels and rejects calls while suspended', async () => {
    let context!: PluginPanelContext;
    const f = setup({ mount(_element, supplied) { context = supplied; return { update() {}, dispose() {} }; } });
    await f.host.service.mount('first', f.first);
    expect(Object.keys(context.services).sort()).toEqual(['activity', 'campaigns', 'clarificationCommands', 'clarifications', 'communication', 'communicationCommands', 'downloads', 'githubSettings', 'jiraSettings', 'localGit', 'profile', 'pullRequestCommands', 'pullRequestInspect', 'pullRequests', 'runCommands', 'runInspect', 'runInstructions', 'runs', 'sourceAdmin', 'sourceCommands', 'suggestedContacts', 'taskActions', 'taskContext', 'taskEdit', 'taskViews', 'tasks', 'terminal', 'todoLegacyRecovery', 'version']);
    f.host.update({ ...page, visible: false });
    await expect(context.services.tasks?.discover()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(context.services.taskEdit?.discover()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(context.services.todoLegacyRecovery?.pending()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(context.services.sourceAdmin?.snapshot()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(context.services.sourceCommands?.pending()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(context.services.taskViews?.bugs({ version: 1, sourceId: '11111111-1111-4111-8111-111111111111', instanceId: 'instance-1', instanceRevision: 1, repo: page.repo })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(context.services.runs?.list({ version: 1, repo: page.repo, kind: 'running', cursor: null, limit: 25 })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(context.services.runInspect?.resolve({ version: 1, runId: 'run-1' })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(context.services.pullRequestInspect?.detail({ version: 1, repo: page.repo!, number: 1 })).rejects.toMatchObject({ name: 'AbortError' });
    const open = vi.fn(async () => new ReadableStream<Uint8Array>());
    await expect(context.services.downloads?.save({ filename: 'run.log', contentType: 'text/plain; charset=utf-8', open })).resolves.toEqual({ status: 'unavailable', reason: 'inactive' });
    expect(open).not.toHaveBeenCalled();
    await expect(context.services.runCommands?.pending()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(context.services.runCommands?.submit({ version: 1, repo: 'org/a', action: 'stop', target: { runId: 'run-1', expectedAttempt: 1 } })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a container removed while its initial layout read is pending', async () => {
    const mount = vi.fn(() => ({ update() {}, dispose() {} })); const f = setup({ mount });
    let release!: (layout: CompositionLayoutV1) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.host.service.mount('first', f.first);
    f.first.remove(); release(f.current());
    await expect(pending).rejects.toThrow('belong'); expect(mount).not.toHaveBeenCalled();
  });
});
