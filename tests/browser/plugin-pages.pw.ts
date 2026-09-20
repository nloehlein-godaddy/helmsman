import { expect, test, type Page } from '@playwright/test';

const summary = (repo: string | null) => ({
  window: { from: '2026-01-01', to: '2026-01-30' },
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
    startedAt: '',
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
    if (url.pathname === '/api/context') body = { repos: ['org/a', 'org/b'], jiraBaseUrl: null, jiraEnabled: true };
    if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } };
    if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
    if (url.pathname === '/api/outcomes') body = summary(url.searchParams.get('repo'));
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
  expect(requests).not.toContain('/api/outcomes');
});

test('shell navigation leaves and returns to Costs with scope intact', async ({ page }) => {
  await mockApi(page);
  await openCosts(page, '/plugins/helmsman.costs/page');
  await page.locator('.page-tab[data-view="runs"]').click();
  await expect(page).toHaveURL(url => url.pathname === '/runs' && url.searchParams.get('repo') === 'org/a');
  await expect(page.locator('.helm')).toHaveAttribute('data-page', 'runs');
  await page.getByRole('tab', { name: 'Costs & Outcomes' }).click();
  await expect(page.getByRole('heading', { name: 'Costs & Outcomes' })).toBeVisible();
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await expect(page.locator('.outcome-runs')).toContainText('run_a');
});
