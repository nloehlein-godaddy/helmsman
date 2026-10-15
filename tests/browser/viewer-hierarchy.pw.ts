import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { expectReadableSurfaces } from './theme-contrast';

const at = '2026-10-14T12:00:00.000Z';
const requestId = '11111111-1111-4111-8111-111111111111';
async function mockRichViewer(page: Page) {
  const state = { instructionsAvailable: true, completed: false }; const errors: string[] = []; const writes: string[] = [];
  const run = { version: 1, id: 'review-11104', repo: 'org/a', displayKey: 'review', title: 'Preserve customer evidence when a review resumes', status: 'running', attempt: 2, startedAt: at, endedAt: null, prNumber: 11104, costUsd: 1.27, review: null, sourceSettlement: null }; const target = { repo: run.repo, runId: run.id, expectedAttempt: 2 };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { writes.push(path); return route.abort(); }
    const visibleRun = { ...run, status: state.completed ? 'succeeded' : 'running', endedAt: state.completed ? at : null, review: state.completed ? { outcome: 'REQUEST_CHANGES', verdict: 'Preserve the original request when the retry resumes.' } : null, sourceSettlement: state.completed ? { state: 'operator-required' } : null };
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.run-viewer', 'helmsman.run-history']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : path === '/api/vpn-status' ? { version: 1, state: 'unknown', client: 'unknown', network: 'not-configured', checkedAt: at }
      : path === '/api/run-read' ? { version: 1, repo: run.repo, items: [visibleRun], nextCursor: null }
      : path === '/api/run-read/review-11104' ? { version: 1, repo: run.repo, runId: run.id, run: visibleRun }
      : path === '/api/run-inspect/resolve' ? { version: 1, target, observedAt: at }
      : path === '/api/run-inspect/history' ? { version: 1, repo: run.repo, items: [visibleRun], nextCursor: null, total: 1, totalQuality: 'exact', observedAt: at, coverage: 'insertion-bounded-current-state' }
      : path === '/api/run-instructions' ? { version: 1, repo: run.repo, runId: run.id, expectedAttempt: 2, channelId: state.instructionsAvailable ? '22222222-2222-4222-8222-222222222222' : null, available: state.instructionsAvailable, reason: state.instructionsAvailable ? null : 'The agent connection ended. Start a new run to send instructions.', targets: state.instructionsAvailable ? [{ id: '33333333-3333-4333-8333-333333333333', provider: 'codex', stage: 'review.resolve' }] : [] }
      : path === '/api/run-inspect/review-11104/log' ? { version: 1, target, provenance: 'run-wide', observedAt: at, workerStatus: visibleRun.status, events: Array.from({ length: 30 }, (_, i) => ({ sequence: i + 1, at, kind: i === 0 ? 'status' : 'log', text: i === 0 ? 'Review #11104 resumed. Checking the latest commit before publication.' : `Evidence ${i}: Retain literal customer content <img src=x> and verify the retry preserves the same request.\nThe existing agent remains attached to this run.`, truncated: false })), throughSequence: 30, hasEarlier: true, hasLater: false, nextCursor: url.searchParams.get('direction') === 'forward' ? 'follow-proof' : 'older-proof', followCursor: url.searchParams.has('cursor') ? null : 'follow-proof' }
      : {};
    return route.fulfill({ json });
  });
  return { state, errors, writes };
}
async function seedSavedRequest(page: Page) {
  await page.evaluate(async requestId => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const opened = indexedDB.open('helmsman.run-commands', 1); opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
    const caller = 'helmsman.run-viewer/panel'; const input = { version: 1, repo: 'org/a', action: 'stop', target: { runId: 'previous-review', expectedAttempt: 1 } };
    await new Promise<void>((resolve, reject) => { const tx = database.transaction('pending', 'readwrite'); tx.objectStore('pending').put({ key: JSON.stringify([caller, input]), caller, command: { ...input, requestId }, receipt: null }); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); database.close();
  }, requestId);
}
async function savedLogHeight(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const opened = indexedDB.open('helmsman.composition-layouts', 1); opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
    const value = await new Promise<{ instances?: { contributionId: string; state?: Record<string, { value?: { logHeight?: number } }> }[] }>((resolve, reject) => { const read = database.transaction('layouts').objectStore('layouts').get('helmsman/run-viewer-page'); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); }); database.close(); return value?.instances?.find(instance => instance.contributionId === 'helmsman.run-viewer/panel')?.state?.['helmsman.run-viewer/panel']?.value?.logHeight ?? null;
  });
}
async function dragHeight(page: Page, handle: ReturnType<Page['getByRole']>, amount: number) {
  await handle.scrollIntoViewIfNeeded(); const bounds = await handle.boundingBox(); if (!bounds) throw new Error('Resize handle is unavailable'); const x = bounds.x + bounds.width / 2; const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + amount, { steps: 5 }); await page.mouse.up();
}

