import { expect, test } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';

for (const width of [1440, 390]) test(`section navigation persists across parent and child pages at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.github-settings', 'helmsman.local-git']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : path === '/api/repo/local' ? { repo: 'org/a', path: '/repo', branches: [], worktrees: [], error: null } : {};
    return route.fulfill({ json });
  });
  await page.goto('/config?repo=org%2Fa');
  await expect(page.locator('#boot')).toHaveCount(0);
  const menu = page.getByRole('navigation', { name: 'Config pages', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('link')).toHaveCount(8);
  await expect(menu.getByRole('link', { name: 'Overview', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveScreenshot(`config-navigation-${width}.png`);
  await menu.getByRole('link', { name: 'GitHub', exact: true }).click();
  await expect(page).toHaveURL(/\/github-settings\?repo=org%2Fa$/);
  await expect(page.getByRole('tab', { name: 'Config', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(menu.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(menu.getByRole('link')).toHaveCount(8);
  await expect(page).toHaveScreenshot(`github-navigation-${width}.png`);
  await menu.getByRole('link', { name: 'Local Git', exact: true }).click();
  await expect(menu.getByRole('link', { name: 'Local Git', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await expect(menu.getByRole('link', { name: 'Local Git', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(menu.getByRole('link', { name: 'Task sources', exact: true })).toHaveAttribute('href', '/source-settings?repo=org%2Fa');
  await page.goBack();
  await expect(menu.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(menu.getByRole('link', { name: 'Overview', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goto('/run-history?repo=org%2Fb&run=old&runRepo=org%2Fa');
  const runs = page.getByRole('navigation', { name: 'Voyages pages', exact: true });
  await expect(runs.getByRole('link', { name: 'History', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(runs.getByRole('link', { name: 'Voyage details', exact: true })).toHaveAttribute('href', '/run-viewer?repo=org%2Fb');
  await expect(page).toHaveScreenshot(`runs-navigation-${width}.png`);
  await runs.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(runs).toBeVisible();
  await expect(runs.getByRole('link', { name: 'Overview', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('tab', { name: 'Todos', exact: true }).click();
  await expect(page.locator('.section-nav')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
