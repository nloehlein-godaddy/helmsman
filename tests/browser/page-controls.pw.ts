import { expect, test } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';

for (const width of [1440, 390]) test.describe(`page controls at ${width}px`, () => {
  test.use({ viewport: { width, height: 1100 }, hasTouch: width === 390 });
  test('keeps layout editing separate and removes duplicated panels persistently', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      expect(route.request().method()).toBe('GET');
      const path = new URL(route.request().url()).pathname;
      const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.local-git']) }
        : path === '/api/context' ? { repos: ['org/a'], jiraBaseUrl: null }
        : path === '/api/config' ? { config: {}, overridden: [] }
        : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
        : path === '/api/repo/local' ? { repo: 'org/a', path: '/repo', branches: [], worktrees: [], error: null } : {};
      return route.fulfill({ json });
    });
    await page.goto('/local-git?repo=org/a');
    const root = page.locator('[data-composition-page]');
    const header = root.locator('.composition-page-header');
    await expect(root.locator('.local-git-panel')).toHaveCount(1);
    await expect(header.getByRole('button')).toHaveCount(2);
    await expect(root.getByRole('button', { name: 'Add panel', exact: true })).toBeHidden();
    await expect(root.getByRole('button', { name: 'Remove Local Git', exact: true })).toBeHidden();
    const buttons = await header.getByRole('button').evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { top: rect.top, height: rect.height, width: rect.width }; }));
    expect(buttons[0]?.top).toBe(buttons[1]?.top);
    expect(buttons.every(button => button.height >= (width === 390 ? 44 : 36) && button.width >= (width === 390 ? 44 : 36))).toBe(true);
    await expect(page).toHaveScreenshot(`local-git-header-${width}.png`);
    await header.getByRole('button', { name: 'Edit page', exact: true }).click();
    await expect(header.getByRole('button', { name: 'Done editing page', exact: true })).toBeFocused();
    await root.getByRole('button', { name: 'Add panel', exact: true }).click();
    await expect(root.locator('.local-git-panel')).toHaveCount(2);
    const rows = root.locator('.composition-panel-row');
    await expect(rows).toHaveCount(2);
    await expect(page).toHaveScreenshot(`local-git-editor-${width}.png`);
    await rows.last().getByRole('button', { name: 'Remove Local Git', exact: true }).click();
    await expect(root.locator('.local-git-panel')).toHaveCount(1);
    await expect(header.getByRole('button', { name: 'Done editing page', exact: true })).toBeFocused();
    await header.getByRole('button', { name: 'Done editing page', exact: true }).click();
    await expect(header.getByRole('button', { name: 'Edit page', exact: true })).toBeFocused();
    await page.reload();
    await expect(root.locator('.local-git-panel')).toHaveCount(1);
    await header.getByRole('button', { name: 'Edit page', exact: true }).click();
    await root.getByRole('button', { name: 'Remove Local Git', exact: true }).click();
    await expect(root.locator('.local-git-panel')).toHaveCount(0);
    await expect(root.getByText('No visible panels. Choose Edit page to add or show a panel.', { exact: true })).toBeVisible();
    await header.getByRole('button', { name: 'Done editing page', exact: true }).click();
    await page.reload();
    await expect(root.locator('.local-git-panel')).toHaveCount(0);
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
});
