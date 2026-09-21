import { afterEach, expect, it, vi } from 'vitest';
import type { PluginCatalog } from '../../src/plugins/runtime';
import type { ProfileIdentityV1 } from '../../src/plugins/profile';
import { ClarificationServiceError } from './clarification-service-common';
import { handleProfileApi } from './profile-routes';
import { profileContributionEnabled } from './profile-runtime';
import { createProfileService } from './profile-service';

const caller = 'example.profile/header'; const input = { version: 1, scope: 'global' };
const profile = { displayName: 'Person', login: 'person' };
afterEach(() => vi.useRealTimers());
function fixture(overrides: Partial<Parameters<typeof createProfileService>[0]> = {}) {
  const authorize = vi.fn(); const read = vi.fn(async () => profile);
  const service = createProfileService({ authorize, read, ...overrides });
  const request = (value: Partial<Parameters<typeof handleProfileApi>[0]> = {}) => handleProfileApi({ method: 'GET', path: '/api/profile', query: new URLSearchParams('version=1&scope=global'), caller, service, ...value });
  return { authorize, read, service, request };
}
it('authorizes before reading and again before releasing a bounded global identity', async () => {
  const f = fixture(); expect(await f.request()).toEqual({ status: 200, json: { ...input, profile } });
  expect(f.authorize).toHaveBeenCalledTimes(2); expect(f.read).toHaveBeenCalledOnce();
  expect(await f.request({ caller: undefined })).toEqual({ status: 403, json: { reason: 'forbidden' } });
  expect(await f.request({ caller: 'invalid' })).toEqual({ status: 403, json: { reason: 'forbidden' } });
  expect(f.read).toHaveBeenCalledOnce();
  const denied = fixture({ authorize: () => { throw new ClarificationServiceError(403, 'forbidden'); } });
  expect((await denied.request())?.status).toBe(403); expect(denied.read).not.toHaveBeenCalled();
});
it('rejects malformed protocol requests before reading', async () => {
  const f = fixture();
  for (const query of ['scope=global', 'version=1&scope=org/a', 'version=1&scope=global&scope=global', 'version=1&scope=global&token=private']) expect((await f.request({ query: new URLSearchParams(query) }))?.status).toBe(400);
  expect((await f.request({ method: 'POST' }))?.status).toBe(405);
  expect(await f.request({ path: '/other' })).toBeNull(); expect(f.read).not.toHaveBeenCalled();
});
it('redacts provider failures and invalid identity output', async () => {
  for (const read of [async () => { throw new Error('private-token'); }, async () => ({ ...profile, token: 'private-token' }), async () => null as unknown as ProfileIdentityV1]) {
    expect(await fixture({ read }).request()).toEqual({ status: 503, json: { reason: 'service-unavailable' } });
  }
  let allowed = true;
  const f = fixture({ authorize: () => { if (!allowed) throw new ClarificationServiceError(403, 'forbidden'); }, read: async () => { allowed = false; return profile; } });
  expect((await f.request())?.status).toBe(403);
});
it('bounds providers that ignore cancellation and prevents pre-aborted reads', async () => {
  vi.useFakeTimers(); let providerSignal: AbortSignal | undefined;
  const f = fixture({ timeoutMs: 10, read: async signal => { providerSignal = signal; return new Promise(() => {}); } });
  const pending = f.request(); await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toEqual({ status: 503, json: { reason: 'service-unavailable' } }); expect(providerSignal?.aborted).toBe(true);
  const controller = new AbortController(); controller.abort(new Error('private cancellation'));
  const cancelled = fixture(); expect((await cancelled.request({ signal: controller.signal }))?.status).toBe(503); expect(cancelled.read).not.toHaveBeenCalled();
  const active = new AbortController(); const inflight = f.request({ signal: active.signal }); await Promise.resolve();
  active.abort(new Error('private cancellation'));
  expect(await inflight).toEqual({ status: 503, json: { reason: 'service-unavailable' } }); expect(providerSignal?.aborted).toBe(true);
  expect(() => createProfileService({ authorize() {}, read: async () => profile, timeoutMs: Infinity })).toThrow();
});
it('accepts enabled profile contributions and denies missing capability and safe mode', () => {
  const manifest = { id: 'example.profile', manifestVersion: 2, pages: [], panels: [{ id: 'header', requires: [{ id: 'helmsman/profile', version: 1 }] }] };
  const catalog = { safeMode: false, plugins: [{ package: { manifest } }] } as unknown as PluginCatalog;
  expect(profileContributionEnabled(catalog, caller)).toBe(true);
  expect(profileContributionEnabled(catalog, 'example.profile/other')).toBe(false);
  expect(profileContributionEnabled({ ...catalog, safeMode: true }, caller)).toBe(false);
  manifest.panels[0]!.requires = []; expect(profileContributionEnabled(catalog, caller)).toBe(false);
});
