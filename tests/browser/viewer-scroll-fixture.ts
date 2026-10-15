import { expect, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';

const at = '2026-10-14T12:00:00.000Z';
async function mockScrollingViewer(page: Page) {
  const errors: string[] = []; const writes: string[] = [];
  const state = { lastEvent: 45 };
  const run = { version: 1, id: 'run-0', repo: 'org/a', displayKey: 'review', status: 'succeeded', attempt: 1, startedAt: at, endedAt: at, prNumber: 11104, costUsd: null, review: null, sourceSettlement: null };
  const target = { repo: run.repo, runId: run.id, expectedAttempt: 1 };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { writes.push(path); return route.abort(); }
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.run-viewer', 'helmsman.run-history']) }
      : path === '/api/context' ? { repos: ['org/a'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : path === '/api/vpn-status' ? { version: 1, state: 'unknown', client: 'unknown', network: 'not-configured', checkedAt: at }
      : path === '/api/run-read' ? { version: 1, repo: run.repo, items: [run], nextCursor: null }
      : path === '/api/run-read/run-0' ? { version: 1, repo: run.repo, runId: run.id, run }
      : path === '/api/run-inspect/resolve' ? { version: 1, target, observedAt: at }
      : path === '/api/run-inspect/history' ? { version: 1, repo: run.repo, items: Array.from({ length: 10 }, (_, i) => ({ ...run, id: `run-${i}`, title: `Preserve literal customer evidence ${i}` })), nextCursor: null, total: 10, totalQuality: 'exact', observedAt: at, coverage: 'insertion-bounded-current-state' }
      : path === '/api/run-inspect/run-0/log' ? { version: 1, target, provenance: 'run-wide', observedAt: at, workerStatus: run.status, events: Array.from({ length: state.lastEvent }, (_, i) => ({ sequence: i + 1, at, kind: 'log', text: Array.from({ length: 12 }, (_, line) => `Event ${i + 1}, line ${line + 1}: Customer evidence stays attached to this review.`).join('\n'), truncated: false })), throughSequence: state.lastEvent, hasEarlier: false, hasLater: false, nextCursor: url.searchParams.get('direction') === 'forward' ? 'follow-proof' : null, followCursor: url.searchParams.has('cursor') ? null : 'follow-proof' }
      : {};
    return route.fulfill({ json });
  });
  return { errors, writes, state };
}

export async function verifyScrollStability(page: Page, drawer: boolean) {
    const f = await mockScrollingViewer(page); await page.clock.install();
    await page.goto(`/${drawer ? 'run-history' : 'run-viewer'}?repo=org%2Fa&run=run-0&runRepo=org%2Fa`);
    const viewer = page.locator('section.plugin-run-viewer'); const log = viewer.locator('.run-log');
    await expect(log).toContainText('Event 45, line 12'); await expect(viewer.getByRole('button', { name: 'Pause follow', exact: true })).toBeVisible();
    await expect.poll(() => log.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
    f.state.lastEvent = 50; const append = page.waitForResponse(response => new URL(response.url()).pathname === '/api/run-inspect/run-0/log'); await page.clock.fastForward(2100); await (await append).finished(); await page.clock.runFor(150);
    await expect(log).toContainText('Event 50, line 12'); await expect.poll(() => log.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
    await page.clock.runFor(350);
    await log.evaluate(element => {
      const log = element as HTMLElement; const outer = log.closest<HTMLElement>('[data-run-viewer-host]') ?? document.querySelector<HTMLElement>('#page-content');
      log.focus({ preventScroll: true }); log.scrollTop = 137;
      if (outer) outer.scrollTop = Math.min(180, outer.scrollHeight - outer.clientHeight);
    });
    await page.clock.runFor(17);
    await expect(viewer.getByRole('button', { name: 'Follow latest', exact: true })).toBeVisible();
    await log.evaluate(element => { const selection = getSelection(); const text = element.firstChild; if (!selection || !text) throw new Error('Log text is unavailable'); const range = document.createRange(); range.setStart(text, 600); range.setEnd(text, 630); selection.removeAllRanges(); selection.addRange(range); });
    const baseline = await log.evaluate(element => {
      const log = element as HTMLElement; const outer = log.closest<HTMLElement>('[data-run-viewer-host]') ?? document.querySelector<HTMLElement>('#page-content');
      return { log: log.scrollTop, outer: outer?.scrollTop ?? 0, selection: getSelection()?.toString() ?? '' };
    });
    expect(baseline.log, JSON.stringify(baseline)).toBe(137); expect(baseline.outer).toBeGreaterThan(0); expect(baseline.selection).not.toBe('');
    await log.evaluate(element => {
      const log = element as HTMLElement; const outer = log.closest<HTMLElement>('[data-run-viewer-host]') ?? document.querySelector<HTMLElement>('#page-content');
      const samples: { log: number; outer: number }[] = []; (window as unknown as { viewerScrollSamples: typeof samples }).viewerScrollSamples = samples;
      const record = () => { samples.push({ log: log.scrollTop, outer: outer?.scrollTop ?? 0 }); };
      log.addEventListener('scroll', record); outer?.addEventListener('scroll', record);
      const sampleFrame = () => { record(); if (samples.length < 1000) requestAnimationFrame(sampleFrame); }; requestAnimationFrame(sampleFrame);
    });
    for (let i = 0; i < 3; i++) {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/run-read/run-0'); await page.clock.fastForward(2100); await (await response).finished(); await page.clock.runFor(150);
      const actual = await log.evaluate(element => ({ log: element.scrollTop, outer: (element.closest<HTMLElement>('[data-run-viewer-host]') ?? document.querySelector<HTMLElement>('#page-content'))?.scrollTop ?? 0, selection: getSelection()?.toString() ?? '' }));
      expect(actual).toEqual(baseline); await expect(log).toBeFocused(); await expect(viewer.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
    }
    const samples = await page.evaluate(() => (window as unknown as { viewerScrollSamples: { log: number; outer: number }[] }).viewerScrollSamples);
    expect(samples.length).toBeGreaterThan(3); expect(samples.every(sample => Math.abs(sample.log - baseline.log) <= 1 && Math.abs(sample.outer - baseline.outer) <= 1)).toBe(true);
    await page.reload(); await expect(log).toContainText('Event 50, line 12'); await expect(viewer.getByRole('button', { name: 'Follow latest', exact: true })).toBeVisible(); await expect.poll(() => log.evaluate(element => Math.abs(element.scrollTop - 137))).toBeLessThanOrEqual(1); expect(f.errors).toEqual([]); expect(f.writes).toEqual([]);
}
