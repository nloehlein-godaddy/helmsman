import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { expectReadableSurfaces } from './theme-contrast';
import { DEFAULT_THEME_GENERATOR_SETTINGS, createThemeRecipeFromPalette, generateThemePalette } from '../../src/data/themeGenerator';

const at = '2026-10-09T12:00:00.000Z';
const row = (repo: string, number: number, title: string, status: 'open' | 'merged') => ({ repo, number, title,
  url: `https://github.com/${repo}/pull/${number}`, status, createdAt: at, mergedAt: status === 'merged' ? at : null,
  draft: false, ticketId: null, reviewDecision: status === 'merged' ? 'APPROVED' : 'REVIEW_REQUIRED', comments: 2,
  reviews: { approved: status === 'merged' ? 1 : 0, changesRequested: 0, commented: 1, requested: 1 } });

async function mockInbox(page: Page) {
  const state = { quality: 'partial' as 'complete' | 'partial' | 'degraded', empty: false };
  const scopes: (string | null)[] = [];
  const writes: string[] = [];
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') writes.push(path);
    if (path === '/api/pull-request-read') {
      const repo = url.searchParams.get('repo'); const kind = url.searchParams.get('kind'); scopes.push(repo);
      return route.fulfill({ json: { version: 1, repo, kind, items: kind === 'authored-recent' && !state.empty
        ? [row(repo ?? 'org/a', 42, 'Restore authored pull requests when search is unavailable', 'open'), { ...row(repo ?? 'org/a', 41, 'Preserve matched pull requests from earlier pages', 'merged'), comments: null, reviews: null }] : [],
        quality: kind === 'authored-recent' ? state.quality : 'complete', truncated: kind === 'authored-recent' && state.quality !== 'complete', browseUrl: `https://github.com/${repo}/pulls` } });
    }
    const target = { repo: url.searchParams.get('repo'), number: Number(url.searchParams.get('number')), baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.compat-pr']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : path === '/api/pull-request-inspect/detail' ? { version: 1, target, observedAt: at, title: 'Scoped pull request details', url: `https://github.com/${target.repo}/pull/${target.number}`, status: 'open', draft: false, authorLogin: 'writer', isOwnPr: true, headRefName: 'topic', updatedAt: at, comments: 0,
        checks: { quality: 'complete', passed: 2, failed: 0, pending: 0 }, reviews: { quality: 'complete', approved: 0, changesRequested: 0, commented: 0, requested: 0, viewerReview: null, viewerReviewedAt: null, viewerReviewedCommitId: null } }
      : path === '/api/pull-request-inspect/diff' ? { version: 1, target, observedAt: at, coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false, files: [] }
      : path === '/api/run-read' ? { version: 1, repo: url.searchParams.get('repo'), items: [{ version: 1, id: 'recent-pr-run', repo: url.searchParams.get('repo'), displayKey: 'PR-42', status: 'succeeded', attempt: 1, startedAt: at, endedAt: at, prNumber: 42, costUsd: null, review: null, sourceSettlement: null }], nextCursor: null }
      : path === '/api/whiteboard' ? { version: 1, target: JSON.parse(url.searchParams.get('target') ?? '{}'), status: 'absent', sessionId: null, baseSha: null, headSha: null, message: null }
      : {};
    return route.fulfill({ json });
  });
  return { state, scopes, writes };
}

