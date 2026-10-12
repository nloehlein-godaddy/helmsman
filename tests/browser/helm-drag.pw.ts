import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { expectReadableSurfaces } from './theme-contrast';
import { DEFAULT_THEME_GENERATOR_SETTINGS, generateThemePalette } from '../../src/data/themeGenerator';

const draftText = 'Preserve local draft <img src=x onerror=alert(1)> during panel movement.';
interface Layout { revision: number; instances: { instanceId: string; scope: unknown; state: unknown }[]; columns: { instances: string[]; activeInstanceId: string; collapsed: boolean }[][]; }
async function layout(page: Page): Promise<Layout> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('helmsman.composition-layouts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const value = await new Promise<Layout>((resolve, reject) => { const tx = db.transaction('layouts', 'readonly'); const read = tx.objectStore('layouts').get('helmsman/helm-page'); tx.oncomplete = () => resolve(read.result); tx.onerror = () => reject(tx.error); }); db.close(); return value;
  });
}
async function fixture(page: Page, light = false) {
  const writes: string[] = []; const errors: string[] = [];
  if (light) await page.addInitScript(value => localStorage.setItem('cmux.theme.custom', value), JSON.stringify({ version: 3, recipe: { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {} }, palette: generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'light') }));
  await page.addInitScript(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
      if ((window as Window & { failHelmWrites?: boolean }).failHelmWrites && this.name === 'helmsman.composition-layouts' && args[1] === 'readwrite') throw new DOMException('Fixture storage unavailable', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { writes.push(path); return route.fulfill({ status: 503, json: { error: 'Unexpected write blocked by test' } }); }
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.helm', 'helmsman.newrun', 'helmsman.running', 'helmsman.recent']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } }
      : path === '/api/vpn-status' ? { version: 1, state: 'unknown', client: 'unknown', network: 'not-configured', checkedAt: '2026-10-12T12:00:00.000Z' }
      : path === '/api/task-sources' ? { instances: [] }
      : path === '/api/run-read' ? { version: 1, repo: url.searchParams.get('repo'), items: [], nextCursor: null } : {};
    return route.fulfill({ json });
  });
  await page.goto('/config?repo=org%2Fa'); await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await page.evaluate(async text => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('helmsman.composition-layouts', 1); open.onupgradeneeded = () => { for (const name of ['layouts', 'migrations']) if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name, { keyPath: 'compositionId' }); }; open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('layouts', 'readwrite'); tx.objectStore('layouts').put({ version: 1, compositionId: 'helmsman/helm-page', revision: 7,
        instances: [
          { instanceId: 'draft', contributionId: 'helmsman.newrun/panel', scope: { kind: 'galleon', repo: 'org/b' }, hidden: false, state: { 'helmsman.newrun/panel': { version: 1, value: { selectedRepo: null, drafts: [{ repo: 'org/b', draft: { mode: 'freeform', task: text, prNumber: '', feedback: '', model: '', effort: '', lookupKey: '', source: null, ref: null } }] } } } },
          { instanceId: 'hidden', contributionId: 'helmsman.recent/panel', scope: { kind: 'inherit' }, hidden: true, state: { retained: { version: 1, value: { opaque: 'stack member' } } } },
          { instanceId: 'recent', contributionId: 'helmsman.recent/panel', scope: { kind: 'inherit' }, hidden: false, state: {} },
          { instanceId: 'running', contributionId: 'helmsman.running/panel', scope: { kind: 'inherit' }, hidden: false, state: {} },
        ], columns: [[{ instances: ['draft', 'hidden'], activeInstanceId: 'draft', collapsed: false }], [{ instances: ['recent'], activeInstanceId: 'recent', collapsed: false }, { instances: ['running'], activeInstanceId: 'running', collapsed: true }]] });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    }); db.close();
  }, draftText);
  await page.goto('/helm?repo=org%2Fa'); await expect(page.locator('#helm-body-draft textarea')).toHaveValue(draftText);
  return { writes, errors };
}
const positions = (value: Layout) => value.columns.map(column => column.map(stack => stack.activeInstanceId));
for (const { width, mode } of [{ width: 1440, mode: 'dark' }, { width: 390, mode: 'dark' }, { width: 1440, mode: 'light' }] as const) test.describe(`Draggable Helm at ${width}px in ${mode}`, () => {
  test.use({ viewport: { width, height: 1100 }, hasTouch: width === 390 });
  test('moves real grips with pointer and keyboard while preserving mounted drafts and saved scope', async ({ page }) => {
    const f = await fixture(page, mode === 'light'); const root = page.locator('.plugin-helm'); const grip = (id: string) => root.locator(`[data-helm-focus="${id}:move"]`); const before = await layout(page);
    await expect(grip('draft')).toHaveAccessibleDescription(/Space or Enter.*arrow.*Escape/i); await expect(root.locator('.helm-grip')).toHaveCount(3); await expect(page.locator('.repo-select')).toHaveValue('org/a'); await expect(page.locator('#helm-body-draft')).toContainText('org/b');
    await expectReadableSurfaces(root, ['.helm-grip'], 3); if (width === 390) { const box = await grip('draft').boundingBox(); expect(box?.height).toBeGreaterThanOrEqual(44); expect(box?.width).toBeGreaterThanOrEqual(44); }
    await page.evaluate(() => { (window as Window & { retainedHelmBody?: Element | null }).retainedHelmBody = document.querySelector('#helm-body-draft'); });
    await page.mouse.move(0, 0); await expect(page).toHaveScreenshot(`helm-grips-${width}-${mode}.png`);
    const recent = grip('recent'); await recent.scrollIntoViewIfNeeded(); const start = await recent.boundingBox(); const destination = await root.locator('#helm-body-draft').locator('..').locator('.helm-stack-header').boundingBox(); expect(start && destination).toBeTruthy(); if (!start || !destination) return;
    const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 }; const to = { x: destination.x + destination.width / 2, y: destination.y + destination.height / 2 };
    const client = width === 390 ? await page.context().newCDPSession(page) : null;
    if (client) { await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] }); await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] }); }
    else { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 }); }
    await expect(recent).toHaveAttribute('aria-pressed', 'true'); await expect(root.locator('.helm-drop-before')).toHaveCount(1);
    if (mode === 'dark') await expect(page).toHaveScreenshot(`helm-drop-${width}.png`);
    if (client) { await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await client.detach(); } else await page.mouse.up();
    await expect.poll(async () => positions(await layout(page))).toEqual([['recent', 'draft'], ['running']]); await expect(recent).toHaveAttribute('aria-pressed', 'false'); await expect(root.locator('.helm-sr-only[aria-live="polite"]')).toContainText('Panel moved.');
    expect((await layout(page)).instances).toEqual(before.instances); expect((await layout(page)).columns[1]?.[0]?.collapsed).toBe(true); expect(await page.evaluate(() => (window as Window & { retainedHelmBody?: Element | null }).retainedHelmBody === document.querySelector('#helm-body-draft'))).toBe(true); await expect(page.locator('#helm-body-draft textarea')).toHaveValue(draftText);
    await grip('draft').focus(); await grip('draft').press('Space'); await grip('draft').press('ArrowRight'); await grip('draft').press('Enter'); await expect.poll(async () => positions(await layout(page))).toEqual([['recent'], ['running', 'draft']]); await expect(grip('draft')).toBeFocused();
    const saved = await layout(page); await grip('draft').press('Enter'); await grip('draft').press('ArrowLeft'); await grip('draft').press('Escape'); expect(await layout(page)).toEqual(saved); await expect(grip('draft')).toHaveAttribute('aria-pressed', 'false');
    await page.reload(); await expect(grip('draft')).toBeVisible(); expect(positions(await layout(page))).toEqual([['recent'], ['running', 'draft']]); await expect(page.locator('#helm-body-draft textarea')).toHaveValue(draftText); await expect(page.locator('.repo-select')).toHaveValue('org/a');
    const collapse = root.locator('[data-helm-focus="running:collapse"]'); await collapse.click(); await expect(collapse).toHaveAttribute('aria-expanded', 'true'); await collapse.click(); await expect(collapse).toHaveAttribute('aria-expanded', 'false');
    if (width === 1440 && mode === 'dark') {
      const retained = await layout(page); await page.evaluate(() => { (window as Window & { failHelmWrites?: boolean }).failHelmWrites = true; }); await grip('draft').focus(); await grip('draft').press('Space'); await grip('draft').press('ArrowUp'); await grip('draft').press('Enter'); await expect(root.getByRole('alert').filter({ hasText: 'The layout changed or could not be saved' })).toBeVisible(); expect(await layout(page)).toEqual(retained); await expect(page.locator('#helm-body-draft textarea')).toHaveValue(draftText); await page.evaluate(() => { (window as Window & { failHelmWrites?: boolean }).failHelmWrites = false; }); await root.getByRole('button', { name: 'Refresh page', exact: true }).click(); await expect(root.getByRole('alert').filter({ hasText: 'The layout changed or could not be saved' })).toHaveCount(0);
    }
    expect(f.writes).toEqual([]); expect(f.errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test.describe('Helm edge scrolling on touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('scrolls the page during a real touch drag and cancels without saving', async ({ page }) => {
    const f = await fixture(page); const saved = await layout(page); const grip = page.locator('[data-helm-focus="draft:move"]'); const scroll = page.locator('#page-content');
    const start = await grip.boundingBox(); const bounds = await scroll.boundingBox(); expect(start && bounds).toBeTruthy(); if (!start || !bounds) return;
    const client = await page.context().newCDPSession(page); const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 }; const edge = { x: from.x, y: bounds.y + bounds.height - 18 };
    const originalScroll = await scroll.evaluate(element => element.scrollTop);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] }); await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [edge] });
    await expect(grip).toHaveAttribute('aria-pressed', 'true'); await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(originalScroll + 20);
    await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await client.detach(); await expect(grip).toHaveAttribute('aria-pressed', 'false'); expect(await layout(page)).toEqual(saved);
    await grip.focus(); await grip.press('Space'); await grip.press('ArrowRight'); await grip.press('End'); await grip.press('Enter');
    await expect.poll(async () => positions(await layout(page))).toEqual([[], ['recent', 'running', 'draft']]);
    const retained = await layout(page); const recent = page.locator('[data-helm-focus="recent:move"]'); await recent.focus(); await recent.press('Space'); await recent.press('ArrowLeft');
    await expect(page.locator('.helm-empty-target[data-helm-column="0"]')).toBeInViewport(); await recent.press('Escape'); expect(await layout(page)).toEqual(retained);
    expect(f.writes).toEqual([]); expect(f.errors).toEqual([]);
  });
});
