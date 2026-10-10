import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { DEFAULT_THEME_GENERATOR_SETTINGS, createThemeRecipeFromPalette, generateThemePalette } from '../../src/data/themeGenerator';
import { expectReadableSurfaces } from './theme-contrast';

const sourceId = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-09T12:00:00.000Z';
const selected = (repo: string, instanceId = 'issues') => ({ version: 1, sourceId, instanceId, instanceRevision: 2, repo });
const row = (externalId: string, title: string, severity: string | null, priority = 'P1') => ({ ref: { sourceId, externalId }, displayKey: `BUG-${externalId}`, title, description: 'Preserve customer content exactly.\n<img src=x onerror=alert(1)>', url: null, priority, severity, dueAt: '2026-10-15', createdAt: '2026-09-19T14:30:00.000Z' });
const report = (repo: string) => ({ version: 1, repo, asOf: at, open: { value: 25000, quality: 'approximate' }, createdLast7d: { value: 0, quality: 'exact' }, completedLast7d: { value: null, quality: 'unavailable' }, pastSla: { value: 2, quality: 'exact' },
  rows: [row('101', 'Keep customer content out of analytics events', 'S1 - Critical'), row('102', 'Preserve collection content when importing arrays', 'S2 - Major', 'P2'), row('103', 'Keep provider labels exactly as supplied', 'Needs careful inspection', 'Customer priority')], rowsQuality: 'partial', oldest: { ref: { sourceId, externalId: '101' }, displayKey: 'BUG-101', url: null, createdAt: '2026-09-19T14:30:00.000Z' }, oldestQuality: 'partial', resolutionP75: { days: 4.5, sampleSize: 100, population: { value: 25000, quality: 'approximate' }, quality: 'partial', capped: true } });
async function mockBugs(page: Page, state: 'mixed' | 'empty' | 'errors' = 'mixed') {
  const queries: { instanceId: string; repo: string; sourceId: string | null; revision: string | null }[] = []; const mutations: string[] = [];
  let failed = state === 'errors';
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { mutations.push(path); return route.fulfill({ status: 503, json: { error: 'Unexpected write blocked by test' } }); }
    const repo = url.searchParams.get('repo') ?? 'org/a';
    if (path.startsWith('/api/task-views-read/')) {
      const instanceId = path.split('/')[3] ?? ''; queries.push({ instanceId, repo, sourceId: url.searchParams.get('sourceId'), revision: url.searchParams.get('revision') });
      if (failed || instanceId === 'secondary') return route.fulfill({ status: 503, json: { error: 'Test metrics unavailable' } });
      const value = report(repo);
      if (state === 'empty') { value.rows = []; value.rowsQuality = 'complete'; value.open = { value: 0, quality: 'exact' }; }
      return route.fulfill({ json: { selection: selected(repo, instanceId), report: value } });
    }
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.bugs']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/task-sources' ? { instances: (state === 'mixed' ? ['issues', 'secondary'] : ['issues']).map(id => ({ id, sourceId, revision: 2, label: 'Customer work', desiredEnabled: true, available: true, allowedRepos: ['org/a', 'org/b'], readViews: ['bugs'] })) }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} } : {};
    return route.fulfill({ json });
  });
  return { queries, mutations, recover: () => { failed = false; } };
}
async function waitForDescriptionSave(page: Page) {
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('helmsman.composition-layouts', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const layout = await new Promise<{ instances?: { state?: Record<string, { value?: { descriptionExpanded?: string[] } }> }[] }>((resolve, reject) => { const request = database.transaction('layouts').objectStore('layouts').get('helmsman/bugs-page'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); database.close();
    return layout?.instances?.flatMap(instance => instance?.state?.['helmsman.bugs/panel']?.value?.descriptionExpanded ?? []) ?? [];
  })).toContain(JSON.stringify(['org/a', sourceId, 'issues', sourceId, '101']));
}

