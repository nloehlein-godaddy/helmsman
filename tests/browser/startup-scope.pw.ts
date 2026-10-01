import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) test(`startup requires and remembers a scope at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
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
  expect(requests.every(path => ['/api/plugins/catalog', '/api/context'].includes(path))).toBe(true);
  await expect(page.locator('[name="startupRepo"]')).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`startup-scope-${width}.png`) });
  await page.locator('[name="startupRepo"]').selectOption('org/b'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.repo-select')).toHaveValue('org/b');
  await page.goto('/config'); await expect(page.locator('.repo-select')).toHaveValue('org/b'); await expect(page.locator('.startup-scope')).toHaveCount(0);
  await page.locator('.repo-select').selectOption(''); await page.goto('/config'); await expect(page.locator('.repo-select')).toHaveValue('');
  await expect(page.locator('.startup-scope')).toHaveCount(0);
});
