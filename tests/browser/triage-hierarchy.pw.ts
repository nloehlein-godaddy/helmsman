import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { DEFAULT_THEME_GENERATOR_SETTINGS, createThemeRecipeFromPalette, generateThemePalette } from '../../src/data/themeGenerator';
import { expectReadableSurfaces } from './theme-contrast';

const sourceId = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-09T12:00:00.000Z';
const selection = (repo: string) => ({ version: 1, sourceId, instanceId: 'issues', instanceRevision: 2, repo });
const item = (externalId: string, title: string, state: 'ready' | 'review' | 'blocked' | 'in_progress', priority: number) => ({
  ref: { sourceId, externalId }, revision: 'r1', displayKey: `TASK-${externalId}`, title, state, priority, url: null, updatedAt: at,
});
const groups = {
  'unassigned-backlog': [item('101', 'Keep customer content out of analytics events', 'ready', 1), item('102', 'Resolve the blocked import dependency', 'blocked', 2)],
  'unassigned-todo': [item('201', 'Preserve collection content when importing arrays', 'ready', 0)],
  'mine-open': [item('301', 'Review the rebuilt SVG sanitizer', 'review', 2), item('302', 'Improve navigation while tasks are running', 'in_progress', 3)],
};
async function mockTriage(page: Page) {
  const queries: URLSearchParams[] = []; const mutations: { path: string; body: unknown }[] = []; const descriptions: string[] = [];
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    const repo = url.searchParams.get('repo') ?? 'org/a';
    if (path === '/api/task-action/discover') return route.fulfill({ json: { version: 1, selection: request.postDataJSON().selection, sourceRevision: 7, actions: ['assign-self'] } });
    if (request.method() !== 'GET') { mutations.push({ path, body: request.postDataJSON() }); return route.fulfill({ status: 503, json: { error: 'Test command delivery unavailable' } }); }
    if (path === '/api/task-views-read/issues/triage') {
      queries.push(url.searchParams);
      const group = url.searchParams.get('group') as keyof typeof groups;
      const cursor = url.searchParams.get('cursor');
      const priorities = (url.searchParams.get('priorities') ?? '').split(',').map(Number);
      const query = { repo, group, priorities, updatedSince: url.searchParams.get('updatedSince') || null, until: url.searchParams.get('until'), cursor: cursor || null, limit: Number(url.searchParams.get('limit')) };
      const items = (cursor ? [item('103', 'Second page retains the same filter window', 'ready', 2)] : groups[group]).filter(task => priorities.includes(task.priority));
      return route.fulfill({ json: { selection: selection(repo), query, page: { version: 1, repo, group, items, nextCursor: group === 'unassigned-backlog' && !cursor ? 'next-page' : null, quality: 'complete' }, relatedRuns: [], relatedRunsQuality: 'complete' } });
    }
    if (path === '/api/task-sources/issues/tasks') {
      const id = url.searchParams.get('externalId') ?? ''; descriptions.push(id);
      const task = Object.values(groups).flat().find(task => task.ref.externalId === id) ?? item('103', 'Second page retains the same filter window', 'ready', 2);
      const { updatedAt: _updatedAt, ...snapshot } = task;
      return route.fulfill({ json: { task: { version: 1, ...snapshot, repo, providerData: null, requirements: { description: 'Keep task context readable.\n<img src=x onerror=alert(1)>', acceptanceCriteria: [], links: [] } } } });
    }
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.triage']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/task-sources' ? { instances: [{ id: 'issues', sourceId, revision: 2, label: 'Customer work', desiredEnabled: true, available: true, allowedRepos: ['org/a', 'org/b'], readViews: ['triage'] }] }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} } : {};
    return route.fulfill({ json });
  });
  return { queries, mutations, descriptions };
}

