import { expect, it, vi } from 'vitest';
import type { CommunicationSettingsValuesV1 } from './communication';
import { createHostCommunicationService } from './communication-service';

const values: CommunicationSettingsValuesV1 = { enabled: false, watchEnabled: false, clientId: '', channelId: '', channelName: '', browserSurface: '', reviewChannel: '', reviewMention: '' };

it('saves settings only through the settings endpoint and does not invoke a communication command', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ version: 1, revision: 'next', values, destination: null }));
  const lifetime = new AbortController();
  const scope = { repo: 'org/project', epoch: 1, active: true, signal: new AbortController().signal };
  const service = createHostCommunicationService(lifetime.signal, { caller: 'example.communication/panel', scope: () => scope, fetch: fetcher });

  expect(await service.saveSettings({ expectedRevision: 'current', values })).toMatchObject({ status: 'available', value: { revision: 'next' } });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/communication/settings');
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ expectedRevision: 'current', values, scopeRepo: 'org/project' });
});

it('keeps connection actions bound to the displayed provider revision and validates redirect URLs', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ version: 1, authorizationUrl: 'https://slack.com/oauth/v2/authorize?state=opaque' }));
  const scope = { repo: 'org/project', epoch: 1, active: true, signal: new AbortController().signal };
  const service = createHostCommunicationService(new AbortController().signal, { caller: 'example.communication/settings', scope: () => scope, fetch: fetcher });
  const input = { expectedRevision: 'a'.repeat(64) };
  expect(await service.connect!(input)).toMatchObject({ status: 'available' });
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/communication-connection/start');
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(input);
  fetcher.mockResolvedValue(Response.json({ version: 1, authorizationUrl: 'javascript:alert(1)' }));
  expect(await service.connect!(input)).toMatchObject({ status: 'unavailable' });
  fetcher.mockResolvedValue(Response.json({ version: 1, providerId: 'example.slack/slack', revision: input.expectedRevision,
    status: 'connected', message: 'Connected', accountLabel: 'T123/U123', redirectUri: null, accessToken: 'must-not-project' }));
  expect(await service.connectionStatus!()).toMatchObject({ status: 'unavailable' });
});

it('clears only the requested scope and captured cutoff, validates receipts and cancels stale calls', async () => {
  const input = { version: 1 as const, repo: 'org/project', clearToken: '1:captured' };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...input, cleared: 4 }));
  const activity = new AbortController(); const scope = { repo: 'org/project', epoch: 1, active: true, signal: activity.signal };
  const service = createHostCommunicationService(new AbortController().signal, { caller: 'example.communication/panel', scope: () => scope, fetch: fetcher });
  expect(await service.clearNotifications!(input)).toMatchObject({ status: 'available', value: { cleared: 4 } });
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/communication/notifications/clear');
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ ...input, scopeRepo: 'org/project' });
  expect(await service.clearNotifications!({ ...input, repo: null })).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValue(Response.json({ ...input, clearToken: 'different', cleared: 4 }));
  expect(await service.clearNotifications!(input)).toMatchObject({ status: 'unavailable', reason: 'invalid-response' });
  activity.abort(); await expect(service.clearNotifications!(input)).rejects.toThrow();
});
