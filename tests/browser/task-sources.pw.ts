import { expect, test } from '@playwright/test';

test('independent sources preserve header scope, drafts and explicit scheduling', async ({ page }) => {
  const writes: { path: string; repo: string | null; body: unknown }[] = [];
  let failSources = false;
  const sources = [
    { id: 'todos', sourceId: 'local-collection', label: 'Local todos', revision: 1, desiredEnabled: true, available: true, identityLevel: 'verified', commands: ['create', 'update', 'delete'], providerId: 'example.local-todos/todos', allowedRepos: ['org/a', 'org/b'], settings: {} },
    { id: 'jira', sourceId: 'jira-site', label: 'Jira', revision: 2, desiredEnabled: false, available: false, identityLevel: 'operator-seeded', commands: [], providerId: 'example.jira/issues', allowedRepos: ['org/a', 'org/b'], settings: { project: 'TEAM' } },
  ];
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body: unknown = {};
    if (request.method() === 'POST') {
      writes.push({ path: url.pathname, repo: url.searchParams.get('repo'), body: request.postDataJSON() });
      const input = request.postDataJSON();
      return route.fulfill({ json: { repo: url.searchParams.get('repo'), instanceIds: input.instanceIds, revision: input.revision + 1 } });
    }
    if (url.pathname === '/api/plugins/catalog') body = { version: 1, safeMode: false, plugins: [], bindings: {} };
    if (url.pathname === '/api/context') body = { repos: ['org/a', 'org/b'], jiraBaseUrl: null, jiraEnabled: false };
    if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } };
    if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
    if (url.pathname === '/api/task-sources') {
      if (failSources) return route.fulfill({ status: 503, json: { error: 'Sources temporarily unavailable' } });
      body = { instances: sources };
    }
    if (url.pathname === '/api/task-sources/schedule') body = { repo: url.searchParams.get('repo'), revision: 3, instanceIds: ['todos'] };
    return route.fulfill({ json: body });
  });
  await page.goto('/config?repo=org/a');
  const panel = page.locator('[data-task-source-settings]');
  await expect(panel.getByRole('button', { name: 'Save source' }).first()).toBeEnabled();
  await expect(page.locator('[data-view="todos"]')).toBeVisible();
  await expect(page.locator('[data-view="triage"]')).toBeVisible();
  await expect(page.locator('[data-view="bugs"]')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1800 });
  await expect(panel).toHaveScreenshot('task-sources.png', { animations: 'disabled' });
  await panel.locator('[data-source-id="todos"]').getByLabel('Label', { exact: true }).fill('Draft source name');
  await panel.getByLabel('Source panel galleon').selectOption('org/b');
  await expect(panel.getByRole('button', { name: 'Save automatic sources' })).toBeEnabled();
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await expect(page).toHaveURL(url => url.searchParams.get('repo') === 'org/a');
  await expect(panel.locator('[data-source-id="todos"]').getByLabel('Label', { exact: true })).toHaveValue('Draft source name');
  await panel.locator('[data-source-schedule="todos"]').uncheck();
  await panel.getByRole('button', { name: 'Save automatic sources' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ path: '/api/task-sources/schedule', repo: 'org/b', body: { instanceIds: [], revision: 3 } });
  await expect(panel.getByRole('button', { name: 'Reload sources' })).toBeEnabled();
  failSources = true;
  await panel.getByRole('button', { name: 'Reload sources' }).click();
  await expect(panel.getByRole('alert')).toContainText('Sources temporarily unavailable');
  await expect(panel.locator('[data-source-id="todos"]').getByLabel('Label', { exact: true })).toHaveValue('Draft source name');
  await expect(panel.locator('[data-source-id="todos"]').getByRole('button', { name: 'Save source' })).toBeDisabled();
});
