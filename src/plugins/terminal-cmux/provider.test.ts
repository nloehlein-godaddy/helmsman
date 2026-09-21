import { describe, expect, it, vi } from 'vitest';
import {
  createCmuxNativeTerminal,
  createNativeSessionIdentity,
  resolveCmuxSocket,
  type CmuxCommandRunner,
  type NativeSocketStat,
} from './provider';

const base: NativeSocketStat = { dev: 1n, ino: 2n, ctimeNs: 3n, mtimeNs: 4n, birthtimeNs: 5n };

describe('cmux native session identity', () => {
  it('binds identity to startup, destination and socket generation', () => {
    let metadata = base;
    let path = '/sockets/cmux';
    const options = { kind: 'cmux', socket: () => path, startup: 'first', stat: () => metadata };
    const identity = createNativeSessionIdentity(options);
    const original = identity();
    expect(identity()).toBe(original);
    metadata = { ...base, ino: 9n };
    expect(identity()).not.toBe(original);
    metadata = base;
    path = '/sockets/other';
    expect(identity()).not.toBe(original);
    path = '/sockets/cmux';
    expect(createNativeSessionIdentity({ ...options, startup: 'next' })()).not.toBe(original);
  });

  it('uses parent generation for inaccessible sockets and fails closed when neither can be inspected', () => {
    let metadata = base;
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const identity = createNativeSessionIdentity({
      kind: 'cmux', startup: 'test', socket: () => '/runtime/cmux.sock',
      stat: path => { if (path.endsWith('cmux.sock')) throw denied; return metadata; },
    });
    const before = identity();
    metadata = { ...base, ctimeNs: 40n, mtimeNs: 40n };
    expect(identity()).not.toBe(before);
    expect(() => createNativeSessionIdentity({ kind: 'cmux', socket: () => '/runtime/cmux.sock', stat: () => { throw denied; } })()).toThrow('denied');
  });

  it('pins explicit sockets and uses supported defaults without CLI discovery', () => {
    expect(resolveCmuxSocket('/custom/socket', '/home', () => true)).toBe('/custom/socket');
    expect(resolveCmuxSocket('', '/home', path => path === '/home/.local/state/cmux/cmux.sock')).toBe('/home/.local/state/cmux/cmux.sock');
    expect(resolveCmuxSocket('', '/home', path => path === '/home/.config/cmux/cmux.sock')).toBe('/home/.config/cmux/cmux.sock');
    expect(resolveCmuxSocket('', '/home', () => false)).toBe('/home/.local/state/cmux/cmux.sock');
  });
});

