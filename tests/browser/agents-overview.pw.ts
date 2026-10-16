import { expect, test } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { DEFAULT_THEME_GENERATOR_SETTINGS, generateThemePalette } from '../../src/data/themeGenerator';
import { expectReadableSurfaces } from './theme-contrast';

for (const [width, mode] of [[1440, 'dark'], [390, 'dark'], [1440, 'light']] as const) test(`Agents overview hierarchy and navigation at ${width}px in ${mode}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
  if (mode === 'light') await page.addInitScript(value => localStorage.setItem('cmux.theme.custom', value), JSON.stringify({ version: 3,
    recipe: { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {} }, palette: generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'light') }));
  const writes: string[] = [];
  await page.route('**/api/**', route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push(path);
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.agents-overview']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} } : {};
    return route.fulfill({ json });
  });
  await page.goto('/config?repo=org%2Fa');
  await page.locator('.section-nav').getByRole('link', { name: 'Agents overview', exact: true }).click();
  await expect(page).toHaveURL(/\/agents-overview\?repo=org%2Fa/);
  const overview = page.locator('.agents-overview');
  await expect(overview.getByRole('heading', { name: 'Agents overview', exact: true })).toBeVisible();
  await expect(page.locator('.page-tab.is-active')).toHaveAttribute('data-view', 'config');
  await expect(overview.getByRole('list', { name: 'Agent hierarchy' })).toContainText('Helmsman · coordinator');
  await expect(overview.getByRole('region', { name: 'Selected agent role' })).toContainText('does not push or open the pull request');
  await expect(overview.locator('.overview-specialists')).toContainText('cannot edit, publish, delegate further');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectReadableSurfaces(overview, ['.overview-layers p', '.overview-role small', '.overview-role-detail p', '.overview-role-detail dd', '.overview-flow-picker button[aria-pressed=true]']);
  await page.screenshot({ path: `test-results/browser/agents-overview-${width}-${mode}.png` });

  const reviewer = overview.getByRole('button', { name: /Independent code review/ });
  await reviewer.focus(); await reviewer.press('Enter');
  await expect(reviewer).toHaveAttribute('aria-pressed', 'true'); await expect(reviewer).toBeFocused();
  await expect(overview.getByRole('region', { name: 'Selected agent role' })).toContainText('incomplete review stops the workflow');
  await overview.getByRole('button', { name: 'Update a PR', exact: true }).click();
  await overview.getByRole('button', { name: /Feedback auditor/ }).click();
  await expect(overview.getByRole('region', { name: 'Selected agent role' })).toContainText('Completed, remaining, or awaiting-decision');
  await overview.getByRole('button', { name: 'Review a PR', exact: true }).click();
  await expect(overview.getByRole('region', { name: 'Selected agent role' })).toContainText('publishes the report as a comment review');
  await expect(overview.locator('.overview-specialists li')).toHaveCount(4);
  await page.screenshot({ path: `test-results/browser/agents-overview-review-${width}-${mode}.png` });
  await expect(overview).toContainText('Whiteboard explainer'); await expect(overview).toContainText('Postmortem investigator');
  await page.locator('.repo-select').selectOption('org/b');
  await expect(overview.getByRole('link', { name: 'Edit agent prompts' })).toHaveAttribute('href', '/agent-prompts?repo=org%2Fb');
  await expect(overview.getByRole('button', { name: 'Review a PR', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.repo-select')).toHaveValue('org/b');
  expect(writes).toEqual([]);
});
