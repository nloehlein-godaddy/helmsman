import { afterEach, expect, it, vi } from 'vitest';
import { createHostJiraSettingsService } from './jira-settings-service';
import { createHostGithubSettingsService } from './github-settings-service';
import { JIRA_SETTINGS_SCHEMA_V1, parseJiraSettingsSnapshotV1 } from './jira-settings';
import { GITHUB_SETTINGS_SCHEMA_V1, parseGithubSettingsSaveInputV1 } from './github-settings';
import { onIntegrationSettingsChanged } from '../data/integration-status-events';

const globalScope = { version: 1 as const, scope: 'global' as const };
const jira = { ...globalScope, namespace: 'helmsman.jira/settings' as const, revision: 'a'.repeat(64), tokenSet: true, sourceConfigured: false, bootstrapEnabled: true };
const github = { ...globalScope, namespace: 'helmsman.github/settings' as const, revision: 'b'.repeat(64), tokenSet: false, values: { defaultRepo: 'org/a', author: 'bot', reviewWatchEnabled: false } };
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const fetcher = vi.fn<typeof fetch>(); const lifetime = new AbortController();
  const scope = { repo: 'org/a', active: true, epoch: 1, signal: new AbortController().signal };
  const options = { caller: 'example.settings/panel', scope: () => scope, fetch: fetcher };
  return { fetcher, lifetime, scope, jira: createHostJiraSettingsService(lifetime.signal, options), github: createHostGithubSettingsService(lifetime.signal, options) };
}
it('uses explicit global namespace requests without changing the active header scope', async () => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(Response.json(github));
  expect(await f.github.snapshot(globalScope)).toMatchObject({ status: 'available', value: github });
  expect(f.fetcher.mock.calls[0]?.[0]).toBe('/api/github-settings?version=1&scope=global');
  f.fetcher.mockResolvedValueOnce(Response.json(github));
  const input = { ...globalScope, namespace: github.namespace, expectedRevision: github.revision, values: { ...github.values, reviewWatchEnabled: true } };
  await f.github.save(input); const request = f.fetcher.mock.calls[1]?.[1];
  expect(JSON.parse(String(request?.body))).toEqual(input); expect(request?.headers).toMatchObject({ 'X-Helmsman-Contribution': 'example.settings/panel' }); expect(f.scope.repo).toBe('org/a');
});
it('sends token only in the explicit write request without browser storage, journals or receipt APIs', async () => {
  const f = fixture(); const persist = vi.spyOn(Storage.prototype, 'setItem'); const token = 'ephemeral-private-test-token';
  f.fetcher.mockImplementationOnce(async (url, init) => { expect(url).toBe('/api/jira-settings/token'); expect(init?.method).toBe('POST'); expect(JSON.parse(String(init?.body)).token).toBe(token); return Response.json(jira); });
  const result = await f.jira.rotateToken({ ...globalScope, namespace: jira.namespace, expectedRevision: jira.revision, token });
  expect(result).toEqual({ status: 'available', value: jira }); expect(JSON.stringify(result)).not.toContain(token); expect(persist).not.toHaveBeenCalled(); expect(Object.keys(f.jira).sort()).toEqual(['rotateToken', 'snapshot', 'version']);
});
it('does not retry token rotations after response loss and returns conflict without replacing the caller revision', async () => {
  const f = fixture(); const token = 'single-attempt-test-token'; const input = { ...globalScope, namespace: jira.namespace, expectedRevision: jira.revision, token };
  f.fetcher.mockRejectedValueOnce(new Error(token)); expect(await f.jira.rotateToken(input)).toEqual({ status: 'unavailable', reason: 'connection-failed' });
  expect(f.fetcher).toHaveBeenCalledTimes(1); f.fetcher.mockResolvedValueOnce(Response.json({ reason: 'conflict', token }, { status: 409 }));
  expect(await f.jira.rotateToken(input)).toEqual({ status: 'unavailable', reason: 'conflict' }); expect(input.expectedRevision).toBe(jira.revision);
});
it('rejects secret-bearing responses and malformed namespace/scope inputs without exposing response contents', async () => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(Response.json({ ...jira, token: 'server-must-not-return' }));
  expect(await f.jira.snapshot(globalScope)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  await expect(f.jira.rotateToken({ ...globalScope, namespace: jira.namespace, expectedRevision: jira.revision, token: 'bad token' })).rejects.toThrow('Invalid source contract data');
  expect(() => parseJiraSettingsSnapshotV1({ ...jira, scope: 'org/a' })).toThrow();
  expect(() => parseGithubSettingsSaveInputV1({ ...globalScope, namespace: jira.namespace, expectedRevision: github.revision, values: github.values })).toThrow();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('publishes bounded namespaced metadata without credential defaults or read values', () => {
  expect(JIRA_SETTINGS_SCHEMA_V1.fields.token).toMatchObject({ maxLength: 8192, writeOnly: true, persistInBrowser: false });
  expect(JIRA_SETTINGS_SCHEMA_V1.fields.token).not.toHaveProperty('default'); expect(GITHUB_SETTINGS_SCHEMA_V1.namespace).toBe(github.namespace);
  expect(() => parseGithubSettingsSaveInputV1({ ...globalScope, namespace: github.namespace, expectedRevision: github.revision, values: { ...github.values, author: 'x'.repeat(101) } })).toThrow();
});
it('cancels a global settings response when its contribution is no longer active', async () => {
  const f = fixture(); f.fetcher.mockImplementationOnce(async () => { f.scope.active = false; f.scope.epoch++; return Response.json(jira); });
  await expect(f.jira.snapshot(globalScope)).rejects.toMatchObject({ name: 'AbortError' });
});
it('refreshes connection status only after successful saves, retaining committed results if a listener fails', async () => {
  const f = fixture(); const listener = vi.fn();
  onIntegrationSettingsChanged(listener, f.lifetime.signal);
  onIntegrationSettingsChanged(() => { throw new Error('View disposed'); }, f.lifetime.signal);
  const input = { ...globalScope, namespace: jira.namespace, expectedRevision: jira.revision, token: 'ephemeral-token' };
  f.fetcher.mockResolvedValueOnce(Response.json(jira));
  expect(await f.jira.rotateToken(input)).toMatchObject({ status: 'available' });
  expect(listener).toHaveBeenCalledTimes(1);
  f.fetcher.mockRejectedValueOnce(new Error('Connection lost'));
  expect(await f.jira.rotateToken(input)).toMatchObject({ status: 'unavailable' });
  expect(listener).toHaveBeenCalledTimes(1);
  f.fetcher.mockResolvedValueOnce(Response.json(github));
  await f.github.save({ ...globalScope, namespace: github.namespace, expectedRevision: github.revision, values: github.values });
  expect(listener).toHaveBeenCalledTimes(2);
  f.lifetime.abort();
});
