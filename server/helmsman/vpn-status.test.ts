import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGlobalProtectCheck, createVpnStatusService, handleVpnStatusApi, type VpnState } from './vpn-status';
import type { networkInterfaces } from 'node:os';

afterEach(() => vi.useRealTimers());
const interfaces = (active: boolean): ReturnType<typeof networkInterfaces> => ({
  utun3: active ? [{ address: '10.0.0.12', netmask: '255.255.255.255', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '10.0.0.12/32' }] : [],
});

describe('GlobalProtect local evidence', () => {
  it.each([
    ['connected', true, 'connected'], ['connected', false, 'unknown'],
    ['disconnected', false, 'disconnected'], ['disconnected', true, 'unknown'], ['connecting', true, 'unknown'],
  ] as const)('combines %s client evidence and live tunnel %s into %s', async (status, active, expected) => {
    const read = vi.fn(async (key: string) => key === 'tunnel-status' ? status : 'ipv4=10.0.0.12,ipv6=');
    const check = createGlobalProtectCheck({ platform: 'darwin', read, interfaces: () => interfaces(active) });
    expect(await check(new AbortController().signal)).toBe(expected);
    expect(read.mock.calls.map(([key]) => key)).toEqual(status === 'connecting' ? ['tunnel-status'] : ['tunnel-status', 'tunnel-ip']);
  });
  it.each(['missing', 'empty'] as const)('honors explicit disconnected status with a %s tunnel address', async format => {
    const check = createGlobalProtectCheck({ platform: 'darwin', read: async key => {
      if (key === 'tunnel-status') return 'disconnected';
      if (format === 'missing') throw new Error('Entry does not exist');
      return '';
    }, interfaces: () => interfaces(true) });
    expect(await check(new AbortController().signal)).toBe('disconnected');
  });
  it('requires a live matching address for connected status and preserves unknown on cancellation', async () => {
    const controller = new AbortController();
    const read = vi.fn(async (key: string) => { if (key === 'tunnel-status') return 'connected'; throw new Error('Missing tunnel address'); });
    expect(await createGlobalProtectCheck({ platform: 'darwin', read, interfaces: () => interfaces(true) })(controller.signal)).toBe('unknown');
    read.mockImplementation(async key => { if (key === 'tunnel-status') return 'disconnected';controller.abort();throw new Error('Aborted'); });
    expect(await createGlobalProtectCheck({ platform: 'darwin', read })(controller.signal)).toBe('unknown');
  });
  it('does not treat physical interfaces or arbitrary utun presence as a matching VPN tunnel', async () => {
    const check = createGlobalProtectCheck({ platform: 'darwin', read: async key => key === 'tunnel-status' ? 'connected' : 'ipv4=10.0.0.13,ipv6=', interfaces: () => interfaces(true) });
    expect(await check(new AbortController().signal)).toBe('unknown');
  });
  it('returns unknown on missing client evidence and unsupported hosts without exposing errors', async () => {
    const read = vi.fn(async () => { throw new Error('private data'); });
    expect(await createGlobalProtectCheck({ platform: 'darwin', read })(new AbortController().signal)).toBe('unknown');
    read.mockClear();
    expect(await createGlobalProtectCheck({ platform: 'linux', read })(new AbortController().signal)).toBe('unknown');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('global VPN status', () => {
  it.each([
    ['connected', false, 'unknown'], ['connected', true, 'connected'],
    ['disconnected', false, 'disconnected'], ['disconnected', true, 'unknown'], ['unknown', true, 'unknown'],
  ] as const)('combines client %s and reachability %s without guessing: %s', async (client, reachable, state) => {
    const fetcher = vi.fn<typeof fetch>(async () => { if (!reachable) throw new Error('private upstream failure'); return new Response(null, { status: 401 }); });
    const service = createVpnStatusService({ client: async () => client, checkUrl: 'https://vpn-only.example/health', fetcher });
    expect(await service.snapshot()).toMatchObject({ version: 1, state, client, network: reachable ? 'reachable' : 'unreachable' });
    expect(fetcher).toHaveBeenCalledWith(new URL('https://vpn-only.example/health'), expect.objectContaining({ method: 'HEAD', credentials: 'omit', redirect: 'error' }));
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });
  it.each([undefined, 'https://user:secret@example.test', 'http://example.test', 'https://example.test/?token=secret', 'invalid'])('does not probe an absent or unsafe URL %s', async checkUrl => {
    const fetcher = vi.fn<typeof fetch>();
    const service = createVpnStatusService({ client: async () => 'connected', checkUrl, fetcher });
    expect(await service.snapshot()).toMatchObject({ state: 'connected', network: 'not-configured' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent global checks and expires the cache after 60 seconds', async () => {
    let now = Date.parse('2026-10-11T00:00:00Z');
    const client = vi.fn(async (): Promise<VpnState> => 'connected');
    const service = createVpnStatusService({ client, now: () => now });
    const [first, second] = await Promise.all([service.snapshot(), service.snapshot()]);
    expect(first).toEqual(second);expect(first.checkedAt).toBe('2026-10-11T00:00:00.000Z');expect(client).toHaveBeenCalledOnce();
    now += 59_999;await service.snapshot();expect(client).toHaveBeenCalledOnce();
    now += 1;await service.snapshot();expect(client).toHaveBeenCalledTimes(2);
  });
  it('expires from check start so slow providers do not skip the next minute', async () => {
    const start = Date.parse('2026-10-11T00:00:00Z'); let now = start;
    const client = vi.fn(async (): Promise<VpnState> => { now += 2000; return 'connected'; });
    const service = createVpnStatusService({ client, now: () => now });
    expect((await service.snapshot()).checkedAt).toBe('2026-10-11T00:00:02.000Z');
    now = start + 59_999; await service.snapshot(); expect(client).toHaveBeenCalledOnce();
    now = start + 60_000; await service.snapshot(); expect(client).toHaveBeenCalledTimes(2);
  });
  it('bounds client and network providers that ignore cancellation', async () => {
    vi.useFakeTimers();
    const service = createVpnStatusService({ client: () => new Promise(() => {}), fetcher: () => new Promise(() => {}), checkUrl: 'https://vpn-only.example', timeoutMs: 100 });
    const pending = service.snapshot();await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ state: 'unknown', client: 'unknown', network: 'unreachable' });
  });
  it('rejects scope and non-read methods without invoking providers', async () => {
    const client = vi.fn(async (): Promise<VpnState> => 'connected');const service = createVpnStatusService({ client });
    for (const [method, query, status] of [['GET', 'repo=org/a', 400], ['POST', '', 405]] as const) {
      expect(await handleVpnStatusApi({ method, path: '/api/vpn-status', query: new URLSearchParams(query), service })).toMatchObject({ status });
    }
    expect(client).not.toHaveBeenCalled();
    expect(await handleVpnStatusApi({ method: 'GET', path: '/api/vpn-status', query: new URLSearchParams(), service })).toMatchObject({ status: 200, json: { state: 'connected' } });
    expect(await handleVpnStatusApi({ method: 'GET', path: '/api/vpn-status', query: new URLSearchParams() })).toMatchObject({ status: 503 });
  });
});
