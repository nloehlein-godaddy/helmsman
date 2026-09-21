import { expect, it, vi } from 'vitest';
import { parseProfileIdentityV1, parseProfileSnapshotInputV1, parseProfileSnapshotV1 } from './profile';
import { createHostProfileService } from './profile-service';

const input = { version: 1 as const, scope: 'global' as const };
const snapshot = { ...input, profile: { displayName: 'Person', login: 'person' } };
function fixture() {
  const fetcher = vi.fn<typeof fetch>(); const lifetime = new AbortController();
  const scope = { repo: 'org/a', active: true, epoch: 1, signal: new AbortController().signal };
  return { fetcher, lifetime, scope, service: createHostProfileService(lifetime.signal, { caller: 'example.profile/header', scope: () => scope, fetch: fetcher }) };
}
it('reads an explicitly global identity through contribution authorization', async () => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(Response.json(snapshot));
  expect(await f.service.snapshot(input)).toEqual({ status: 'available', value: snapshot });
  expect(f.fetcher).toHaveBeenCalledWith('/api/profile?version=1&scope=global', expect.objectContaining({ method: 'GET', credentials: 'same-origin', headers: expect.objectContaining({ 'X-Helmsman-Contribution': 'example.profile/header' }) }));
});
it('rejects unexpected profile data, invalid scopes and unbounded identity fields', async () => {
  expect(parseProfileIdentityV1({ displayName: null, login: null })).toEqual({ displayName: null, login: null });
  for (const profile of [null, {}, { displayName: 'a'.repeat(257), login: null }, { displayName: null, login: 'a'.repeat(129) }, { displayName: 'bad\nname', login: null }, { displayName: '', login: null }, { displayName: null, login: null, token: 'private' }]) expect(() => parseProfileIdentityV1(profile)).toThrow();
  expect(() => parseProfileSnapshotInputV1({ ...input, scope: 'org/a' })).toThrow();
  expect(() => parseProfileSnapshotV1({ ...snapshot, token: 'private' })).toThrow();
  const f = fixture(); f.fetcher.mockResolvedValueOnce(Response.json({ ...snapshot, profile: { ...snapshot.profile, token: 'private' } }));
  expect(await f.service.snapshot(input)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
});
it('cancels stale and disposed contributions without returning their identities', async () => {
  const f = fixture(); f.fetcher.mockImplementationOnce(async () => { f.scope.epoch++; return Response.json(snapshot); });
  await expect(f.service.snapshot(input)).rejects.toMatchObject({ name: 'AbortError' });
  f.lifetime.abort(); await expect(f.service.snapshot(input)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
