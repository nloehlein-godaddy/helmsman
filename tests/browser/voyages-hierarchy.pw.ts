import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { DEFAULT_THEME_GENERATOR_SETTINGS, createThemeRecipeFromPalette, generateThemePalette } from '../../src/data/themeGenerator';
import { expectReadableSurfaces } from './theme-contrast';

const at = '2026-10-09T12:00:00.000Z';
const raw = 'Keep literal customer evidence.\n<img src=x onerror=alert(1)>';
const run = (repo: string, id: string, status: 'running' | 'succeeded' | 'failed' | 'stopped', title: string | null = null) => ({ version: 1, id, repo, displayKey: id === 'run-review' || id === 'run-stopped' ? 'review' : id === 'run-next' ? 'TASK-5' : 'TASK-2', ...(title ? { title } : {}), status, attempt: 1, startedAt: at, endedAt: status === 'running' ? null : at, prNumber: id === 'run-review' ? 42 : id === 'run-stopped' ? 43 : null, costUsd: status === 'running' ? null : 1.25,
  review: id === 'run-review' ? { outcome: 'REQUEST_CHANGES', verdict: raw } : null, sourceSettlement: id === 'run-review' ? { state: 'operator-required' } : null,
  ...(id === 'run-review' ? { feedbackOutcome: { state: 'changes_remaining', headSha: 'a'.repeat(40), summary: raw } } : {}) });
