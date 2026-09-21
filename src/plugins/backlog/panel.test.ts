import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelContext, PluginPanelState, PluginPageServices, TaskReadServiceV1, TaskReadSourceV1, TaskReadTaskV1 } from '@helmsman/plugin-sdk';
import backlog from './panel';
import alternative from '../backlog-alternative/panel';

const sourceId = '11111111-1111-4111-8111-111111111111';
const repo = 'owner/project';
const source: TaskReadSourceV1 = { version: 1, sourceId, instanceId: 'source-one', instanceRevision: 2, repo, label: 'Tasks', availability: 'available' };
const task: TaskReadTaskV1 = { version: 1, ref: { sourceId, externalId: '10001' }, repo, revision: 'r1', displayKey: 'TASK-2', title: 'Read isolated tasks', state: 'ready', priority: null, url: null, requirements: { description: '', acceptanceCriteria: [], links: [] } };
function fixture() {
  const container = document.createElement('div'); document.body.append(container);
  const lifetime = new AbortController(); const activity = new AbortController();
  const state: PluginPanelState = { repo, themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'panel-one', activity: { repo, epoch: 1, active: true, signal: activity.signal }, savedState: null };
  const discover = vi.fn<TaskReadServiceV1['discover']>(async () => ({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source] } }] } }));
  const list = vi.fn<TaskReadServiceV1['list']>(async () => ({ status: 'available', value: { selection: source, items: [task], nextCursor: null } }));
  const services: PluginPageServices = { version: 1, runCommands: { version: 1, pending: vi.fn(async () => []), submit: vi.fn(), receipt: vi.fn(), acknowledge: vi.fn() }, tasks: { version: 1, discover, list, load: vi.fn() }, usage: { query: vi.fn() }, outcomes: { summary: vi.fn(), assessment: vi.fn() }, pricing: { estimate: vi.fn() } };
  const saveState = vi.fn<PluginPanelContext['saveState']>(async () => {});
  const context: PluginPanelContext = { state, activity: state.activity, signal: lifetime.signal, services, saveState, navigate: vi.fn(), onDispose: vi.fn() };
  return { container, lifetime, activity, state, context, discover, list, saveState };
}
afterEach(() => document.body.replaceChildren());

describe.each([['shipped backlog', backlog], ['independent task table', alternative]] as const)('%s public task reader', (_name, module) => {
  it('reads canonical task data without a global Jira URL fallback', async () => {
    const f = fixture(); await module.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.container.textContent).toContain(task.title));
    expect(f.container.querySelector('a')).toBeNull();
    expect(f.list).toHaveBeenCalledWith(expect.objectContaining({ sourceId, instanceId: source.instanceId, instanceRevision: 2, repo, limit: 25, state: 'ready' }), expect.any(AbortSignal));
    f.lifetime.abort();
  });
  it('keeps other sources usable while reporting unavailable source views', async () => {
    const f = fixture(); f.discover.mockResolvedValue({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source, { ...source, instanceId: 'disabled', label: 'Disabled tasks', availability: 'disabled' }] } }, { repo: 'owner/other', sources: { status: 'unavailable', reason: 'service-unavailable' } }] } });
    await module.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.container.textContent).toContain(task.title));
    expect(f.container.textContent).toContain('Disabled tasks'); expect(f.container.textContent).toContain('owner/other'); expect(f.list).toHaveBeenCalledTimes(1); f.lifetime.abort();
  });
  it('rejects late data from a previous activity epoch', async () => {
    const f = fixture(); let finish!: (value: Awaited<ReturnType<TaskReadServiceV1['discover']>>) => void;
    f.discover.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const instance = await module.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.discover).toHaveBeenCalledTimes(1));
    f.activity.abort(); const activity = new AbortController();
    await instance.update({ ...f.state, repo: 'owner/other', activity: { repo: 'owner/other', epoch: 2, active: false, signal: activity.signal } });
    finish({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source] } }] } });
    await Promise.resolve(); await Promise.resolve();
    expect(f.list).not.toHaveBeenCalled(); expect(f.container.textContent).not.toContain(task.title); f.lifetime.abort();
  });
  it('suspends reads while hidden and refreshes after reactivation', async () => {
    const f = fixture(); f.context = { ...f.context, state: { ...f.state, visible: false, activity: { ...f.state.activity, active: false } } };
    const instance = await module.mount(f.container, f.context); expect(f.discover).not.toHaveBeenCalled();
    await instance.update(f.state);
    await vi.waitFor(() => expect(f.container.textContent).toContain(task.title));
    f.lifetime.abort(); const calls = f.discover.mock.calls.length; await instance.refresh?.(); expect(f.discover).toHaveBeenCalledTimes(calls);
  });
  it('preserves source failures without showing an empty successful task list', async () => {
    const f = fixture(); f.list.mockResolvedValue({ status: 'unavailable', reason: 'selection-changed' });
    await module.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.container.textContent).toContain('selection-changed')); expect(f.container.textContent).not.toContain(task.title); f.lifetime.abort();
  });
});

