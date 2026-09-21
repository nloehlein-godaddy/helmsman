import { afterEach, expect, it, vi } from 'vitest';
import type { ClarificationReadResultV1, PluginPageContext, PluginPageState, ProfileSnapshotV1 } from '@helmsman/plugin-sdk';
import header from './header';

const lifetimes: AbortController[] = [];
const state: PluginPageState = { repo: 'org/one', themeId: 'dark', pirateMode: false, visible: true, pane: null };
const available = (displayName: string | null = 'Ada', login: string | null = 'ada'): ClarificationReadResultV1<ProfileSnapshotV1> => ({
  status: 'available', value: { version: 1, scope: 'global', profile: { displayName, login } },
});

async function setup(options: { visible?: boolean; aborted?: boolean; missing?: boolean; result?: unknown } = {}) {
  const lifetime = new AbortController();
  lifetimes.push(lifetime);
  if (options.aborted) lifetime.abort();
  const snapshot = vi.fn(async (_input: { version: 1; scope: 'global' }, _signal?: AbortSignal): Promise<ClarificationReadResultV1<ProfileSnapshotV1>> =>
    (Object.hasOwn(options, 'result') ? options.result : available()) as ClarificationReadResultV1<ProfileSnapshotV1>);
  const disposeCallbacks: (() => void)[] = [];
  const context: PluginPageContext = {
    state: { ...state, visible: options.visible ?? true }, signal: lifetime.signal,
    navigate: vi.fn(), onDispose: callback => disposeCallbacks.push(callback),
    services: options.missing ? undefined : { version: 1, profile: { version: 1, snapshot } } as unknown as PluginPageContext['services'],
  };
  const container = document.createElement('span');
  document.body.append(container);
  const instance = await header.mount(container, context);
  return { lifetime, snapshot, disposeCallbacks, container, instance, context };
}