async function mockVoyages(page: Page) {
  const queries: { repo: string; kind: string; cursor: string | null }[] = []; const writes: string[] = [];
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { writes.push(path); return route.fulfill({ status: 503, json: { error: 'Unexpected write blocked by test' } }); }
    const repo = url.searchParams.get('repo') ?? 'org/a';
    if (path === '/api/run-inspect/history') {
      const kind = url.searchParams.get('kind') ?? 'all'; const cursor = url.searchParams.get('cursor'); queries.push({ repo, kind, cursor });
      const rows = [run(repo, 'run-review', 'succeeded', 'Preserve customer evidence through feedback updates'), run(repo, 'run-running', 'running', 'Restore scoped terminal connections'), run(repo, 'run-failed', 'failed'), run(repo, 'run-stopped', 'stopped')];
      const items = cursor ? [run(repo, 'run-next', 'succeeded')] : rows.filter(item => kind === 'all' || (kind === 'running' ? item.status === 'running' : item.status !== 'running'));
      return route.fulfill({ json: { version: 1, repo, items, nextCursor: cursor || kind !== 'all' ? null : 'next-page', total: kind === 'all' ? 5 : items.length, totalQuality: 'exact', observedAt: at, coverage: 'insertion-bounded-current-state' } });
    }
    if (path === '/api/pull-request-read') {
      const kind = url.searchParams.get('kind');
      return route.fulfill({ json: { version: 1, repo, kind, items: kind === 'authored-recent' ? [{ repo, number: 42, title: 'Preserve customer evidence through feedback updates', url: `https://github.com/${repo}/pull/42`, status: 'open', createdAt: at, mergedAt: null, draft: false, ticketId: null, reviewDecision: 'REVIEW_REQUIRED', comments: 2, reviews: { approved: 0, changesRequested: 0, commented: 1, requested: 1 } }] : [], quality: 'complete', truncated: false, browseUrl: `https://github.com/${repo}/pulls` } });
    }
    const runId = url.searchParams.get('runId') ?? path.split('/')[3] ?? 'run-review'; const target = { repo, runId, expectedAttempt: 1 };
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.runs', 'helmsman.compat-pr', 'helmsman.run-history', 'helmsman.run-viewer']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : path === '/api/run-read' ? { version: 1, repo, items: [], nextCursor: null }
      : /^\/api\/run-read\/[^/]+$/.test(path) ? { version: 1, repo, runId, run: run(repo, runId, 'succeeded') }
      : path === '/api/run-inspect/resolve' ? { version: 1, target, observedAt: at }
      : /\/api\/run-inspect\/[^/]+\/log$/.test(path) ? { version: 1, target, provenance: 'run-wide', observedAt: at, workerStatus: 'succeeded', events: [{ sequence: 1, at, kind: 'log', text: raw, truncated: false }], throughSequence: 1, hasEarlier: false, hasLater: false, nextCursor: null, followCursor: 'follow-proof' }
      : {};
    return route.fulfill({ json });
  });
  return { queries, writes };
}
async function readLayout(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('helmsman.composition-layouts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const value = await new Promise<{ instances?: { contributionId: string; hidden: boolean; state?: Record<string, { value?: { kind?: string } }> }[]; columns?: { collapsed: boolean }[][] }>((resolve, reject) => { const read = db.transaction('layouts').objectStore('layouts').get('helmsman/runs-page'); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); }); db.close(); return value;
  });
}
for (const { width, mode } of [{ width: 1440, mode: 'dark' }, { width: 900, mode: 'dark' }, { width: 390, mode: 'dark' }, { width: 1440, mode: 'light' }, { width: 390, mode: 'custom' }] as const) test.describe(`Voyages at ${width}px in ${mode}`, () => {
  test.use({ viewport: { width, height: 1100 }, hasTouch: width === 390 });
  test('retains scoped composition, clear independent outcomes and literal evidence', async ({ page }) => {
    if (mode !== 'dark') {
      const recipe = mode === 'custom' ? createThemeRecipeFromPalette(['#780000', '#c1121f', '#fdf0d5', '#003049', '#669bbc']) : { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {} };
      if (!recipe) throw new Error('Invalid theme fixture');
      await page.addInitScript(value => localStorage.setItem('cmux.theme.custom', value), JSON.stringify({ version: 3, recipe, palette: generateThemePalette(recipe.settings, mode === 'light' ? 'light' : 'dark', recipe.overrides, 'sourcePalette' in recipe ? recipe.sourcePalette : undefined) }));
    }
    const f = await mockVoyages(page); await page.goto('/runs?repo=org%2Fa');
    const history = page.locator('section.plugin-run-history'); const first = history.locator('[data-run-id="run-review"]'); const refresh = page.getByRole('button', { name: 'Refresh page', exact: true });
    await expect(first.locator('.run-open')).toHaveText('Preserve customer evidence through feedback updates');
    await expect(first.locator('.run-open')).toHaveAccessibleName('Preserve customer evidence through feedback updates · Inspection #42 · org/a · run-review · Attempt 1');
    await expect(history.locator('.run-row')).toHaveCount(4);
    if (width >= 900) expect((await history.locator('[data-run-id="run-stopped"]').boundingBox())?.height).toBeLessThanOrEqual(110);
    if (width === 1440) {
      const title = await first.locator('.run-open').boundingBox(); const link = await first.locator('.run-identity a').boundingBox();
      expect(title && link && Math.abs(title.y + title.height / 2 - link.y - link.height / 2)).toBeLessThanOrEqual(5);
      const date = await first.locator('.run-started').boundingBox(); const details = await first.locator('.run-details > summary').boundingBox();
      expect(date && details && Math.abs(date.y + date.height / 2 - details.y - details.height / 2)).toBeLessThanOrEqual(5);
    }
    expect((await readLayout(page))?.instances?.map(instance => instance.contributionId)).toEqual(['helmsman.compat-pr/panel', 'helmsman.run-history/panel']);
    await expect(page.getByRole('heading', { name: 'Voyages', exact: true })).toHaveCount(1);
    await expect(history.getByRole('heading', { name: 'Voyage history', exact: true })).toHaveCount(1);
    await expect(refresh).toHaveCount(1); await expect(history.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
    await expect(first.locator('.run-worker')).toContainText('Worker completed'); await expect(first.locator('.run-worker')).toHaveAttribute('data-status', 'succeeded');
    await expect(first.locator('.run-recommendation')).toContainText('Recommendation: Changes requested'); await expect(first.locator('.run-settlement')).toContainText('Needs action'); await expect(first.locator('.run-details .run-settlement')).toHaveCount(0); await expect(first.locator('.run-feedback-outcome')).toHaveText('Feedback remaining');
    await expect(history.locator('[data-run-id="run-running"] .run-worker')).toContainText('Worker running'); await expect(history.locator('[data-run-id="run-failed"] .run-worker')).toContainText('Worker failed'); await expect(history.locator('[data-run-id="run-stopped"] .run-worker')).toContainText('Worker stopped');
    await expect(first.locator('.run-started time')).toHaveAttribute('datetime', at); await expect(first.locator('.run-started time')).toHaveAttribute('title', at); await expect(first.locator('.run-started')).toContainText('Oct 9, 2026, 12:00 PM UTC');
    await expectReadableSurfaces(history, ['.run-filters', '.run-open', '.run-worker[data-status="succeeded"]', '.run-worker[data-status="running"]', '.run-worker[data-status="failed"]', '.run-recommendation', '.run-settlement', '.run-feedback-outcome', '.run-started', '.run-details > summary']);
    await expectReadableSurfaces(history, ['.run-icon'], 3);
    await page.locator('#page-content').evaluate(content => { content.scrollTop = 0; }); await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot(`voyages-${width}-${mode}.png`);
    const lists = page.locator('.plugin-public-pr details.pr-list-section'); await expect(lists).toHaveCount(2);
    for (const list of await lists.all()) { await expect(list).toHaveAttribute('open', ''); const listSummary = list.locator(':scope > summary'); await listSummary.focus(); await listSummary.press('Enter'); await expect(list).not.toHaveAttribute('open', ''); }
    await refresh.click(); await expect(refresh).toBeFocused(); await expect(history).toHaveAttribute('aria-busy', 'false');
    for (const list of await lists.all()) await expect(list).not.toHaveAttribute('open', '');
    if (mode === 'dark' && width !== 900) { await page.locator('#page-content').evaluate(content => { content.scrollTop = 0; }); await page.mouse.move(0, 0); await expect(page).toHaveScreenshot(`voyages-collapsed-${width}.png`); }
    await history.evaluate(element => element.scrollIntoView({ block: 'start' })); await page.mouse.move(0, 0); await expect(page).toHaveScreenshot(`voyages-history-${width}-${mode}.png`);
    const details = first.locator('.run-details'); const summary = details.locator('summary'); await expect(details).not.toHaveAttribute('open', '');
    if (width === 390) { expect((await summary.boundingBox())?.height).toBeGreaterThanOrEqual(44); await summary.tap(); } else { await summary.focus(); await summary.press('Space'); }
    await expect(details).toHaveAttribute('open', ''); await expect(first.locator('.run-evidence')).toContainText(raw); await expect(first.locator('.run-evidence')).toContainText('REQUEST_CHANGES'); await expect(first.locator('.run-evidence')).toContainText('Feedback head: ' + 'a'.repeat(40)); await expect(first.locator('.run-evidence')).toContainText('Source settlement: operator-required'); await expect(history.locator('img, script')).toHaveCount(0);
    await expectReadableSurfaces(history, ['.run-evidence']);
    if (mode === 'dark' && width !== 900) { await first.scrollIntoViewIfNeeded(); await expect(page).toHaveScreenshot(`voyages-details-${width}.png`); }
    await refresh.focus(); await refresh.press('Enter'); await expect(refresh).toBeFocused(); await expect(details).toHaveAttribute('open', '');
    await summary.focus(); await summary.press('Enter'); await expect(details).not.toHaveAttribute('open', ''); await expect(summary).toBeFocused();
    await history.getByRole('button', { name: 'Next page', exact: true }).click(); await expect(history.locator('.run-row')).toHaveCount(1); await expect(history).toContainText('Page 2 · 1 runs shown.');
    await history.getByRole('button', { name: 'Previous page', exact: true }).click(); await expect(history.locator('.run-row')).toHaveCount(4);
    const filter = history.getByRole('combobox', { name: 'Run status filter', exact: true }); await filter.focus(); await filter.selectOption('running'); await expect(history.locator('.run-row')).toHaveCount(1); await expect(filter).toBeFocused();
    await expect.poll(async () => (await readLayout(page))?.instances?.find(instance => instance.contributionId === 'helmsman.run-history/panel')?.state?.['helmsman.run-history/panel']?.value?.kind).toBe('running');
    await page.reload(); await expect(filter).toHaveValue('running'); await expect(history.locator('.run-row')).toHaveCount(1);
    await filter.selectOption('terminal'); await expect(history.locator('.run-row')).toHaveCount(3); await expect(filter.locator('option[value="terminal"]')).toHaveText('Finished');
    await page.locator('.repo-select').selectOption('org/b'); await expect.poll(() => f.queries.some(query => query.repo === 'org/b' && query.kind === 'terminal')).toBe(true); await expect(page.locator('.repo-select')).toHaveValue('org/b');
    await history.locator('[data-run-id="run-review"] .run-open').click(); await expect(page).toHaveURL(url => url.searchParams.get('repo') === 'org/b' && url.searchParams.get('run') === 'run-review' && url.searchParams.get('runRepo') === 'org/b');
    await expect(page.locator('.plugin-auxiliary-slot .run-log')).toContainText(raw); await expect(page.locator('.repo-select')).toHaveValue('org/b');
    expect(f.queries.some(query => query.cursor === 'next-page')).toBe(true); expect(f.writes).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
test('plain terminology preserves user content and canonical review identity', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('helmsman.pirateMode', 'false')); const f = await mockVoyages(page); await page.goto('/runs?repo=org%2Fa');
  const history = page.locator('section.plugin-run-history'); await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toHaveCount(1); await expect(history.getByRole('heading', { name: 'Run history', exact: true })).toHaveCount(1);
  await expect(history.locator('[data-run-id="run-review"] .run-open')).toHaveAccessibleName('Preserve customer evidence through feedback updates · Review #42 · org/a · run-review · Attempt 1');
  await expect(history.getByRole('link', { name: 'PR #42 · org/a', exact: true })).toHaveAttribute('href', '/prs?repo=org%2Fa&prRepo=org%2Fa&pr=42'); expect(f.writes).toEqual([]);
});
test('recent route reveals custom history without resetting saved filters or header scope', async ({ page }) => {
  const f = await mockVoyages(page); await page.goto('/runs?repo=org%2Fa'); await expect(page.locator('section.plugin-run-history .run-row')).toHaveCount(4);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('helmsman.composition-layouts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('layouts', 'readwrite'); tx.objectStore('layouts').put({ version: 1, compositionId: 'helmsman/runs-page', revision: 7, instances: [{ instanceId: 'custom-history', contributionId: 'helmsman.run-history/panel', hidden: true, scope: { kind: 'inherit' }, state: { 'helmsman.run-history/panel': { version: 1, value: { kind: 'terminal' } } } }], columns: [[{ instances: ['custom-history'], activeInstanceId: 'custom-history', collapsed: true }]] }); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  });
  await page.goto('/runs?repo=org%2Fa&pane=recent'); const history = page.locator('section.plugin-run-history'); await expect(history.locator('.run-row')).toHaveCount(3); await expect(history.getByRole('combobox', { name: 'Run status filter', exact: true })).toHaveValue('terminal'); await expect(page.locator('.repo-select')).toHaveValue('org/a');
  const saved = await readLayout(page); expect(saved?.instances).toHaveLength(1); expect(saved?.instances?.[0]?.hidden).toBe(false); expect(saved?.columns?.[0]?.[0]?.collapsed).toBe(false); expect(f.writes).toEqual([]);
});
