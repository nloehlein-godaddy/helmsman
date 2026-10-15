import { expect, test } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';

for (const reviewed of [false, true]) test(`accepted review selects and refreshes its drawer after delayed run admission without changing header scope, previously reviewed=${reviewed}`, async ({ page }) => {
  const at = '2026-10-14T12:00:00.000Z'; const errors: string[] = []; const writes: string[] = []; const launches: unknown[] = []; const resolved: string[] = [];
  let newResolves = 0;
  const run = (id: string) => ({ version: 1, id, repo: 'org/b', displayKey: 'PR-42', title: id === 'new-review' ? 'New review admitted' : 'Previous review', status: 'running', attempt: 1, startedAt: at, endedAt: null, prNumber: 42, costUsd: null, review: null, sourceSettlement: null });
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') {
      if (path !== '/api/run-commands' || request.method() !== 'POST') { writes.push(path); return route.abort(); }
      const input = request.postDataJSON(); launches.push(input);
      return route.fulfill({ json: { version: 1, repo: input?.repo, requestId: input?.requestId, action: 'launch', status: 'accepted', runId: 'new-review', attempt: 1, message: null } });
    }
    const runId = url.searchParams.get('runId') ?? path.split('/')[3] ?? 'previous-review'; const target = { repo: 'org/b', runId, expectedAttempt: 1 };
    const pr = { repo: 'org/b', number: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
    if (path === '/api/run-inspect/resolve') { resolved.push(runId); if (runId === 'new-review' && ++newResolves === 1) return route.fulfill({ status: 404, json: { error: 'Run not found' } }); }
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.compat-pr', 'helmsman.run-viewer']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : path === '/api/vpn-status' ? { version: 1, state: 'unknown', client: 'unknown', network: 'not-configured', checkedAt: at }
      : path === '/api/pull-request-read' ? { version: 1, repo: url.searchParams.get('repo'), kind: url.searchParams.get('kind'), items: [], quality: 'complete', truncated: false, browseUrl: 'https://github.com/org/b/pulls' }
      : path === '/api/pull-request-inspect/detail' ? { version: 1, target: pr, observedAt: at, title: 'Review the delayed admission', url: 'https://github.com/org/b/pull/42', status: 'open', draft: false, authorLogin: 'writer', isOwnPr: true, headRefName: 'topic', updatedAt: at, comments: 0, checks: { quality: 'complete', passed: 2, failed: 0, pending: 0 }, reviews: { quality: 'complete', approved: reviewed ? 1 : 0, changesRequested: 0, commented: 0, requested: 0, viewerReview: reviewed ? 'APPROVED' : null, viewerReviewedAt: reviewed ? at : null, viewerReviewedCommitId: reviewed ? pr.headSha : null } }
      : path === '/api/pull-request-inspect/diff' ? { version: 1, target: pr, observedAt: at, coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false, files: [] }
      : path === '/api/run-read' ? { version: 1, repo: 'org/b', items: [run('previous-review')], nextCursor: null }
      : /^\/api\/run-read\/[^/]+$/.test(path) ? { version: 1, repo: 'org/b', runId, run: run(runId) }
      : path === '/api/run-inspect/resolve' ? { version: 1, target, observedAt: at }
      : /\/api\/run-inspect\/[^/]+\/log$/.test(path) ? { version: 1, target, provenance: 'run-wide', observedAt: at, workerStatus: 'running', events: url.searchParams.has('cursor') ? [] : [{ sequence: 1, at, kind: 'log', text: `${runId} log evidence`, truncated: false }], throughSequence: 1, hasEarlier: false, hasLater: false, nextCursor: url.searchParams.get('direction') === 'forward' ? 'follow-proof' : null, followCursor: url.searchParams.has('cursor') ? null : 'follow-proof' }
      : {};
    return route.fulfill({ json });
  });
  await page.goto('/prs?repo=org%2Fa&prRepo=org%2Fb&pr=42&runRepo=org%2Fb&run=previous-review');
  const viewer = page.locator('#run-log-drawer section.plugin-run-viewer');
  await expect(viewer.locator('.run-log')).toContainText('previous-review log evidence');
  if (reviewed) {
    const launch = page.locator('.pr-review-agent[data-launch="review"]'); const guidance = page.locator('.pr-review-guidance');
    await expect(launch).toBeDisabled(); await expect(page.locator('[data-review-repeat-note]')).toContainText('You already reviewed this commit');
    await guidance.fill('Keep literal <img src=x> evidence and focus on retry ordering.'); await expect(launch).toBeDisabled();
    await page.getByRole('tabpanel').getByRole('button', { name: 'Refresh page', exact: true }).click(); await expect(page.locator('.plugin-public-pr')).toHaveAttribute('aria-busy', 'false'); await expect(guidance).toHaveValue('Keep literal <img src=x> evidence and focus on retry ordering.'); await expect(launch).toBeDisabled();
    await page.reload(); await expect(guidance).toHaveValue('Keep literal <img src=x> evidence and focus on retry ordering.'); await expect(launch).toBeDisabled();
    await page.locator('.pr-model').selectOption('gpt-6-astra'); await expect(launch).toBeEnabled(); await page.locator('.pr-model').selectOption(''); await expect(launch).toBeDisabled(); await page.locator('.pr-effort').selectOption('high'); await expect(launch).toBeEnabled();
  }
  await page.locator('.pr-review-agent[data-launch="review"]').click();
  await expect.poll(() => newResolves).toBe(1);
  await expect(viewer).toContainText('Resolving selected run');
  await expect(viewer.locator('.run-log')).toHaveCount(0);
  expect(await page.locator('#run-log-drawer').evaluate(element => element.closest('details')?.open)).toBe(true);
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await page.clock.runFor(2600);
  await expect(viewer.locator('.run-log')).toContainText('new-review log evidence');
  await expect(viewer.locator('.run-log')).not.toContainText('previous-review log evidence');
  await expect(viewer.getByRole('tab', { selected: true })).toContainText('PR-42');
  await expect(viewer).toContainText('Worker: running');
  await expect(page).toHaveURL(url => url.searchParams.get('repo') === 'org/a' && url.searchParams.get('runRepo') === 'org/b' && url.searchParams.get('run') === 'new-review');
  expect(launches).toHaveLength(1); expect(launches[0]).toMatchObject({ repo: 'org/b', action: 'launch', launch: { mode: 'review', prNumber: 42, headSha: 'b'.repeat(40) } });
  if (reviewed) expect(launches[0]).toMatchObject({ launch: { effort: 'high', guidance: 'Keep literal <img src=x> evidence and focus on retry ordering.' } });
  expect(resolved).toContain('previous-review'); expect(newResolves).toBeGreaterThanOrEqual(2); expect(writes).toEqual([]); expect(errors).toEqual([]);
});
