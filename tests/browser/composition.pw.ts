import { expect, test, type Page } from '@playwright/test';
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

async function activityFixture(page: Page) {
  const sourceId = '11111111-1111-4111-8111-111111111111';
  const until = '2026-09-20T12:30:00.000Z';
  await page.clock.setFixedTime(new Date(until));
  await page.addInitScript(() => localStorage.setItem('helmsman.rackLayout', JSON.stringify([[{ panels: ['activity'], active: 'activity', collapsed: false }]])));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const repo = url.searchParams.get('repo') ?? 'org/a';
    let body: unknown = {};
    if (url.pathname === '/api/plugins/catalog') body = { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.costs', 'helmsman.helm', 'helmsman.activity']) };
    if (url.pathname === '/api/context') body = { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null };
    if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } };
    if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
    if (url.pathname === '/api/task-sources') body = { instances: [{ id: 'tasks', sourceId, revision: 2, label: 'Local tasks', desiredEnabled: true, available: true, allowedRepos: ['org/a', 'org/b'], readViews: ['history'] }] };
    if (url.pathname === '/api/activity-read/tasks') body = {
      selection: { version: 1, sourceId, instanceId: 'tasks', instanceRevision: 2, repo },
      history: { version: 1, repo, from: '2026-09-14T00:00:00.000Z', until, historyQuality: 'partial', throughputQuality: 'complete',
        days: Array.from({ length: 7 }, (_, index) => ({ date: `2026-09-${14 + index}`, completed: [0, 2, 0, 1, 0, 0, 3][index] })),
        events: [
          { id: 'completed', ref: { sourceId, externalId: '10043' }, displayKey: 'TASK-43', title: `Preserve imported collection content for ${repo}`, url: null, at: '2026-09-20T12:00:00.000Z', kind: 'completed', status: null },
          { id: 'status', ref: { sourceId, externalId: '10044' }, displayKey: 'TASK-44', title: 'Sanitize imported SVG assets on rebuild', url: 'https://tasks.example/TASK-44', at: '2026-09-20T10:00:00.000Z', kind: 'status-changed', status: 'In review' },
          { id: 'created', ref: { sourceId, externalId: '10045' }, displayKey: 'TASK-45', title: 'Add a visible empty state for media imports', url: null, at: '2026-09-19T10:00:00.000Z', kind: 'created', status: null },
        ] },
    };
    if (url.pathname === '/api/pull-request-read') body = { version: 1, repo, kind: url.searchParams.get('kind'), quality: 'partial', truncated: true, browseUrl: null,
      items: [{ repo, number: 42, title: 'Keep customer values out of session analytics', url: `https://provider.example/${repo}/pull/42`, status: 'merged', createdAt: '2026-09-18T10:00:00.000Z', mergedAt: '2026-09-20T11:00:00.000Z', draft: false, ticketId: 'TASK-42', reviewDecision: 'APPROVED', comments: null, reviews: null }] };
    await route.fulfill({ json: body });
  });
  await page.goto('http://127.0.0.1:4175/helm?repo=org/a');
  const panel = page.locator('.plugin-activity');
  await expect(panel.locator('dd')).toHaveCount(7);
  await expect(panel.getByText('Preserve imported collection content for org/a', { exact: true })).toBeVisible();
  return panel;
}

test('Activity keeps limited history truthful and event rows readable on desktop and touch screens', async ({ page, browser }) => {
  const activity = await activityFixture(page);
  await expect(activity.locator('dd')).toHaveText(['0', '2', '0', '1', '0', '0', '3']);
  const phosphor = activity.locator('.activity-phosphor').first();
  expect(await phosphor.evaluate(async el => {
    const fonts = await document.fonts.load('16px "Helmsman Phosphor Regular"', (el as HTMLElement).dataset.glyph);
    return fonts.length > 0 && fonts.every(font => font.status === 'loaded');
  })).toBe(true);
  await expect(activity.getByText('PR history limited', { exact: true })).toBeVisible();
  await expect(activity.getByText('Event history partial', { exact: true })).toBeVisible();
  await expect(activity.getByRole('list', { name: 'Recent activity' }).locator('li')).toHaveCount(5);
  const merged = activity.getByRole('list', { name: 'Recent activity' }).locator('li').filter({ hasText: 'Merged' });
  await expect(merged.getByRole('link', { name: 'Keep customer values out of session analytics', exact: true })).toHaveAttribute('href', 'https://provider.example/org/a/pull/42');
  expect((await activity.locator('.event-evidence').allTextContents()).every(text => !text.includes('org/a'))).toBe(true);
  await expect(activity).toHaveScreenshot('activity-panel.png', { animations: 'disabled' });
  const warning = activity.locator('details').filter({ hasText: 'PR history limited' });
  await warning.locator('summary').click(); await expect(warning).toContainText('partial'); await expect(warning).toContainText('truncated');
  await warning.locator('summary').click();
  await activity.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(activity.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
  await page.locator('.repo-select').selectOption('org/b');
  await expect(activity.getByText('Preserve imported collection content for org/b', { exact: true })).toBeVisible();
  await expect(activity.getByText('Preserve imported collection content for org/a', { exact: true })).toHaveCount(0);
  const touchContext = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 1800 } });
  const touchPage = await touchContext.newPage();
  const mobile = await activityFixture(touchPage);
  await expect(mobile).toHaveScreenshot('activity-panel-mobile.png', { animations: 'disabled' });
  expect(await mobile.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const refresh = mobile.getByRole('button', { name: 'Refresh', exact: true });
  const bounds = await refresh.boundingBox();
  expect(bounds?.height).toBeGreaterThanOrEqual(44); expect(bounds?.width).toBeGreaterThanOrEqual(44);
  const notice = mobile.locator('details').filter({ hasText: 'Event history partial' });
  const noticeBounds = await notice.locator('summary').boundingBox(); expect(noticeBounds?.height).toBeGreaterThanOrEqual(44);
  await notice.locator('summary').tap(); await expect(notice).toHaveJSProperty('open', true);
  await notice.locator('summary').tap(); await expect(notice).toHaveJSProperty('open', false);
  await refresh.tap(); await expect(refresh).toBeEnabled();
  await touchContext.close();
});