for (const { width, mode } of [{ width: 1440, mode: 'dark' }, { width: 900, mode: 'dark' }, { width: 390, mode: 'dark' }, { width: 1440, mode: 'light' }, { width: 390, mode: 'custom' }] as const) test.describe(`Triage at ${width}px in ${mode}`, () => {
  test.use({ viewport: { width, height: 1100 }, hasTouch: width === 390 });
  test('keeps grouped tasks readable and preserves filtering, paging and scoped actions', async ({ page }) => {
    if (mode !== 'dark') {
      const recipe = mode === 'custom' ? createThemeRecipeFromPalette(['#780000', '#c1121f', '#fdf0d5', '#003049', '#669bbc']) : { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {} };
      if (!recipe) throw new Error('Invalid theme fixture');
      await page.addInitScript(value => localStorage.setItem('cmux.theme.custom', value), JSON.stringify({ version: 3, recipe, palette: generateThemePalette(recipe.settings, mode === 'light' ? 'light' : 'dark', recipe.overrides, 'sourcePalette' in recipe ? recipe.sourcePalette : undefined) }));
    }
    const f = await mockTriage(page);
    await page.goto('/triage?repo=org%2Fa');
    const panel = page.locator('.triage-panel');
    const backlog = panel.locator('[data-triage-group="unassigned-backlog"]');
    await expect(panel.locator('[data-triage-group]')).toHaveCount(3);
    await expect(backlog).toContainText('Keep customer content out of analytics events');
    await expect(page.getByRole('button', { name: 'Refresh page', exact: true })).toHaveCount(1);
    await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
    await expect(backlog.getByRole('button', { name: 'Launch TASK-101', exact: true })).toBeEnabled();
    await expect(backlog.getByRole('button', { name: 'Assign TASK-101 to me', exact: true })).toBeEnabled();
    await expect(panel).toContainText('Not ready for a new run.');
    expect(f.descriptions).toEqual([]);
    const surfaces = await expectReadableSurfaces(panel, ['.triage-filters', '.triage-column-heading h3', '.triage-task-title', '.triage-task-state', '.triage-launch']);
    expect(surfaces[0]?.background).not.toBe(surfaces[1]?.background);
    expect(surfaces[1]?.background).not.toBe(surfaces[2]?.background);
    await expectReadableSurfaces(panel, ['.triage-task-state .triage-phosphor', '.triage-task-priority .triage-phosphor', '.triage-launch .triage-phosphor'], 3);
    await expect(panel.locator('.triage-phosphor').first()).toHaveAttribute('aria-hidden', 'true');
    if (width === 390) expect((await backlog.getByRole('button', { name: 'Launch TASK-101', exact: true }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.locator('#page-content').evaluate(content => { content.scrollTop = 0; });
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot(`triage-${width}-${mode}.png`);
    const description = backlog.getByRole('button', { name: 'Show description for TASK-101', exact: true });
    if (width === 390) await description.tap(); else { await description.focus(); await description.press('Enter'); }
    await expect(backlog.locator('.triage-description-content')).toContainText('<img src=x onerror=alert(1)>');
    await expect(panel.locator('img, script')).toHaveCount(0);
    await expect(backlog.getByRole('button', { name: 'Hide description for TASK-101', exact: true })).toBeFocused();
    if (mode === 'dark' && width !== 900) {
      await page.locator('#page-content').evaluate(content => { content.scrollTop = 0; });
      await expect(page).toHaveScreenshot(`triage-description-${width}.png`);
    }
    const sourcePicker = panel.getByRole('combobox', { name: 'Task source', exact: true });
    await sourcePicker.selectOption({ label: 'Customer work' });
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(backlog.getByRole('button', { name: 'Next page for Backlog', exact: true })).toBeEnabled();
    const firstWindow = f.queries.filter(query => query.get('group') === 'unassigned-backlog').at(-1)?.get('until');
    await backlog.getByRole('button', { name: 'Next page for Backlog', exact: true }).click();
    await expect(backlog).toContainText('Second page retains the same filter window');
    expect(f.queries.find(query => query.get('cursor') === 'next-page')?.get('until')).toBe(firstWindow);
    await backlog.getByRole('button', { name: 'Previous page for Backlog', exact: true }).click();
    await expect(backlog).toContainText('Keep customer content out of analytics events');
    await panel.getByRole('checkbox', { name: 'Priority P1', exact: true }).uncheck();
    await expect(backlog).not.toContainText('Keep customer content out of analytics events');
    await panel.getByRole('combobox', { name: 'Last updated', exact: true }).selectOption('7');
    await expect.poll(() => f.queries.some(query => query.get('updatedSince'))).toBe(true);
    await page.reload();
    await expect(panel.getByRole('checkbox', { name: 'Priority P1', exact: true })).not.toBeChecked();
    await expect(panel.getByRole('combobox', { name: 'Last updated', exact: true })).toHaveValue('7');
    await page.locator('.repo-select').selectOption('org/b');
    await expect(panel).toContainText('The selected source is unavailable in this scope. Your selection is kept.');
    await panel.getByRole('combobox', { name: 'Task source', exact: true }).selectOption('');
    await expect.poll(() => f.queries.some(query => query.get('repo') === 'org/b')).toBe(true);
    await expect(page.locator('.repo-select')).toHaveValue('org/b');
    expect(f.mutations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
