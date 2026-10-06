import { expect, test } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';

test('fresh Helm composes all eight panels and preserves deliberate removals', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-20T12:30:00.000Z'));
  const panels = ['underway', 'newrun', 'backlog', 'running', 'repoprs', 'recent', 'activity', 'shipped'];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body: unknown = {};
    if (url.pathname === '/api/plugins/catalog') body = { version: 1, safeMode: false, plugins: [], bindings: {},
      builtins: builtinCatalog(['costs', 'helm', ...panels].map(name => `helmsman.${name}`)) };
    if (url.pathname === '/api/context') body = { repos: ['org/a'], jiraEnabled: false, jiraBaseUrl: null };
    if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } };
    if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
    if (url.pathname === '/api/task-sources') body = { instances: [] };
    if (url.pathname === '/api/run-read') body = { version: 1, repo: url.searchParams.get('repo'), items: [], nextCursor: null };
    if (url.pathname === '/api/pull-request-read') body = { version: 1, repo: url.searchParams.get('repo'),
      kind: url.searchParams.get('kind'), items: [], quality: 'complete', truncated: false, browseUrl: null };
    await route.fulfill({ json: body });
  });
  await page.goto('/helm?repo=org/a');
  for (const panel of panels) await expect(page.locator(`#helm-body-${panel}`)).toBeVisible();
  await expect(page.locator('.plugin-recent').getByText('No past voyages.', { exact: true })).toBeVisible();
  await expect(page.locator('.plugin-activity').getByText('No activity in the available history.', { exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot('default-helm.png', { animations: 'disabled' });
  await page.locator('#helm-body-repoprs').scrollIntoViewIfNeeded();
  await expect(page.locator('#helm-body-repoprs')).toBeInViewport();
  await page.locator('[data-helm-focus="page:edit"]').click();
  const backlog = page.locator('.helm-config-row').filter({ has: page.getByLabel('Scope for Backlog', { exact: false }) });
  await backlog.getByRole('button', { name: /^Remove(?: ·|$)/ }).click();
  await expect(page.locator('#helm-body-backlog')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#helm-body-newrun')).toBeVisible();
  await expect(page.locator('#helm-body-backlog')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page).toHaveScreenshot('default-helm-mobile.png', { animations: 'disabled' });
  await page.locator('#helm-body-shipped').scrollIntoViewIfNeeded();
  await expect(page.locator('#helm-body-shipped')).toBeInViewport();
  await expect(page).toHaveScreenshot('default-helm-mobile-lower.png', { animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Helm keeps independent panel scopes and layout through disablement and reload', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('helmsman.rackLayout') === null) localStorage.setItem('helmsman.rackLayout',
      JSON.stringify([[{ panels: ['backlog'], active: 'backlog', collapsed: false }]]));
  });
  const sourceId = '11111111-1111-4111-8111-111111111111';
  const enabled = new Set(['helmsman.costs', 'helmsman.helm', 'helmsman.backlog']);
  const reads: string[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body: unknown = {};
    if (url.pathname === '/api/plugins/catalog') body = { version: 1, safeMode: false, plugins: [], bindings: {},
      builtins: builtinCatalog(['helmsman.costs', 'helmsman.helm', 'helmsman.backlog'], enabled) };
    if (url.pathname === '/api/context') body = { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null };
    if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } };
    if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
    if (url.pathname === '/api/task-sources') body = { instances: [{ id: 'local', sourceId, revision: 1,
      label: 'Local tasks', desiredEnabled: true, available: true, allowedRepos: ['org/a', 'org/b'] }] };
    if (url.pathname === '/api/task-sources/local/tasks') {
      const repo = url.searchParams.get('repo'); reads.push(repo ?? 'all');
      body = { items: [{ version: 1, ref: { sourceId, externalId: 'TASK-1' }, repo, revision: '1', displayKey: 'TASK-1',
        title: `Work for ${repo}`, state: 'ready', priority: null, url: null,
        requirements: { description: 'A scoped task', acceptanceCriteria: [], links: [] }, providerData: { version: 1 } }], nextCursor: null };
    }
    return route.fulfill({ json: body });
  });
  await page.goto('/helm?repo=org/a&panel=legacy-0-0-0');
  await expect(page).toHaveTitle('↻ Helm · Helmsman');
  await expect(page.locator('#boot')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Helm', exact: true })).toBeVisible();
  await expect(page.locator('#helm-body-legacy-0-0-0').getByText('Work for org/a', { exact: true })).toBeVisible();
  await expect(page.locator('#helm-body-legacy-0-0-0').getByText('TASK-1', { exact: true })).toBeVisible();
  await page.locator('[data-helm-focus="page:edit"]').click();
  await page.getByRole('button', { name: /^Duplicate(?: ·|$)/ }).click();
  await expect(page.getByRole('button', { name: /^Duplicate(?: ·|$)/ })).toHaveCount(2);
  const row = page.locator('.helm-config-row').filter({ has: page.getByRole('button', { name: /^Duplicate(?: ·|$)/ }) }).last();
  await row.getByLabel('Scope for Backlog', { exact: false }).selectOption('galleon');
  await row.getByLabel('Panel galleon', { exact: false }).fill('org/b');
  await row.getByRole('button', { name: /^Apply scope(?: ·|$)/ }).click();
  await expect(page.locator('#helm-body-legacy-0-0-0').getByText('Work for org/a', { exact: true })).toBeVisible();
  await expect(page.getByText('Work for org/b', { exact: true })).toBeVisible();
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await expect(page).toHaveURL(url => url.searchParams.get('repo') === 'org/a' && url.searchParams.get('panel') === 'legacy-0-0-0');
  await page.locator('[data-helm-focus="page:edit"]').click();
  await expect(page.locator('.plugin-helm')).toHaveScreenshot('composed-helm.png', { animations: 'disabled' });
  enabled.delete('helmsman.backlog');
  await expect(page.getByText('This panel is unavailable. Enable or install its plugin to bring it aboard.')).toHaveCount(2);
  const before = reads.length;
  await page.waitForTimeout(2200);
  expect(reads).toHaveLength(before);
  await page.reload();
  await expect(page.getByText('This panel is unavailable. Enable or install its plugin to bring it aboard.')).toHaveCount(2);
  enabled.add('helmsman.backlog');
  await expect(page.locator('#helm-body-legacy-0-0-0').getByText('Work for org/a', { exact: true })).toBeVisible();
  await expect(page.getByText('Work for org/b', { exact: true })).toBeVisible();
  enabled.delete('helmsman.helm');
  await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await expect(page.getByRole('tab', { name: 'Config', exact: true })).toBeVisible();
  enabled.add('helmsman.helm');
  await expect(page.getByText('Work for org/b', { exact: true })).toBeVisible();
});