describe('cmux native terminal provider', () => {
  it('projects terminal surfaces and executes exact screen/text/key commands', async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const run = vi.fn<CmuxCommandRunner>(async args => {
      mutableCalls.push([...args]);
      if (args[0] === 'list-windows') return { code: 0, stdout: JSON.stringify([{ id: 'window:1' }]), stderr: '' };
      if (args[0] === 'workspace') return { code: 0, stdout: JSON.stringify({ window_ref: 'window:1', workspaces: [{ ref: 'workspace:2', title: 'Repo', current_directory: '/repo' }] }), stderr: '' };
      if (args[0] === 'list-pane-surfaces') return { code: 0, stdout: JSON.stringify({ surfaces: [{ ref: 'surface:3', title: 'Agent', type: 'terminal', selected: true }] }), stderr: '' };
      if (args[0] === 'read-screen') return { code: 0, stdout: 'screen text', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const provider = createCmuxNativeTerminal({ socketPath: '/tmp/cmux.sock', run, startup: 'test', stat: () => base });
    await expect(provider.listTabs()).resolves.toEqual({ connected: true, tabs: [{ windowRef: 'window:1', workspaceRef: 'workspace:2', workspaceTitle: 'Repo', surfaceRef: 'surface:3', surfaceTitle: 'Agent', type: 'terminal', cwd: '/repo', selected: true }] });
    await expect(provider.readScreen('surface:3', 100)).resolves.toEqual({ ok: true, text: 'screen text' });
    await expect(provider.send('surface:3', '--help', true)).resolves.toEqual({ ok: true });
    await expect(provider.sendKey('surface:3', 'ctrl+c')).resolves.toEqual({ ok: true });
    expect(mutableCalls).toContainEqual(['send', '--surface', 'surface:3', '--help']);
    expect(mutableCalls).toContainEqual(['send-key', '--surface', 'surface:3', 'Enter']);
    expect(mutableCalls).toContainEqual(['send-key', '--surface', 'surface:3', 'ctrl+c']);
  });

  it('provides bounded structured browser primitives and forwards cancellation', async () => {
    const controller = new AbortController();
    const run = vi.fn<CmuxCommandRunner>(async (args, signal) => {
      expect(signal).toBe(controller.signal);
      if (args[0] === '--id-format') return { code: 0, stdout: JSON.stringify({ windows: [] }), stderr: '' };
      if (args[0] === 'browser' && args[2] === 'eval') return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const browser = createCmuxNativeTerminal({ socketPath: '/tmp/cmux.sock', run, stat: () => base }).browser!;
    await expect(browser.tree(controller.signal)).resolves.toEqual({ windows: [] });
    await expect(browser.focus({ surface: 'surface:1' }, controller.signal)).resolves.toBeUndefined();
    await expect(browser.evaluate({ surface: 'surface:1', script: 'JSON.stringify(true)' }, controller.signal)).resolves.toEqual({ ok: true });
    await browser.click({ surface: 'surface:1', selector: '[data-qa="send"]' }, controller.signal);
    await browser.fill({ surface: 'surface:1', selector: 'textarea', value: '' }, controller.signal);
    await browser.wait({ surface: 'surface:1', selector: '.ready', timeoutMs: 1000 }, controller.signal);
    expect(run).toHaveBeenCalledWith(['rpc', 'surface.focus', JSON.stringify({ surface_id: 'surface:1' })], controller.signal, '/tmp/cmux.sock');
    expect(run).toHaveBeenCalledWith(['browser', 'surface:1', 'fill', 'textarea', ''], controller.signal, '/tmp/cmux.sock');
  });

  it('fails closed on invalid inventories and oversized screen output', async () => {
    const run = vi.fn<CmuxCommandRunner>(async args => args[0] === 'read-screen'
      ? { code: 0, stdout: 'x'.repeat(1024 * 1024 + 1), stderr: '' }
      : { code: 0, stdout: '{}', stderr: '' });
    const provider = createCmuxNativeTerminal({ socketPath: '/tmp/cmux.sock', run, stat: () => base });
    await expect(provider.listTabs()).resolves.toEqual({ connected: false, tabs: [] });
    await expect(provider.readScreen('surface:1', 10)).resolves.toEqual({ ok: false, error: 'screen output exceeds the limit' });
  });

  it('pins one auto-discovered socket across text and Enter', async () => {
    let firstSocket = true;
    const sockets: Array<string | undefined> = [];
    const run = vi.fn<CmuxCommandRunner>(async (_args, _signal, socketPath) => {
      sockets.push(socketPath);
      firstSocket = false;
      return { code: 0, stdout: '', stderr: '' };
    });
    const provider = createCmuxNativeTerminal({
      home: '/home',
      exists: path => firstSocket ? path.endsWith('/.local/state/cmux/cmux.sock') : path.endsWith('/.config/cmux/cmux.sock'),
      run,
      stat: () => base,
    });
    await expect(provider.send('surface:1', 'hello', true)).resolves.toEqual({ ok: true });
    expect(sockets).toEqual([
      '/home/.local/state/cmux/cmux.sock',
      '/home/.local/state/cmux/cmux.sock',
    ]);
  });
});