for (const { width, mode } of [{ width: 1440, mode: 'dark' }, { width: 900, mode: 'dark' }, { width: 390, mode: 'dark' }, { width: 1440, mode: 'light' }, { width: 390, mode: 'custom' }] as const) test.describe(`Bugs at ${width}px in ${mode}`, () => {
  test.use({ viewport: { width, height: 1100 }, hasTouch: width === 390 });
  test('preserves metric quality, source identity, scope and description state', async ({ page }) => {
    if (mode !== 'dark') {
      const recipe = mode === 'custom' ? createThemeRecipeFromPalette(['#780000', '#c1121f', '#fdf0d5', '#003049', '#669bbc']) : { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {} };
      if (!recipe) throw new Error('Invalid theme fixture');
      await page.addInitScript(value => localStorage.setItem('cmux.theme.custom', value), JSON.stringify({ version: 3, recipe, palette: generateThemePalette(recipe.settings, mode === 'light' ? 'light' : 'dark', recipe.overrides, 'sourcePalette' in recipe ? recipe.sourcePalette : undefined) }));
    }
    const f = await mockBugs(page); await page.goto('/bugs?repo=org%2Fa');
    const panel = page.locator('.plugin-bugs:not([data-composition-page])'); const first = panel.locator('.bugs-report').first(); const picker = panel.getByRole('combobox', { name: 'Bug source', exact: true });
    await expect(first).toContainText('Keep customer content out of analytics events');
    await expect(panel.locator('.bugs-report')).toHaveCount(2);
    await expect(panel).toContainText('service-unavailable');
    await expect(first.locator('.bugs-metrics dd').nth(1)).toHaveText('0');
    await expect(first.getByRole('columnheader', { name: 'Bug', exact: true })).toHaveCount(1);
    if (width >= 900) expect(await first.locator('thead').evaluate(head => [...head.querySelectorAll<HTMLElement>('.bugs-column-label')].every(label => { const rectangle = label.getBoundingClientRect(); const cell = label.closest('th')?.getBoundingClientRect(); return rectangle.height <= Number.parseFloat(getComputedStyle(label).lineHeight) + 1 && !!cell && rectangle.right <= cell.right; }))).toBe(true);
    await expect(first.locator('tbody tr').first().locator('td').first()).toContainText('Keep customer content out of analytics events');
    await expect(first.locator('.bugs-title-cell > small').first()).toHaveText('BUG-101');
    await expect(first).toContainText('≈ 25,000'); await expect(first).toContainText('Unavailable'); await expect(first).toContainText('100 sampled');
    await expect(first.getByLabel('Severity S1 - Critical', { exact: true })).toHaveText('S1');
    await expect(first.getByLabel('Severity S2 - Major', { exact: true })).toHaveText('S2');
    await expect(first.getByLabel('Priority P1', { exact: true })).toHaveText('P1');
    await expect(first.getByLabel('Priority P2', { exact: true })).toHaveText('P2');
    await expect(first.getByText('Customer priority', { exact: true })).toBeVisible();
    await expect(first.getByText('Needs careful inspection', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bugs', exact: true })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Bugs', exact: true })).toHaveCSS('font-size', '26px');
    await expect(first.getByRole('table')).toHaveAccessibleName('Open bugs · Customer work · issues');
    await expect(page.getByRole('button', { name: 'Refresh page', exact: true })).toHaveCount(1);
    await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
    await expect(picker.locator('option').filter({ hasText: 'issues' })).toHaveCount(1);
    await expect(picker.locator('option').filter({ hasText: 'secondary' })).toHaveCount(1);
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(first.locator('time[datetime="2026-10-15"]').first()).toHaveText('Oct 15, 2026');
    await expect(first.locator('time[datetime="2026-10-09T12:00:00.000Z"]')).toContainText('UTC');
    await expectReadableSurfaces(panel, ['.bugs-filters', '.bugs-report-heading h3', '.bugs-metrics dd', '.bugs-title', '.severity-badge.rank-1', '.severity-badge.rank-2', '.priority-badge.rank-1', '.priority-badge.rank-2']);
    await expectReadableSurfaces(panel, ['.bugs-description button', '.bugs-icon'], 3);
    const hues = await first.evaluate(node => ['.severity-badge.rank-1', '.severity-badge.rank-2'].map(selector => { const badge = node.querySelector(selector); if (!badge) throw new Error(`Missing badge ${selector}`); const color = getComputedStyle(badge).color; const rgb = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []; const [red = 0, green = 0, blue = 0] = rgb; const maximum = Math.max(red, green, blue); const minimum = Math.min(red, green, blue); const delta = maximum - minimum; if (delta === 0) return -1; const hue = maximum === red ? (green - blue) / delta : maximum === green ? (blue - red) / delta + 2 : (red - green) / delta + 4; return ((hue * 60) % 360 + 360) % 360; }));
    expect(hues[0]! < 10 || hues[0]! > 345).toBe(true); expect(hues[1]).toBeGreaterThanOrEqual(12); expect(hues[1]).toBeLessThanOrEqual(50);
    await expect(first.locator('.priority-badge.rank-1')).toHaveCSS('color', await first.locator('.severity-badge.rank-1').evaluate(node => getComputedStyle(node).color));
    await expect(first.locator('.priority-badge.rank-2')).toHaveCSS('color', await first.locator('.severity-badge.rank-2').evaluate(node => getComputedStyle(node).color));
    await expect(panel.locator('.bugs-icon').first()).toHaveAttribute('aria-hidden', 'true');
    await page.locator('#page-content').evaluate(content => { content.scrollTop = 0; }); await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot(`bugs-${width}-${mode}.png`);
    const disclosure = first.getByRole('button', { name: 'Show description for BUG-101', exact: true });
    await expect(disclosure).toHaveAttribute('title', 'Show description for BUG-101'); await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(disclosure.locator('.bugs-icon')).toHaveCount(1); await expect(disclosure).not.toContainText('Show description');
    if (width === 390) { expect((await disclosure.boundingBox())?.height).toBeGreaterThanOrEqual(44); await disclosure.tap(); } else { await disclosure.focus(); await disclosure.press('Enter'); }
    await expect(first.locator('.bugs-description-content')).toContainText('<img src=x onerror=alert(1)>'); await expect(panel.locator('img, script')).toHaveCount(0);
    await expect(first.getByRole('button', { name: 'Hide description for BUG-101', exact: true })).toBeFocused();
    await expect(first.getByRole('button', { name: 'Hide description for BUG-101', exact: true })).toHaveAttribute('title', 'Hide description for BUG-101');
    await expect(first.getByRole('button', { name: 'Hide description for BUG-101', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await waitForDescriptionSave(page);
    if (mode === 'dark' && width !== 900) { if (width === 390) await first.locator('.bugs-description-content').scrollIntoViewIfNeeded(); else await page.locator('#page-content').evaluate(content => { content.scrollTop = 0; }); await expect(page).toHaveScreenshot(`bugs-description-${width}.png`); }
    await page.reload(); await expect(first.locator('.bugs-description-content')).toContainText('Preserve customer content exactly.');
    const refresh = page.getByRole('button', { name: 'Refresh page', exact: true }); await refresh.focus(); await refresh.press('Enter'); await expect(refresh).toBeFocused();
    await expect(first).toContainText('Keep customer content out of analytics events');
    await page.locator('.repo-select').focus(); await expect(page.locator('.repo-select')).toBeFocused();
    await picker.focus(); await picker.selectOption(JSON.stringify(['org/a', sourceId, 'secondary']));
    await expect(panel.locator('.bugs-report')).toHaveCount(1); await expect(panel).toContainText('service-unavailable'); await expect(picker).toBeFocused();
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await page.reload(); await expect(picker).toHaveValue(JSON.stringify(['org/a', sourceId, 'secondary']));
    await page.locator('.repo-select').selectOption('org/b'); await expect(panel).toContainText('The selected source is unavailable in this scope. Your selection is kept.');
    await picker.selectOption(''); await expect.poll(() => f.queries.some(query => query.repo === 'org/b')).toBe(true); await expect(page.locator('.repo-select')).toHaveValue('org/b');
    expect(f.queries.every(query => query.sourceId === sourceId && query.revision === '2')).toBe(true); expect(f.mutations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
for (const state of ['empty', 'errors'] as const) test(`Bugs shows ${state} honestly and keeps refresh recovery available`, async ({ page }) => {
  const f = await mockBugs(page, state); await page.goto('/bugs?repo=org%2Fa'); const panel = page.locator('.plugin-bugs:not([data-composition-page])');
  await expect(panel).toContainText(state === 'empty' ? 'No open bugs.' : 'service-unavailable');
  await expect(page).toHaveScreenshot(`bugs-${state}.png`);
  if (state === 'errors') { f.recover(); await page.getByRole('button', { name: 'Refresh page', exact: true }).click(); await expect(panel).toContainText('Keep customer content out of analytics events'); }
  expect(f.mutations).toEqual([]);
});
test('unsupported saved source stays visible until explicitly replaced', async ({ page }) => {
  const f = await mockBugs(page); await page.goto('/bugs?repo=org%2Fa'); await expect(page.locator('.plugin-bugs:not([data-composition-page])')).toContainText('Keep customer content out of analytics events');
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('helmsman.composition-layouts', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => { const transaction = database.transaction('layouts', 'readwrite'); const store = transaction.objectStore('layouts'); const request = store.get('helmsman/bugs-page'); request.onsuccess = () => { const layout = request.result; const instance = layout?.instances?.[0]; if (!instance) { transaction.abort(); return; } instance.state['helmsman.bugs/panel'] = { version: 99, value: { source: 'unknown' } }; store.put(layout); }; transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); }); database.close();
  });
  await page.reload(); const panel = page.locator('.plugin-bugs:not([data-composition-page])'); const picker = panel.getByRole('combobox', { name: 'Bug source', exact: true });
  await expect(panel).toContainText('The saved source selection is unsupported. Choose a source to replace it.'); await expect(picker).toHaveValue('unsupported');
  await picker.selectOption(''); await expect(panel).toContainText('Keep customer content out of analytics events'); await expect(page.locator('.repo-select')).toHaveValue('org/a'); expect(f.mutations).toEqual([]);
});

test('refresh completion does not steal focus from the header', async ({ page }) => {
  const f = await mockBugs(page); await page.goto('/bugs?repo=org%2Fa');
  const panel = page.locator('.plugin-bugs:not([data-composition-page])'); await expect(panel).toContainText('Keep customer content out of analytics events');
  let complete!: () => void; const pending = new Promise<void>(resolve => { complete = resolve; });
  let waiting = false;
  await page.route('**/api/task-views-read/issues/bugs?*', async route => { waiting = true; await pending; await route.fulfill({ json: { selection: selected('org/a'), report: report('org/a') } }); });
  await page.getByRole('button', { name: 'Refresh page', exact: true }).click(); await expect.poll(() => waiting).toBe(true);
  const header = page.locator('.repo-select'); await header.focus(); complete();
  await expect(panel).toHaveAttribute('aria-busy', 'false'); await expect(panel).toContainText('Keep customer content out of analytics events'); await expect(header).toBeFocused(); expect(f.mutations).toEqual([]);
});
