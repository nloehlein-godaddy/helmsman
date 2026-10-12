import { describe, expect, it, vi } from 'vitest';
import { createVpnStatusController, parseVpnStatus } from './vpn-status';

const snapshot = { version: 1, state: 'connected', client: 'connected', network: 'not-configured', checkedAt: '2026-10-11T00:00:00Z' };

describe('VPN status client', () => {
  it.each([null, {}, { ...snapshot, state: 'available' }, { ...snapshot, client: null }, { ...snapshot, network: 'unknown' }, { ...snapshot, checkedAt: 'invalid' }, { ...snapshot, secret: 'private' }])('rejects invalid snapshots %j', input => {
    expect(parseVpnStatus(input)).toBeNull();
  });

  it('deduplicates globally and checks once a minute', async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(snapshot));
    const changed = vi.fn();
    const controller = createVpnStatusController(changed, { fetcher, now: () => now });
    await Promise.all([controller.refresh(), controller.refresh()]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('/api/vpn-status', expect.objectContaining({ credentials: 'same-origin' }));
    expect(changed.mock.calls[0]?.[0]).toEqual({ state: 'checking' });
    expect(changed).toHaveBeenLastCalledWith(snapshot);
    now = 59_999;
    await controller.refresh();
    expect(fetcher).toHaveBeenCalledOnce();
    now = 60_000;
    await controller.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('clears stale connected evidence after failure and waits a minute before retrying', async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(snapshot)).mockRejectedValue(new Error('Private details'));
    const changed = vi.fn();
    const controller = createVpnStatusController(changed, { fetcher, now: () => now });
    await controller.refresh();
    now = 60_000;
    await controller.refresh();
    expect(changed).toHaveBeenLastCalledWith({ state: 'unknown' });
    await controller.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('ignores late responses after disposal', async () => {
    let resolve: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(done => { resolve = done; }));
    const changed = vi.fn();
    const controller = createVpnStatusController(changed, { fetcher });
    const pending = controller.refresh();
    controller.dispose();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    resolve?.(Response.json(snapshot));
    await pending;
    await controller.refresh();
    expect(changed).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
