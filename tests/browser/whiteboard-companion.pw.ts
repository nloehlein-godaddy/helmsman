import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';

const at = '2026-10-08T12:00:00.000Z';
const run = { version: 1, id: 'failed-run', repo: 'org/a', displayKey: 'TASK-41', status: 'failed', attempt: 2, startedAt: at, endedAt: at, prNumber: null, costUsd: null, review: null, sourceSettlement: null };
const target = { repo: run.repo, runId: run.id, expectedAttempt: 2 };
const pinned = { kind: 'run', ...target };
const absent = { version: 1, target: pinned, status: 'absent', sessionId: null, baseSha: null, headSha: null, message: null };
const created = { ...absent, status: 'ready', sessionId: 'whiteboard-session', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };

async function mockWhiteboard(page: Page, holdCreation = false, pr = false) {
  let release: (() => void) | undefined;
  const expectedTarget = pr ? { kind: 'pull-request', repo: 'org/b', number: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) } : pinned;
  const currentAbsent = { ...absent, target: expectedTarget };
  const currentCreated = { ...created, target: expectedTarget };
  const mutations: { path: string; body: unknown }[] = [];
  let ready = false;
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (path.startsWith('/api/whiteboard')) {
      expect(request.headers()['x-helmsman-contribution']).toBe(pr ? 'helmsman.compat-pr/panel' : 'helmsman.run-viewer/panel');
      if (request.method() === 'GET') {
        expect(JSON.parse(url.searchParams.get('target') ?? '{}')).toEqual(expectedTarget);
        expect(url.searchParams.get('scopeRepo')).toBe(pr ? 'org/b' : 'org/a');
      } else {
        const body = request.postDataJSON(); expect(body).toEqual({ target: expectedTarget, scopeRepo: pr ? 'org/b' : 'org/a' });
        mutations.push({ path, body });
        if (holdCreation && path.endsWith('/explain')) await new Promise<void>(resolve => { release = resolve; });
        ready = true;
      }
      return route.fulfill({ json: ready ? currentCreated : currentAbsent });
    }
    if (request.method() !== 'GET') throw new Error(`Unexpected mutation: ${path}`);
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.run-viewer', 'helmsman.compat-pr']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } }
      : path === '/api/task-sources' ? { instances: [] }
      : path === '/api/pull-request-read' ? { version: 1, repo: url.searchParams.get('repo'), kind: url.searchParams.get('kind'), items: [], quality: 'complete', truncated: false, browseUrl: null }
      : path === '/api/pull-request-inspect/detail' ? { version: 1, target: { repo: 'org/b', number: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }, observedAt: at, title: 'Whiteboard comparison', url: 'https://github.com/org/b/pull/42', status: 'open', draft: false, authorLogin: 'writer', isOwnPr: true, headRefName: 'topic', updatedAt: at, comments: 0, checks: { quality: 'complete', passed: 2, failed: 0, pending: 0 }, reviews: { quality: 'complete', approved: 0, changesRequested: 0, commented: 0, requested: 0, viewerReview: null, viewerReviewedAt: null, viewerReviewedCommitId: null } }
      : path === '/api/pull-request-inspect/diff' ? { version: 1, target: { repo: 'org/b', number: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }, observedAt: at, coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false, files: [] }
      : path === '/api/run-read' ? { version: 1, repo: url.searchParams.get('repo'), items: [], nextCursor: null }
      : path === `/api/run-read/${run.id}` ? { version: 1, repo: run.repo, runId: run.id, run }
      : path === '/api/run-inspect/resolve' ? { version: 1, target, observedAt: at }
      : path === `/api/run-inspect/${run.id}/log` ? { version: 1, target, provenance: 'run-wide', observedAt: at, workerStatus: run.status,
        events: [], throughSequence: 0, hasEarlier: false, hasLater: false,
        nextCursor: url.searchParams.get('direction') === 'forward' ? 'follow' : null, followCursor: url.searchParams.has('cursor') ? null : 'follow' }
      : {};
    return route.fulfill({ json });
  });
  return { mutations, release: () => release?.() };
}

for (const width of [1440, 390]) test.describe(`Whiteboard companion at ${width}px`, () => {
  test.use({ viewport: { width, height: 1000 }, hasTouch: width === 390 });
  test('explains and opens the pinned attempt while preserving header scope', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const { mutations } = await mockWhiteboard(page);
    await page.goto('/run-viewer?repo=org/a&run=failed-run&runRepo=org/a');
    await expect(page.getByRole('button', { name: 'Retry run', exact: true })).toBeEnabled();
    const explain = page.getByRole('button', { name: 'Explain in Whiteboard', exact: true });
    await expect(explain).toBeEnabled(); await explain.click();
    const open = page.getByRole('button', { name: 'Open in Whiteboard', exact: true });
    await expect(open).toBeEnabled(); await open.focus();
    await page.getByRole('button', { name: 'Refresh', exact: true }).last().click();
    await expect(open).toBeEnabled(); await open.click();
    await expect.poll(() => mutations.map(item => item.path)).toEqual(['/api/whiteboard/explain', '/api/whiteboard/open']);
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    expect(new URL(page.url()).searchParams.get('repo')).toBe('org/a');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await open.scrollIntoViewIfNeeded();
    const screenshot = `/tmp/helmsman-whiteboard-${width}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`whiteboard-${width}`, { path: screenshot, contentType: 'image/png' });
    expect(errors).toEqual([]);
  });
  test('explains a panel PR override without changing the header galleon', async ({ page }) => {
    const { mutations } = await mockWhiteboard(page, false, true);
    await page.goto('/prs?repo=org/a&prRepo=org/b&pr=42');
    const explain = page.getByRole('button', { name: 'Explain in Whiteboard', exact: true });
    await expect(explain).toBeEnabled(); await explain.click();
    const open = page.getByRole('button', { name: 'Open in Whiteboard', exact: true });
    await expect(open).toBeEnabled(); await open.click();
    await expect.poll(() => mutations.length).toBe(2);
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    expect(new URL(page.url()).searchParams.get('repo')).toBe('org/a');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test('discards a late creation response after the header scope changes', async ({ page }) => {
    const fixture = await mockWhiteboard(page, true);
    await page.goto('/run-viewer?repo=org/a&run=failed-run&runRepo=org/a');
    await expect(page.getByRole('button', { name: 'Retry run', exact: true })).toBeEnabled();
    const explain = page.getByRole('button', { name: 'Explain in Whiteboard', exact: true });
    await expect(explain).toBeEnabled(); await explain.click();
    await expect.poll(() => fixture.mutations.length).toBe(1);
    await page.locator('.repo-select').selectOption('org/b');
    fixture.release();
    await expect(page.locator('.repo-select')).toHaveValue('org/b');
    await expect(page.getByRole('button', { name: 'Open in Whiteboard', exact: true })).toHaveCount(0);
    expect(fixture.mutations.map(item => item.path)).toEqual(['/api/whiteboard/explain']);
  });
});