for (const { width, mode } of [{ width: 1440, mode: 'dark' }, { width: 900, mode: 'dark' }, { width: 390, mode: 'dark' }, { width: 1440, mode: 'light' }, { width: 390, mode: 'custom' }] as const) test.describe(`Bounties hierarchy at ${width}px in ${mode}`, () => {
  test.use({ viewport: { width, height: 1100 }, hasTouch: width === 390 });
  test('prioritizes lookup and titles while retaining scoped results and compact states', async ({ page }) => {
    if (mode === 'light') await page.addInitScript(value => localStorage.setItem('cmux.theme.custom', value), JSON.stringify({ version: 3,
      palette: generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'light'), recipe: { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {} } }));
    if (mode === 'custom') {
      const recipe = createThemeRecipeFromPalette(['#780000', '#c1121f', '#fdf0d5', '#003049', '#669bbc']);
      if (!recipe) throw new Error('Invalid custom palette fixture');
      await page.addInitScript(value => localStorage.setItem('cmux.theme.custom', value), JSON.stringify({ version: 3, recipe, palette: generateThemePalette(recipe.settings, 'dark', recipe.overrides, recipe.sourcePalette) }));
    }
    const f = await mockInbox(page);
    await page.goto('/prs?repo=org%2Fa');
    const panel = page.locator('.plugin-public-pr');
    const authored = panel.locator('[data-pr-pane="authored"]');
    const requested = panel.locator('[data-pr-pane="review-requests"]');
    const lookup = panel.locator('[data-pr-compat-lookup]');
    const refresh = page.getByRole('button', { name: 'Refresh page', exact: true });
    await expect(refresh).toHaveCount(1);
    await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Use top selection', exact: true })).toHaveCount(0);
    await expect(panel).not.toContainText('Showing: org/a');
    await expect(authored.locator('.pr-list-row')).toHaveCount(2);
    await expect(authored.getByRole('status')).toHaveText('Only some results were returned. More may be available in the full list.');
    await expect(authored).not.toContainText('unknown');
    await expect(requested.getByRole('status')).toHaveText('No matching pull requests.');
    await expect.poll(async () => (await requested.boundingBox())?.height ?? Infinity).toBeLessThan(190);
    const lookupBounds = await lookup.boundingBox(); const listBounds = await authored.boundingBox();
    expect(lookupBounds?.y).toBeLessThan(listBounds?.y ?? 0);
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    const history = panel.locator('details[data-pr-disclosure="recent-runs"]');
    await expect(history).not.toHaveAttribute('open', '');
    const summary = history.locator('summary');
    await summary.focus(); await summary.press('Space');
    await expect(history).toHaveAttribute('open', '');
    await expect(history.getByRole('button', { name: /PR-42/ })).toBeVisible();
    await refresh.click();
    await expect(history).toHaveAttribute('open', '');
    await summary.focus(); await summary.press('Space');
    await expect(history).not.toHaveAttribute('open', '');
    const surfaces = await expectReadableSurfaces(panel, ['.pr-lookup-heading h3', '.pr-lookup-go', '[data-pr-pane="authored"] h3', '.pr-list-title', '.pr-recent-runs summary']);
    expect(surfaces[0]?.background).not.toBe(surfaces[2]?.background);
    expect(surfaces[2]?.background).not.toBe(surfaces[4]?.background);
    await expect(panel.locator('.pr-phosphor').first()).toHaveAttribute('aria-hidden', 'true');
    await expectReadableSurfaces(panel, ['.pr-lookup-go .pr-phosphor', '.pr-list-status .pr-phosphor'], 3);
    if (width === 390) expect((await panel.locator('.pr-lookup-go').boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.locator('#page-content').evaluate(content => { content.scrollTop = 0; });
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot(`pr-inbox-${width}-${mode}.png`);
    const first = authored.locator('[data-select-number="42"]');
    await expect(first).toContainText('Restore authored pull requests when search is unavailable');
    await first.focus();
    await first.press('Enter');
    await expect(panel.locator('.pr-panel')).toBeVisible();
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(panel.getByRole('button', { name: 'Explain in Whiteboard', exact: true })).toBeEnabled();
    await expect(panel.getByRole('button', { name: 'Post comment', exact: true })).toBeEnabled();
    await expect(panel.getByRole('button', { name: 'Update branch with feedback', exact: true })).toBeEnabled();
    const body = panel.locator('[data-draft="body"]'); const feedback = panel.locator('[data-draft="feedback"]');
    await body.fill('Retain my review draft through page refresh.');
    await feedback.fill('Retain my branch update instructions.');
    await refresh.click();
    await expect(body).toHaveValue('Retain my review draft through page refresh.');
    await expect(feedback).toHaveValue('Retain my branch update instructions.');
    if (mode === 'dark' && width !== 900) {
      await expect(panel).toHaveAttribute('aria-busy', 'false');
      await page.locator('#page-content').evaluate(content => { content.scrollTop = 0; });
      await page.mouse.move(0, 0);
      await expect(page).toHaveScreenshot(`pr-inspection-${width}.png`);
      await feedback.evaluate(input => input.scrollIntoView({ block: 'start' }));
      await expect(page).toHaveScreenshot(`pr-inspection-actions-${width}.png`);
    }
    await lookup.fill('https://github.com/org/b/pull/42');
    await lookup.press('Enter');
    await expect(panel.locator('.pr-panel')).toHaveAttribute('data-pr-repo', 'org/b');
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    expect(new URL(page.url()).searchParams.get('repo')).toBe('org/a');
    await expect(panel).toContainText('org/b');
    await panel.locator('[data-close-inspection]').click();
    await expect(panel.locator('.pr-panel')).toHaveCount(0);
    await expect(lookup).toHaveValue('');
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(page).toHaveURL(url => url.searchParams.get('repo') === 'org/a' && !url.searchParams.has('pr') && !url.searchParams.has('prRepo'));
    if (width === 390) await first.tap(); else { await first.focus(); await first.press('Enter'); }
    await expect(body).toHaveValue('Retain my review draft through page refresh.');
    await expect(feedback).toHaveValue('Retain my branch update instructions.');
    await panel.locator('[data-close-inspection]').click();
    f.state.quality = 'degraded';
    await refresh.click();
    await expect(authored.getByRole('status')).toHaveText('Could not load all pull requests. Refresh page to try again.');
    await expect(authored.locator('.pr-list-row')).toHaveCount(2);
    f.state.quality = 'complete'; f.state.empty = true;
    await refresh.click();
    await expect(authored.locator('.pr-list-row')).toHaveCount(0);
    await expect(authored.getByRole('status')).toHaveText('No matching pull requests.');
    await expect.poll(async () => (await authored.boundingBox())?.height ?? Infinity).toBeLessThan(190);
    f.state.quality = 'degraded';
    await refresh.click();
    await expect(authored.getByRole('status')).toHaveText('Could not load all pull requests. Refresh page to try again.');
    await expect(authored).not.toContainText('No matching pull requests.');
    expect(f.scopes).toContain('org/a'); expect(f.scopes).toContain('org/b');
    expect(f.writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
