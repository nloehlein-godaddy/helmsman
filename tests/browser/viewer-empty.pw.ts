import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { expectReadableSurfaces } from './theme-contrast';

const at = '2026-10-14T12:00:00.000Z';
const makeRun = (repo: string, index: number) => ({ version: 1, id: `run-${index}`, repo, displayKey: `TASK-${index}`, title: index === 0 ? 'Preserve customer evidence through feedback updates' : 'Restore scoped terminal connections', status: index === 0 ? 'running' : 'failed', attempt: 1, startedAt: at, endedAt: index === 0 ? null : at, prNumber: null, costUsd: null, review: null, sourceSettlement: null });

async function mockViewer(page: Page) {
  const writes: string[] = []; const errors: string[] = []; const lists: URLSearchParams[] = []; const selections: string[] = [];
  const state = { mode: 'ready' as 'ready' | 'empty' | 'failed' | 'loading', resolveFailed: false };
  let release: (() => void) | null = null;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { writes.push(path); return route.abort(); }
    const repo = url.searchParams.get('repo') ?? 'org/a'; const runId = url.searchParams.get('runId') ?? path.split('/')[3] ?? 'run-0'; const index = Number(runId.replace('run-', '')); const run = makeRun(repo, Number.isFinite(index) ? index : 0); const target = { repo, runId, expectedAttempt: 1 };
    if (path === '/api/run-read') {
      lists.push(new URLSearchParams(url.searchParams));
      if (state.mode === 'loading') await new Promise<void>(resolve => { release = resolve; });
      if (state.mode === 'failed') return route.fulfill({ status: 503, json: { error: 'Fixture read unavailable' } });
      return route.fulfill({ json: { version: 1, repo, items: state.mode === 'empty' ? [] : Array.from({ length: 10 }, (_, i) => makeRun(repo, i)), nextCursor: 'older' } });
    }
    if (path === '/api/run-inspect/resolve') {
      selections.push(runId);
      if (state.resolveFailed) return route.fulfill({ status: 403, json: { error: 'Run unavailable' } });
    }
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.run-viewer']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : path === '/api/vpn-status' ? { version: 1, state: 'unknown', client: 'unknown', network: 'not-configured', checkedAt: at }
      : path === '/api/run-inspect/resolve' ? { version: 1, target, observedAt: at }
      : /^\/api\/run-read\/[^/]+$/.test(path) ? { version: 1, repo, runId, run }
      : /\/api\/run-inspect\/[^/]+\/log$/.test(path) ? { version: 1, target, provenance: 'run-wide', observedAt: at, workerStatus: run.status, events: [{ sequence: 1, at, kind: 'log', text: 'Literal customer evidence <img src=x>', truncated: false }], throughSequence: 1, hasEarlier: false, hasLater: false, nextCursor: null, followCursor: 'follow-proof' }
      : {};
    return route.fulfill({ json });
  });
  return { state, writes, errors, lists, selections, release() { release?.(); release = null; } };
}

async function expectUnboundControlsHidden(page: Page) {
  const panel = page.locator('section.plugin-run-viewer');
  await expect(panel.locator('.run-instructions')).toBeHidden();
  await expect(panel.locator('.run-postmortem')).toBeHidden();
  await expect(panel.getByRole('button', { name: 'Send instruction', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Ask about this failure', exact: true })).toHaveCount(0);
  await expect(panel.locator('.run-log')).toHaveCount(0);
}

for (const width of [1440, 390]) test.describe(`Empty voyage viewer at ${width}px`, () => {
  test.use({ viewport: { width, height: 1100 }, hasTouch: width === 390 });
  test('offers scoped recent choices and restores an explicit selection without changing header scope', async ({ page }) => {
    const f = await mockViewer(page); await page.goto('/run-viewer?repo=org%2Fa'); const panel = page.locator('section.plugin-run-viewer');
    await expect(panel.locator('.run-picker-row')).toHaveCount(10); await expect(panel.getByRole('heading', { name: 'Choose a voyage', exact: true })).toBeVisible(); await expectUnboundControlsHidden(page);
    await expect(page.getByRole('heading', { name: 'Voyage viewer', exact: true })).toHaveCount(1); await expect(page.getByRole('button', { name: 'Refresh page', exact: true })).toHaveCount(1); await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
    expect(f.lists.some(query => query.get('repo') === 'org/a' && query.get('kind') === 'all' && query.get('limit') === '10')).toBe(true); expect(f.selections).toEqual([]); await expect(page).not.toHaveURL(/run=/);
    await expectReadableSurfaces(panel, ['.run-picker-title', '.run-picker-meta', '.run-picker-state']); await page.mouse.move(0, 0); await expect(page).toHaveScreenshot(`viewer-choose-${width}.png`);
    await page.locator('.repo-select').selectOption('org/b'); await expect(panel.locator('.run-picker-row')).toHaveCount(10); await expectUnboundControlsHidden(page); await expect(panel.locator('.run-picker-meta').first()).toContainText('org/b'); expect(f.lists.some(query => query.get('repo') === 'org/b')).toBe(true);
    await page.locator('.repo-select').selectOption('org/a'); await expect(panel.locator('.run-picker-meta').first()).toContainText('org/a');
    const choice = panel.locator('[data-select-run="run-0"]'); await choice.focus(); await choice.press('Enter'); await expect(panel.locator('.run-log')).toContainText('Literal customer evidence <img src=x>'); await expect(panel.locator('.run-log img, .run-log script')).toHaveCount(0); await expect(page.locator('.repo-select')).toHaveValue('org/a'); await expect(page).toHaveURL(url => url.searchParams.get('run') === 'run-0' && url.searchParams.get('runRepo') === 'org/a');
    await page.goto('/run-viewer?repo=org%2Fa'); await expect(panel.locator('.run-log')).toContainText('Literal customer evidence'); await expect(panel.getByRole('tab')).toHaveAttribute('aria-selected', 'true'); await expect(page.locator('.repo-select')).toHaveValue('org/a');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(f.writes).toEqual([]); expect(f.errors).toEqual([]);
  });
});

test('empty, failed and loading reads keep unbound controls hidden and allow refresh recovery', async ({ page }) => {
  const f = await mockViewer(page); f.state.mode = 'empty'; await page.goto('/run-viewer?repo=org%2Fa'); const panel = page.locator('section.plugin-run-viewer'); const refresh = page.getByRole('button', { name: 'Refresh page', exact: true });
  await expect(panel.getByRole('status')).toHaveText('No runs in this scope yet. Start a run, then open its log here.'); await expectUnboundControlsHidden(page);
  f.state.mode = 'failed'; await refresh.click(); await expect(panel.getByRole('alert')).toHaveText('Recent runs could not be loaded. Refresh to try again.'); await expectUnboundControlsHidden(page);
  f.state.mode = 'loading'; await refresh.click(); await expect(panel.getByRole('status')).toHaveText('Loading recent runs…'); await expectUnboundControlsHidden(page); f.state.mode = 'ready'; f.release(); await expect(panel.locator('.run-picker-row')).toHaveCount(10);
  f.state.resolveFailed = true; await panel.locator('[data-select-run="run-0"]').click(); await expect(panel.getByRole('alert')).toContainText('Selected run is unavailable'); await expectUnboundControlsHidden(page); expect(f.writes).toEqual([]); expect(f.errors).toEqual([]);
});
