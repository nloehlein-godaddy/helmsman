import { expect, test, type Page } from '@playwright/test';

const summary = (repo: string | null) => ({
  window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-30T00:00:00.000Z' },
  repo,
  runs: 1,
  execution: { succeeded: 1, failed: 0, stopped: 0, running: 0 },
  assessments: { complete: 0, partial: 0, failed: 0, 'not-assessed': 1 },
  outcomes: { achieved: 0, partial: 0, 'not-achieved': 0, unknown: 1 },
  knownCostUsd: null,
  observedCostUsd: null,
  runsWithKnownCost: 0,
  costCoverage: null,
  averageCostUsd: null,
  averageDurationMs: null,
  runsWithDuration: 0,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  totalTokens: null,
  linkedPrs: 0,
  unknownPrs: 0,
  stalePrs: 0,
  unavailablePrs: 0,
  publishedPrs: 0,
  reviewedPrs: 0,
  mergedPrs: 0,
  costPerPublishedPrUsd: null,
  costPerReviewedPrUsd: null,
  costPerMergedPrUsd: null,
  correctionRounds: null,
  failures: [],
  daily: [],
  recentRuns: [{
    runId: repo === 'org/b' ? 'run_b' : 'run_a',
    repo: repo ?? 'org/a',
    status: 'succeeded',
    prNumber: null,
    startedAt: '2026-01-10T00:00:00.000Z',
    durationMs: null,
    costUsd: null,
    observedCostUsd: null,
    assessment: null,
  }],
});

async function mockApi(page: Page): Promise<string[]> {
  const requests: string[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests.push(url.pathname);
    let body: unknown = {};
    if (url.pathname === '/api/plugins/catalog') body = { version: 1, safeMode: false, plugins: [], bindings: {} };
    if (url.pathname === '/api/context') body = { repos: ['org/a', 'org/b'], jiraBaseUrl: null, jiraEnabled: true };
    if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } };
    if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
    if (url.pathname === '/api/reports/outcomes/v1') body = summary(url.searchParams.get('repo'));
    if (url.pathname === '/api/usage/v1') {
      const repo = url.searchParams.get('repo');
      body = { version: 1, currency: 'USD', repo,
        window: { from: url.searchParams.get('from'), to: url.searchParams.get('to') },
        runs: [{ runId: repo === 'org/b' ? 'run_b' : 'run_a', repo: repo ?? 'org/a', status: 'succeeded',
          startedAt: '2026-01-10T00:00:00.000Z', endedAt: '2026-01-10T01:00:00.000Z', reportedCostUsd: null }],
        records: [], reported: { observedCostUsd: null, knownCostUsd: null, runsWithKnownCost: 0, runsWithoutUsage: 1,
          inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null } };
    }
    if (url.pathname === '/api/pricing/v1') body = null;
    if (url.pathname === '/api/runs') body = { runs: [], total: 0, limit: 25, offset: 0 };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return requests;
}

async function openCosts(page: Page, path: string): Promise<void> {
  await page.goto(`${path}?repo=org/a`);
  await expect(page.locator('#boot')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Costs & Outcomes' })).toBeVisible();
  await expect(page.locator('.outcome-runs')).toContainText('run_a');
}

test('legacy and canonical Costs links render the same view', async ({ page }) => {
  await mockApi(page);
  await openCosts(page, '/outcomes');
  const legacyContent = await page.locator('section.outcomes-view').innerHTML();
  await openCosts(page, '/plugins/helmsman.costs/page');
  expect(await page.locator('section.outcomes-view').innerHTML()).toBe(legacyContent);
  await expect(page).toHaveScreenshot('costs-page.png', {
    fullPage: true,
    animations: 'disabled',
    mask: [page.locator('.footer-meta')],
  });
});

test('canonical deep link preserves its route while header scope changes', async ({ page }) => {
  await mockApi(page);
  await openCosts(page, '/plugins/helmsman.costs/page');
  await page.locator('.repo-select').selectOption('org/b');
  await expect(page).toHaveURL(url => url.pathname === '/plugins/helmsman.costs/page' && url.searchParams.get('repo') === 'org/b');
  await expect(page.locator('.outcome-runs')).toContainText('run_b');
  await expect(page.locator('.outcome-runs')).not.toContainText('run_a');
  await page.reload();
  await expect(page.locator('.repo-select')).toHaveValue('org/b');
  await expect(page.locator('.outcome-runs')).toContainText('run_b');
});

test('missing plugin stays unavailable without fetching Costs', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/plugins/acme.missing/page?repo=org/a');
  await expect(page.locator('#boot')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
  await page.locator('.repo-select').selectOption('org/b');
  await expect(page).toHaveURL(url => url.pathname === '/plugins/acme.missing/page' && url.searchParams.get('repo') === 'org/b');
  await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
  expect(requests).not.toContain('/api/reports/outcomes/v1');
});

test('shell navigation leaves and returns to Costs with scope intact', async ({ page }) => {
  await mockApi(page);
  await openCosts(page, '/plugins/helmsman.costs/page');
  await page.locator('.page-tab[data-view="runs"]').click();
  await expect(page).toHaveURL(url => url.pathname === '/runs' && url.searchParams.get('repo') === 'org/a');
  await expect(page.locator('.helm')).toHaveAttribute('data-page', 'plugin');
  await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
  await page.getByRole('tab', { name: 'Costs & Outcomes' }).click();
  await expect(page.getByRole('heading', { name: 'Costs & Outcomes' })).toBeVisible();
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await expect(page.locator('.outcome-runs')).toContainText('run_a');
});

test('failed assessment saves preserve the draft and expanded details', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/reports/outcomes/v1/run_a/assessment', route => route.fulfill({
    status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Assessment could not be saved' }),
  }));
  await openCosts(page, '/plugins/helmsman.costs/page');
  await page.getByText('Assess task outcome', { exact: true }).click();
  const form = page.locator('[data-outcome-assessment="run_a"]');
  await form.getByLabel('Assessment progress').selectOption('complete');
  await form.getByLabel('Task outcome').selectOption('achieved');
  await form.getByLabel('Summary (required)').fill('Completed the integration and checked failure paths.');
  await form.getByRole('textbox', { name: /^Evidence/ }).fill('Unit tests\nPR #42');
  await form.getByText('Failure and correction details (optional)').click();
  await form.getByLabel('Where the task failed').fill('Initial test fixture');
  await form.getByLabel('Correction rounds').fill('2');
  await form.getByRole('button', { name: 'Save assessment' }).click();
  await expect(form.getByRole('alert')).toHaveText('Assessment could not be saved');
  await expect(form.getByLabel('Summary (required)')).toHaveValue('Completed the integration and checked failure paths.');
  await expect(form.getByRole('textbox', { name: /^Evidence/ })).toHaveValue('Unit tests\nPR #42');
  await expect(form.getByLabel('Assessment progress')).toHaveValue('complete');
  await expect(form.getByLabel('Task outcome')).toHaveValue('achieved');
  await expect(form.getByLabel('Where the task failed')).toBeVisible();
  await expect(form.getByLabel('Where the task failed')).toHaveValue('Initial test fixture');
  await expect(form.getByLabel('Correction rounds')).toHaveValue('2');
  await expect(form.getByRole('button', { name: 'Save assessment' })).toBeEnabled();
});

