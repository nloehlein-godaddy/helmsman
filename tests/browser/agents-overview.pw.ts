import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import { DEFAULT_THEME_GENERATOR_SETTINGS, generateThemePalette } from '../../src/data/themeGenerator';
import { expectReadableSurfaces } from './theme-contrast';
import type { AgentPromptSettingsSaveV1, AgentPromptSettingsSnapshotV1 } from '../../src/plugins/agent-prompts';

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


async function mockOverviewPrompts(page: Page) {
  let generation = 1;
  const writes: AgentPromptSettingsSaveV1[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const reads: string[] = [];
  const definitions = [
    ['coding.implement', 'Implement a task'], ['coding.fix', 'Fix a task'], ['coding.review', 'Review an implementation'],
    ['review.pull-request', 'Review a pull request'], ['branch.author', 'Update a branch'], ['branch.audit', 'Audit a branch'],
  ] as const;
  let snapshot: AgentPromptSettingsSnapshotV1 = {
    version: 1, revision: generation.toString(16).padStart(64, '0'),
    roles: definitions.map(([id, label]) => ({ id, label, description: `Instructions to ${label.toLowerCase()}.`, providerLabel: 'Built-in workflow',
      defaultText: `Default: ${label}. Follow project instructions.`, text: `Default: ${label}. Follow project instructions.`, overridden: false })),
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/agent-prompts') {
      expect(request.headers()['x-helmsman-contribution']).toBe('helmsman.agents-overview/page');
      expect(url.search).toBe('');
      if (request.method() === 'GET') { reads.push(request.url()); return route.fulfill({ json: snapshot }); }
      if (request.method() === 'POST') {
        const input = request.postDataJSON() as AgentPromptSettingsSaveV1;
        writes.push(input);
        if (input.expectedRevision !== snapshot.revision) return route.fulfill({ status: 409, json: { reason: 'conflict' } });
        snapshot = { ...snapshot, revision: (++generation).toString(16).padStart(64, '0'), roles: snapshot.roles.map(role => role.id === input.roleId
          ? { ...role, text: input.text ?? role.defaultText, overridden: input.text !== null } : role) };
        return route.fulfill({ json: snapshot });
      }
    }
    if (request.method() !== 'GET') { unexpected.push(path); return route.abort(); }
    return route.fulfill({ json: path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.agents-overview']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: {} } : {} });
  });
  return { writes, unexpected, errors, reads, snapshot: () => snapshot, peerChange() {
    snapshot = { ...snapshot, revision: (++generation).toString(16).padStart(64, '0'), roles: snapshot.roles.map(role => role.id === 'coding.implement'
      ? { ...role, text: 'Implementation instructions changed elsewhere.', overridden: true } : role) };
  } };
}

for (const [width, mode] of [[1440, 'dark'], [390, 'dark'], [1440, 'light']] as const) test(`Agents overview edits only the highlighted role at ${width}px in ${mode}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1100 });
  if (mode === 'light') await page.addInitScript(value => localStorage.setItem('cmux.theme.custom', value), JSON.stringify({ version: 3,
    recipe: { settings: DEFAULT_THEME_GENERATOR_SETTINGS, overrides: {} }, palette: generateThemePalette(DEFAULT_THEME_GENERATOR_SETTINGS, 'light') }));
  const fixture = await mockOverviewPrompts(page);
  await page.goto('/agents-overview?repo=org%2Fa');
  const overview = page.locator('.agents-overview');
  const selected = overview.getByRole('button', { name: /Independent code review/ });
  await selected.click();
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  const launcher = overview.getByRole('region', { name: 'Selected agent role' }).getByRole('button', { name: 'Edit prompt', exact: true });
  await launcher.click();
  const dialog = page.getByRole('dialog', { name: 'Edit Independent code review prompt', exact: true });
  const panel = dialog.locator('.agent-prompts');
  const text = panel.locator('[data-text]');
  const save = panel.locator('[data-save]');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element instanceof HTMLDialogElement && element.open && element.matches(':modal'))).toBe(true);
  await expect(text).toHaveValue('Default: Review an implementation. Follow project instructions.');
  await expect(dialog.getByRole('combobox')).toHaveCount(0);
  await expect(save).toBeDisabled();
  await expect(panel).toContainText('Existing sessions keep their original prompts.');
  expect(fixture.writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expectReadableSurfaces(panel, ['[data-text]', '[data-source]', '.prompt-note', '[data-save]']);
  await page.screenshot({ path: `test-results/browser/agents-overview-prompt-${width}-${mode}.png` });

  await text.fill('Review draft retained after closing.');
  await text.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(launcher).toBeFocused();
  expect(fixture.writes).toEqual([]);
  await launcher.click();
  await expect(text).toHaveValue('Review draft retained after closing.');
  await page.mouse.click(1, 1);
  await expect(dialog).not.toBeVisible();
  await expect(launcher).toBeFocused();
  expect(fixture.writes).toEqual([]);
  await launcher.click();
  await expect(text).toHaveValue('Review draft retained after closing.');
  await save.click();
  await expect(panel.locator('[data-status]')).toContainText('Prompt saved');
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]).toMatchObject({ version: 1, roleId: 'coding.review', text: 'Review draft retained after closing.' });
  expect(fixture.snapshot().roles.filter(role => role.overridden).map(role => role.id)).toEqual(['coding.review']);
  await expect(panel.locator('[data-source]')).toHaveText('Custom prompt');
  await panel.locator('[data-restore]').click();
  expect(fixture.writes).toHaveLength(1);
  await expect(text).toHaveValue('Default: Review an implementation. Follow project instructions.');
  await save.click();
  await expect(panel.locator('[data-status]')).toContainText('Prompt saved');
  expect(fixture.writes[1]).toMatchObject({ roleId: 'coding.review', text: null });

  await text.fill('Keep the review draft across a remote change.');
  fixture.peerChange();
  const revision = fixture.snapshot().revision;
  const readCount = fixture.reads.length;
  await dialog.getByRole('button', { name: 'Refresh prompt', exact: true }).click();
  await expect.poll(() => fixture.reads.length).toBeGreaterThan(readCount);
  await expect(panel.locator('[data-conflict]')).toContainText('Saved prompts changed');
  await expect(text).toHaveValue('Keep the review draft across a remote change.');
  await expect(save).toBeDisabled();
  expect(fixture.writes).toHaveLength(2);
  await panel.locator('[data-rebase]').click();
  await expect(save).toBeEnabled();
  expect(fixture.writes).toHaveLength(2);
  await save.click();
  await expect(panel.locator('[data-status]')).toContainText('Prompt saved');
  expect(fixture.writes).toHaveLength(3);
  expect(fixture.writes[2]).toMatchObject({ roleId: 'coding.review', expectedRevision: revision, text: 'Keep the review draft across a remote change.' });
  expect(fixture.snapshot().roles.find(role => role.id === 'coding.implement')?.text).toBe('Implementation instructions changed elsewhere.');
  await dialog.getByRole('button', { name: 'Close prompt editor', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(launcher).toBeFocused();
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.repo-select')).toHaveValue('org/a');
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
