import { describe, expect, it, vi } from 'vitest';
import { createCommunicationReadService } from './communication-read-service';
import { handleCommunicationApi } from './communication-routes';
import type { Persistence } from './persistence';
import type { CommunicationSettingsValuesV1 } from '../../src/plugins/communication';

function fixture() {
  let values: CommunicationSettingsValuesV1 = { enabled: false, watchEnabled: false, clientId: '', channelId: '', channelName: '', browserSurface: '', reviewChannel: '', reviewMention: '' };
  let readAt: string | null = null;
  const write = vi.fn((next: CommunicationSettingsValuesV1) => { values = next; });
  const markRead = vi.fn((_id: string, now: string) => { readAt = now; return true; });
  const service = createCommunicationReadService({ persistence: { transaction: (work: () => unknown) => work() } as Persistence,
    repos: () => ['org/a', 'org/b'], authorize: caller => { if (caller !== 'example.ui/notifications') throw new Error('Unavailable caller'); },
    values: () => values, destination: () => null, write, markRead,
    snapshot: () => ({ health: { enabled: false, status: 'disabled', channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: null }, notifications: [
      { kind: 'voyage-completed', id: 'voyage-one', repo: 'org/b', title: 'Finished', prNumber: null, prUrl: '', sourceUrl: '/runs?run=run-one',
        author: 'Helmsman', channelName: '', status: 'succeeded', runId: 'run-one', createdAt: '2026-09-20T12:00:00Z', updatedAt: '2026-09-20T12:00:00Z', readAt, error: null },
    ] }),
  });
  return { service, write, markRead };
}
const caller = 'example.ui/notifications';
describe('communication notification and settings authority', () => {
  it('filters by scope and refuses a mark-read request for another galleon', () => {
    const f = fixture();
    expect(f.service.notifications(caller, { version: 1, repo: null, limit: 10 }, 'org/a')).toMatchObject({ unread: 0, notifications: [] });
    expect(() => f.service.markRead(caller, { repo: 'org/a', id: 'voyage-one' }, 'org/a')).toThrow();
    expect(f.markRead).not.toHaveBeenCalled();
    expect(f.service.markRead(caller, { repo: 'org/b', id: 'voyage-one' }, 'org/b').id).toBe('voyage-one');
    f.service.markRead(caller, { repo: 'org/b', id: 'voyage-one' }, 'org/b');
    expect(f.markRead).toHaveBeenCalledTimes(1);
  });
  it('saves empty settings under revision comparison and rejects stale writes', () => {
    const f = fixture(); const original = f.service.settings(caller, null);
    const changed = f.service.saveSettings(caller, { expectedRevision: original.revision, values: { ...original.values, clientId: 'T123' } }, null);
    expect(changed.revision).not.toBe(original.revision);
    expect(() => f.service.saveSettings(caller, { expectedRevision: original.revision, values: original.values }, null)).toThrow('conflict');
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.service.settings(caller, null).values.clientId).toBe('T123');
  });
  it('requires a contribution and rejects duplicate query parameters before service reads', () => {
    const { service } = fixture();
    expect(handleCommunicationApi({ method: 'GET', path: '/api/communication/settings', query: new URLSearchParams(), service })?.status).toBe(403);
    expect(handleCommunicationApi({ method: 'GET', path: '/api/communication/settings', query: new URLSearchParams('scopeRepo=org/a&scopeRepo=org/b'), caller, service })?.status).toBe(400);
  });
});
