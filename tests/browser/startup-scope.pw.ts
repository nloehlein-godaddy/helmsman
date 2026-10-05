import { expect, test } from '@playwright/test';

for (const theme of ['field-guide', 'github-light', 'quarterdeck']) for (const width of [1440, 390]) test(`startup requires and remembers a scope in ${theme} at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  if (theme !== 'field-guide') await page.addInitScript(value => localStorage.setItem('cmux.theme', value), theme);
  const requests: string[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname; requests.push(path);
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: [] }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} } : null;
    return route.fulfill(json ? { json } : { status: 404 });
  });
  await page.goto('/config'); await expect(page.locator('#boot')).toHaveCount(0);
  await expect(page.locator('.startup-scope')).toBeVisible();
  const contrast = await page.locator('.startup-scope').evaluate(panel => {
    const luminance = (color: string): number => {
      const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(channel => {
        const value = Number(channel) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      if (channels?.length !== 3) throw new Error(`Unsupported color: ${color}`);
      return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
    };
    const styles = getComputedStyle(panel);
    const values = [luminance(styles.color), luminance(styles.backgroundColor)];
    return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  expect(requests.every(path => ['/api/plugins/catalog', '/api/context'].includes(path))).toBe(true);
  await expect(page.locator('[name="startupRepo"]')).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page).toHaveScreenshot(`startup-scope-${theme}-${width}.png`);
  await page.locator('[name="startupRepo"]').selectOption('org/b'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.repo-select')).toHaveValue('org/b');
  await page.goto('/config'); await expect(page.locator('.repo-select')).toHaveValue('org/b'); await expect(page.locator('.startup-scope')).toHaveCount(0);
  await page.locator('.repo-select').selectOption(''); await page.goto('/config'); await expect(page.locator('.repo-select')).toHaveValue('');
  await expect(page.locator('.startup-scope')).toHaveCount(0);
});