for (const width of [1440, 390]) test.describe(`Voyage viewer hierarchy at ${width}px`, () => {
  test.use({ viewport: { width, height: width === 390 ? 2200 : 1800 }, hasTouch: width === 390 });
  test('groups real log evidence, live instructions and saved requests, and resizes the log persistently', async ({ page }) => {
    const f = await mockRichViewer(page); await page.clock.install(); await page.goto('/run-viewer?repo=org%2Fa&run=review-11104&runRepo=org%2Fa'); await expect(page.locator('.run-log')).toContainText('Evidence 29'); await seedSavedRequest(page); await page.reload();
    const viewer = page.locator('section.plugin-run-viewer'); const instructions = viewer.locator('.run-instructions'); const editor = instructions.getByRole('textbox', { name: 'Instruction for active agent', exact: true }); const send = instructions.getByRole('button', { name: 'Send instruction', exact: true });
    await expect(viewer.locator(`[data-request-id="${requestId}"]`)).toBeVisible(); await expect(instructions.getByRole('combobox', { name: 'Active agent', exact: true })).toContainText('codex'); await editor.fill('Verify the customer evidence before publishing the next review.'); await expect(send).toBeEnabled();
    await expect(viewer.getByRole('heading', { name: 'Log preview', exact: true })).toBeVisible(); await expect(viewer.locator('.run-log img, .run-log script')).toHaveCount(0); await expectReadableSurfaces(viewer, ['.run-log', '.instruction-helper', '.instruction-status']); await editor.evaluate(element => (element as HTMLElement).blur()); await page.mouse.move(0, 0); await expect(viewer).toHaveScreenshot(`viewer-active-${width}.png`);
    const requestDetails = viewer.locator(`[data-request-id="${requestId}"] .run-request-details`); await requestDetails.locator('summary').focus(); await requestDetails.locator('summary').press('Enter'); await expect(requestDetails).toHaveAttribute('open', '');
    await editor.focus(); await editor.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(7, 15)); f.state.instructionsAvailable = false; f.state.completed = true; const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/run-instructions'); await page.clock.fastForward(2600); await (await read).finished(); await page.clock.runFor(100);
    await expect(editor).toBeFocused(); await expect(editor).toHaveValue('Verify the customer evidence before publishing the next review.'); expect(await editor.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([7, 15]); await expect(send).toBeHidden(); await expect(instructions.getByRole('combobox', { name: 'Active agent', exact: true })).toBeHidden(); await expect(instructions.getByText('Saved draft', { exact: true })).toBeVisible(); await expect(instructions.locator('.instruction-status')).toContainText('The agent connection ended.');
    await expect(viewer.getByText('Worker: succeeded', { exact: true })).toBeVisible(); await expect(viewer.getByText('Source settlement: operator-required', { exact: true })).toBeVisible(); await expect(viewer.getByRole('button', { name: 'Request changes: open GitHub review draft', exact: true })).toBeVisible(); await expect(requestDetails).toHaveAttribute('open', ''); await requestDetails.locator('summary').click(); await editor.evaluate(element => (element as HTMLElement).blur()); await page.mouse.move(0, 0); await expect(viewer).toHaveScreenshot(`viewer-unavailable-${width}.png`);
    const resize = viewer.getByRole('separator', { name: 'Resize log preview', exact: true }); await resize.focus(); await resize.press('ArrowDown'); await expect(resize).toHaveAttribute('aria-valuenow', '452'); await resize.press('Home'); await expect(resize).toHaveAttribute('aria-valuenow', '180'); await dragHeight(page, resize, 80); const preferred = Number(await resize.getAttribute('aria-valuenow')); expect(preferred).toBeGreaterThan(180);
    await expect.poll(() => savedLogHeight(page)).toBe(preferred); await page.reload(); await expect(viewer.locator('.run-log')).toContainText('Evidence 29'); await expect(resize).toHaveAttribute('aria-valuenow', String(preferred)); await resize.focus(); await resize.press('End'); await expect(resize).toHaveAttribute('aria-valuenow', '1200'); await page.setViewportSize({ width, height: 500 }); expect((await viewer.locator('.run-log').boundingBox())?.height ?? Infinity).toBeLessThanOrEqual(402); await expect(resize).toHaveAttribute('aria-valuenow', '1200'); await resize.focus(); await resize.press('ArrowUp'); await expect.poll(async () => (await viewer.locator('.run-log').boundingBox())?.height ?? Infinity).toBeLessThanOrEqual(370); await resize.press('End'); await expect(resize).toHaveAttribute('aria-valuenow', '1200'); await page.setViewportSize({ width, height: 1800 }); expect((await viewer.locator('.run-log').boundingBox())?.height ?? 0).toBeGreaterThan(1000);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(f.errors).toEqual([]); expect(f.writes).toEqual([]);
  });
});

