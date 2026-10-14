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
  const state = { quality: 'partial' as 'complete' | 'partial' | 'degraded', empty: false, withPatch: false, richEvidence: false, connected: false, connectionError: false, own: true, detailStatus: 'open' as 'open' | 'closed' };
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
        ? [row(repo ?? 'org/a', 42, 'Restore authored pull requests when search is unavailable', 'open'), ...(url.searchParams.get('state') === 'all' ? [{ ...row(repo ?? 'org/a', 41, 'Preserve matched pull requests from earlier pages', 'merged'), comments: null, reviews: null }] : [])] : [],
        quality: kind === 'authored-recent' ? state.quality : 'complete', truncated: kind === 'authored-recent' && state.quality !== 'complete', browseUrl: `https://github.com/${repo}/pulls` } });
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
    await expect(detail.locator('.pr-agent-extras').getByRole('button', { name: 'Explain in Whiteboard', exact: true })).toBeVisible();
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
    f.state.own = true; f.state.detailStatus = 'closed'; await refresh.click(); await expect(panel).toHaveAttribute('aria-busy', 'false'); await expect(slack).toHaveCount(0); await expect(detail.locator('.pr-review-agent')).toBeDisabled(); await expect(detail.locator('.pr-comment')).toBeDisabled();
    await expect(page.locator('.repo-select')).toHaveValue('org/a'); expect(f.writes).toEqual([]); expect(f.errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test('shows the saved launch rejection reason as literal text after reload',async({page})=>{
  const f=await mockInbox(page);
  await page.addInitScript(()=>localStorage.setItem('helmsman.pull-request.v1:helmsman.compat-pr/panel:result:run:legacy-rejection',JSON.stringify({version:1,value:{input:{repo:'org/b',action:'launch',launch:{mode:'rerun',prNumber:42}},receipt:{status:'rejected',runId:'blocked-run',message:'Retained <worktree> & branch ownership blocks this launch.'}}})));
  await page.goto('/prs?repo=org%2Fa&prRepo=org%2Fb&pr=42');
  const result=page.locator('.pr-saved-result');
  await expect(result).toHaveText('Saved run result: rejected · blocked-run — Retained <worktree> & branch ownership blocks this launch.');
  await expect(result.locator('worktree')).toHaveCount(0);
  await page.reload(); await expect(result).toContainText('Retained <worktree> & branch ownership blocks this launch.');
  expect(f.writes).toEqual([]); expect(f.errors).toEqual([]);
});
