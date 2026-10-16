import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { expectReadableSurfaces } from './theme-contrast';
import { DEFAULT_THEME_GENERATOR_SETTINGS, createThemeRecipeFromPalette, generateThemePalette } from '../../src/data/themeGenerator';
import { richPrEvidence } from './pr-evidence-fixture';

const at = '2026-10-09T12:00:00.000Z';
const row = (repo: string, number: number, title: string, status: 'open' | 'merged') => ({ repo, number, title,
  url: `https://github.com/${repo}/pull/${number}`, status, createdAt: at, mergedAt: status === 'merged' ? at : null,
  draft: false, ticketId: null, reviewDecision: status === 'merged' ? 'APPROVED' : 'REVIEW_REQUIRED', comments: 2,
  reviews: { approved: status === 'merged' ? 1 : 0, changesRequested: 0, commented: 1, requested: 1 } });

async function mockInbox(page: Page) {
  const state = { quality: 'partial' as 'complete' | 'partial' | 'degraded', ssoRequired: false, requestOrigins: false, empty: false, withPatch: false, richEvidence: false, connected: false, connectionError: false, own: true, detailStatus: 'open' as 'open' | 'closed' };
  const scopes: (string | null)[] = [];
  const listStates: (string | null)[] = [];
  const writes: string[] = []; const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { writes.push(path); return route.abort(); }
    if (path === '/api/communication-connection') return route.fulfill({ status: state.connectionError ? 503 : 200, json: { version: 1, providerId: state.connected ? 'example.slack/slack' : null, revision: state.connected ? 'a'.repeat(64) : null, status: state.connected ? 'connected' : 'disconnected', message: state.connected ? 'Connected' : 'Not connected', accountLabel: state.connected ? 'T123/U123' : null, redirectUri: null } });
    if (path === '/api/pull-request-read') {
      const repo = url.searchParams.get('repo'); const kind = url.searchParams.get('kind'); scopes.push(repo); if (kind === 'authored-recent') listStates.push(url.searchParams.get('state'));
      return route.fulfill({ json: { version: 1, repo, kind, items: kind === 'authored-recent' && !state.empty
        ? [{ ...row(repo ?? 'org/a', 42, 'Restore authored pull requests when search is unavailable', 'open'), ...(state.requestOrigins ? { authorLogin: 'authored-writer', viewerHasReviewed: false, feedback: { changesRequested: false, newComments: true, latestCommitAt: at } } : {}) }, ...(url.searchParams.get('state') === 'all' ? [{ ...row(repo ?? 'org/a', 41, 'Preserve matched pull requests from earlier pages', 'merged'), comments: null, reviews: null }] : [])] : state.requestOrigins ? [
          { ...row(repo ?? 'org/a', 51, 'Directly requested review', 'open'), authorLogin: 'direct-author', viewerHasReviewed: false, feedback: { changesRequested: false, newComments: true, latestCommitAt: at }, reviewRequest: { direct: true, teams: [] } },
          { ...row(repo ?? 'org/a', 52, 'Team review request', 'open'), authorLogin: '<img src=x> & writer', viewerHasReviewed: true, feedback: { changesRequested: false, newComments: true, latestCommitAt: at }, reviewRequest: { direct: false, teams: [{ name: 'AIRO AI Builder Developers', slug: 'airo-ai-builder-devs' }] } },
          { ...row(repo ?? 'org/a', 53, 'Direct and team review request', 'open'), authorLogin: null, viewerHasReviewed: null, feedback: { changesRequested: false, newComments: true, latestCommitAt: at }, reviewRequest: { direct: true, teams: [{ name: 'Platform engineering and developer experience', slug: 'platform-engineering' }] } },
          { ...row(repo ?? 'org/a', 54, 'Review requested without new discussion', 'open'), authorLogin: 'quiet-author', viewerHasReviewed: false, feedback: { changesRequested: false, newComments: false, latestCommitAt: at }, reviewRequest: { direct: true, teams: [] } },
        ] : [],
        quality: kind === 'authored-recent' ? state.quality : state.ssoRequired ? 'partial' : 'complete', truncated: kind === 'authored-recent' && state.quality !== 'complete', browseUrl: `https://github.com/${repo}/pulls`, ...(kind === 'review-requested' && state.ssoRequired ? { notice: 'github-sso-required' } : {}) } });
    }
    const target = { repo: url.searchParams.get('repo'), number: Number(url.searchParams.get('number')), baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.compat-pr']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : path === '/api/pull-request-inspect/detail' ? { version: 1, target, observedAt: at, title: 'Scoped pull request details', url: `https://github.com/${target.repo}/pull/${target.number}`, status: state.detailStatus, draft: false, authorLogin: 'writer', isOwnPr: state.own, headRefName: 'topic', updatedAt: at, comments: state.richEvidence ? 2 : 0,
        ...(state.richEvidence ? { evidence: richPrEvidence(at) } : {}), checks: { quality: 'complete', passed: state.richEvidence ? 61 : 2, failed: state.richEvidence ? 1 : 0, pending: state.richEvidence ? 1 : 0 }, reviews: { quality: 'complete', approved: state.richEvidence ? 2 : 0, changesRequested: state.richEvidence ? 1 : 0, commented: 0, requested: state.richEvidence ? 2 : 0, viewerReview: null, viewerReviewedAt: null, viewerReviewedCommitId: null } }
      : path === '/api/pull-request-inspect/diff' ? { version: 1, target, observedAt: at, coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false, files: state.withPatch ? [{ filename: 'src/retry.ts', previousFilename: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-return false;\n+return retry("<img src=x>");', patchStatus: 'preview' }] : [] }
      : path === '/api/run-read' ? { version: 1, repo: url.searchParams.get('repo'), items: [{ version: 1, id: 'recent-pr-run', repo: url.searchParams.get('repo'), displayKey: 'PR-42', status: 'succeeded', attempt: 1, startedAt: at, endedAt: at, prNumber: 42, costUsd: null, review: null, sourceSettlement: null }], nextCursor: null }
      : path === '/api/whiteboard' ? { version: 1, target: JSON.parse(url.searchParams.get('target') ?? '{}'), status: 'absent', sessionId: null, baseSha: null, headSha: null, message: null }
      : {};
    return route.fulfill({ json });
  });
  return { state, scopes, listStates, writes, errors };
}

for (const width of [1440, 390]) test(`restores bounty lists on return while refreshing in the background at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const f = await mockInbox(page); f.state.requestOrigins = true;
  await page.goto('/prs?repo=org%2Fa');
  await expect(page.locator('.plugin-public-pr')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-pr-pane="authored"] [data-select-number="42"]')).toBeVisible();
  const navigate = (path: string) => page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, path);
  await navigate('/config?repo=org%2Fa');
  await expect(page.locator('.plugin-public-pr')).toHaveCount(0);
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const hold = async (route: import('@playwright/test').Route) => { await blocked; await route.fallback(); };
  await page.route('**/api/pull-request-read?**', hold); await page.route('**/api/run-read?**', hold);
  try {
    await navigate('/prs?repo=org%2Fa');
    const panel = page.locator('.plugin-public-pr'); await expect(panel).toHaveAttribute('aria-busy', 'true');
    await expect(panel.locator('[data-select-number="51"]')).toBeVisible();
    await expect(panel.locator('[data-pr-pane="authored"] [data-select-number="42"]')).toBeVisible();
    await expect(panel.locator('[data-run="recent-pr-run"]')).toHaveCount(1);
    await expect(panel).not.toContainText('Loading pull requests');
    await expectReadableSurfaces(panel, ['.pr-list-author', '.pr-feedback-badge']);
    await panel.screenshot({ path: `test-results/browser/bounty-cached-return-${width}.png` });
    f.state.empty = true;
  } finally { release(); }
  await expect(page.locator('.plugin-public-pr')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-pr-pane="authored"] [data-select-number="42"]')).toHaveCount(0);
  expect(f.writes).toEqual([]); expect(f.errors).toEqual([]);
});

for (const width of [1440, 390]) test(`labels direct and team review requests at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const f = await mockInbox(page); f.state.requestOrigins = true;
  await page.goto('/prs?repo=org%2Fa');
  const requested = page.locator('[data-pr-pane="review-requests"]');
  const direct = requested.locator('[data-select-number="51"]');
  const team = requested.locator('[data-select-number="52"]');
  const both = requested.locator('[data-select-number="53"]');
  await expect(direct.locator('.pr-request-origin')).toHaveText(['Direct']);
  await expect(team.locator('.pr-request-origin')).toHaveText(['AIRO AI Builder Developers']);
  await expect(both.locator('.pr-request-origin')).toHaveText(['Direct', 'Platform engineering and developer experience']);
  await expect(team).toHaveAccessibleName(/Team: AIRO AI Builder Developers/);
  const quiet = requested.locator('[data-select-number="54"]');
  await expect(direct.locator('.pr-list-author')).toContainText('direct-author'); await expect(team.locator('.pr-list-author')).toContainText('<img src=x> & writer'); await expect(both.locator('.pr-list-author')).toContainText('Author unavailable');
  await expect(requested.locator('img, script')).toHaveCount(0);
  const authored = page.locator('[data-pr-pane="authored"] [data-select-number="42"]');
  await expect(authored).toContainText('New comments'); await expect(authored).not.toContainText('Not reviewed');
  for (const unreviewed of [direct, quiet]) {
    await expect(unreviewed.locator('.pr-feedback-badge')).toHaveText('Not reviewed');
    await expect(unreviewed).not.toContainText('New comments'); await expect(unreviewed).toHaveAccessibleName(/Not reviewed/);
  }
  for (const reviewed of [team, both]) { await expect(reviewed.locator('.pr-feedback-badge')).toHaveText('New comments'); await expect(reviewed).not.toContainText('Not reviewed'); }
  await expectReadableSurfaces(requested, ['.pr-request-origin', '.pr-list-author', '.pr-feedback-badge']);
  expect(await requested.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.setViewportSize({ width, height: 2000 }); await requested.screenshot({ path: `test-results/browser/review-request-origins-${width}.png` }); await page.setViewportSize({ width, height: 1000 });
  await direct.click();
  await expect(page.locator('[data-pr-number="51"]')).toBeVisible();
  expect(f.errors).toEqual([]); expect(f.writes).toEqual([]);
});

for (const width of [1440, 390]) test(`explains GitHub SSO authorization for missing review requests at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const f = await mockInbox(page); f.state.ssoRequired = true;
  await page.goto('/prs?repo=org%2Fa');
  const requested = page.locator('[data-pr-pane="review-requests"]');
  await expect(requested.getByRole('status')).toContainText('GitHub SSO authorization is needed');
  await expect(requested).not.toContainText('Only some results were returned');
  await expect(requested).not.toContainText('No matching pull requests');
  await expect(requested.getByRole('link', { name: 'View all on GitHub' })).toBeVisible();
  await expectReadableSurfaces(requested, ['.pr-list-notice']);
  expect(await requested.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await requested.screenshot({ path: `test-results/browser/github-sso-${width}.png` });
  expect(f.errors).toEqual([]); expect(f.writes).toEqual([]);
});

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
    await expect(authored.locator('.pr-list-row')).toHaveCount(1); expect(f.listStates).toContain('open'); await expect(authored.locator('[data-select-number="41"]')).toHaveCount(0);
    const allFilter = authored.locator('[data-authored-state="all"]'); const openFilter = authored.locator('[data-authored-state="open"]');
    await allFilter.click(); await expect(authored.locator('.pr-list-row')).toHaveCount(2); await expect(allFilter).toHaveAttribute('aria-pressed', 'true'); await expect(allFilter).toBeFocused(); expect(f.listStates).toContain('all');
    await openFilter.click(); await expect(authored.locator('.pr-list-row')).toHaveCount(1); await expect(openFilter).toHaveAttribute('aria-pressed', 'true'); await expect(openFilter).toBeFocused(); await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(authored).toHaveAttribute('open', ''); await expect(requested).toHaveAttribute('open', '');
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
    expect(surfaces[2]?.background).not.toBe(surfaces[3]?.background);
    await expect(panel.locator('.pr-phosphor').first()).toHaveAttribute('aria-hidden', 'true');
    await expectReadableSurfaces(panel, ['.pr-lookup-go .pr-phosphor', '.pr-list-status .pr-phosphor'], 3);
    if (width === 390) await expect.poll(async () => (await panel.locator('.pr-lookup-go').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.locator('#page-content').evaluate(content => { content.scrollTop = 0; });
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot(`pr-inbox-${width}-${mode}.png`);
    const authoredSummary = authored.locator(':scope > summary'); const requestedSummary = requested.locator(':scope > summary');
    for (const sectionSummary of [requestedSummary, authoredSummary]) {
      if (width === 390) await expect.poll(async () => (await sectionSummary.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      await sectionSummary.focus(); await sectionSummary.press('Space');
    }
    await expect(authored).not.toHaveAttribute('open', ''); await expect(requested).not.toHaveAttribute('open', '');
    await expect(authored.locator('.pr-list-row').first()).not.toBeVisible(); await expect(authoredSummary).toBeFocused();
    await refresh.evaluate(button => (button as HTMLButtonElement).click());
    await expect(panel).toHaveAttribute('aria-busy', 'false'); await expect(authoredSummary).toBeFocused();
    await expect(authored).not.toHaveAttribute('open', ''); await expect(requested).not.toHaveAttribute('open', '');
    if (mode === 'dark' && width !== 900) { await page.locator('#page-content').evaluate(content => { content.scrollTop = 0; }); await page.mouse.move(0, 0); await expect(page).toHaveScreenshot(`pr-inbox-collapsed-${width}.png`); }
    for (const sectionSummary of [requestedSummary, authoredSummary]) { await sectionSummary.focus(); await sectionSummary.press('Enter'); }
    await expect(authored).toHaveAttribute('open', ''); await expect(requested).toHaveAttribute('open', '');
    const first = authored.locator('[data-select-number="42"]');
    await expect(first).toContainText('Restore authored pull requests when search is unavailable');
    await expect(first.locator('time')).toHaveText('Oct 9, 2026');
    await expect(first.locator('time')).toHaveAttribute('datetime', at);
    await expect(first.locator('time')).toHaveAttribute('title', at);
    await expect(first.getByLabel('Status: open', { exact: true })).toHaveText('open');
    await first.focus();
    await first.press('Enter');
    await expect(panel.locator('.pr-panel')).toBeVisible();
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(panel.getByRole('button', { name: 'Explain in Whiteboard', exact: true })).toBeEnabled();
    const manual = panel.locator('.pr-manual-review'); await expect(manual).not.toHaveAttribute('open', ''); await expect(panel.locator('.pr-slack-review')).toHaveCount(0);
    await manual.locator(':scope > summary').focus(); await manual.locator(':scope > summary').press('Space'); await expect(manual).toHaveAttribute('open', '');
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
    await expect(authored.locator('.pr-list-row')).toHaveCount(1);
    f.state.quality = 'complete'; f.state.empty = true;
    await refresh.click();
    await expect(authored.locator('.pr-list-row')).toHaveCount(0);
    await expect(authored.getByRole('status')).toHaveText('No matching pull requests.');
    await expect.poll(async () => (await authored.boundingBox())?.height ?? Infinity).toBeLessThan(230);
    f.state.quality = 'degraded';
    await refresh.click();
    await expect(authored.getByRole('status')).toHaveText('Could not load all pull requests. Refresh page to try again.');
    await expect(authored).not.toContainText('No matching pull requests.');
    expect(f.scopes).toContain('org/a'); expect(f.scopes).toContain('org/b');
    expect(f.writes).toEqual([]); expect(f.errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

for (const { width, mode } of [{ width: 1440, mode: 'dark' }, { width: 390, mode: 'dark' }, { width: 1440, mode: 'light' }] as const) test.describe(`Selected bounty at ${width}px in ${mode}`, () => {
  test.use({ viewport: { width, height: 1100 }, hasTouch: width === 390 });
  test('prioritizes agent work, keeps manual review opt-in and gates Slack on the current connection', async ({ page }) => {
    page.setDefaultTimeout(10_000);
    if (mode === 'light') await page.addInitScript(value => localStorage.setItem('cmux.theme.custom', value), JSON.stringify({ version: 3, palette: generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'light'), recipe: { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {} } }));
    const f = await mockInbox(page); f.state.connected = true; f.state.withPatch = true; f.state.richEvidence = true;
    await page.goto('/prs?repo=org%2Fa&prRepo=org%2Fb&pr=42');
    const panel = page.locator('.plugin-public-pr'); const detail = panel.locator('.pr-panel'); const manual = panel.locator('.pr-manual-review'); const context = panel.locator('.pr-provenance'); const refresh = page.getByRole('button', { name: 'Refresh page', exact: true }); const body = detail.locator('.pr-review-body'); const lookup = panel.locator('[data-pr-compat-lookup]');
    await expect(detail.locator(':scope > .pr-subpanel')).toHaveCount(4);
    expect(await detail.evaluate(root => ['.pr-summary', '.pr-agent-section', '.pr-diff-panel', '.pr-manual-review'].every(selector => root.querySelector(selector)?.closest('.pr-panel') === root))).toBe(true);
    const orderedRegions = await Promise.all(['.pr-agent-section', '.pr-diff-panel', '.pr-manual-review'].map(selector => detail.locator(selector).boundingBox()));
    expect((orderedRegions[0]?.y ?? Infinity) + (orderedRegions[0]?.height ?? 0)).toBeLessThanOrEqual(orderedRegions[1]?.y ?? -Infinity); expect((orderedRegions[1]?.y ?? Infinity) + (orderedRegions[1]?.height ?? 0)).toBeLessThanOrEqual(orderedRegions[2]?.y ?? -Infinity);
    await expect(detail).toHaveAttribute('data-pr-repo', 'org/b'); await expect(panel).toHaveAttribute('aria-busy', 'false'); await expect(manual).not.toHaveAttribute('open', ''); await expect(context).not.toHaveAttribute('open', ''); await expect(body).not.toBeVisible();
    await expect(detail.getByRole('button', { name: 'Start deckhand review', exact: true })).toBeVisible(); await expect(detail.getByRole('button', { name: 'Update branch with feedback', exact: true })).toBeVisible();
    await expect(detail.getByRole('link', { name: /Open (review|branch update) setup/ })).toHaveCount(0);
    const slack = detail.locator('.pr-slack-review'); await expect(slack).toBeVisible(); const slackHref = await slack.getAttribute('href'); const slackUrl = new URL(slackHref ?? '', 'http://localhost'); expect(slackUrl.searchParams.get('repo')).toBe('org/a'); expect(slackUrl.searchParams.get('prRepo')).toBe('org/b'); expect(slackUrl.searchParams.get('pr')).toBe('42');
    const reviewTask = detail.locator('.pr-agent-review'); const updateTask = detail.locator('.pr-agent-update'); const reviewTools = reviewTask.locator('[data-pr-review-tools]');
    await expect(reviewTask.getByRole('heading', { name: 'Review', exact: true })).toBeVisible(); await expect(updateTask.getByRole('heading', { name: 'Update', exact: true })).toBeVisible();
    await expect(reviewTools.getByRole('button', { name: 'Explain in Whiteboard', exact: true })).toBeVisible();
    await expect(reviewTools.locator('button')).toHaveText(['Start deckhand review', 'Explain in Whiteboard']);
    await expect(updateTask.locator('.pr-rerun-feedback')).toHaveValue('update the pr using the provided comment feedback.');
    expect(await detail.locator('.pr-agent-body').evaluate(root => {
      const ordered = ['.pr-agent-review', '.pr-review-guidance', '[data-pr-review-tools]', '.pr-agent-update', '.pr-rerun-feedback', '.pr-rerun'].map(selector => root.querySelector(selector));
      return ordered.every((node, index) => node && (index === 0 || !!(ordered[index - 1]!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)));
    })).toBe(true);
    await expectReadableSurfaces(detail, ['.pr-agent-review h5', '.pr-agent-update h5', '.pr-rerun-feedback']);
    for (const task of [reviewTask, updateTask]) expect(await task.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await detail.locator('.pr-agent-section').screenshot({ path: `test-results/browser/pr-agent-tasks-${width}-${mode}.png` });
    await expectReadableSurfaces(detail, ['.pr-panel-title', '.pr-agent-section h4', '.pr-evidence-count', '.pr-manual-review > summary', '.pr-slack-review', '.pr-review-agent']);
    await detail.locator('.pr-review-agent').hover(); await expectReadableSurfaces(detail, ['.pr-review-agent']); await page.mouse.move(0, 0);
    await expectReadableSurfaces(detail, ['.pr-agent-section h4 .pr-phosphor', '.pr-evidence-count .pr-phosphor', '.pr-slack-review .pr-phosphor'], 3);
    if (width === 390) await page.setViewportSize({ width, height: 1800 }); await page.mouse.move(0, 0); await expect(detail).toHaveScreenshot(`selected-pr-${width}-${mode}.png`); if (width === 390) await page.setViewportSize({ width, height: 1100 });
    const metadata = detail.locator('.pr-summary'); const discussion = metadata.locator('.pr-discussion');
    await expect(discussion).toHaveCount(2); for (const section of await discussion.all()) { await expect(section).not.toHaveAttribute('open', ''); await section.locator(':scope > summary').focus(); await section.locator(':scope > summary').press('Enter'); await expect(section.locator('.pr-discussion-body')).toBeVisible(); }
    await expect(metadata.locator('.pr-discussion-text')).toContainText(['Handle the failed retry', 'Literal <img src=x>', 'Follow-up discussion']); await expect(metadata.locator('img, script')).toHaveCount(0); await expect(metadata).toContainText('Text shortened.'); await expect(metadata).toContainText('Some details are unavailable.');
    await page.setViewportSize({ width, height: 1800 }); await metadata.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0); await expect(metadata).toHaveScreenshot(`pr-evidence-discussion-${width}-${mode}.png`);
    const approved = metadata.locator('[data-pr-disclosure$=":approved:preview"]'); const requested = metadata.locator('[data-pr-disclosure$=":requested:preview"]'); const checks = metadata.locator('[data-pr-disclosure$=":checks-passed:preview"]');
    await approved.locator(':scope > summary').focus(); await expect(approved.locator('.pr-stat-popup')).toBeVisible(); await expect(approved.locator('li')).toHaveText(['reviewer-a ↗', 'reviewer-b ↗']); await approved.locator(':scope > summary').press('Escape'); await expect(approved).not.toHaveAttribute('open', ''); await expect(approved.locator(':scope > summary')).toBeFocused();
    if (width === 390) await requested.locator(':scope > summary').tap(); else await requested.locator(':scope > summary').hover(); await expect(requested.locator('.pr-stat-popup')).toBeVisible(); await expect(requested.locator('li')).toHaveText(['reviewer-d ↗', 'team:platform']);
    await detail.locator('.pr-panel-title').click(); await expect(requested).not.toHaveAttribute('open', '');
    await checks.locator(':scope > summary').focus(); await expect(checks.locator('.pr-stat-popup')).toBeVisible(); await expect(checks.locator(':scope > .pr-stat-popup > ul > li')).toHaveCount(5); await expect(checks.locator('.pr-evidence-more')).not.toHaveAttribute('open', '');
    await expect(checks.locator('.pr-stat-popup')).toHaveScreenshot(`pr-evidence-checks-${width}-${mode}.png`); await checks.locator('.pr-evidence-more > summary').click(); await expect(checks).toHaveAttribute('open', ''); await expect(checks.locator('.pr-evidence-more > ul > li')).toHaveCount(56); await expect(checks.locator('.pr-evidence-more')).toHaveAttribute('open', '');
    await detail.locator('.pr-panel-title').click(); await expect(checks).not.toHaveAttribute('open', ''); for (const section of await discussion.all()) await section.locator(':scope > summary').click(); await page.setViewportSize({ width, height: 1100 });
    const collapsible = [detail.locator('.pr-summary'), detail.locator('.pr-agent-section'), detail.locator('.pr-diff-panel')];
    for (const section of collapsible) {
      const sectionBody = section.locator(':scope > div'); await expect(section).toHaveAttribute('open', ''); await expect(sectionBody).toBeVisible(); const sectionSummary = section.locator(':scope > summary'); await sectionSummary.focus(); await sectionSummary.press('Space'); await expect(section).not.toHaveAttribute('open', ''); await expect(sectionBody).not.toBeVisible();
      await refresh.evaluate(element => (element as HTMLButtonElement).click()); await expect(panel).toHaveAttribute('aria-busy', 'false'); await expect(section).not.toHaveAttribute('open', ''); await expect(sectionSummary).toBeFocused();
      await sectionSummary.press('Enter'); await expect(section).toHaveAttribute('open', ''); await expect(sectionBody).toBeVisible();
    }
    for (const section of collapsible) { await section.locator(':scope > summary').focus(); await section.locator(':scope > summary').press('Space'); await expect(section).not.toHaveAttribute('open', ''); }
    await page.mouse.move(0, 0); await expect(detail).toHaveScreenshot(`selected-pr-collapsed-${width}-${mode}.png`);
    const navigateTo = async (path: string) => page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, path);
    await navigateTo('/prs?repo=org%2Fa&prRepo=org%2Fb&pr=42&mode=review'); await expect(collapsible[1]!).toHaveAttribute('open', ''); await expect(detail.locator('.pr-review-agent')).toBeFocused();
    await collapsible[1]!.locator(':scope > summary').focus(); await collapsible[1]!.locator(':scope > summary').press('Space');
    await navigateTo('/prs?repo=org%2Fa&prRepo=org%2Fb&pr=42&mode=rerun'); await expect(collapsible[1]!).toHaveAttribute('open', ''); await expect(detail.locator('.pr-rerun-feedback')).toBeFocused();
    await navigateTo('/prs?repo=org%2Fa&prRepo=org%2Fb&pr=42&pane=diff'); await expect(collapsible[2]!).toHaveAttribute('open', ''); await expect(collapsible[0]!).not.toHaveAttribute('open', '');
    await collapsible[0]!.locator(':scope > summary').focus(); await collapsible[0]!.locator(':scope > summary').press('Enter');
    const manualSummary = manual.locator(':scope > summary'); await manualSummary.focus(); await manualSummary.press('Space'); await expect(manual).toHaveAttribute('open', ''); await expect(body).toBeVisible(); await body.fill('Keep this manual review draft while I work with agents.');
    await context.locator(':scope > summary').focus(); await context.locator(':scope > summary').press('Enter'); await expect(context).toHaveAttribute('open', ''); await expect(context).toContainText('Branch: topic');
    const diffFile = detail.locator('.diff-file'); await diffFile.locator(':scope > summary').focus(); await diffFile.locator(':scope > summary').press('Space'); await expect(diffFile.locator('.diff-patch')).toContainText('return retry("<img src=x>");'); await expect(diffFile.locator('img')).toHaveCount(0);
    await manualSummary.focus(); await manualSummary.press('Space'); await refresh.evaluate(element => (element as HTMLButtonElement).click()); await expect(panel).toHaveAttribute('aria-busy', 'false'); await expect(manual).not.toHaveAttribute('open', ''); await expect(context).toHaveAttribute('open', ''); await expect(diffFile).toHaveAttribute('open', ''); await expect(manualSummary).toBeFocused(); await expect(body).toHaveValue('Keep this manual review draft while I work with agents.');
    await lookup.fill('org/b#43'); await lookup.press('Enter'); await expect(detail).toHaveAttribute('data-pr-number', '43'); await expect(manual).not.toHaveAttribute('open', ''); await expect(context).not.toHaveAttribute('open', ''); await expect(body).toHaveValue('');
    await lookup.fill('org/b#42'); await lookup.press('Enter'); await expect(detail).toHaveAttribute('data-pr-number', '42'); await expect(manual).toHaveAttribute('open', ''); await expect(body).toHaveValue('Keep this manual review draft while I work with agents.');
    await page.reload(); await expect(manual).toHaveAttribute('open', ''); await expect(body).toHaveValue('Keep this manual review draft while I work with agents.');
    f.state.connected = false; await refresh.click(); await expect(panel).toHaveAttribute('aria-busy', 'false'); await expect(slack).toHaveCount(0);
    f.state.connected = true; f.state.connectionError = true; await refresh.click(); await expect(panel).toHaveAttribute('aria-busy', 'false'); await expect(slack).toHaveCount(0);
    f.state.connectionError = false; f.state.own = false; await refresh.click(); await expect(panel).toHaveAttribute('aria-busy', 'false'); await expect(slack).toHaveCount(0); await expect(detail.locator('.pr-rerun')).toHaveCount(0);
    f.state.own = true; f.state.detailStatus = 'closed'; await refresh.click(); await expect(panel).toHaveAttribute('aria-busy', 'false'); await expect(slack).toHaveCount(0); await expect(detail.locator('.pr-agent-section')).toHaveCount(0); await expect(detail.locator('.pr-manual-review')).toHaveCount(0); await expect(detail.locator('[data-launch], [data-review], [data-draft]')).toHaveCount(0); await expect(detail.locator('.pr-diff-panel')).toBeVisible();
    await expect(page.locator('.repo-select')).toHaveValue('org/a'); expect(f.writes).toEqual([]); expect(f.errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test('shows the saved launch rejection reason as literal text after reload',async({page})=>{
  const f=await mockInbox(page);
  await page.addInitScript(()=>localStorage.setItem('helmsman.pull-request.v1:helmsman.compat-pr/panel:result:run:legacy-rejection',JSON.stringify({version:1,value:{input:{repo:'org/b',action:'launch',launch:{mode:'rerun',prNumber:42}},receipt:{status:'rejected',runId:'blocked-run',message:'Retained <worktree> & branch ownership blocks this launch.'}}})));
  await page.goto('/prs?repo=org%2Fa&prRepo=org%2Fb&pr=42');
  const history=page.locator('.pr-panel .pr-request-history'); const result=history.locator('.pr-saved-result');
  await expect(history).not.toHaveAttribute('open','');
  await history.locator(':scope > summary').click(); await expect(result).toContainText('Request rejected');
  await expect(result.getByRole('button',{name:'Open run',exact:true})).toHaveCount(0);
  await result.getByText('Request details',{exact:true}).click();
  await expect(result).toContainText('Retained <worktree> & branch ownership blocks this launch.');
  await expect(result.locator('worktree')).toHaveCount(0);
  await page.reload(); await history.locator(':scope > summary').click(); await result.getByText('Request details',{exact:true}).click();
  await expect(result).toContainText('Retained <worktree> & branch ownership blocks this launch.');
  expect(f.writes).toEqual([]); expect(f.errors).toEqual([]);
});

for (const width of [1440, 390]) test(`keeps saved request evidence scoped and collapsible at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
  const f = await mockInbox(page);
  await page.addInitScript(() => {
    const prefix = 'helmsman.pull-request.v1:helmsman.compat-pr/panel:result:';
    const entries = [
      ['run:accepted', { savedAt: 1791547200000, value: { input: { repo: 'org/b', action: 'launch', launch: { mode: 'review', prNumber: 42 } }, receipt: { status: 'accepted', runId: 'accepted-run', message: 'Review queued for processing.' } } }],
      ['run:rejected', { savedAt: 1791547260000, value: { input: { repo: 'org/b', action: 'launch', launch: { mode: 'rerun', prNumber: 42 } }, receipt: { status: 'rejected', runId: 'allocated-rejected-run', message: 'Execution resources remain owned by <older-run> & cannot be reused.' } } }],
      ['review:published', { savedAt: 1791547320000, value: { input: { repo: 'org/b', number: 42, action: 'review', event: 'REQUEST_CHANGES' }, status: 'succeeded', result: { actor: 'reviewer' } } }],
      ['run:other-scope', { savedAt: 1791547380000, value: { input: { repo: 'org/a', action: 'launch', launch: { mode: 'review', prNumber: 42 } }, receipt: { status: 'accepted', runId: 'other-scope-run' } } }],
    ] as const;
    for (const [key, receipt] of entries) localStorage.setItem(`${prefix}${key}`, JSON.stringify({ version: 1, ...receipt }));
  });
  await page.goto('/prs?repo=org%2Fa&prRepo=org%2Fb&pr=42');
  const detail = page.locator('.pr-panel'); const history = detail.locator('.pr-request-history');
  const summary = history.locator(':scope > summary');
  await expect(history).not.toHaveAttribute('open', ''); await expect(summary).toContainText('Request history'); await expect(summary.locator('.pr-list-count')).toHaveText('3');
  await expect(history.locator('.pr-request-body')).toBeHidden(); await expect(page.locator('.plugin-public-pr > .pr-saved-result')).toHaveCount(0);
  await summary.focus(); await summary.press('Enter'); await expect(history).toHaveAttribute('open', '');
  const rows = history.locator('.pr-saved-result');
  await expect(rows).toHaveCount(3); await expect(rows.locator('.pr-request-status')).toHaveText(['Review submitted', 'Request rejected', 'Request accepted']);
  await expect(rows.nth(0)).toContainText('Submitted to GitHub by reviewer.');
  await expect(rows.nth(1)).toContainText('Another run still owned this branch or workspace');
  await expect(history.getByRole('button', { name: 'Open run', exact: true })).toHaveCount(1);
  await expect(rows.nth(2).getByRole('button', { name: 'Open run', exact: true })).toHaveAttribute('data-run', 'accepted-run');
  await expect(history).not.toContainText('other-scope-run');
  const evidence = rows.nth(1).locator('.pr-request-evidence'); const evidenceSummary = evidence.locator(':scope > summary');
  await expect(evidence).not.toHaveAttribute('open', ''); await expect(evidence.locator('code')).toBeHidden();
  await evidenceSummary.focus(); await evidenceSummary.press('Space');
  await expect(evidence).toContainText('Execution resources remain owned by <older-run> & cannot be reused.'); await expect(evidence.locator('older-run')).toHaveCount(0);
  await expect(evidence.locator('code')).toHaveText('allocated-rejected-run');
  const refresh = page.getByRole('button', { name: 'Refresh page', exact: true });
  await refresh.evaluate(element => (element as HTMLButtonElement).click()); await expect(page.locator('.plugin-public-pr')).toHaveAttribute('aria-busy', 'false');
  await expect(history).toHaveAttribute('open', ''); await expect(evidence).toHaveAttribute('open', ''); await expect(evidenceSummary).toBeFocused();
  await expectReadableSurfaces(history, ['.pr-request-status', '.pr-request-explanation', '.pr-request-evidence p', '.pr-request-open']);
  expect(await history.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.setViewportSize({ width, height: 1800 });
  await history.screenshot({ path: `/tmp/helmsman-request-history-${width}.png` });
  await summary.focus(); await summary.press('Space');
  await refresh.evaluate(element => (element as HTMLButtonElement).click()); await expect(page.locator('.plugin-public-pr')).toHaveAttribute('aria-busy', 'false');
  await expect(history).not.toHaveAttribute('open', ''); await expect(summary).toBeFocused();
  expect(f.writes).toEqual([]); expect(f.errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [1440, 390]) test(`keeps uncertain review recovery beside launch and emphasizes diff counts at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
  const f = await mockInbox(page); f.state.withPatch = true; f.state.own = false;
  const requestId = 'b0ef36b8-e7a2-4b24-a343-2dac4b561824';
  const original = { version: 1, repo: 'org/a', action: 'launch', launch: { mode: 'review', prNumber: 42, headSha: 'b'.repeat(40) } };
  const deliveries: unknown[] = []; const checks: string[] = [];
  await page.route(url => url.pathname.startsWith('/api/run-commands'), async route => {
    const request = route.request();
    if (request.method() === 'GET') { checks.push(new URL(request.url()).pathname); return route.fulfill({ json: null }); }
    deliveries.push(request.postDataJSON());
    return route.fulfill({ json: { version: 1, repo: 'org/a', requestId, action: 'launch', status: 'rejected', runId: null, attempt: null, message: 'Mock request resolved without launching.' } });
  });
  await page.goto('/prs?repo=org%2Fa&pr=42');
  const launch = page.locator('.pr-review-agent'); await expect(launch).toBeEnabled();
  await page.evaluate(async ({ requestId, original }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const opened = indexedDB.open('helmsman.run-commands', 1); opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
    const caller = 'helmsman.compat-pr/panel';
    await new Promise<void>((resolve, reject) => { const tx = database.transaction('pending', 'readwrite'); tx.objectStore('pending').put({ key: JSON.stringify([caller, original]), caller, command: { ...original, requestId }, receipt: null }); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); database.close();
  }, { requestId, original });
  await page.reload();
  const crew = page.locator('.pr-crew-controls'); const retained = crew.locator('[data-pr-retained-actions]');
  await expect(launch).toBeDisabled();
  await expect(crew.locator('[data-launch-feedback]')).toBeVisible();
  await expect(crew.locator('[data-launch-feedback]')).toContainText('Check its receipt below before starting another');
  await expect(launch).toHaveAttribute('title', /saved request/);
  await expect(retained).toContainText('Uncertain result');
  const requestDetails = retained.locator('details');
  await expect(requestDetails).not.toHaveAttribute('open', '');
  await expect(requestDetails.locator('code')).toBeHidden();
  expect(deliveries).toEqual([]); expect(checks).toEqual([]);
  expect(await crew.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expectReadableSurfaces(crew, ['[data-launch-feedback]', '.pr-pending h4']);
  await crew.screenshot({ path: `test-results/browser/uncertain-review-${width}.png` });
  const diff = page.locator('.pr-diff-panel');
  await expect(diff.locator('.diff-file-added')).toHaveText('+1'); await expect(diff.locator('.diff-file-deleted')).toHaveText('−1');
  const counts = await diff.locator('.diff-file-stat strong').evaluateAll(nodes => nodes.map(node => ({ weight: getComputedStyle(node).fontWeight, color: getComputedStyle(node).color })));
  expect(counts).toHaveLength(2); for (const count of counts) expect(Number(count.weight)).toBeGreaterThanOrEqual(700);
  expect(counts[0]?.color).not.toBe(counts[1]?.color);
  await expectReadableSurfaces(diff, ['.diff-file-added', '.diff-file-deleted']);
  expect(await diff.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await diff.screenshot({ path: `test-results/browser/diff-counts-${width}.png` });
  await requestDetails.getByText('Request details', { exact: true }).click();
  await expect(requestDetails.locator('code')).toHaveText(requestId);
  await retained.getByRole('button', { name: 'Check original receipt', exact: true }).click();
  await expect.poll(() => checks.length).toBe(1); expect(deliveries).toEqual([]);
  await expect(requestDetails).toHaveAttribute('open', '');
  const retry = retained.getByRole('button', { name: 'Retry original request', exact: true }); await expect(retry).toBeEnabled(); await retry.click();
  await expect.poll(() => deliveries.length).toBe(1);
  expect(deliveries[0]).toMatchObject({ ...original, requestId });
  await expect(launch).toBeEnabled(); await expect(retained).toBeHidden();
  expect(f.errors).toEqual([]); expect(f.writes).toEqual([]);
});

test('reconciles a request acknowledged in another tab without losing the focused draft or launching again', async ({ page, context }) => {
  const f = await mockInbox(page);
  const requestId = 'b0ef36b8-e7a2-4b24-a343-2dac4b561824';
  const original = { version: 1, repo: 'org/a', action: 'launch', launch: { mode: 'review', prNumber: 42, headSha: 'b'.repeat(40) } };
  const path = '/prs?repo=org%2Fa&pr=42';
  await page.goto(path);
  const launch = page.locator('.pr-review-agent'); await expect(launch).toBeEnabled();
  await page.evaluate(async ({ requestId, original }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const opened = indexedDB.open('helmsman.run-commands', 1); opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
    const caller = 'helmsman.compat-pr/panel';
    await new Promise<void>((resolve, reject) => { const tx = database.transaction('pending', 'readwrite'); tx.objectStore('pending').put({ key: JSON.stringify([caller, original]), caller, command: { ...original, requestId }, receipt: null }); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); database.close();
  }, { requestId, original });
  await page.reload();
  const retained = page.locator('[data-pr-retained-actions]');
  await expect(retained).toContainText('Uncertain result'); await expect(launch).toBeDisabled();
  const draft = page.locator('.pr-review-guidance');
  await draft.fill('Keep my current review instructions.'); await expect(draft).toBeFocused();
  const other = await context.newPage(); const otherFixture = await mockInbox(other);
  const checks: string[] = [];
  await other.route(url => url.pathname.startsWith('/api/run-commands'), async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    checks.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { version: 1, repo: 'org/a', requestId, action: 'launch', status: 'rejected', runId: null, attempt: null, message: 'Original request resolved in another tab.' } });
  });
  await other.goto(path);
  const otherRetained = other.locator('[data-pr-retained-actions]');
  await expect(otherRetained).toContainText('Uncertain result');
  await otherRetained.getByRole('button', { name: 'Check original receipt', exact: true }).click();
  await other.locator('.pr-request-history > summary').click();
  await expect(other.locator('.pr-saved-result')).toContainText('Request rejected');
  await expect(otherRetained).toBeHidden();
  await page.bringToFront();
  await expect(retained).toBeHidden({ timeout: 15_000 }); await expect(launch).toBeEnabled();
  await expect(draft).toHaveValue('Keep my current review instructions.'); await expect(draft).toBeFocused();
  await page.locator('.pr-request-history > summary').click();
  await page.locator('.pr-request-evidence > summary').click();
  await expect(page.locator('.pr-saved-result')).toContainText('Original request resolved in another tab.');
  expect(checks).toEqual([`/api/run-commands/${requestId}`]);
  expect(f.writes).toEqual([]); expect(otherFixture.writes).toEqual([]); expect(f.errors).toEqual([]); expect(otherFixture.errors).toEqual([]);
});
