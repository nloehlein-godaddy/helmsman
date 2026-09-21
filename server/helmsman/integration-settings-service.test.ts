import { afterEach, expect, it, vi } from 'vitest';
import { createIntegrationSettingsService, type IntegrationSettingsServerOptions } from './integration-settings-service';
import { handleIntegrationSettingsApi } from './integration-settings-routes';
import { githubSettingsContributionEnabled, jiraSettingsContributionEnabled } from './integration-settings-runtime';
import { builtinFrontendManifests } from '../../src/plugins/frontend-manifests';
import type { PluginCatalog } from '../../src/plugins/runtime';
import { openPersistence, type Persistence } from './persistence';
import { openDb } from './db';
import { ConfigStore } from './config-store';
import { ClarificationServiceError } from './clarification-service-common';

const githubCaller = 'example.settings/github'; const jiraCaller = 'example.settings/jira'; const query = { version: 1 as const, scope: 'global' as const };
const stores: Persistence[] = []; afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const persistence = openPersistence(':memory:'); stores.push(persistence); const config = new ConfigStore({ GITHUB_REPO: 'org/a', GITHUB_PR_AUTHOR: 'bot', JIRA_API_TOKEN: 'initial-test-token' }, openDb(persistence.sql));
  const now = () => '2026-09-22T00:00:00.000Z'; const callback = vi.fn(() => { expect(persistence.sql.inTransaction).toBe(false); });
  const options: IntegrationSettingsServerOptions = { persistence,
    githubValues() { const env = config.effectiveEnv(); return { defaultRepo: env.GITHUB_REPO ?? '', author: env.GITHUB_PR_AUTHOR ?? '', reviewWatchEnabled: env.GITHUB_REVIEW_WATCH_ENABLED === 'true' }; },
    writeGithub(values) { config.setOverride('GITHUB_REPO', values.defaultRepo, now); config.setOverride('GITHUB_PR_AUTHOR', values.author, now); config.setOverride('GITHUB_REVIEW_WATCH_ENABLED', String(values.reviewWatchEnabled), now); },
    githubTokenSet: () => !!config.effectiveEnv().GITHUB_TOKEN, jiraTokenSet: () => config.hasJiraToken(), writeJiraToken: token => config.setSecret('JIRA_API_TOKEN', token, now),
    sourceConfigured: () => false, bootstrapEnabled: () => true,
    authorize(caller, namespace) { if (caller !== (namespace === 'helmsman.github/settings' ? githubCaller : jiraCaller)) throw new ClarificationServiceError(403, 'forbidden'); }, afterGithubSave: callback,
  };
  const service = createIntegrationSettingsService(options);
  return { persistence, config, options, service, callback };
}
it('reads effective GitHub values without credentials and independently authorizes namespaced global settings', () => {
  const f = fixture(); expect(f.config.current().github).toBeNull();
  expect(f.service.githubSnapshot(githubCaller, query)).toMatchObject({ scope: 'global', namespace: 'helmsman.github/settings', tokenSet: false, values: { defaultRepo: 'org/a', author: 'bot', reviewWatchEnabled: false } });
  expect(() => f.service.githubSnapshot(jiraCaller, query)).toThrow('forbidden');
  expect(() => f.service.jiraSnapshot(githubCaller, query)).toThrow('forbidden');
  expect(() => f.service.githubSnapshot(githubCaller, { version: 1, scope: 'org/a' })).toThrow();
});
it('allows only one concurrent CAS save and notifies the watcher after commit', async () => {
  const f = fixture(); const original = f.service.githubSnapshot(githubCaller, query);
  const save = (author: string) => Promise.resolve().then(() => f.service.saveGithub(githubCaller, { ...query, namespace: original.namespace, expectedRevision: original.revision, values: { ...original.values, author } }));
  const outcomes = await Promise.allSettled([save('first'), save('second')]);
  expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'rejected']); expect(f.callback).toHaveBeenCalledTimes(1);
  const saved = f.service.githubSnapshot(githubCaller, query); expect(saved.values.author).toBe('first'); expect(saved.revision).not.toBe(original.revision);
});
it('rolls back multi-field settings and revision on a failed write', () => {
  const f = fixture(); const service = createIntegrationSettingsService({ ...f.options, writeGithub(values) { f.config.setOverride('GITHUB_REPO', values.defaultRepo, () => '2026-09-22T00:00:00Z'); throw new Error('write failed'); } });
  const original = service.githubSnapshot(githubCaller, query);
  expect(() => service.saveGithub(githubCaller, { ...query, namespace: original.namespace, expectedRevision: original.revision, values: { ...original.values, defaultRepo: 'org/b' } })).toThrow('write failed');
  expect(service.githubSnapshot(githubCaller, query)).toEqual(original); expect(f.callback).not.toHaveBeenCalled(); expect(f.config.effectiveEnv().GITHUB_REPO).toBe('org/a');
});
it('rotates tokens without returning or retaining them outside ConfigStore and changes the credential revision even for identical tokens', () => {
  const f = fixture(); const original = f.service.jiraSnapshot(jiraCaller, query); const token = 'replacement-private-test-token';
  const body = { ...query, namespace: original.namespace, expectedRevision: original.revision, token };
  const result = handleIntegrationSettingsApi({ service: f.service, caller: jiraCaller, method: 'POST', path: '/api/jira-settings/token', query: new URLSearchParams(), body });
  expect(result?.status).toBe(200); expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain('initial-test-token'); expect(f.config.effectiveEnv().JIRA_API_TOKEN).toBe(token);
  const next = f.service.jiraSnapshot(jiraCaller, query); expect(next.revision).not.toBe(original.revision);
  expect(() => f.service.rotateJiraToken(jiraCaller, body)).toThrow('conflict');
  const same = f.service.rotateJiraToken(jiraCaller, { ...body, expectedRevision: next.revision }); expect(same.revision).not.toBe(next.revision);
  expect(f.persistence.sql.prepare('SELECT * FROM integration_settings_revisions').all()).toEqual([{ namespace: 'helmsman.jira/settings', revision: 2 }]);
  expect(f.callback).not.toHaveBeenCalled();
});
it('rolls back a token if its revision cannot commit and redacts unexpected write errors', () => {
  const f = fixture(); const original = f.service.jiraSnapshot(jiraCaller, query); const token = 'never-echo-this-test-token';
  f.persistence.sql.exec("CREATE TRIGGER reject_settings_marker BEFORE INSERT ON integration_settings_revisions BEGIN SELECT RAISE(ABORT,'marker failed'); END");
  const result = handleIntegrationSettingsApi({ service: f.service, caller: jiraCaller, method: 'POST', path: '/api/jira-settings/token', query: new URLSearchParams(), body: { ...query, namespace: original.namespace, expectedRevision: original.revision, token } });
  expect(result).toEqual({ status: 503, json: { reason: 'service-unavailable' } }); expect(f.service.jiraSnapshot(jiraCaller, query)).toEqual(original); expect(f.config.effectiveEnv().JIRA_API_TOKEN).toBe('initial-test-token');
  const failing = createIntegrationSettingsService({ ...f.options, writeJiraToken(value) { throw new Error(value); } }); const snapshot = failing.jiraSnapshot(jiraCaller, query);
  const error = handleIntegrationSettingsApi({ service: failing, caller: jiraCaller, method: 'POST', path: '/api/jira-settings/token', query: new URLSearchParams(), body: { ...query, namespace: snapshot.namespace, expectedRevision: snapshot.revision, token } });
  expect(JSON.stringify(error)).not.toContain(token);
});
it('invalidates old revisions across service startup and rejects namespace, scope and query injection', () => {
  const f = fixture(); const snapshot = f.service.jiraSnapshot(jiraCaller, query); const restarted = createIntegrationSettingsService(f.options);
  expect(() => restarted.rotateJiraToken(jiraCaller, { ...query, namespace: snapshot.namespace, expectedRevision: snapshot.revision, token: 'unused' })).toThrow('conflict');
  for (const body of [{ ...query, namespace: 'helmsman.github/settings', expectedRevision: snapshot.revision, token: 'unused' }, { ...query, namespace: snapshot.namespace, expectedRevision: snapshot.revision, token: 'unused', repo: 'org/a' }, { ...query, namespace: snapshot.namespace, expectedRevision: snapshot.revision, token: 'bad token' }])
    expect(handleIntegrationSettingsApi({ service: f.service, caller: jiraCaller, method: 'POST', path: '/api/jira-settings/token', query: new URLSearchParams(), body })?.status).toBe(400);
  expect(handleIntegrationSettingsApi({ service: f.service, caller: jiraCaller, method: 'GET', path: '/api/jira-settings', query: new URLSearchParams('version=1&scope=global&scope=org/a') })?.status).toBe(400);
  expect(f.service.jiraSnapshot(jiraCaller, query)).toEqual(snapshot);
});
it('keeps settings contributions available with their integration providers disabled', () => {
  const selected = builtinFrontendManifests.filter(manifest => ['helmsman.jira-settings', 'helmsman.github-settings'].includes(manifest.id)); expect(selected).toHaveLength(2);
  const catalog: PluginCatalog = { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: selected.map(manifest => ({ id: manifest.id, version: manifest.version, enabled: true, hash: 'a'.repeat(64) })) };
  for (const manifest of selected) {
    const panel = manifest.manifestVersion === 2 ? manifest.panels[0] : undefined; if (!panel) throw new Error('Settings panel missing'); const caller = `${manifest.id}/${panel.id}`;
    expect(manifest.id === 'helmsman.jira-settings' ? jiraSettingsContributionEnabled(catalog, caller) : githubSettingsContributionEnabled(catalog, caller)).toBe(true);
    expect(jiraSettingsContributionEnabled({ ...catalog, safeMode: true }, caller)).toBe(false);
  }
});
