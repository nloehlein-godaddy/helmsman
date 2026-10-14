import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { expectReadableSurfaces } from './theme-contrast';
import { DEFAULT_THEME_GENERATOR_SETTINGS, generateThemePalette } from '../../src/data/themeGenerator';

const at = '2026-10-14T12:00:00.000Z';
async function mockFeedback(page: Page) {
  const writes: string[] = []; const errors: string[] = []; const state = { cleared: false };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { writes.push(path); return route.abort(); }
    if (path === '/api/pull-request-read') {
      const repo = url.searchParams.get('repo'); const kind = url.searchParams.get('kind');
      const rows = [
        { number: 42, title: 'Preserve customer evidence through feedback updates', changesRequested: true, newComments: true },
        { number: 43, title: 'Correct retry behavior when a connection drops', changesRequested: true, newComments: false },
        { number: 44, title: 'Keep review discussions attached to the latest work', changesRequested: false, newComments: true },
        { number: 45, title: 'Feedback timing is unavailable for this pull request', changesRequested: null, newComments: null },
        { number: 46, title: 'Previously requested changes on a merged pull request', changesRequested: true, newComments: true },
      ].map(item => ({ repo: repo ?? 'org/a', number: item.number, title: item.title, url: `https://github.com/${repo}/pull/${item.number}`, status: item.number === 46 ? 'merged' : 'open', createdAt: at, mergedAt: item.number === 46 ? at : null,
        draft: false, ticketId: null, reviewDecision: null, comments: 3, reviews: { approved: 0, changesRequested: 1, commented: 2, requested: 0 },
        feedback: { changesRequested: state.cleared ? false : item.changesRequested, newComments: state.cleared ? false : item.newComments, latestCommitAt: item.number === 45 ? null : at } }));
      return route.fulfill({ json: { version: 1, repo, kind, items: kind === 'authored-recent' ? rows : [], quality: 'complete', truncated: false, browseUrl: null } });
    }
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.compat-pr']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : path === '/api/run-read' ? { version: 1, repo: url.searchParams.get('repo'), items: [], nextCursor: null }
      : path === '/api/vpn-status' ? { version: 1, state: 'unknown', client: 'unknown', network: 'not-configured', checkedAt: at }
      : {};
    return route.fulfill({ json });
  });
  return { state, writes, errors };
}
for (const { width, mode } of [{ width: 1440, mode: 'dark' }, { width: 390, mode: 'dark' }, { width: 1440, mode: 'light' }] as const) test.describe(`PR feedback at ${width}px in ${mode}`, () => {
  test.use({ viewport: { width, height: 1100 }, hasTouch: width === 390 });
  test('distinguishes current feedback from historical counts and clears highlights after fresh observations', async ({ page }) => {
    if (mode === 'light') await page.addInitScript(value => localStorage.setItem('cmux.theme.custom', value), JSON.stringify({ version: 3, palette: generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'light'), recipe: { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {} } }));
    const f = await mockFeedback(page); await page.goto('/prs?repo=org%2Fa'); const root = page.locator('.plugin-public-pr'); const authored = root.locator('[data-pr-pane="authored"]');
    await expect(authored.locator('.pr-list-row')).toHaveCount(5);
    const row = (number: number) => authored.locator(`[data-select-number="${number}"]`);
    await expect(row(42).locator('.pr-feedback-badge')).toHaveText(['Changes requested', 'New comments']);
    await expect(row(42)).toHaveAccessibleName(/Changes requested · New comments$/);
    await expect(row(43).locator('.pr-feedback-badge')).toHaveText(['Changes requested']); await expect(row(44).locator('.pr-feedback-badge')).toHaveText(['New comments']);
    for (const number of [45, 46]) { await expect(row(number).locator('.pr-feedback-badge')).toHaveCount(0); await expect(row(number)).toContainText('3 discussion comments'); }
    await expect(row(42).getByText('New comments', { exact: true })).toHaveAttribute('title', /after the latest commit/);
    await expectReadableSurfaces(authored, ['.pr-feedback-badge', '.pr-list-title']); await expectReadableSurfaces(authored, ['.pr-feedback-badge .pr-phosphor'], 3);
    await row(42).focus(); await expect(row(42)).toBeFocused(); const outline = await row(42).evaluate(element => getComputedStyle(element).outlineStyle); expect(outline).not.toBe('none');
    await row(42).evaluate(element => (element as HTMLElement).blur()); if (width === 390) await page.setViewportSize({ width, height: 1800 }); await page.locator('#page-content').evaluate(element => { element.scrollTop = 0; }); await page.mouse.move(0, 0); await expect(authored).toHaveScreenshot(`pr-feedback-${width}-${mode}.png`); if (width === 390) await page.setViewportSize({ width, height: 1100 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    f.state.cleared = true; await page.getByRole('button', { name: 'Refresh page', exact: true }).click(); await expect(authored.locator('.pr-feedback-badge')).toHaveCount(0); await expect(authored.locator('[data-feedback]')).toHaveCount(0);
    await expect(row(42)).toContainText('3 discussion comments'); await expect(row(42)).not.toContainText('changes requested'); await expect(row(42)).not.toHaveAccessibleName(/New comments/); await expect(page.locator('.repo-select')).toHaveValue('org/a');
    expect(f.writes).toEqual([]); expect(f.errors).toEqual([]);
  });
});