test('drawer resize responds to pointer and keyboard, persists preference and clamps to the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 760 }); const f = await mockRichViewer(page); await page.goto('/run-history?repo=org%2Fa&run=review-11104&runRepo=org%2Fa'); await expect(page.locator('.run-log')).toContainText('Evidence 29');
  const grip = page.locator('[data-run-drawer-resize]'); const drawer = page.locator('[data-run-viewer-host]'); await expect(grip).toHaveAttribute('role', 'separator'); const initial = Number(await grip.getAttribute('aria-valuenow')); await dragHeight(page, grip, -60); const pointerHeight = Number(await grip.getAttribute('aria-valuenow')); expect(pointerHeight).toBeGreaterThan(initial); await grip.focus(); await grip.press('ArrowDown'); await expect(grip).toHaveAttribute('aria-valuenow', String(pointerHeight - 24)); await grip.press('End'); const preferred = Number(await grip.getAttribute('aria-valuemax')); await expect(grip).toHaveAttribute('aria-valuenow', String(preferred));
  await page.reload(); await expect(page.locator('.run-log')).toContainText('Evidence 29'); await expect(grip).toHaveAttribute('aria-valuenow', String(preferred)); expect(Number(await page.evaluate(() => localStorage.getItem('helmsman.runDrawerHeight')))).toBe(preferred); await page.setViewportSize({ width: 390, height: 500 }); await expect.poll(async () => Number(await grip.getAttribute('aria-valuenow'))).toBeLessThan(preferred); expect(Number(await page.evaluate(() => localStorage.getItem('helmsman.runDrawerHeight')))).toBe(preferred); expect((await drawer.boundingBox())?.height ?? Infinity).toBeLessThanOrEqual(350); await page.setViewportSize({ width: 1440, height: 760 }); await expect(grip).toHaveAttribute('aria-valuenow', String(preferred));
  expect(f.errors).toEqual([]); expect(f.writes).toEqual([]);
});
