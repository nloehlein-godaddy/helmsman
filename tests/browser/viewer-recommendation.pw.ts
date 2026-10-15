import { expect, test } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';

for (const outcome of ['APPROVE', 'REQUEST_CHANGES'] as const) test(`prepares ${outcome} from a completed review while preserving the current scope and existing draft`, async ({ page }) => {
  const at = '2026-10-14T12:00:00.000Z'; const verdict = `Review ${outcome}: preserve literal <img src=x> customer evidence.`;
  const run = { version: 1, id: 'review-42', repo: 'org/b', displayKey: 'PR-42', title: 'Completed agent review', status: 'succeeded', attempt: 1, startedAt: at, endedAt: at, prNumber: 42, costUsd: null, review: { outcome, verdict }, sourceSettlement: null };
  const target = { repo: run.repo, runId: run.id, expectedAttempt: 1 }; const pr = { repo: run.repo, number: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }; const writes: string[] = []; const errors: string[] = [];
  let diffUnavailable = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { writes.push(path); return route.abort(); }
    if (path === '/api/pull-request-inspect/diff' && diffUnavailable) return route.fulfill({ status: 503, json: { error: 'Diff unavailable' } });
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.compat-pr', 'helmsman.run-viewer']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : path === '/api/pull-request-read' ? { version: 1, repo: url.searchParams.get('repo'), kind: url.searchParams.get('kind'), items: [], quality: 'complete', truncated: false, browseUrl: 'https://github.com/org/b/pulls' }
      : path === '/api/pull-request-inspect/detail' ? { version: 1, target: pr, observedAt: at, title: 'Inspect the latest diff before publishing', url: 'https://github.com/org/b/pull/42', status: 'open', draft: false, authorLogin: 'writer', isOwnPr: false, headRefName: 'topic', updatedAt: at, comments: 0, checks: { quality: 'complete', passed: 2, failed: 0, pending: 0 }, reviews: { quality: 'complete', approved: 0, changesRequested: 0, commented: 0, requested: 0, viewerReview: 'COMMENTED', viewerReviewedAt: at, viewerReviewedCommitId: 'c'.repeat(40) } }
      : path === '/api/pull-request-inspect/diff' ? { version: 1, target: pr, observedAt: at, coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false, files: [] }
      : path === '/api/run-read' ? { version: 1, repo: run.repo, items: [run], nextCursor: null }
      : path === '/api/run-read/review-42' ? { version: 1, repo: run.repo, runId: run.id, run }
      : path === '/api/run-inspect/resolve' ? { version: 1, target, observedAt: at }
      : path === '/api/run-inspect/review-42/log' ? { version: 1, target, provenance: 'run-wide', observedAt: at, workerStatus: run.status, events: url.searchParams.has('cursor') ? [] : [{ sequence: 1, at, kind: 'log', text: 'Completed review evidence', truncated: false }], throughSequence: 1, hasEarlier: false, hasLater: false, nextCursor: url.searchParams.get('direction') === 'forward' ? 'follow-proof' : null, followCursor: url.searchParams.has('cursor') ? null : 'follow-proof' }
      : {};
    return route.fulfill({ json });
  });
  await page.goto('/prs?repo=org%2Fa&prRepo=org%2Fb&pr=42');
  await expect(page.locator('.pr-metadata-recommendation')).toContainText(verdict);
  await page.locator('.pr-provenance > summary').click(); await expect(page.locator('.pr-provenance')).toContainText('You commented');
  if (outcome === 'REQUEST_CHANGES') { await page.locator('.pr-manual-review > summary').click(); await page.locator('.pr-review-body').fill('My existing review draft.'); }
  await page.locator(`[data-prepare-metadata-review="${outcome}"]`).click();
  await expect(page.locator('.pr-manual-review')).toHaveAttribute('open', ''); await expect(page.locator('.pr-diff-panel')).toHaveAttribute('open', ''); await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await expect(page.locator('.pr-review-body')).toHaveValue(outcome === 'REQUEST_CHANGES' ? 'My existing review draft.' : verdict);
  if (outcome === 'APPROVE') await page.locator('.pr-review-body').fill('');
  expect(writes).toEqual([]);
  await page.goto('/run-viewer?repo=org%2Fa&runRepo=org%2Fb&run=review-42');
  const action = page.locator(`[data-prepare-review="${outcome}"]`); await expect(action).toBeVisible(); await expect(page.locator('.repo-select')).toHaveValue('org/a'); expect(writes).toEqual([]); await action.click();
  await expect(page.locator('.pr-manual-review .pr-review-recommendation')).toContainText(verdict);
  await expect(page.locator('.repo-select')).toHaveValue('org/a'); await expect(page.locator('.pr-panel')).toHaveAttribute('data-pr-repo', 'org/b');
  await expect(page.locator('.pr-manual-review')).toHaveAttribute('open', ''); await expect(page.locator('.pr-diff-panel')).toHaveAttribute('open', '');
  const body = page.locator('.pr-review-body');
  if (outcome === 'REQUEST_CHANGES') {
    await expect(body).toHaveValue('My existing review draft.');
    await page.locator('[data-append-recommendation]').click(); await expect(body).toHaveValue(`My existing review draft.\n\n${verdict}`); await expect(page.locator('[data-append-recommendation]')).toHaveCount(0);
  } else await expect(body).toHaveValue(verdict);
  await expect(page.locator(outcome === 'APPROVE' ? '.pr-approve' : '.pr-request-changes')).toBeEnabled();
  expect(new URL(page.url()).search).not.toContain('customer'); expect(new URL(page.url()).searchParams.get('repo')).toBe('org/a');
  diffUnavailable = true; await page.getByRole('tabpanel').getByRole('button', { name: 'Refresh page', exact: true }).click(); await expect(page.locator('.plugin-public-pr')).toHaveAttribute('aria-busy', 'false'); await body.fill('Keep my updated draft while the latest diff is unavailable.'); await expect(page.locator('.pr-approve')).toBeDisabled(); await expect(page.locator('.pr-request-changes')).toBeDisabled();
  await expect(page.locator('.pr-review-recommendation img, .pr-review-recommendation script')).toHaveCount(0); expect(writes).toEqual([]); expect(errors).toEqual([]);
});
