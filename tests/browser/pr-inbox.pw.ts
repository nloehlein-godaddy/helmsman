import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';

const at = '2026-10-09T12:00:00.000Z';
const row = (repo: string, number: number, title: string, status: 'open' | 'merged') => ({ repo, number, title,
  url: `https://github.com/${repo}/pull/${number}`, status, createdAt: at, mergedAt: status === 'merged' ? at : null,
  draft: false, ticketId: null, reviewDecision: status === 'merged' ? 'APPROVED' : 'REVIEW_REQUIRED', comments: 2,
  reviews: { approved: status === 'merged' ? 1 : 0, changesRequested: 0, commented: 1, requested: 1 } });

async function mockInbox(page: Page) {
  const state = { quality: 'partial' as 'complete' | 'partial' | 'degraded', empty: false };
  const scopes: (string | null)[] = [];
  const writes: string[] = [];
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') writes.push(path);
    if (path === '/api/pull-request-read') {
      const repo = url.searchParams.get('repo'); const kind = url.searchParams.get('kind'); scopes.push(repo);
      return route.fulfill({ json: { version: 1, repo, kind, items: kind === 'authored-recent' && !state.empty
        ? [row(repo ?? 'org/a', 42, 'Restore authored pull requests when search is unavailable', 'open'), row(repo ?? 'org/a', 41, 'Preserve matched pull requests from earlier pages', 'merged')] : [],
        quality: kind === 'authored-recent' ? state.quality : 'complete', truncated: kind === 'authored-recent' && state.quality !== 'complete', browseUrl: `https://github.com/${repo}/pulls` } });
    }
    const target = { repo: url.searchParams.get('repo'), number: Number(url.searchParams.get('number')), baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.compat-pr']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : path === '/api/pull-request-inspect/detail' ? { version: 1, target, observedAt: at, title: 'Scoped pull request details', url: `https://github.com/${target.repo}/pull/${target.number}`, status: 'open', draft: false, authorLogin: 'writer', isOwnPr: true, headRefName: 'topic', updatedAt: at, comments: 0,
        checks: { quality: 'complete', passed: 2, failed: 0, pending: 0 }, reviews: { quality: 'complete', approved: 0, changesRequested: 0, commented: 0, requested: 0, viewerReview: null, viewerReviewedAt: null, viewerReviewedCommitId: null } }
      : path === '/api/pull-request-inspect/diff' ? { version: 1, target, observedAt: at, coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false, files: [] }
      : path === '/api/run-read' ? { version: 1, repo: url.searchParams.get('repo'), items: [], nextCursor: null }
      : path === '/api/whiteboard' ? { version: 1, target: JSON.parse(url.searchParams.get('target') ?? '{}'), status: 'absent', sessionId: null, baseSha: null, headSha: null, message: null }
      : {};
    return route.fulfill({ json });
  });
  return { state, scopes, writes };
}

for (const width of [1440, 390]) test(`recent authored pull requests retain limited results and reset to the top selection at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
  const f = await mockInbox(page);
  await page.goto('/prs?repo=org%2Fa&prRepo=org%2Fb&pr=42');
  const panel = page.locator('.plugin-public-pr');
  const authored = panel.locator('[data-pr-pane="authored"]');
  const reset = panel.getByRole('button', { name: 'Use top selection', exact: true });
  const refresh = panel.getByRole('button', { name: 'Refresh', exact: true }).first();
  await expect(panel).toContainText('Showing: org/b');
  await expect(authored.locator('.pr-list-row')).toHaveCount(2);
  await expect(authored.getByRole('status')).toHaveText('Only some results were returned. More may be available in the full list.');
  await expect(authored.getByText('Restore authored pull requests when search is unavailable', { exact: true })).toBeVisible();
  await expect(authored.getByRole('link', { name: 'View all on GitHub ↗', exact: true })).toHaveAttribute('href', 'https://github.com/org/b/pulls');
  await expect(reset).toHaveAttribute('title', 'Match the selection at the top of Helmsman.');
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await expect(panel.locator('.pr-panel')).toBeVisible();
  await expect(page).toHaveScreenshot(`pr-inbox-${width}.png`);
  f.state.quality = 'degraded';
  await refresh.click();
  await expect(authored.getByRole('status')).toHaveText('Could not load all pull requests. Refresh to try again.');
  await expect(authored.locator('.pr-list-row')).toHaveCount(2);
  await reset.click();
  await expect(panel).toContainText('Showing: org/a');
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await expect(page).toHaveURL(url => url.searchParams.get('repo') === 'org/a' && !url.searchParams.has('pr') && !url.searchParams.has('prRepo'));
  await expect(panel.locator('.pr-panel')).toHaveCount(0);
  await expect(panel.locator('[data-pr-compat-lookup]')).toHaveValue('');
  await expect(authored.getByText('org/a', { exact: true })).toHaveCount(2);
  expect(f.scopes).toContain('org/b'); expect(f.scopes).toContain('org/a');
  f.state.quality = 'complete'; f.state.empty = true;
  await refresh.click();
  await expect(authored.locator('.pr-list-row')).toHaveCount(0);
  await expect(authored.getByRole('status')).toHaveText('No matching pull requests.');
  f.state.quality = 'degraded';
  await refresh.click();
  await expect(authored.getByRole('status')).toHaveText('Could not load all pull requests. Refresh to try again.');
  await expect(authored).not.toContainText('No matching pull requests.');
  expect(f.writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
