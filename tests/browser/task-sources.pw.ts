import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { SourceAdminSourceV1 } from '../../src/plugins/source-admin';

const sourceSettingsManifest = JSON.parse(readFileSync(new URL('../../src/plugins/source-settings/plugin-package.json', import.meta.url), 'utf8')).manifest;

test('selected source-settings package preserves header scope, drafts and durable scheduling', async ({ page, baseURL }) => {
  const writes: { path: string; input: Record<string, unknown> }[] = [];
  let failSources = false;
  const sources: SourceAdminSourceV1[] = [
    { target: { sourceId: '11111111-1111-4111-8111-111111111111', instanceId: 'todos', sourceRevision: 1, instanceRevision: 1 }, label: 'Local todos', desiredEnabled: true, available: true, current: true, identityLevel: 'verified', providerId: 'example.local-todos/todos', allowedRepos: ['org/a', 'org/b'], settingsFields: {}, settings: {}, replacements: [] },
    { target: { sourceId: '22222222-2222-4222-8222-222222222222', instanceId: 'jira', sourceRevision: 1, instanceRevision: 2 }, label: 'Jira', desiredEnabled: false, available: false, current: true, identityLevel: 'operator-seeded', providerId: 'example.jira/issues', allowedRepos: ['org/a', 'org/b'], settingsFields: {}, settings: {}, replacements: [] },
  ];
  const schedules = new Map(['org/a', 'org/b'].map(repo => [repo, { repo, revision: 3, instanceIds: ['todos'] }]));
  const legacy: string[] = [];
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== new URL(baseURL ?? 'http://127.0.0.1:4175').origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body: unknown = {};
    if (['/api/todos', '/api/triage', '/api/bugs', '/api/task-sources'].includes(url.pathname)) legacy.push(url.pathname);
    if (url.pathname === '/api/source-admin/commands' && request.method() === 'POST') {
      const { requestId, ...input } = request.postDataJSON(); writes.push({ path: url.pathname, input });
      const schedule = { repo: input.repo, revision: input.expectedRevision + 1, instanceIds: input.instanceIds }; schedules.set(input.repo, schedule);
      return route.fulfill({ json: { version: 1, requestId, input, status: 'succeeded', result: { kind: 'scheduled', schedule }, message: null } });
    }
    if (url.pathname === '/api/plugins/catalog') body = { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: [{ id: sourceSettingsManifest.id, version: sourceSettingsManifest.version, enabled: true, hash: 'a'.repeat(64) }] };
    if (url.pathname === '/api/context') body = { repos: ['org/a', 'org/b'], jiraBaseUrl: null, jiraEnabled: false };
    if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } };
    if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
    if (url.pathname === '/api/source-admin') {
      if (failSources) return route.fulfill({ status: 503, json: { error: 'Sources temporarily unavailable' } });
      const repo = url.searchParams.get('repo'); const repos = repo ? [repo] : ['org/a', 'org/b'];
      body = { version: 1, repo, repos, sources, schedules: repos.map(repo => schedules.get(repo)), runtimes: repos.map(repo => ({ repo, epoch: '33333333-3333-4333-8333-333333333333', revision: 0, enabled: false })) };
    }
    return route.fulfill({ json: body });
  });
  await page.goto('/config?repo=org/a');
  await page.locator('.section-nav a[href="/source-settings?repo=org%2Fa"]').click();
  const panel = page.locator('.plugin-source-settings').first(); await panel.getByLabel('Source instance', { exact: true }).selectOption('todos');
  await expect(panel.getByRole('button', { name: 'Apply source configuration', exact: true })).toBeEnabled();
  for (const path of ['/todos', '/triage', '/bugs']) await expect(page.locator(`.page-tabs a[href="${path}?repo=org%2Fa"]`)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1800 }); await expect(panel).toHaveScreenshot('task-sources.png', { animations: 'disabled' });
  await panel.getByLabel('Source label', { exact: true }).fill('Draft source name');
  await panel.getByLabel('Administration galleon').selectOption(''); await panel.getByLabel('Administration galleon').selectOption('org/b');
  await expect(panel.getByRole('button', { name: 'Save automatic source selection' })).toBeEnabled();
  await expect(page.locator('.repo-select')).toHaveValue('org/a'); await expect(page).toHaveURL(url => url.searchParams.get('repo') === 'org/a');
  await expect(panel.getByLabel('Source label', { exact: true })).toHaveValue('Draft source name');
  await panel.getByLabel('Schedule Local todos (todos)', { exact: true }).uncheck(); await panel.getByRole('button', { name: 'Save automatic source selection' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ path: '/api/source-admin/commands', input: { version: 1, kind: 'schedule', repo: 'org/b', instanceIds: [], expectedRevision: 3 } });
  await expect(panel.getByRole('button', { name: 'Refresh source settings' })).toBeEnabled(); failSources = true;
  await panel.getByRole('button', { name: 'Refresh source settings' }).click();
  await expect(panel.getByRole('alert')).toContainText('unavailable');
  await expect(panel.getByRole('button', { name: 'Apply source configuration', exact: true })).toHaveCount(0);
  failSources = false;
  await panel.getByRole('button', { name: 'Refresh source settings' }).click();
  await expect(panel.getByLabel('Source label', { exact: true })).toHaveValue('Draft source name');
  await expect(panel.getByRole('button', { name: 'Apply source configuration', exact: true })).toBeEnabled();
  expect(writes).toHaveLength(1); expect(legacy).toEqual([]);
});
