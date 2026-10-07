import { expect, test } from '@playwright/test';

const oldHash = 'a'.repeat(64);
const newHash = 'b'.repeat(64);
const external = () => ({ id: 'example.summary', name: 'Work summary', version: '1.0.0', kind: 'external', hash: oldHash,
  desiredEnabled: true, health: 'active', state: 'active', revision: 1, obligationsOnly: false });
const builtin = { id: 'helmsman.jira', name: 'Jira', version: '0.1.0', kind: 'builtin', hash: 'c'.repeat(64),
  desiredEnabled: true, health: 'active', state: 'active', revision: 1, obligationsOnly: false };

for (const width of [1440, 390]) test.describe(`plugin management at ${width}px`, () => {
  test.use({ viewport: { width, height: 1050 }, hasTouch: width === 390 });
  test('updates a package through an inspected archive and keeps source recovery in scope', async ({ page }) => {
    let installed: ReturnType<typeof external> | null = external();
    const mutations: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/plugins/manage') {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          if (body.action === 'inspect') return route.fulfill({ json: { version: 1, preview: {
            id: 'example.summary', name: 'Work summary', version: '2.0.0', hash: newHash, kind: 'external',
            expected: installed ? { hash: installed.hash, revision: installed.revision, desiredEnabled: installed.desiredEnabled } : null,
          } } });
          mutations.push(body.action);
          expect(body.expected).toEqual(installed ? { hash: installed.hash, revision: installed.revision, desiredEnabled: installed.desiredEnabled } : null);
          if (body.action === 'disable' && installed) installed = { ...installed, desiredEnabled: false, health: 'inactive', state: 'disabled', revision: installed.revision + 1 };
          else if (body.action === 'install' && installed) {
            expect(body.trustConfirmed).toBe(true); expect(body.confirmedHash).toBe(newHash);
            installed = { ...installed, version: '2.0.0', hash: newHash, revision: installed.revision + 1 };
          } else if (body.action === 'enable' && installed) {
            expect(body.trustConfirmed).toBe(true);
            installed = { ...installed, desiredEnabled: true, revision: installed.revision + 1 };
          } else if (body.action === 'uninstall') installed = null;
        }
        return route.fulfill({ json: { version: 1, plugins: [...(installed ? [installed] : []), builtin], restartRequired: mutations.length > 0 } });
      }
      const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: [] }
        : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
        : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} } : {};
      return route.fulfill({ json });
    });
    await page.goto('/config?repo=org/a&pane=plugins');
    const manager = page.locator('.plugin-manager');
    const row = manager.locator('[data-plugin-id="example.summary"]');
    await expect(row).toContainText(/configured:? enabled/i);
    await expect(page.locator('.section-nav [aria-current="page"]')).toHaveText('Plugins');
    await expect(manager.getByRole('link', { name: 'Source settings' })).toHaveAttribute('href', '/source-settings?repo=org%2Fa');
    await expect(page).toHaveScreenshot(`plugin-manager-${width}.png`);
    await row.getByRole('button', { name: 'Details', exact: true }).click();
    await row.getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(row).toContainText(/configured:? disabled/i);
    await expect(manager.getByRole('status')).toContainText('Restart Helmsman');
    const chooser = page.waitForEvent('filechooser');
    await row.getByRole('button', { name: 'Update from .hmp', exact: true }).click();
    await (await chooser).setFiles({ name: 'summary-2.hmp', mimeType: 'application/json', buffer: Buffer.from('{}') });
    const preview = manager.getByRole('region', { name: 'Archive preview' });
    await expect(preview).toContainText('version 2.0.0');
    await expect(preview.getByRole('button', { name: 'Update plugin', exact: true })).toBeDisabled();
    await preview.getByRole('checkbox').check();
    await expect(page).toHaveScreenshot(`plugin-manager-update-${width}.png`);
    await preview.getByRole('button', { name: 'Update plugin', exact: true }).click();
    await expect(row).toContainText('v2.0.0');
    await row.getByRole('checkbox').check();
    await row.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(row).toContainText(/configured:? enabled/i);
    await manager.getByRole('button', { name: 'Refresh plugins', exact: true }).click();
    await expect(manager.getByRole('status')).toContainText('Restart Helmsman');
    await row.getByRole('button', { name: 'Disable', exact: true }).click();
    await row.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.locator('.repo-select').selectOption('org/b');
    await expect(manager.getByRole('link', { name: 'Source settings' })).toHaveAttribute('href', '/source-settings?repo=org%2Fb');
    await manager.getByRole('searchbox', { name: 'Search plugins' }).fill('jira');
    await expect(manager.locator('[data-plugin-id]')).toHaveCount(1);
    expect(mutations).toEqual(['disable', 'install', 'enable', 'disable', 'uninstall']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
});
