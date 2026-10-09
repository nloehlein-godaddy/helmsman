import { describe, expect, it, vi } from 'vitest';
import { createIntegrationStatusController, parseIntegrationStatus } from './integration-status';

const snapshot = { version: 1, repo: 'org/a', jira: 'available', github: 'not-configured', checkedAt: '2026-10-09T00:00:00.000Z' };

describe('integration status client', () => {
  it.each([null, {}, { ...snapshot, repo: 'org/b' }, { ...snapshot, jira: 'connected' }, { ...snapshot, checkedAt: null }, { ...snapshot, token: 'secret' }])('rejects malformed or mismatched status %j', value => {
    expect(parseIntegrationStatus(value, 'org/a')).toBeNull();
  });

  it('reports checking, caches results, and refreshes explicitly', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(snapshot));
    const changed = vi.fn();
    const controller = createIntegrationStatusController(changed, { fetcher });
    await controller.refresh('org/a');
    expect(changed.mock.calls[0]?.[0]).toEqual({ repo: 'org/a', jira: 'checking', github: 'checking' });
    expect(changed).toHaveBeenLastCalledWith(snapshot);
    await controller.refresh('org/a');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await controller.refresh('org/a', true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('ignores a late response for the previous header galleon', async () => {
    let resolve: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockResolvedValueOnce(Response.json({ ...snapshot, repo: 'org/b', github: 'available' }));
    const changed = vi.fn();
    const controller = createIntegrationStatusController(changed, { fetcher });
    const old = controller.refresh('org/a');
    await controller.refresh('org/b');
    resolve?.(Response.json(snapshot));
    await old;
    expect(changed).toHaveBeenLastCalledWith({ ...snapshot, repo: 'org/b', github: 'available' });
    expect(changed.mock.calls.filter(([value]) => value.repo === 'org/a')).toEqual([[{ repo: 'org/a', jira: 'checking', github: 'checking' }]]);
    controller.dispose();
  });

  it('shows unknown instead of upstream errors and suppresses updates after disposal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Private upstream text'));
    const changed = vi.fn();
    const controller = createIntegrationStatusController(changed, { fetcher });
    await controller.refresh('org/a');
    expect(changed).toHaveBeenLastCalledWith({ repo: 'org/a', jira: 'unknown', github: 'unknown' });
    controller.dispose();
    await controller.refresh('org/b');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('forces a fresh same-scope request when credentials are saved during a pending check', async () => {
    let resolve: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockResolvedValueOnce(Response.json({ ...snapshot, github: 'available' }));
    const changed = vi.fn();
    const controller = createIntegrationStatusController(changed, { fetcher });
    const old = controller.refresh('org/a');
    await controller.refresh('org/a', true);
    resolve?.(Response.json({ ...snapshot, github: 'unavailable' }));
    await old;
    expect(changed).toHaveBeenLastCalledWith({ ...snapshot, github: 'available' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});
