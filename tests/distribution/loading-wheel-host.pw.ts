import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { fixture, sourceRoot } from './isolated-fixture';

test('source-denied copied run panels retain accessible loading and unavailable states', async ({ page }) => {
  test.setTimeout(120_000);
  const host = await fixture(); const errors: string[] = []; const held: Promise<void>[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(host.script('deny-loading-wheel-source.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/running/panel.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await host.installAuthorPackage('plugin-sources/running', 'example.loading-running', { buildScript: true });
    await host.installAuthorPackage('plugin-sources/recent', 'example.loading-recent', { buildScript: true });
    const origin = await host.start();
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize({ width: 320, height: 720 });
    await page.route('**/api/run-read?**', async route => {
      const pending = gate.then(() => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"held run read unavailable"}' }));
      held.push(pending); await pending;
    });
    await page.goto(`${origin}/helm?repo=org/a`); await expect(page.locator('.plugin-helm')).toBeVisible();
    await page.getByText('Manage panels', { exact: true }).click();
    for (const contribution of ['example.loading-running/panel', 'example.loading-recent/panel']) {
      await page.getByLabel('Panel to add', { exact: true }).selectOption(contribution);
      await page.getByRole('button', { name: 'Add panel', exact: true }).click();
    }
    await page.getByText('Manage panels', { exact: true }).click();
    await expect.poll(() => held.length).toBeGreaterThanOrEqual(2);
    const running = page.locator('.plugin-running').last(); const recent = page.locator('.plugin-recent').last();
    for (const panel of [running, recent]) {
      const loading = panel.getByRole('status', { name: 'Loading runs…', exact: true });
      await expect(loading).toBeVisible(); await expect(loading.locator('svg')).toHaveCSS('animation-name', 'none');
      expect(await loading.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    release(); await Promise.all(held);
    for (const panel of [running, recent]) {
      await expect(panel.getByRole('alert')).toContainText('Run data is unavailable: service-unavailable. Refresh to retry.');
      await expect(panel.getByRole('status', { name: 'Loading runs…', exact: true })).toHaveCount(0);
    }
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { release?.(); await host.close(); }
});