function deferred() {
  let resolve!: (value: ClarificationReadResultV1<ProfileSnapshotV1>) => void;
  const promise = new Promise<ClarificationReadResultV1<ProfileSnapshotV1>>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  lifetimes.splice(0).forEach(lifetime => lifetime.abort());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('renders only an optional global identity suffix, preferring display name', async () => {
  const f = await setup();
  expect(f.container.textContent).toBe(', Ada');
  expect(f.snapshot).toHaveBeenCalledWith({ version: 1, scope: 'global' }, expect.any(AbortSignal));
  f.snapshot.mockResolvedValue(available(null, 'ada'));
  await f.instance.refresh?.();
  expect(f.container.textContent).toBe(', ada');
  f.snapshot.mockResolvedValue(available(null, null));
  await f.instance.refresh?.();
  expect(f.container.textContent).toBe('');
});

it('keeps external text literal and preserves its node through unrelated shell updates', async () => {
  const f = await setup({ result: available('<img src=x onerror=alert(1)>') });
  const node = f.container.firstChild;
  expect(f.container.textContent).toBe(', <img src=x onerror=alert(1)>');
  expect(f.container.querySelector('img')).toBeNull();
  await f.instance.update({ ...state, repo: 'org/two', themeId: 'light', pirateMode: true });
  expect(f.snapshot).toHaveBeenCalledTimes(1);
  expect(f.container.firstChild).toBe(node);
  expect(f.context.navigate).not.toHaveBeenCalled();
});

it.each([
  null, undefined, {}, { status: 'available', value: null },
  { status: 'available', value: { version: 1, scope: 'global', profile: null } },
  { status: 'available', value: { version: 1, scope: 'galleon', profile: { displayName: 'Ada', login: null } } },
  { status: 'available', value: { version: 2, scope: 'global', profile: { displayName: 'Ada', login: null } } },
  available('x'.repeat(257)), available(null, 'x'.repeat(129)), available(' '), available('Ada\n'),
  { status: 'available', value: { version: 1, scope: 'global', profile: { displayName: 42, login: null } } },
  { status: 'available', value: { version: 1, scope: 'global', profile: { login: 'ada' } } },
  { status: 'unavailable', reason: 'service-unavailable' },
])('falls back to the neutral greeting for malformed or unavailable response %#', async result => {
  const f = await setup({ result });
  expect(f.container.textContent).toBe('');
});

it('accepts maximum name and login lengths', async () => {
  const f = await setup({ result: available('x'.repeat(256), 'y'.repeat(128)) });
  expect(f.container.textContent).toBe(`, ${'x'.repeat(256)}`);
});

it.each(['unavailable', 'rejected'] as const)('clears previous identity after a %s refresh', async failure => {
  const f = await setup();
  expect(f.container.textContent).toBe(', Ada');
  if (failure === 'unavailable') f.snapshot.mockResolvedValue({ status: 'unavailable', reason: 'connection-failed' });
  else f.snapshot.mockRejectedValue(new Error('Offline'));
  await f.instance.refresh?.();
  expect(f.container.textContent).toBe('');
});

it('does not fetch when mounted hidden and refreshes only when becoming visible', async () => {
  const f = await setup({ visible: false });
  await f.instance.refresh?.();
  expect(f.snapshot).not.toHaveBeenCalled();
  await f.instance.update(state);
  expect(f.snapshot).toHaveBeenCalledTimes(1);
  expect(f.container.textContent).toBe(', Ada');
  await f.instance.update({ ...state, visible: false });
  expect(f.container.textContent).toBe('');
  await f.instance.update(state);
  expect(f.snapshot).toHaveBeenCalledTimes(2);
});

it('aborts hidden requests and ignores late success and failures across reactivation', async () => {
  const f = await setup();
  const old = deferred();
  f.snapshot.mockReturnValueOnce(old.promise);
  const refresh = f.instance.refresh?.();
  const signal = f.snapshot.mock.calls.at(-1)?.[1];
  await f.instance.update({ ...state, visible: false });
  expect(signal?.aborted).toBe(true);
  f.snapshot.mockResolvedValue(available('Grace'));
  await f.instance.update(state);
  old.resolve(available('Stale'));
  await refresh;
  expect(f.container.textContent).toBe(', Grace');
});

it('superseding refresh cancels the first request and ignores its late reply', async () => {
  const f = await setup();
  const old = deferred();
  f.snapshot.mockReturnValueOnce(old.promise);
  const first = f.instance.refresh?.();
  const signal = f.snapshot.mock.calls.at(-1)?.[1];
  f.snapshot.mockResolvedValue(available('Grace'));
  await f.instance.refresh?.();
  expect(signal?.aborted).toBe(true);
  old.resolve({ status: 'unavailable', reason: 'connection-failed' });
  await first;
  expect(f.container.textContent).toBe(', Grace');
});

it.each(['abort', 'dispose', 'callback'] as const)('cancels on %s and ignores subsequent updates or late responses', async method => {
  const f = await setup();
  const old = deferred();
  f.snapshot.mockReturnValueOnce(old.promise);
  const refresh = f.instance.refresh?.();
  const signal = f.snapshot.mock.calls.at(-1)?.[1];
  if (method === 'abort') f.lifetime.abort();
  else if (method === 'callback') f.disposeCallbacks.forEach(callback => callback());
  else await f.instance.dispose();
  expect(signal?.aborted).toBe(true);
  old.resolve(available('Late'));
  await refresh;
  await f.instance.update(state);
  await f.instance.refresh?.();
  expect(f.snapshot).toHaveBeenCalledTimes(2);
  expect(f.container.childNodes).toHaveLength(0);
});

it('does not fetch for an already-aborted host', async () => {
  const f = await setup({ aborted: true });
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(f.container.childNodes).toHaveLength(0);
});

it('gracefully falls back when the optional service is missing', async () => {
  const f = await setup({ missing: true });
  await f.instance.refresh?.();
  expect(f.container.textContent).toBe('');
  expect(f.snapshot).not.toHaveBeenCalled();
});
