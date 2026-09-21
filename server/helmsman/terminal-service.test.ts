import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPersistence, type Persistence } from './persistence';
import { createTerminalService, type TerminalServerOptions } from './terminal-service';
import type { NativeTerminalSurfaceV1 } from '../../src/plugins/native-terminal';
import type { TerminalControlCommandV1 } from '../../src/plugins/terminal';
import { handleTerminalApi } from './terminal-routes';

const caller = 'example.terminal/panel';
const requestId = '10000000-0000-4000-8000-000000000001';
const stores: Persistence[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const persistence = openPersistence(':memory:'); stores.push(persistence);
  const tab: NativeTerminalSurfaceV1 = { surfaceRef: 'surface:1', windowRef: 'window:1', workspaceRef: 'workspace:1', workspaceTitle: 'org/b', surfaceTitle: 'codex', cwd: '/work/a', type: 'terminal', selected: true };
  let tabs = [tab]; let session = 'first';
  const bridge = { listTabs: vi.fn(async () => ({ connected: true, tabs })), readScreen: vi.fn(async () => ({ ok: true as const, text: 'safe' })),
    send: vi.fn(async (_surface: string, _text: string, _enter: boolean) => ({ ok: true as const })), sendKey: vi.fn(async () => ({ ok: true as const })) };
  const options: TerminalServerOptions = { persistence, bridge, repos: () => ['org/a', 'org/b'], roots: () => [{ repo: 'org/a', path: '/work/a' }, { repo: 'org/b', path: '/work/b' }], sessionIdentity: () => session, authorize: vi.fn() };
  const service = createTerminalService(options);
  return { persistence, options, bridge, service, tab, tabs: (value: NativeTerminalSurfaceV1[]) => { tabs = value; }, session: (value: string) => { session = value; },
    async command(): Promise<TerminalControlCommandV1> { const snapshot = await service.list(caller, { version: 1, repo: 'org/a' }, 'org/a'); return { version: 1, target: snapshot.tabs[0]!.target, operation: { kind: 'text', text: 'hello', enter: true }, requestId }; } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
describe('scoped terminal service', () => {
  it('associates by cwd, rejects ambiguous roots, and exposes unattached terminals only in All', async () => {
    const f = setup(); f.tabs([f.tab, { ...f.tab, surfaceRef: 'surface:2', cwd: null }]);
    const concrete = await f.service.list(caller, { version: 1, repo: 'org/a' }, 'org/a');
    expect(concrete.tabs.map(tab => tab.target.repo)).toEqual(['org/a']);
    expect((await f.service.list(caller, { version: 1, repo: 'org/b' }, 'org/b')).tabs).toEqual([]);
    expect((await f.service.list(caller, { version: 1, repo: null }, null)).tabs).toHaveLength(2);
    await expect(f.service.list(caller, { version: 1, repo: null }, 'org/a')).rejects.toMatchObject({ reason: 'forbidden' });
    const ambiguous = createTerminalService({ ...f.options, roots: () => [{ repo: 'org/a', path: '/work' }, { repo: 'org/b', path: '/work/a' }] });
    expect((await ambiguous.list(caller, { version: 1, repo: 'org/a' }, 'org/a')).tabs).toEqual([]);
  });
  it('rejects session, cwd and provider changes before control and detects changes during screen capture', async () => {
    const f = setup(); const command = await f.command(); f.session('second');
    expect((await f.service.control(caller, command, 'org/a')).status).toBe('rejected'); expect(f.bridge.send).not.toHaveBeenCalled();
    const next = await f.command(); f.tabs([{ ...f.tab, surfaceTitle: 'shell' }]);
    await expect(f.service.screen(caller, { target: next.target, lines: 40 }, 'org/a')).rejects.toMatchObject({ reason: 'conflict' });
    f.tabs([f.tab]); const third = await f.command();
    f.bridge.readScreen.mockImplementationOnce(async () => { f.tabs([{ ...f.tab, cwd: '/work/b' }]); return { ok: true, text: 'foreign' }; });
    await expect(f.service.screen(caller, { target: third.target, lines: 40 }, 'org/a')).rejects.toMatchObject({ reason: 'conflict' });
  });
  it('reserves before native dispatch, serializes duplicates and retains success across restart', async () => {
    const f = setup(); const command = await f.command(); const gate = deferred<{ ok: true }>(); const started = deferred<void>();
    f.bridge.send.mockImplementationOnce(() => { started.resolve(); return gate.promise; });
    const first = f.service.control(caller, command, 'org/a'); await started.promise;
    expect(f.service.receipt(caller, { requestId, repo: 'org/a' }, 'org/a')?.status).toBe('pending');
    const duplicate = f.service.control(caller, command, 'org/a');
    const restarted = createTerminalService(f.options);
    expect(restarted.receipt(caller, { requestId, repo: 'org/a' }, 'org/a')?.status).toBe('recovery-required');
    expect((await restarted.control(caller, command, 'org/a')).status).toBe('recovery-required');
    expect(f.bridge.send).toHaveBeenCalledTimes(1);
    gate.resolve({ ok: true }); expect((await first).status).toBe('succeeded'); expect((await duplicate).status).toBe('succeeded');
    f.session('new-process'); expect((await createTerminalService(f.options).control(caller, command, 'org/a')).status).toBe('succeeded');
    expect(f.bridge.send).toHaveBeenCalledTimes(1);
    await expect(f.service.control(caller, { ...command, operation: { kind: 'key', key: 'Enter' } }, 'org/a')).rejects.toMatchObject({ reason: 'conflict' });
  });
  it('retains an uncertain receipt when the native session changes during successful dispatch', async () => {
    const f = setup(); const command = await f.command();
    f.bridge.send.mockImplementationOnce(async () => { f.session('replacement'); return { ok: true }; });
    expect((await f.service.control(caller, command, 'org/a')).status).toBe('recovery-required');
    expect((await createTerminalService(f.options).control(caller, command, 'org/a')).status).toBe('recovery-required');
    expect(f.bridge.send).toHaveBeenCalledOnce();
  });
  it('never replays unknown transport outcomes and revalidates each queued target', async () => {
    const f = setup(); const command = await f.command();
    f.bridge.send.mockRejectedValueOnce(new Error('response lost'));
    expect((await f.service.control(caller, command, 'org/a')).status).toBe('recovery-required');
    expect((await createTerminalService(f.options).control(caller, command, 'org/a')).status).toBe('recovery-required');
    expect(f.bridge.send).toHaveBeenCalledTimes(1);
    const gate = deferred<{ ok: true }>(); const started = deferred<void>();
    f.bridge.send.mockImplementationOnce(() => { started.resolve(); return gate.promise; });
    const first = f.service.control(caller, { ...command, requestId: '10000000-0000-4000-8000-000000000002' }, 'org/a'); await started.promise;
    const second = f.service.control(caller, { ...command, requestId: '10000000-0000-4000-8000-000000000003' }, 'org/a');
    f.tabs([{ ...f.tab, cwd: '/work/b' }]); gate.resolve({ ok: true }); await first;
    expect((await second).status).toBe('rejected'); expect(f.bridge.send).toHaveBeenCalledTimes(2);
  });
  it('derives actions server side and isolates receipt callers and nullable targets', async () => {
    const f = setup(); f.tabs([{ ...f.tab, surfaceTitle: 'shell' }]); const command = await f.command();
    expect((await f.service.control(caller, { ...command, operation: { kind: 'action', action: 'approve' } }, 'org/a')).status).toBe('rejected');
    expect(f.bridge.sendKey).not.toHaveBeenCalled();
    expect(f.service.receipt('example.other/panel', { requestId, repo: 'org/a' }, 'org/a')).toBeNull();
    expect(() => f.service.receipt(caller, { requestId, repo: null }, null)).toThrow('not-found');
    expect(() => f.service.receipt(caller, { requestId, repo: null }, 'org/a')).toThrow('forbidden');
  });
  it('routes reject duplicate/unknown queries and missing explicit POST scope', async () => {
    const f = setup(); const command = await f.command();
    expect(await handleTerminalApi({ caller, service: f.service, method: 'GET', path: '/api/terminal/tabs', query: new URLSearchParams('version=1&repo=org/a&repo=org/b') })).toMatchObject({ status: 400 });
    expect(await handleTerminalApi({ caller, service: f.service, method: 'POST', path: '/api/terminal/control', query: new URLSearchParams(), body: { command } })).toMatchObject({ status: 400 });
    expect(await handleTerminalApi({ caller, service: f.service, method: 'GET', path: `/api/terminal/receipts/${requestId}`, query: new URLSearchParams('scopeRepo=org/a') })).toMatchObject({ status: 403 });
    expect(f.bridge.send).not.toHaveBeenCalled();
  });
});

it('keeps partial actions and failed image transports uncertain without replay', async () => {
  const f = setup(); const command = await f.command();
  f.bridge.sendKey.mockImplementationOnce(async () => { f.tabs([{ ...f.tab, cwd: '/work/b' }]); return { ok: true }; });
  expect((await f.service.control(caller, { ...command, operation: { kind: 'action', action: 'approve' } }, 'org/a')).status).toBe('recovery-required');
  expect(f.bridge.sendKey).toHaveBeenCalledTimes(1);
  expect((await createTerminalService(f.options).control(caller, { ...command, operation: { kind: 'action', action: 'approve' } }, 'org/a')).status).toBe('recovery-required');
  f.tabs([f.tab]); const pasteImage = vi.fn(async () => ({ ok: false as const, error: 'response lost after typing path' }));
  const images = createTerminalService({ ...f.options, pasteImage });
  const image = { ...command, requestId: '10000000-0000-4000-8000-000000000002', operation: { kind: 'image' as const, mimeType: 'image/png', dataBase64: 'AAAA' } };
  expect((await images.control(caller, image, 'org/a')).status).toBe('recovery-required');
  expect((await images.control(caller, image, 'org/a')).status).toBe('recovery-required'); expect(pasteImage).toHaveBeenCalledTimes(1);
});

it('validates stored receipt integrity and the owned migration schema', async () => {
  const f = setup(); const command = await f.command(); await f.service.control(caller, command, 'org/a');
  expect(f.persistence.sql.prepare('SELECT version FROM migration_ledger WHERE owner=?').get('core.terminal-control-receipts')).toEqual({ version: 1 });
  f.persistence.sql.prepare('UPDATE terminal_control_receipts SET hash=?').run('0'.repeat(64));
  expect(() => f.service.receipt(caller, { repo: 'org/a', requestId }, 'org/a')).toThrow('integrity');
});

it('explicit inspection fences absent controls against late delivery and restart without native dispatch', async () => {
  const f = setup(); const command = await f.command(); const query = { repo: 'org/a', requestId };
  expect(f.service.receipt(caller, query, 'org/a')).toBeNull();
  const inspected = f.service.inspect(caller, command, 'org/a');
  expect(inspected).toMatchObject({ status: 'recovery-required', input: { target: command.target } });
  expect(f.bridge.send).not.toHaveBeenCalled();
  expect(await f.service.control(caller, command, 'org/a')).toEqual(inspected);
  const restarted = createTerminalService(f.options);
  expect(restarted.receipt(caller, query, 'org/a')).toEqual(inspected);
  expect(await restarted.control(caller, command, 'org/a')).toEqual(inspected);
  expect(() => restarted.inspect(caller, { ...command, operation: { kind: 'key', key: 'Enter' } }, 'org/a')).toThrow('conflict');
  expect(f.bridge.send).not.toHaveBeenCalled();
});

it('inspection bypasses a hung control queue, preserves active pending evidence and fences queued work', async () => {
  const f = setup(); const command = await f.command(); const gate = deferred<{ ok: true }>(); const started = deferred<void>();
  f.bridge.send.mockImplementationOnce(() => { started.resolve(); return gate.promise; });
  const first = f.service.control(caller, command, 'org/a'); await started.promise;
  expect(f.service.inspect(caller, command, 'org/a').status).toBe('pending');
  const queuedCommand = { ...command, requestId: '10000000-0000-4000-8000-000000000002' };
  const queued = f.service.control(caller, queuedCommand, 'org/a');
  const inspected = f.service.inspect(caller, queuedCommand, 'org/a');
  expect(inspected.status).toBe('recovery-required'); expect(f.bridge.send).toHaveBeenCalledTimes(1);
  gate.resolve({ ok: true }); const success = await first; expect(await queued).toEqual(inspected);
  expect(f.service.inspect(caller, command, 'org/a')).toEqual(success); expect(f.bridge.send).toHaveBeenCalledTimes(1);
});

it('inspection also fences a control already awaiting live validation and enforces its HTTP body scope', async () => {
  const f = setup(); const command = await f.command(); const gate = deferred<{ connected: boolean; tabs: NativeTerminalSurfaceV1[] }>(); const started = deferred<void>();
  f.bridge.listTabs.mockImplementationOnce(() => { started.resolve(); return gate.promise; });
  const delayed = f.service.control(caller, command, 'org/a'); await started.promise;
  const result = await handleTerminalApi({ caller, service: f.service, method: 'POST', path: '/api/terminal/inspect', query: new URLSearchParams(), body: { command, scopeRepo: 'org/a' } });
  expect(result).toMatchObject({ status: 200, json: { status: 'recovery-required' } });
  gate.resolve({ connected: true, tabs: [f.tab] }); expect(await delayed).toEqual(result?.json); expect(f.bridge.send).not.toHaveBeenCalled();
  expect(await handleTerminalApi({ caller, service: f.service, method: 'POST', path: '/api/terminal/inspect', query: new URLSearchParams(), body: { command, scopeRepo: 'org/b' } })).toMatchObject({ status: 404 });
});