test('changing the period refreshes Costs while preserving an assessment draft', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/reports/outcomes/v1?*', route => {
    const url = new URL(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...summary(url.searchParams.get('repo')), runs: Number(url.searchParams.get('days')),
    }) });
  });
  await openCosts(page, '/plugins/helmsman.costs/page');
  await page.getByText('Assess task outcome', { exact: true }).click();
  const form = page.locator('[data-outcome-assessment="run_a"]');
  await form.getByLabel('Summary (required)').fill('Keep this draft while changing the period.');
  const period = page.getByLabel('Time period');
  await period.focus();
  await period.selectOption('90');
  await expect(page.locator('.outcome-stat').first().locator('b')).toHaveText('90');
  await expect(period).toHaveValue('90');
  await expect(period).toBeFocused();
  await expect(form.getByLabel('Summary (required)')).toBeVisible();
  await expect(form.getByLabel('Summary (required)')).toHaveValue('Keep this draft while changing the period.');
});

test('leaving Costs cancels a pending save without updating the next page', async ({ page }) => {
  await mockApi(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/reports/outcomes/v1/run_a/assessment', async route => {
    await pending;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Late save failure' }) }).catch(() => {});
  });
  await openCosts(page, '/plugins/helmsman.costs/page');
  await page.getByText('Assess task outcome', { exact: true }).click();
  const form = page.locator('[data-outcome-assessment="run_a"]');
  await form.getByLabel('Summary (required)').fill('Save while navigating away.');
  const requested = page.waitForRequest(request => request.url().endsWith('/api/reports/outcomes/v1/run_a/assessment'));
  await form.getByRole('button', { name: 'Save assessment' }).click();
  await requested;
  const aborted = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/reports/outcomes/v1/run_a/assessment'));
  await page.locator('.page-tab[data-view="runs"]').click();
  release();
  await aborted;
  await expect(page.locator('.helm')).toHaveAttribute('data-page', 'plugin');
  await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
  await expect(page.getByText('Late save failure', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Costs & Outcomes' }).click();
  await expect(page.locator('.outcome-runs')).toContainText('run_a');
  await expect(page.getByText('Late save failure', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});


test('catalog failure keeps optional pages unavailable without substituting Costs', async ({ page }) => {
  const requests = await mockApi(page);
  await page.route('**/api/plugins/catalog', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto('/outcomes?repo=org/a');
  await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
  await expect(page.getByText('Some plugin pages could not be loaded. Check the plugin catalog and restart.', { exact: true })).toBeVisible();
  expect(requests).not.toContain('/api/reports/outcomes/v1');
});


test('Config omits the branch disclaimer and preserves unavailable settings and footer controls', async ({ page }) => {
  await mockApi(page);
  await page.goto('/config?repo=org/a');
  await expect(page.locator('.operator-note')).toHaveCount(0);
  await expect(page.locator('.app-footer [data-recovery-link]')).toHaveAttribute('href', '/recovery?repo=org%2Fa');
  await expect(page.locator('.app-footer [data-pirate-mode]')).toBeVisible();
  await expect(page).toHaveScreenshot('config-operator-desktop.png', { fullPage: true, mask: [page.locator('.footer-meta')] });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page).toHaveScreenshot('config-operator-mobile.png', { fullPage: true, mask: [page.locator('.footer-meta')] });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.route('**/api/config', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.reload();
  await expect(page.locator('.config-load-error')).toBeVisible();
  await expect(page.locator('.operator-note')).toHaveCount(0);
  await expect(page.locator('.app-footer [data-pirate-mode]')).toBeVisible();
  await expect(page).toHaveScreenshot('config-operator-unavailable.png', { fullPage: true, mask: [page.locator('.footer-meta')] });
  await page.goto('/outcomes?repo=org/a');
  await expect(page.getByRole('heading', { name: 'Costs & Outcomes' })).toBeVisible();
  await expect(page.locator('.operator-note')).toHaveCount(0);
});
