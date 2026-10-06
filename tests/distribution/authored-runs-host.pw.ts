import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, sourceRoot } from './isolated-fixture';

const packageId = 'example.authored-runs';
const pageId = `${packageId}/page`;
const compositionId = 'helmsman/runs-page';
interface SavedLayout {
  version: number; compositionId: string; revision: number;
  instances: { instanceId: string; contributionId: string; hidden: boolean; scope: unknown; state: unknown }[];
  columns: { instances: string[]; activeInstanceId: string; collapsed: boolean }[][];
}
async function layout(page: Page): Promise<SavedLayout> {
  return page.evaluate(compositionId => new Promise<SavedLayout>((resolve, reject) => {
    const open = indexedDB.open('helmsman.composition-layouts', 1); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result; const tx = db.transaction('layouts', 'readonly'); const read = tx.objectStore('layouts').get(compositionId);
      tx.oncomplete = () => { db.close(); read.result ? resolve(read.result) : reject(new Error('Missing Runs layout')); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), compositionId);
}
async function replaceLayout(page: Page, kind: 'custom' | 'missing' | 'empty'): Promise<SavedLayout> {
  return page.evaluate(({ compositionId, kind }) => new Promise<SavedLayout>((resolve, reject) => {
    const open = indexedDB.open('helmsman.composition-layouts', 1); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result; const tx = db.transaction('layouts', 'readwrite'); const table = tx.objectStore('layouts'); const read = table.get(compositionId); let saved: SavedLayout;
      read.onsuccess = () => {
        if (!read.result || typeof read.result.revision !== 'number') { tx.abort(); return; }
        const instanceId = kind === 'custom' ? 'custom-history' : 'retained-missing';
        saved = { ...read.result, revision: read.result.revision + 1,
          instances: kind === 'empty' ? [] : [{ instanceId, contributionId: kind === 'custom' ? 'helmsman.run-history/panel' : 'example.unavailable/panel', hidden: kind === 'custom',
            scope: kind === 'custom' ? { kind: 'inherit' } : { kind: 'galleon', repo: 'org/b' }, state: kind === 'custom' ? {} : { 'example.unavailable/panel': { version: 9, value: { future: 'Retained Runs panel evidence' } } } }],
          columns: kind === 'empty' ? [] : [[{ instances: [instanceId], activeInstanceId: instanceId, collapsed: kind === 'custom' }]] };
        table.put(saved);
      };
      tx.oncomplete = () => { db.close(); resolve(saved); }; tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Runs layout unavailable')); };
    };
  }), { compositionId, kind });
}
async function navigate(page: Page, path: string) {
  await page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, path);
}