describe('shipped backlog manual source selection and pagination', () => {
  it('preserves unsupported saved state until the operator chooses a replacement selection', async () => {
    const f = fixture(); f.context = { ...f.context, state: { ...f.state, savedState: { version: 99, value: { newer: 'keep' } } } };
    await backlog.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.container.textContent).toContain('unsupported data'));
    expect(f.list).not.toHaveBeenCalled(); expect(f.saveState).not.toHaveBeenCalled();
    const select = f.container.querySelector('select')!; select.value = ''; select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(f.container.textContent).toContain(task.title));
    expect(f.saveState).toHaveBeenCalledWith(null); f.lifetime.abort();
  });
  it('applies a changed saved selection from the host without reading the previous source', async () => {
    const f = fixture(); const instance = await backlog.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.container.textContent).toContain(task.title));
    const reads = f.list.mock.calls.length;
    await instance.update({ ...f.state, savedState: { version: 1, value: { sourceId, instanceId: 'missing', repo } } });
    await vi.waitFor(() => expect(f.container.textContent).toContain('Your selection is kept'));
    expect(f.container.textContent).not.toContain(task.title); expect(f.list).toHaveBeenCalledTimes(reads); f.lifetime.abort();
  });
  it('retains an unavailable manual selection instead of falling back to another source', async () => {
    const f = fixture(); f.context = { ...f.context, state: { ...f.state, savedState: { version: 1, value: { sourceId, instanceId: 'missing', repo } } } };
    await backlog.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.container.textContent).toContain('Your selection is kept'));
    expect(f.list).not.toHaveBeenCalled(); expect(f.container.querySelector('select')?.selectedOptions[0]?.textContent).toContain('Unavailable source'); f.lifetime.abort();
  });
  it('saves selection per panel and retains the local selection when persistence fails', async () => {
    const f = fixture(); f.saveState.mockRejectedValueOnce(new Error('Conflict'));
    await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain(task.title));
    const select = f.container.querySelector('select')!; select.value = select.options[1]!.value; select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(f.container.textContent).toContain('selection could not be saved'));
    expect(f.saveState).toHaveBeenCalledWith({ version: 1, value: { sourceId, instanceId: source.instanceId, repo } });
    expect(f.container.querySelector('select')?.value).not.toBe(''); f.lifetime.abort();
  });
  it('does not let an older repeated All selection settle the latest unsaved choice', async () => {
    const f = fixture(); const saves: { resolve(): void; reject(error: Error): void }[] = [];
    f.saveState.mockImplementation(() => new Promise<void>((resolve, reject) => { saves.push({ resolve, reject }); }));
    const instance = await backlog.mount(f.container, f.context);
    await vi.waitFor(() => expect(f.container.textContent).toContain(task.title));
    const choose = (value: string) => { const select = f.container.querySelector('select')!; select.value = value; select.dispatchEvent(new Event('change')); };
    const sourceValue = f.container.querySelector('select')!.options[1]!.value;
    choose(''); choose(sourceValue); choose(''); expect(saves).toHaveLength(3);
    saves[0]!.resolve(); await Promise.resolve();
    await instance.update({ ...f.state, savedState: { version: 1, value: { sourceId, instanceId: 'missing', repo } } });
    expect(f.container.querySelector('select')?.value).toBe('');
    saves[2]!.reject(new Error('Latest failed'));
    await vi.waitFor(() => expect(f.container.textContent).toContain('selection could not be saved'));
    saves[1]!.resolve(); await Promise.resolve(); expect(f.container.querySelector('select')?.value).toBe(''); f.lifetime.abort();
  });
  it('uses opaque pagination cursors and retains earlier pages when a later read fails', async () => {
    const f = fixture(); f.list.mockResolvedValueOnce({ status: 'available', value: { selection: source, items: [task], nextCursor: 'opaque-next' } }).mockResolvedValueOnce({ status: 'unavailable', reason: 'source-unavailable' });
    await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain(task.title));
    await vi.waitFor(() => expect(Array.from(f.container.querySelectorAll('button')).find(value => value.textContent === 'Load more')?.disabled).toBe(false));
    Array.from(f.container.querySelectorAll('button')).find(value => value.textContent === 'Load more')?.click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('source-unavailable'));
    expect(f.container.textContent).toContain(task.title); expect(f.list.mock.calls[1]?.[0].cursor).toBe('opaque-next'); f.lifetime.abort();
  });
  it('does not silently append the same canonical work twice across pages', async () => {
    const f = fixture(); f.list.mockResolvedValueOnce({ status: 'available', value: { selection: source, items: [task], nextCursor: 'next' } }).mockResolvedValueOnce({ status: 'available', value: { selection: source, items: [{ ...task, displayKey: 'TASK-99' }], nextCursor: null } });
    await backlog.mount(f.container, f.context); await vi.waitFor(() => expect(f.container.textContent).toContain(task.title));
    await vi.waitFor(() => expect(Array.from(f.container.querySelectorAll('button')).find(value => value.textContent === 'Load more')?.disabled).toBe(false));
    Array.from(f.container.querySelectorAll('button')).find(value => value.textContent === 'Load more')?.click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('pagination changed')); expect(f.container.querySelectorAll('li')).toHaveLength(1); f.lifetime.abort();
  });
});
