import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { DEFAULT_THEME_GENERATOR_SETTINGS, createThemeRecipeFromPalette, generateThemePalette } from '../../src/data/themeGenerator';
import { expectReadableSurfaces } from './theme-contrast';

const at = '2026-10-09T12:00:00.000Z';
const longPrompt = '<img src=x onerror=alert(1)>\nReview the terminal workspace and preserve the selected tab, input draft, keyboard focus, screen scroll position, and exact command targets while updating this prompt preview. Explain any important edge cases before changing the implementation.';
const tabs = Array.from({ length: 6 }, (_, index) => ({
  target: { repo: index === 4 ? 'org/b' : null, surfaceRef: `surface:${index + 1}`, revision: String(index + 1).repeat(64) },
  title: ['Application server', 'Review work', 'Build output', 'Shell', 'Another galleon', 'Agent console'][index],
  workspaceTitle: index < 4 ? 'Development' : 'Operations', type: 'terminal', selected: index === 0, actions: [],
  ...(index === 3 ? {} : { lastPrompt: [longPrompt, 'Review AAB #11330 and summarize unresolved feedback.', null, undefined, 'Check the build output before starting the next task.', 'Run the focused unit tests and report failures.'][index] }),
}));
async function mockTerminal(page: Page, state: 'tabs' | 'empty' | 'disconnected' | 'unavailable' = 'tabs') {
  const lists: URLSearchParams[] = []; const screens: { target: typeof tabs[number]['target']; scopeRepo: null }[] = [];
  const controls: { command: { version: 1; target: typeof tabs[number]['target']; operation: unknown; requestId: string }; scopeRepo: null }[] = [];
  let screenVersion = 0; let promptVersion = 0;
  const updatedPrompt = 'The newest prompt arrived while you were writing this draft.';
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/terminal/tabs') {
      lists.push(url.searchParams);
      return state === 'unavailable' ? route.fulfill({ status: 503, json: { error: 'Terminal unavailable' } }) : route.fulfill({ json: { version: 1, repo: null, connected: state !== 'disconnected', quality: 'complete', tabs: state === 'tabs' ? tabs.map(tab => tab.target.surfaceRef === 'surface:5' && promptVersion ? { ...tab, lastPrompt: updatedPrompt } : tab) : [], observedAt: at } });
    }
    if (path === '/api/terminal/screen') {
      const body = request.postDataJSON(); screens.push(body);
      return route.fulfill({ json: { version: 1, target: body.target, text: `<img src=x onerror=alert(1)>\n${Array.from({ length: 90 }, (_, index) => `Screen line ${index + 1}`).join('\n')}\nPreview ${screenVersion}`, truncated: false, observedAt: at } });
    }
    if (path === '/api/terminal/control') {
      const body = request.postDataJSON(); controls.push(body);
      const { requestId, ...input } = body.command;
      return route.fulfill({ json: { version: 1, requestId, input, status: 'succeeded', reason: null } });
    }
    if (request.method() !== 'GET') return route.fulfill({ status: 503, json: { error: 'Unexpected write blocked by test' } });
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.terminal']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} } : {};
    return route.fulfill({ json });
  });
  return { lists, screens, controls, updatedPrompt, updatePrompt: () => { promptVersion++; }, updateScreen: () => { screenVersion++; } };
}
async function seedScopedLayout(page: Page) {
  await page.goto('/config?repo=org%2Fa');
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('helmsman.composition-layouts', 1);
      request.onupgradeneeded = () => { for (const store of ['layouts', 'migrations']) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'compositionId' }); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('layouts', 'readwrite');
      transaction.objectStore('layouts').put({ version: 1, compositionId: 'helmsman/terminal-page', revision: 7,
        instances: [{ instanceId: 'terminal', contributionId: 'helmsman.terminal/panel', scope: { kind: 'galleon', repo: 'org/a' }, state: {}, hidden: false }],
        columns: [[{ instances: ['terminal'], activeInstanceId: 'terminal', collapsed: false }]] });
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
}