test('copied Runs page preserves public PR scope, drafts and command identity and reuses the shared viewer', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const host = await fixture({ distribution: process.env.HELMSMAN_AUTHORED_RUNS_DISTRIBUTION }); host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const reviews: Record<string, unknown>[] = []; const otherMutations: string[] = []; const legacyStreams: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path !== '/api/pull-request-command') otherMutations.push(path);
    if (/^\/api\/agents\/[^/]+\/log$/.test(path)) legacyStreams.push(path);
  });
  const target = { repo: 'org/b', number: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
  const status = { version: 1, target, observedAt: '2026-09-20T12:00:00Z', title: 'Runs public target', url: 'https://github.com/org/b/pull/42',
    status: 'open', draft: false, authorLogin: 'writer', isOwnPr: true, headRefName: 'topic', updatedAt: '2026-09-20T12:00:00Z', comments: 0,
    checks: { quality: 'complete', passed: 1, failed: 0, pending: 0 },
    reviews: { quality: 'complete', approved: 0, changesRequested: 0, commented: 0, requested: 0, viewerReview: null, viewerReviewedAt: null, viewerReviewedCommitId: null } };
  try {
    await expect(host.script('deny-runs-source.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/runs/page.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    const descriptor = await host.installAuthorPackage('plugin-sources/runs', packageId);
    expect(descriptor.manifest.pages[0]?.requires).toEqual([{ id: 'helmsman/composition', version: 1 }]); expect(descriptor.panelEntries).toEqual({});
    await host.cli('select', compositionId, pageId);
    const dbUrl = pathToFileURL(join(host.app, 'server/helmsman/db.js')).href;
    await host.script('seed-authored-runs.mjs', `import { openDb } from ${JSON.stringify(dbUrl)};
      const db=openDb(process.env.HELMSMAN_DB); try {
        db.insertRun({id:'runs-proof',repo:'org/a',ticketId:'TASK-1',adapter:'codex',status:'succeeded',attempt:1,prNumber:null,startedAt:'2026-09-20T12:00:00.000Z',endedAt:'2026-09-20T13:00:00.000Z',costUsd:null,worktreePath:null});
        for(let index=0;index<350;index++) db.appendEvent('runs-proof','log','Authored Runs retained log '+index,'2026-09-20T12:00:00.000Z');
      } finally {db.close();}`);
    const origin = await host.start();
    await page.route('**/api/pull-request-inspect/detail?*', route => route.fulfill({ json: status }));
    await page.route('**/api/pull-request-inspect/diff?*', route => route.fulfill({ json: { version: 1, target, observedAt: status.observedAt, coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false, files: [] } }));
    await page.route('**/api/pull-request-command', async route => { reviews.push(route.request().postDataJSON().command); await route.abort('failed'); });
    await page.route('**/api/config', route => route.request().method() === 'GET' ? route.fulfill({ json: { config: { SLACK_ENABLED: 'true' }, overridden: [] } }) : route.continue());
    await page.goto(`${origin}/prs?repo=org/a&prRepo=org/b&pr=42`);
    const initialPr = page.locator('.pr-lookup-result');
    await initialPr.locator('.pr-review-body').fill('Review draft retained on authored Runs');
    await initialPr.locator('.pr-rerun-feedback').fill('Feedback retained on authored Runs');
    await initialPr.locator('.pr-comment').click(); await expect(page.locator('[data-pending-kind="review"][data-retry="true"]')).toBeVisible();
    const targetPath = '/runs?repo=org/a&prRepo=org/b&pr=42&pane=newrun&mode=rerun';
    await navigate(page, targetPath);
    const runs = page.locator(`[data-plugin-page="${pageId}"]`); const pr = runs.locator('.pr-panel[data-pr-repo="org/b"][data-pr-number="42"]');
    await expect(runs).toBeVisible(); await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(pr.locator('.pr-rerun-feedback')).toHaveValue('Feedback retained on authored Runs'); await expect(pr.locator('.pr-rerun-feedback')).toBeFocused();
    await expect(pr.locator('.pr-review-body')).toHaveValue('Review draft retained on authored Runs');
    expect(reviews).toHaveLength(1); expect(otherMutations).toEqual([]);
    await runs.locator('[data-pending-kind="review"][data-retry="true"]').click(); await expect.poll(() => reviews.length).toBe(2);
    expect(reviews[1]).toEqual(reviews[0]); expect(reviews[1]?.expectedHeadSha).toBe(target.headSha);
    await pr.getByRole('link', { name: 'Open review setup ↗', exact: true }).click();
    await expect(pr.locator('.pr-review-agent')).toBeDisabled();
    await page.reload(); await expect(pr).toBeVisible(); await expect(pr.locator('.pr-review-agent')).toBeDisabled();
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    const { requestId, ...input } = reviews[0]!;
    await page.route('**/api/pull-request-command/receipts/*?*', route => route.fulfill({ json: {
      version: 1, requestId, input, status: 'succeeded', reason: null,
      result: { repo: target.repo, number: target.number, headSha: target.headSha, actor: 'reviewer', reviewId: 101 },
    } }));
    await runs.locator('[data-pending-kind="review"]:not([data-retry])').click();
    await expect(pr.locator('.pr-review-agent')).toBeEnabled();
    await navigate(page, targetPath);
    await pr.getByRole('link', { name: 'Open review setup ↗', exact: true }).click(); await expect(pr.locator('.pr-review-agent')).toBeFocused();
    await page.reload(); await expect(pr).toBeVisible(); await expect(pr.locator('.pr-review-agent')).toBeFocused();
    expect((await layout(page)).instances.map(instance => instance.contributionId)).toEqual(['helmsman.compat-pr/panel', 'helmsman.run-history/panel']);
    const historyPanel = runs.locator('section.plugin-run-history');
    const historyRun = historyPanel.getByRole('button', { name: 'TASK-1 · org/a · runs-proof · Attempt 1', exact: true });
    await expect(historyRun).toBeVisible();
    await historyRun.click();
    const viewer = page.locator('[data-plugin-page="helmsman.run-viewer/page"]');
    await expect(viewer.locator('.run-log')).toContainText('log 349'); await expect(viewer).toHaveCount(1);
    await viewer.getByRole('button', { name: 'Earlier logs', exact: true }).click(); await expect(viewer.locator('.run-log')).toContainText('log 250');
    const retainedViewer = await viewer.elementHandle(); const retainedLog = await viewer.locator('.run-log').elementHandle(); const retainedText = await viewer.locator('.run-log').textContent();
    for (const path of ['/run-viewer?repo=org/a&run=runs-proof&runRepo=org/a', '/runs?repo=org/a&run=runs-proof&runRepo=org/a&pane=tasks']) {
      await navigate(page, path); await expect(viewer).toBeVisible();
      expect(await viewer.evaluate((element, expected) => element === expected, retainedViewer)).toBe(true);
      expect(await viewer.locator('.run-log').evaluate((element, expected) => element === expected, retainedLog)).toBe(true);
      await expect(viewer.locator('.run-log')).toHaveText(retainedText ?? ''); await expect(viewer.getByRole('button', { name: 'Follow latest', exact: true })).toBeVisible();
    }
    await expect(page.locator('#boot')).toBeHidden({ timeout: 15_000 });
    await runs.getByRole('heading', { name: 'Voyages', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('authored-runs-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await runs.getByRole('heading', { name: 'Voyages', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('authored-runs-mobile.png') });
    await viewer.locator('.run-log').scrollIntoViewIfNeeded(); await expect(viewer.locator('.run-log')).toBeInViewport(); await page.screenshot({ path: testInfo.outputPath('authored-runs-mobile-viewer.png') });
    expect(reviews).toHaveLength(2); expect(otherMutations).toEqual([]); expect(legacyStreams).toEqual([]); expect(errors).toEqual([]);
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});

test('Runs selection preserves custom, missing and empty layouts and never falls back when disabled', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const host = await fixture({ distribution: process.env.HELMSMAN_AUTHORED_RUNS_DISTRIBUTION }); host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await host.installAuthorPackage('plugin-sources/runs', packageId); await host.cli('select', compositionId, pageId);
    let origin = await host.start(); await page.goto(`${origin}/runs?repo=org/a`);
    await expect(page.locator(`[data-plugin-page="${pageId}"]`)).toBeVisible(); await expect(page.locator('.plugin-runs [data-pr-compat-lookup]')).toBeVisible();
    const initial = await layout(page); await page.goto(`${origin}/plugins/${pageId}?repo=org/a`);
    await expect(page.locator(`[data-plugin-page="${pageId}"]`)).toBeVisible(); expect(await layout(page)).toEqual(initial);
    await page.goto(`${origin}/config?repo=org/a`); await replaceLayout(page, 'custom');
    await page.goto(`${origin}/runs?repo=org/a&pane=recent`);
    await expect(page.locator('[data-panel-instance="custom-history"]').first()).toBeVisible();
    await expect(page.locator('section.plugin-run-history')).toBeVisible();
    expect((await layout(page)).instances).toMatchObject([{ instanceId: 'custom-history', hidden: false }]);
    await page.goto(`${origin}/config?repo=org/a`); const missing = await replaceLayout(page, 'missing');
    await page.goto(`${origin}/runs?repo=org/a&panel=missing-route-target`);
    await expect(page.getByText(/requested panel \(missing-route-target\)/)).toBeVisible();
    await expect(page.locator('[data-panel-instance="retained-missing"]').first()).toContainText(/unavailable/i); expect(await layout(page)).toEqual(missing);
    await page.goto(`${origin}/config?repo=org/a`); const empty = await replaceLayout(page, 'empty');
    await page.goto(`${origin}/runs?repo=org/b&pane=recent`); await expect(page.getByText('Add a panel to view voyages.', { exact: true })).toBeVisible(); expect(await layout(page)).toEqual(empty);
    host.env.HELMSMAN_PORT = new URL(origin).port; origin = await host.start(); await page.reload();
    await expect(page.getByText('Add a panel to view voyages.', { exact: true })).toBeVisible(); await expect(page.locator('.repo-select')).toHaveValue('org/b'); expect(await layout(page)).toEqual(empty);
    await expect(page.locator('#boot')).toBeHidden({ timeout: 15_000 }); await page.screenshot({ path: testInfo.outputPath('authored-runs-empty-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath('authored-runs-empty-mobile.png') });
    await host.cli('disable', packageId); await page.reload(); await expect(page.getByRole('heading', { name: 'Page unavailable', exact: true })).toBeVisible();
    await expect(page.locator('.plugin-runs, section.plugin-run-history, [data-pr-compat-lookup]')).toHaveCount(0); expect(await layout(page)).toEqual(empty);
    await host.cli('select', compositionId, 'example.missing/page'); await page.reload(); await expect(page.getByRole('heading', { name: 'Page unavailable', exact: true })).toBeVisible();
    await host.cli('select', compositionId, 'default'); await page.reload(); await expect(page.locator('[data-plugin-page="helmsman.runs/page"]')).toBeVisible();
    await expect(page.getByText('Add a panel to view voyages.', { exact: true })).toBeVisible(); expect(await layout(page)).toEqual(empty);
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});
