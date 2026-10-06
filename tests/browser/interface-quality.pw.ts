import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';

async function mockInterface(page: Page) {
  const ids = ['helm', 'running', 'newrun', 'underway', 'recent', 'backlog', 'repoprs', 'shipped', 'activity', 'run-viewer'];
  const at = '2026-09-20T12:00:00.000Z';
  const run = { version: 1, id: 'sample-run', repo: 'org/a', displayKey: 'TASK-41', status: 'running', attempt: 1,
    startedAt: at, endedAt: null, prNumber: null, costUsd: null, review: null, sourceSettlement: null };
  const target = { repo: run.repo, runId: run.id, expectedAttempt: 1 };
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (route.request().method() !== 'GET') throw new Error(`Unexpected mutation: ${url.pathname}`);
    const path = url.pathname;
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(ids.map(id => `helmsman.${id}`)) }
      : path === '/api/context' ? { repos: ['org/a'], jiraEnabled: false, jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } }
      : path === '/api/task-sources' ? { instances: [] }
      : path === '/api/run-read' ? { version: 1, repo: 'org/a', items: [], nextCursor: null }
      : path === '/api/pull-request-read' ? { version: 1, repo: 'org/a', kind: url.searchParams.get('kind'), items: [], quality: 'complete', truncated: false, browseUrl: null }
      : path === '/api/run-read/sample-run' ? { version: 1, repo: run.repo, runId: run.id, run }
      : path === '/api/run-inspect/resolve' ? { version: 1, target, observedAt: at }
      : path === '/api/run-inspect/sample-run/log' ? { version: 1, target, provenance: 'run-wide', observedAt: at, workerStatus: run.status, events: [], throughSequence: 0, hasEarlier: false, hasLater: false, nextCursor: url.searchParams.get('direction') === 'forward' ? 'follow' : null, followCursor: url.searchParams.has('cursor') ? null : 'follow' }
      : {};
    return route.fulfill({ json });
  });
}

for (const touch of [false, true]) test.describe(touch ? 'touch interface' : 'pointer interface', () => {
  test.use({ hasTouch: touch, viewport: { width: touch ? 390 : 1440, height: 1000 } });
  test('keeps navigation and panel controls usable with the active input method', async ({ page }) => {
    await mockInterface(page);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/config?repo=org/a');
    await expect(page.locator('#boot')).toHaveCount(0);
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(touch);
    if (touch) {
      for (const selector of ['.repo-select', '.pages-menu > summary', '.page-tab', '.section-link', '.footer-about > summary', '[data-recovery-link]']) {
        const heights = await page.locator(selector).evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        expect(heights.length).toBeGreaterThan(0);
        expect(heights.every(height => height >= 44)).toBe(true);
      }
      await expect(page).toHaveScreenshot('touch-config.png');
      const nav = page.locator('.section-nav');
      const bounds = await nav.boundingBox();
      expect(bounds).not.toBeNull();
      if (!bounds) return;
      const client = await page.context().newCDPSession(page);
      const y = bounds.y + bounds.height / 2;
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 330, y }] });
      for (const x of [280, 220, 160, 100, 50]) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => nav.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
      await client.detach();
    }
    await page.goto('/helm?repo=org/a');
    const collapse = page.locator('.helm-collapse').first();
    await expect(collapse).toBeVisible();
    const size = await collapse.boundingBox();
    expect(size?.width).toBe(touch ? 44 : 32);
    expect(size?.height).toBe(touch ? 44 : 32);
    if (touch) await collapse.tap(); else await collapse.click();
    await expect(collapse).toHaveAttribute('aria-expanded', 'false');
    if (touch) await collapse.tap(); else await collapse.click();
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    if (touch) {
      await expect(page.locator('.plugin-running button').first()).toBeVisible();
      await expect(page.locator('.plugin-newrun select').first()).toBeVisible();
      for (const selector of ['.plugin-running button', '.plugin-newrun select', '.plugin-newrun button']) {
        const sizes = await page.locator(selector).evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => node.getBoundingClientRect().height));
        expect(sizes.length).toBeGreaterThan(0);
        expect(sizes.every(height => height >= 44)).toBe(true);
      }
      await expect(page).toHaveScreenshot('touch-helm.png');
    }
    await page.goto('/run-viewer?repo=org/a&run=sample-run&runRepo=org/a');
    await expect(page.locator('.run-tab-status')).toHaveText('running');
    await expect(page.locator('.run-tab-open')).toBeVisible();
    if (touch) {
      for (const selector of ['.run-tab-open', '.run-tab > button:not([role=tab])']) {
        const bounds = await page.locator(selector).boundingBox();
        expect(bounds?.width).toBeGreaterThanOrEqual(44);
        expect(bounds?.height).toBeGreaterThanOrEqual(44);
      }
      await expect(page).toHaveScreenshot('touch-run-viewer.png');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
});

test('Config remains readable when text sizes double on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await mockInterface(page);
  await page.goto('/config?repo=org/a');
  await expect(page.locator('.theme-preview-swatch').first()).toBeVisible();
  await page.evaluate(() => {
    const sizes = [...document.querySelectorAll<HTMLElement>('body *')].map(node => ({ node, size: parseFloat(getComputedStyle(node).fontSize) }));
    for (const { node, size } of sizes) if (Number.isFinite(size)) node.style.fontSize = `${size * 2}px`;
    window.dispatchEvent(new Event('resize'));
  });
  const content = page.locator('#page-content');
  expect(await content.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  const swatches = await page.locator('.theme-preview-swatch').evaluateAll(nodes => nodes.map(node => node.scrollWidth <= node.clientWidth));
  expect(swatches.every(Boolean)).toBe(true);
});
