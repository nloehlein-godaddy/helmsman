import { describe, expect, it, vi } from 'vitest';
import {
  createWeztermNativeTerminal,
  pickWeztermSocket,
  resolveWeztermSocket,
  weztermCwd,
  type NativeSocketStat,
  type WeztermCommandRunner,
} from './provider';

const socketStat: NativeSocketStat = { dev: 1n, ino: 2n, ctimeNs: 3n, mtimeNs: 4n, birthtimeNs: 5n };

describe('WezTerm native terminal provider', () => {
  it('pins configured sockets and picks the newest live discovered GUI', () => {
    const candidates = [
      { path: '/runtime/gui-sock-10', pid: 10, mtimeMs: 100 },
      { path: '/runtime/gui-sock-20', pid: 20, mtimeMs: 200 },
      { path: '/runtime/gui-sock-30', pid: 30, mtimeMs: 300 },
    ];
    expect(resolveWeztermSocket({ configured: '/custom/socket', candidates: () => candidates, alive: () => true })).toBe('/custom/socket');
    expect(pickWeztermSocket(candidates, pid => pid !== 30)).toBe('/runtime/gui-sock-20');
    expect(pickWeztermSocket(candidates, () => false)).toBeNull();
  });

  it('projects panes, focused client and normalized cwd without browser support', async () => {
    const calls: Array<{ args: readonly string[]; socket: string }> = [];
    const run = vi.fn<WeztermCommandRunner>(async (args, socket) => {
      calls.push({ args, socket });
      if (args[1] === 'list-clients') return { code: 0, stdout: JSON.stringify([{ focused_pane_id: 7 }]), stderr: '' };
      if (args[1] === 'list') return { code: 0, stdout: JSON.stringify([{ window_id: 1, tab_id: 2, pane_id: 7, workspace: 'dev', title: 'Agent', cwd: 'file:///C:/repo', is_active: false }]), stderr: '' };
      if (args[1] === 'get-text') return { code: 0, stdout: 'screen\n\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const provider = createWeztermNativeTerminal({ socketPath: '/tmp/wez.sock', run, startup: 'test', stat: () => socketStat });
    expect(provider.metadata).toEqual({ version: 1, label: 'WezTerm', browser: false });
    expect(provider.browser).toBeUndefined();
    await expect(provider.listTabs()).resolves.toEqual({ connected: true, tabs: [{ windowRef: 'window:1', workspaceRef: 'tab:2', workspaceTitle: 'dev', surfaceRef: '7', surfaceTitle: 'Agent', type: 'terminal', cwd: 'C:/repo', selected: true }] });
    await expect(provider.readScreen('7', 100)).resolves.toEqual({ ok: true, text: 'screen' });
    await expect(provider.send('7', '--help', true)).resolves.toEqual({ ok: true });
    await expect(provider.sendKey('7', 'ctrl+c')).resolves.toEqual({ ok: true });
    expect(calls.every(call => call.socket === '/tmp/wez.sock')).toBe(true);
    expect(calls).toContainEqual({ args: ['cli', 'send-text', '--pane-id', '7', '--no-paste', '--', '--help'], socket: '/tmp/wez.sock' });
    expect(calls).toContainEqual({ args: ['cli', 'send-text', '--pane-id', '7', '--no-paste', '--', '\u0003'], socket: '/tmp/wez.sock' });
  });

  it('does not invoke the CLI without a live socket and rejects non-pane references', async () => {
    const run = vi.fn<WeztermCommandRunner>();
    const provider = createWeztermNativeTerminal({ candidates: () => [], run });
    await expect(provider.listTabs()).resolves.toEqual({ connected: false, tabs: [] });
    await expect(provider.send('surface:1', 'text', false)).resolves.toEqual({ ok: false, error: 'not a WezTerm pane id: surface:1' });
    expect(run).not.toHaveBeenCalled();
  });

  it('normalizes malformed and platform-independent cwd values', () => {
    expect(weztermCwd('file:///C:/Users/name')).toBe('C:/Users/name');
    expect(weztermCwd('file://%')).toBeNull();
    expect(weztermCwd('/repo')).toBe('/repo');
    expect(weztermCwd(null)).toBeNull();
  });

  it('does not send Enter after the pinned socket is replaced', async () => {
    let metadata = socketStat;
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const run = vi.fn<WeztermCommandRunner>(async args => {
      mutableCalls.push([...args]);
      metadata = { ...socketStat, ino: 99n };
      return { code: 0, stdout: '', stderr: '' };
    });
    const provider = createWeztermNativeTerminal({ socketPath: '/tmp/wez.sock', run, startup: 'test', stat: () => metadata });
    await expect(provider.send('7', 'hello', true)).resolves.toEqual({
      ok: false,
      error: 'WezTerm native session changed; text input outcome is uncertain',
    });
    expect(mutableCalls).toEqual([['cli', 'send-text', '--pane-id', '7', '--no-paste', '--', 'hello']]);
  });
});