for (const { width, mode } of [{ width: 1440, mode: 'dark' }, { width: 900, mode: 'dark' }, { width: 390, mode: 'dark' }, { width: 1440, mode: 'light' }, { width: 390, mode: 'custom' }] as const) test.describe(`Terminal at ${width}px in ${mode}`, () => {
  test.use({ viewport: { width, height: 1100 }, hasTouch: width === 390 });
  test('shows every global terminal and preserves explicit controls and header scope', async ({ page }) => {
    if (mode !== 'dark') {
      const recipe = mode === 'custom' ? createThemeRecipeFromPalette(['#780000', '#c1121f', '#fdf0d5', '#003049', '#669bbc']) : { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {} };
      if (!recipe) throw new Error('Invalid theme fixture');
      await page.addInitScript(value => localStorage.setItem('cmux.theme.custom', value), JSON.stringify({ version: 3, recipe, palette: generateThemePalette(recipe.settings, mode === 'light' ? 'light' : 'dark', recipe.overrides, 'sourcePalette' in recipe ? recipe.sourcePalette : undefined) }));
    }
    const f = await mockTerminal(page); await seedScopedLayout(page);
    await page.goto('/terminal?repo=org%2Fa');
    const panel = page.locator('.terminal-panel');
    await expect(panel.locator('.terminal-tab')).toHaveCount(6);
    await expect(panel.locator('.terminal-tab-prompt')).toHaveCount(6);
    const rawPrompt = panel.locator('[data-surface="surface:1"] .terminal-tab-prompt');
    await expect(rawPrompt).toHaveText(longPrompt.replace(/\s+/g, ' ').trim());
    await expect(rawPrompt).toHaveAttribute('title', longPrompt);
    await expect(panel.locator('[data-surface="surface:1"]')).toHaveAttribute('aria-description', longPrompt.replace(/\s+/g, ' ').trim());
    await expect(panel.locator('[data-surface="surface:3"] .terminal-tab-prompt')).toHaveText('No prompt available');
    await expect(panel.locator('[data-surface="surface:4"] .terminal-tab-prompt')).toHaveText('No prompt available');
    await expect(panel.locator('.terminal-tab img, .terminal-tab script')).toHaveCount(0);
    const savedScope = await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('helmsman.composition-layouts', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const layout = await new Promise<{ instances: { scope: { kind: string } }[] }>((resolve, reject) => { const request = database.transaction('layouts').objectStore('layouts').get('helmsman/terminal-page'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      database.close(); return layout.instances[0]?.scope;
    });
    expect(savedScope).toEqual({ kind: 'all' });
    await expect(page.locator('.repo-select')).toBeHidden();
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Refresh page', exact: true })).toHaveCount(1);
    await expect(panel.locator('[data-refresh]')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /Use top selection|Show all terminals/ })).toHaveCount(0);
    await panel.locator('[data-surface="surface:5"]').click();
    await expect(panel.locator('.terminal-screen')).toContainText('<img src=x onerror=alert(1)>');
    await expect(panel.locator('img, script')).toHaveCount(0);
    await expect(panel.locator('[data-surface="surface:5"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/repo=org%2Fa/);
    await expect(page).toHaveURL(/surface=surface%3A5/);
    await expectReadableSurfaces(panel, ['.terminal-connection', '.terminal-tab-title', '.terminal-tab-prompt', '.terminal-tab-prompt.is-empty', '.terminal-tab[aria-pressed=true] .terminal-tab-prompt', '.terminal-tab small', '.terminal-column-head h3', '.terminal-screen', '.terminal-input', '.terminal-send button', '.terminal-note']);
    await expectReadableSurfaces(panel, ['.terminal-connection .terminal-phosphor', '.terminal-tab[aria-pressed=true] .terminal-phosphor'], 3);
    if (width === 390) {
      expect((await panel.locator('[data-capture]').boundingBox())?.height).toBeGreaterThanOrEqual(44);
      expect((await panel.locator('[data-key=up]').boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    await panel.locator('.terminal-input').fill('Keep this draft');
    const screen = panel.locator('.terminal-screen');
    await screen.evaluate(element => { element.scrollTop = 180; });
    f.updateScreen(); f.updatePrompt();
    await expect(panel.locator('[data-surface="surface:5"] .terminal-tab-prompt')).toHaveText(f.updatedPrompt);
    await expect(screen).toContainText('Preview 1');
    await expect(panel.locator('.terminal-input')).toBeFocused();
    await expect(panel.locator('.terminal-input')).toHaveValue('Keep this draft');
    expect(await screen.evaluate(element => element.scrollTop)).toBe(180);
    expect(f.controls).toEqual([]);
    expect(f.lists.every(query => !query.has('repo') && !query.has('scopeRepo'))).toBe(true);
    expect(f.screens.every(body => body.scopeRepo === null && tabs.some(tab => JSON.stringify(tab.target) === JSON.stringify(body.target)))).toBe(true);
    await page.locator('#page-content').evaluate(element => { element.scrollTop = 0; });
    await panel.locator('.terminal-input').blur(); await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot(`terminal-${width}-${mode}.png`);
    if (width === 390 && mode === 'dark') {
      await panel.getByRole('button', { name: 'Collapse Terminal tabs', exact: true }).tap();
      await expect(panel.locator('.terminal-tabs')).toBeHidden();
      await expect(panel.getByRole('button', { name: 'Expand Terminal tabs', exact: true })).toBeFocused();
      await panel.locator('[data-capture]').tap(); await expect(screen).toBeFocused();
      await screen.press('Shift+Escape'); await expect(panel.locator('[data-capture]')).toBeFocused();
      await panel.getByRole('button', { name: 'Send + Enter', exact: true }).tap();
      await expect.poll(() => f.controls.length).toBe(1);
      const history = panel.locator('details');
      await history.locator('summary').tap();
      await expect(history.getByText('Control confirmed.', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: 'Collapse Terminal screen', exact: true }).tap();
      await expect(screen).toBeHidden();
      await panel.getByRole('button', { name: 'Expand Terminal screen', exact: true }).tap();
      await expect(screen).toBeVisible();
      await panel.getByRole('button', { name: 'Expand Terminal tabs', exact: true }).tap();
      await expect(panel.locator('.terminal-tabs')).toBeVisible();
    }
    if (width === 1440 && mode === 'dark') {
      await page.reload(); await expect(panel.locator('.terminal-input')).toHaveValue('Keep this draft');
      await panel.getByRole('button', { name: 'Send + Enter', exact: true }).click();
      await expect.poll(() => f.controls.length).toBe(1);
      expect(f.controls[0]?.command.target).toEqual(tabs[4]?.target);
      expect(f.controls[0]?.command.operation).toEqual({ kind: 'text', text: 'Keep this draft', enter: true });
      expect(f.controls[0]?.scopeRepo).toBeNull();
      await expect(panel.locator('.terminal-input')).toHaveValue('');
      await panel.locator('[data-capture]').click(); await expect(screen).toBeFocused();
      await screen.press('ArrowUp'); await expect.poll(() => f.controls.length).toBe(2);
      expect(f.controls[1]?.command.operation).toEqual({ kind: 'key', key: 'up' });
      await screen.press('Shift+Escape'); await expect(panel.locator('[data-capture]')).toBeFocused();
      await expect(panel.locator('[data-capture]')).toHaveAttribute('aria-pressed', 'false');
      await page.getByRole('tab', { name: 'Config', exact: true }).click();
      await expect(page.locator('.repo-select')).toBeVisible(); await expect(page.locator('.repo-select')).toHaveValue('org/a');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

for (const state of ['empty', 'disconnected', 'unavailable'] as const) test(`Terminal ${state} offers a meaningful recovery state`, async ({ page }) => {
  const f = await mockTerminal(page, state); await page.goto('/terminal?repo=org%2Fa');
  const panel = page.locator('.terminal-panel');
  await expect(panel.locator('.terminal-empty')).toBeVisible();
  await expect(panel.locator('.terminal-empty h3')).toHaveText(state === 'empty' ? 'No terminal tabs open' : state === 'disconnected' ? 'Terminal is not connected' : 'Terminal connection unavailable');
  await expect(panel.locator('.terminal-empty p')).toContainText(/refresh/i);
  await expect(panel.locator('.terminal-columns')).toBeHidden();
  if (state === 'unavailable') await expect(panel.locator('.terminal-status')).toHaveText('Terminal tabs could not be loaded. Refresh to retry.');
  await expectReadableSurfaces(panel, ['.terminal-empty h3', '.terminal-empty p']);
  await expect(page.getByRole('button', { name: 'Refresh page', exact: true })).toHaveCount(1);
  expect(f.controls).toEqual([]);
  await expect(page).toHaveScreenshot(`terminal-${state}.png`);
});
