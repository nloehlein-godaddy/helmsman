import { expect, test } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { expectReadableSurfaces } from './theme-contrast';

for (const width of [1440, 390]) test.describe(`Global VPN status at ${width}px`, () => {
  test.use({ viewport: { width, height: 1000 }, hasTouch: width === 390 });
  test('keeps read-only header evidence global and refreshes it without navigation or writes', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-11T12:00:00.000Z') });
    let release!: () => void; const initial = new Promise<void>(resolve => { release = resolve; });
    const reads: string[] = []; const writes: string[] = []; const errors: string[] = [];
    let status = { version: 1, state: 'connected', client: 'connected', network: 'reachable', checkedAt: '2026-10-11T12:00:00.000Z' };
    let failed = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
      if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
      if (!path.startsWith('/api/')) return route.continue();
      if (request.method() !== 'GET') { writes.push(path); return route.fulfill({ status: 503, json: { error: 'Unexpected write blocked by test' } }); }
      if (path === '/api/vpn-status') { reads.push(url.search); if (reads.length === 1) await initial; return route.fulfill(failed ? { status: 503, json: { error: 'Status unavailable' } } : { json: status }); }
      const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.communication']) }
        : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
        : path === '/api/config' ? { config: {}, overridden: [] }
        : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
        : path === '/api/integration-status' ? { version: 1, repo: url.searchParams.get('repo'), jira: 'not-configured', github: 'not-configured', checkedAt: status.checkedAt } : {};
      return route.fulfill({ json });
    });
    await page.goto('/config?repo=org%2Fa'); const header = page.locator('.helm-head'); const vpn = header.locator('[data-vpn-status]');
    await expect(vpn).toHaveCount(1); await expect(vpn).toHaveAttribute('data-state', 'checking'); await expect(vpn).toHaveAccessibleName(/VPN/i); await expect(vpn).toHaveAttribute('title', /checking/i); await expectReadableSurfaces(header, ['[data-vpn-status]'], 3); if (width === 390) expect((await vpn.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expect(header.getByText('Pages', { exact: true })).toHaveCount(0); const bell = header.getByRole('button', { name: /^Notifications,/ }); await expect(bell).toBeVisible(); await expect.poll(async () => { const a = await vpn.boundingBox(); const b = await bell.boundingBox(); return a && b ? Math.min(Math.abs(a.x - b.x - b.width), Math.abs(b.x - a.x - a.width)) : Infinity; }).toBeLessThanOrEqual(16); expect(await vpn.textContent()).toBe('');
    release(); await expect(vpn).toHaveAttribute('data-state', 'connected'); await expect(vpn).toHaveAttribute('title', /connected/i); await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await page.mouse.move(0, 0); await expect(header).toHaveScreenshot(`vpn-header-connected-${width}.png`);
    await page.locator('.repo-select').selectOption('org/b'); await expect(page.locator('.repo-select')).toHaveValue('org/b'); await expect(vpn).toHaveAttribute('data-state', 'connected'); expect(reads).toEqual(['']);
    await page.getByRole('tab', { name: 'Todos', exact: true }).click(); await expect(vpn).toBeVisible(); await expect(vpn).toHaveAttribute('data-state', 'connected');
    status = { ...status, state: 'unknown', client: 'connected', network: 'unreachable', checkedAt: '2026-10-11T12:01:00.000Z' }; await page.clock.runFor(60_000); await expect(vpn).toHaveAttribute('data-state', 'unknown'); await expect(vpn).toHaveAttribute('title', /unreachable/i); await expect(vpn).toHaveAccessibleName(/GlobalProtect: connected.*unreachable.*does not prove.*disconnected/i);
    await vpn.focus(); await expect(vpn).toBeFocused(); await expect(vpn).toHaveAccessibleName(/VPN/i); await page.mouse.move(0, 0); await expect(header).toHaveScreenshot(`vpn-header-unreachable-${width}.png`);
    status = { ...status, state: 'disconnected', client: 'disconnected', network: 'not-configured', checkedAt: '2026-10-11T12:02:00.000Z' }; await page.clock.runFor(60_000); await expect(vpn).toHaveAttribute('data-state', 'disconnected'); await expect(vpn).toHaveAttribute('title', /disconnected/i);
    failed = true; await page.clock.runFor(60_000); await expect(vpn).toHaveAttribute('data-state', 'unknown');
    expect(reads).toEqual(['', '', '', '']); failed = false;
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000)); const beforeHidden = reads.length; status = { ...status, state: 'connected', client: 'connected' };
    try {
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.clock.runFor(60_000); expect(reads).toHaveLength(beforeHidden); await page.clock.runFor(30_000); expect(reads).toHaveLength(beforeHidden);
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
      await expect.poll(() => reads.length).toBe(beforeHidden + 1); await expect(vpn).toHaveAttribute('data-state', 'connected');
      await page.clock.runFor(59_999); expect(reads).toHaveLength(beforeHidden + 1); await page.clock.runFor(1); await expect.poll(() => reads.length).toBe(beforeHidden + 2);
    } finally { await page.evaluate(() => { Reflect.deleteProperty(document, 'hidden'); document.dispatchEvent(new Event('visibilitychange')); }); }
    await page.getByRole('tab', { name: 'Config', exact: true }).click();
    for (const mode of ['dark', 'light']) {
      const appearance = page.locator('[data-custom-theme-mode]'); if (await appearance.getAttribute('aria-pressed') !== String(mode === 'dark')) await appearance.click();
      for (const state of ['connected', 'disconnected', 'unknown']) { status = { ...status, state, client: state, network: 'not-configured' }; await page.clock.runFor(60_000); await expect(vpn).toHaveAttribute('data-state', state); await expectReadableSurfaces(header, ['[data-vpn-status]'], 3); }
    }
    expect(reads.every(query => query === '')).toBe(true); expect(writes).toEqual([]); expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
