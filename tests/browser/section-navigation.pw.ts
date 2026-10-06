import { expect, test } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { THEMES } from '../../src/data/themes';

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


test('section navigation stands apart and stays readable in every theme', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: [] }
      : path === '/api/context' ? { repos: ['org/a'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} } : {};
    return route.fulfill({ json });
  });
  await page.goto('/config?repo=org/a');
  await expect(page.locator('#boot')).toHaveCount(0);
  await expect(page.locator('#page-content a.app-link')).toHaveCount(0);
  for (const theme of THEMES) {
    await page.locator('.theme-select').selectOption(theme.id);
    const nav = page.locator('.section-nav');
    const inactive = nav.getByRole('link', { name: 'Task sources', exact: true });
    const contrast = async () => page.evaluate(() => {
      const css = (selector: string) => {
        const node = document.querySelector(selector);
        if (!node) throw new Error(`Missing ${selector}`);
        return getComputedStyle(node);
      };
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
        if (!channels || channels.length !== 3) throw new Error(`Unsupported color: ${color}`);
        const [r, g, b] = channels.map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; });
        return .2126 * r! + .7152 * g! + .0722 * b!;
      };
      const ratio = (a: string, b: string) => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const bar = css('.section-nav'); const link = css('.section-link:not(.is-active)'); const active = css('.section-link.is-active');
      return {
        surfaces: ['.page-tabs', '.helm-head', '.page-content', '.config-panel'].map(selector => ratio(bar.backgroundColor, css(selector).backgroundColor)),
        text: ratio(link.color, link.backgroundColor === 'rgba(0, 0, 0, 0)' ? bar.backgroundColor : link.backgroundColor),
        selected: ratio(active.color, active.backgroundColor),
        selection: ratio(active.backgroundColor, bar.backgroundColor),
      };
    });
    await page.mouse.move(0, 0);
    const normal = await contrast();
    expect(normal.surfaces.every(value => value >= 3), theme.id).toBe(true);
    expect(normal.text, theme.id).toBeGreaterThanOrEqual(4.5);
    expect(normal.selected, theme.id).toBeGreaterThanOrEqual(4.5);
    expect(normal.selection, theme.id).toBeGreaterThanOrEqual(3);
    await inactive.hover();
    expect((await contrast()).text, `${theme.id} hover`).toBeGreaterThanOrEqual(4.5);
  }
  await page.locator('.theme-select').selectOption('github-light');
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('config-navigation-light.png');
});
