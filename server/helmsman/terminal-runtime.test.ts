import { expect, it } from 'vitest';
import { createTerminalSessionIdentity, resolveCmuxSocket, type TerminalSocketStat } from './terminal-runtime';

const base: TerminalSocketStat = { dev: 1n, ino: 2n, ctimeNs: 3n, mtimeNs: 4n, birthtimeNs: 5n };
it('binds terminal revisions to socket replacement, chosen destination and application startup', () => {
  let metadata = base; let path = '/sockets/cmux';
  const options = { kind: 'cmux', socket: () => path, startup: 'first', stat: () => metadata };
  const identity = createTerminalSessionIdentity(options); const original = identity(); expect(identity()).toBe(original);
  metadata = { ...base, ino: 9n }; expect(identity()).not.toBe(original);
  metadata = base; path = '/sockets/other'; expect(identity()).not.toBe(original);
  path = '/sockets/cmux'; expect(createTerminalSessionIdentity({ ...options, startup: 'next' })()).not.toBe(original);
});
it('uses directory generation when Windows cannot stat sockets and fails closed if neither can be inspected', () => {
  let metadata = base;
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  const identity = createTerminalSessionIdentity({ kind: 'wezterm', startup: 'test', socket: () => '/runtime/gui-sock-10', stat: path => { if (path.endsWith('gui-sock-10')) throw denied; return metadata; } });
  const before = identity(); metadata = { ...base, mtimeNs: 40n, ctimeNs: 40n }; expect(identity()).not.toBe(before);
  expect(() => createTerminalSessionIdentity({ kind: 'wezterm', socket: () => '/runtime/gui-sock-10', stat: () => { throw denied; } })()).toThrow('denied');
});
it('pins explicit cmux sockets and uses supported defaults without CLI auto-discovery', () => {
  expect(resolveCmuxSocket({ CMUX_SOCKET_PATH: '/custom/socket' }, '/home', () => true)).toBe('/custom/socket');
  expect(resolveCmuxSocket({}, '/home', path => path === '/home/.local/state/cmux/cmux.sock')).toBe('/home/.local/state/cmux/cmux.sock');
  expect(resolveCmuxSocket({}, '/home', path => path === '/home/.config/cmux/cmux.sock')).toBe('/home/.config/cmux/cmux.sock');
  expect(resolveCmuxSocket({}, '/home', () => false)).toBe('/home/.local/state/cmux/cmux.sock');
});
