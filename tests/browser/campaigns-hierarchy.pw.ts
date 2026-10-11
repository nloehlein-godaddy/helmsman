import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { expectReadableSurfaces } from './theme-contrast';
import { DEFAULT_THEME_GENERATOR_SETTINGS, createThemeRecipeFromPalette, generateThemePalette } from '../../src/data/themeGenerator';

const at = '2026-10-09T12:00:00.000Z'; const revision = 'a'.repeat(64);
const raw = 'Keep literal customer content <img src=x onerror=alert(1)>.';
const campaign = (repo: string) => ({ id: repo === 'org/a' ? 'campaign-a' : 'campaign-b', name: repo === 'org/a' ? 'Customer content reliability' : 'Terminal connection cleanup', repo, workflowRef: 'coding@v1', concurrency: 2, createdAt: at });
const record = (repo = 'org/a', title = 'Preserve customer content', task = raw) => ({ key: null, repo, mode: 'freeform', task, ticketId: null, title });
const task = (id: string, phaseId: string, state: 'queued' | 'running' | 'failed' | 'succeeded' | 'claiming', repo = 'org/a') => ({ id, campaignId: 'campaign-a', phaseId, record: record(repo, state === 'failed' ? 'Restore import data after a worker failure' : state === 'running' ? 'Preserve terminal connection scope' : 'Keep customer content literal'), state, attempt: state === 'failed' ? 2 : 1, runId: `run-${id}`, claimToken: null, claimedAt: null, error: state === 'failed' ? 'Literal worker error <script>bad()</script>' : null, createdAt: at, updatedAt: at });
const phase = (id: string, name: string, position: number, state: 'paused' | 'running' | 'completed') => ({ id, campaignId: 'campaign-a', name, position, state, createdAt: at, updatedAt: at });
const preview = { id: 'preview-1', campaignId: 'campaign-a', phaseId: 'phase-1', digest: 'd'.repeat(64), records: [record(), record('org/b', 'Explicit destination', 'Keep this task in its explicit galleon')], duplicateCount: 1, createdAt: at, importedAt: null };
const content = JSON.stringify({ task: raw, repo: 'org/a' });
async function fixture(page: Page, empty = false, saved = true) {
  const reads: (string | null)[] = []; const writes: string[] = []; const state = { failed: false, workflows: true };
  if (saved && !empty) await page.addInitScript(value => { const key = 'helmsman.campaigns.v1:helmsman.campaigns/panel:campaigns:draft'; if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }, JSON.stringify({ version: 1, forms: { 'org/a': { name: 'Follow-up batch draft', workflowRef: 'coding@v1', concurrency: '2' } }, selected: { 'org/a': { id: 'campaign-a', repo: 'org/a' } }, phases: { 'campaign-a': { name: 'Wider rollout draft', revision, imports: { 'phase-1': { format: 'jsonl', content, revision } } } }, previews: { 'phase-1': { repo: 'org/a', target: { campaignId: 'campaign-a', revision }, preview, content, format: 'jsonl' } } }));
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { writes.push(path); return route.fulfill({ status: 503, json: { error: 'Unexpected write blocked by test' } }); }
    const repo = url.searchParams.get('repo');
    if (path === '/api/campaign-service/list') { reads.push(repo); if (state.failed) return route.fulfill({ status: 503, json: { error: 'Fixture campaigns unavailable' } }); return route.fulfill({ json: { version: 1, repo, campaigns: empty ? [] : (repo ? [campaign(repo)] : [campaign('org/a'), campaign('org/b')]), workflows: state.workflows ? [{ ref: 'coding@v1', name: 'Coding tasks' }] : [] } }); }
    if (path === '/api/campaign-service/detail') return route.fulfill({ json: { version: 1, revision, campaign: campaign(repo ?? 'org/a'), phases: repo === 'org/b' ? [] : [{ phase: phase('phase-1', 'Pilot fixes', 0, 'paused'), tasks: [task('task-1', 'phase-1', 'queued'), task('task-2', 'phase-1', 'running', 'org/b'), task('task-3', 'phase-1', 'failed'), task('task-4', 'phase-1', 'succeeded')] }, { phase: phase('phase-2', 'Active rollout', 1, 'running'), tasks: [task('task-5', 'phase-2', 'claiming')] }, { phase: phase('phase-3', 'Initial validation', 2, 'completed'), tasks: [task('task-6', 'phase-3', 'succeeded')] }] } });
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.campaigns']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} } : {};
    return route.fulfill({ json });
  }); return { reads, writes, state };
}
async function theme(page: Page, mode: 'dark' | 'light' | 'custom') {
  if (mode === 'dark') return;
  const recipe = mode === 'custom' ? createThemeRecipeFromPalette(['#780000', '#c1121f', '#fdf0d5', '#003049', '#669bbc']) : { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {} };
  if (!recipe) throw new Error('Invalid theme fixture');
  await page.addInitScript(value => localStorage.setItem('cmux.theme.custom', value), JSON.stringify({ version: 3, recipe, palette: generateThemePalette(recipe.settings, mode === 'light' ? 'light' : 'dark', recipe.overrides, 'sourcePalette' in recipe ? recipe.sourcePalette : undefined) }));
}
for (const { width, mode } of [{ width: 1440, mode: 'dark' }, { width: 900, mode: 'dark' }, { width: 390, mode: 'dark' }, { width: 1440, mode: 'light' }, { width: 390, mode: 'custom' }] as const) test.describe(`Campaigns at ${width}px in ${mode}`, () => {
  test.use({ viewport: { width, height: 1100 }, hasTouch: width === 390 });
  test('preserves scoped drafts, independent task states and deliberate campaign actions', async ({ page }) => {
    await theme(page, mode); const f = await fixture(page); await page.goto('/campaigns?repo=org%2Fa');
    const root = page.locator('.campaigns-page'); const panel = root.locator('.campaign-page'); const create = panel.locator('[data-campaign-create]'); const phaseForm = panel.locator('[data-campaign-phase-create]'); const importForm = panel.locator('[data-campaign-import="phase-1"]'); const refresh = root.getByRole('button', { name: 'Refresh page', exact: true });
    await expect(panel.getByRole('heading', { name: 'Customer content reliability', exact: true })).toBeVisible();
    await expect(root.locator('h1')).toHaveCount(1); await expect(refresh).toHaveCount(1); await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0); await expect(panel.getByRole('button', { name: 'Use top selection', exact: true })).toHaveCount(0);
    await expect(create.getByLabel('Campaign name')).toHaveValue('Follow-up batch draft'); await expect(phaseForm.getByLabel('New phase', { exact: true })).toHaveValue('Wider rollout draft'); await expect(panel.locator('[data-campaign-select="campaign-a"]')).toHaveAttribute('aria-pressed', 'true');
    for (const [state, label, count] of [['queued', 'Queued', 1], ['running', 'Running', 1], ['failed', 'Failed', 1], ['succeeded', 'Succeeded', 2]] as const) {
      const cells = panel.getByRole('cell').filter({ has: page.locator(`.campaign-task-state[data-state="${state}"]`) });
      await expect(cells).toHaveCount(count); await expect(cells.locator('.campaign-task-state')).toContainText(Array(count).fill(label));
    }
    await expect(panel.locator('.campaign-preview')).toContainText(raw); await expect(panel.locator('.campaign-preview')).toContainText('org/b'); await expect(panel.locator('img,script')).toHaveCount(0);
    if (width === 390) {
      const table = panel.locator('.campaign-table-wrap').first(); const running = table.locator('tbody tr').nth(1);
      await expect.poll(async () => (await running.locator('.campaign-task-title').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(250);
      await expect.poll(async () => (await running.locator('td[data-label="State"]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(100);
      await expect.poll(async () => (await running.locator('.campaign-task-actions button').first().boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(90);
      await expect(running.locator('td[data-label="Attempt"]')).toHaveText('1');
      const title = await running.locator('.campaign-task-title').boundingBox(); const repo = await running.locator('.campaign-task-repo').boundingBox(); const actions = await running.locator('.campaign-task-actions').boundingBox();
      expect(title && repo && actions && title.y < repo.y && repo.y < actions.y).toBe(true);
    }
    await expectReadableSurfaces(root, ['.campaign-scope', '[data-campaign-create] label', '.campaign-primary', '.campaign-state', '.campaign-detail h2', '.campaign-preview', '.campaign-table-wrap th', '.campaign-task-state[data-state=queued]', '.campaign-task-state[data-state=running]', '.campaign-task-state[data-state=failed]', '.campaign-task-state[data-state=succeeded]']);
    await expect(panel.locator('.campaign-icon').first()).toHaveAttribute('aria-hidden', 'true'); await expectReadableSurfaces(root, ['.campaign-icon'], 3);
    await page.locator('#page-content').evaluate(node => { node.scrollTop = 0; }); await page.mouse.move(0, 0); await expect(page).toHaveScreenshot(`campaigns-${width}-${mode}.png`);
    const previewPanel = panel.locator('.campaign-preview');
    if (mode === 'dark' && width !== 900) { await previewPanel.evaluate(node => node.scrollIntoView({ block: 'start' })); await page.mouse.move(0, 0); await expect(page).toHaveScreenshot(`campaigns-preview-${width}.png`); await panel.locator('.campaign-table-wrap').first().evaluate(node => node.scrollIntoView({ block: 'start' })); await expect(page).toHaveScreenshot(`campaigns-tasks-${width}.png`); }
    const execution = create.locator('details.campaign-settings'); const executionSummary = execution.locator('summary'); await executionSummary.focus(); await executionSummary.press('Enter'); await expect(execution).toHaveAttribute('open', '');
    const createName = create.getByLabel('Campaign name'); await createName.fill('Retain this creation draft'); await createName.evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 8));
    await refresh.evaluate(button => (button as HTMLButtonElement).click()); await expect(createName).toBeFocused(); expect(await createName.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([2, 8]); await expect(execution).toHaveAttribute('open', '');
    const importSummary = importForm.locator('details > summary').first(); await importSummary.focus(); await importSummary.press('Enter'); const taskData = importForm.getByRole('textbox', { name: 'Task data', exact: true }); await expect(taskData).toHaveValue(content); await taskData.fill(content + '\n' + JSON.stringify({ task: 'Keep imported task drafts' }));
    await refresh.evaluate(button => (button as HTMLButtonElement).click()); await expect(taskData).toBeFocused(); await expect(taskData).toHaveValue(content + '\n' + JSON.stringify({ task: 'Keep imported task drafts' })); await expect(importSummary.locator('..')).toHaveAttribute('open', '');
    if (width === 390) { await expect.poll(async () => (await panel.locator('[data-campaign-action="resume"]').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44); await expect.poll(async () => (await executionSummary.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44); }
    const stop = panel.locator('[data-campaign-action="stop"][data-phase-id="phase-1"]'); await stop.focus(); await stop.press('Enter'); await expect(panel.locator('[data-campaign-dismiss]')).toBeFocused(); await panel.locator('[data-campaign-dismiss]').press('Enter'); await expect(stop).toBeFocused();
    await root.locator('[data-scope-all]').click(); await expect.poll(() => f.reads.includes(null)).toBe(true); await expect(page.locator('.repo-select')).toHaveValue('org/a'); await expect(create.getByRole('button', { name: 'Create campaign', exact: true })).toBeDisabled();
    await panel.locator('[data-campaign-select="campaign-b"]').focus(); await panel.locator('[data-campaign-select="campaign-b"]').press('Enter'); await expect(panel.getByRole('heading', { name: 'Terminal connection cleanup', exact: true })).toBeVisible(); await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await root.locator('[data-scope-inherit]').click(); await expect(panel.getByRole('heading', { name: 'Customer content reliability', exact: true })).toBeVisible(); await expect(createName).toHaveValue('Retain this creation draft'); await expect(taskData).toHaveValue(content + '\n' + JSON.stringify({ task: 'Keep imported task drafts' }));
    await page.reload(); await expect(createName).toHaveValue('Retain this creation draft'); await expect(phaseForm.getByLabel('New phase', { exact: true })).toHaveValue('Wider rollout draft');
    await page.locator('.repo-select').selectOption('org/b'); await expect(panel.getByRole('heading', { name: 'Terminal connection cleanup', exact: true })).toBeVisible(); await expect(createName).toHaveValue(''); await page.locator('.repo-select').selectOption('org/a'); await expect(createName).toHaveValue('Retain this creation draft');
    expect(f.writes).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  });
});
for (const width of [1440, 390]) test.describe(`Empty Campaigns at ${width}px`, () => {
  test.use({ viewport: { width, height: 1100 }, hasTouch: width === 390 });
  test('shows a useful empty state with creation enabled only for a selected galleon', async ({ page }) => {
    const f = await fixture(page, true); await page.goto('/campaigns?repo=org%2Fa'); const root = page.locator('.campaigns-page'); const panel = root.locator('.campaign-page');
    await expect(panel.getByRole('button', { name: 'Create campaign', exact: true })).toBeEnabled(); await expect(panel).toContainText('No campaigns yet'); await expect(panel).toContainText('Import adds queued tasks'); await expect(panel).toContainText('Start phase launches queued tasks'); await expect(root.locator('h1')).toHaveCount(1);
    await page.mouse.move(0, 0); await expect(page).toHaveScreenshot(`campaigns-empty-${width}.png`); await root.locator('[data-scope-all]').click(); await expect(panel.getByRole('button', { name: 'Create campaign', exact: true })).toBeDisabled(); await expect(page.locator('.repo-select')).toHaveValue('org/a'); expect(f.writes).toEqual([]);
  });
});
test('plain campaign copy leaves task content and technical identifiers literal', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('helmsman.pirateMode', 'false')); const f = await fixture(page); await page.goto('/campaigns?repo=org%2Fa'); const panel = page.locator('.campaign-page');
  await expect(panel.getByRole('heading', { name: 'Customer content reliability', exact: true })).toBeVisible(); await expect(panel.getByRole('columnheader', { name: 'Repository', exact: true })).toHaveCount(3); await expect(panel.locator('.campaign-preview')).toContainText(raw); expect(f.writes).toEqual([]);
});

test('local draft errors and read failures keep recovery accessible without sending commands', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    const taskWindow = window as Window & { restoreCampaignStorage?: () => void };
    taskWindow.restoreCampaignStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('helmsman.campaigns.v1:')) throw new DOMException('Fixture storage full', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  const f = await fixture(page, true, false); await page.goto('/campaigns?repo=org%2Fa'); const root = page.locator('.campaigns-page'); const panel = root.locator('.campaign-page'); const name = panel.getByLabel('Campaign name', { exact: true }); const refresh = root.getByRole('button', { name: 'Refresh page', exact: true });
  await expect(panel.getByRole('button', { name: 'Create campaign', exact: true })).toBeEnabled(); await name.fill('Retain draft through recovery');
  await expect(panel.locator('[data-storage-error]')).toHaveAttribute('role', 'alert'); await expect(panel.locator('[data-storage-error]')).toContainText('Fixture storage full'); const retry = panel.getByRole('button', { name: 'Retry saving drafts', exact: true }); await expect(retry).toBeVisible(); await expect(panel.getByRole('button', { name: 'Create campaign', exact: true })).toBeDisabled();
  await refresh.focus(); await page.evaluate(() => (window as Window & { restoreCampaignStorage?: () => void }).restoreCampaignStorage?.()); await retry.focus(); await retry.press('Enter'); await expect(retry).toBeHidden(); await expect(name).toHaveValue('Retain draft through recovery'); await expect(panel.getByRole('button', { name: 'Create campaign', exact: true })).toBeEnabled();
  f.state.failed = true; await refresh.click(); await expect(panel.locator('.campaign-error[role="alert"]').filter({ hasText: 'could not be refreshed' })).toBeVisible(); await expect(name).toHaveValue('Retain draft through recovery'); await expect(panel.getByRole('button', { name: 'Create campaign', exact: true })).toBeDisabled();
  f.state.failed = false; await refresh.click(); await expect(panel.getByRole('button', { name: 'Create campaign', exact: true })).toBeEnabled(); await expect(refresh).toBeFocused(); f.state.workflows = false; await refresh.click(); await expect(panel).toContainText('No task workflow is available'); await expect(panel.getByRole('button', { name: 'Create campaign', exact: true })).toBeDisabled(); await expect(name).toHaveValue('Retain draft through recovery'); expect(f.writes).toEqual([]);
});
