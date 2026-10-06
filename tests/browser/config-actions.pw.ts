import { expect, test } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';

for (const width of [1440, 390]) test(`Config actions distinguish saving, recovery and customization at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
  let revision = 'a'.repeat(64);
  let author = 'saved-author';
  const writes: unknown[] = [];
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      expect(path).toBe('/api/github-settings');
      const input = request.postDataJSON(); writes.push(input);
      expect(input.expectedRevision).toBe(revision);
      author = input.values.author; revision = 'c'.repeat(64);
    }
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.github-settings', 'helmsman.jira-settings']) }
      : path === '/api/context' ? { repos: ['org/a'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} }
      : path === '/api/github-settings' ? { version: 1, scope: 'global', namespace: 'helmsman.github/settings', revision, tokenSet: true, values: { defaultRepo: 'org/a', author, reviewWatchEnabled: false } }
      : path === '/api/jira-settings' ? { version: 1, scope: 'global', namespace: 'helmsman.jira/settings', revision: 'a'.repeat(64), tokenSet: true, sourceConfigured: true, bootstrapEnabled: false }
      : {};
    return route.fulfill({ json });
  });
  await page.goto('/github-settings?repo=org/a');
  const panel = page.locator('.plugin-github-settings');
  const authorInput = panel.locator('[data-setting=author]');
  await expect(authorInput).toHaveValue('saved-author');
  await expect(page.getByRole('button', { name: 'Add panel', exact: true })).toBeHidden();
  await expect(panel.locator('[data-rebase]')).toBeHidden();
  await expect(panel.locator('[data-discard]')).toBeHidden();
  await expect(panel.locator('[data-save-draft]')).toBeHidden();
  await authorInput.fill('my-author');
  await expect(panel.getByRole('button', { name: 'Discard changes', exact: true })).toBeVisible();
  if (width === 390) {
    await panel.locator('[data-discard]').scrollIntoViewIfNeeded();
    await expect(page).toHaveScreenshot(`github-actions-${width}.png`);
  } else await expect(panel).toHaveScreenshot(`github-actions-${width}.png`);
  revision = 'b'.repeat(64); author = 'peer-author';
  await panel.getByRole('button', { name: 'Refresh settings', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Keep my changes', exact: true })).toBeVisible();
  await expect(authorInput).toHaveValue('my-author');
  await panel.getByRole('button', { name: 'Keep my changes', exact: true }).click();
  expect(writes).toHaveLength(0);
  await expect(panel.locator('[data-rebase]')).toBeHidden();
  await panel.getByRole('button', { name: 'Save GitHub settings', exact: true }).click();
  await expect(panel.locator('[data-status]')).toContainText('saved');
  expect(writes).toHaveLength(1);
  await expect(panel.locator('[data-discard]')).toBeHidden();
  await page.getByRole('button', { name: 'Edit page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hide GitHub settings', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide GitHub settings', exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: 'Show GitHub settings', exact: true }).click();
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Refresh page', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Page customization', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done editing page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add panel', exact: true })).toBeHidden();
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  await page.goto('/jira-settings?repo=org/a');
  const jira = page.locator('.plugin-jira-settings');
  await expect(jira.locator('[data-token-status]')).toHaveText('API token: set.');
  await expect(jira.locator('[data-discard]')).toBeHidden();
  await jira.locator('[data-token]').fill('fake-browser-test-token');
  await expect(jira.getByRole('button', { name: 'Clear entered token', exact: true })).toBeVisible();
  await expect(jira).toHaveScreenshot(`jira-actions-${width}.png`);
  await jira.getByRole('button', { name: 'Clear entered token', exact: true }).click();
  await expect(jira.locator('[data-token]')).toBeFocused();
  await expect(jira.locator('[data-token]')).toHaveValue('');
  expect(writes).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
