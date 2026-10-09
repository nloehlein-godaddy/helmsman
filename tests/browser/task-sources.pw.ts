import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { SourceAdminSourceV1 } from '../../src/plugins/source-admin';

const sourceSettingsManifest = JSON.parse(readFileSync(new URL('../../src/plugins/source-settings/plugin-package.json', import.meta.url), 'utf8')).manifest;

for (const touch of [false, true]) test.describe(touch ? 'touch source settings' : 'desktop source settings', () => {
  test.use({ hasTouch: touch, viewport: { width: touch ? 390 : 1440, height: touch ? 4200 : 2600 } });

  test('selected source-settings package preserves header scope, drafts and durable scheduling', async ({ page, baseURL }) => {
  const writes: { path: string; input: Record<string, unknown> }[] = [];
  let failSources = false;
  const replacement = { mode: 'refresh' as const, providerId: 'example.local-todos/todos', artifactHash: 'a'.repeat(64) };
  const sources: SourceAdminSourceV1[] = [
    { target: { sourceId: '11111111-1111-4111-8111-111111111111', instanceId: 'todos', sourceRevision: 1, instanceRevision: 1 }, label: 'Local todos', desiredEnabled: true, available: true, current: true, identityLevel: 'verified', providerId: 'example.local-todos/todos', allowedRepos: ['org/a', 'org/b'], settingsFields: { statuses: { label: 'Statuses', schema: { type: 'string-list', default: ['Ready'], maxItems: 10, maxLength: 100 } }, includeBlocked: { label: 'Include blocked tasks', schema: { type: 'boolean', default: true } } }, settings: {}, replacements: [replacement] },
    { target: { sourceId: '22222222-2222-4222-8222-222222222222', instanceId: 'jira', sourceRevision: 1, instanceRevision: 2 }, label: 'Jira', desiredEnabled: false, available: false, current: true, identityLevel: 'operator-seeded', providerId: 'example.jira/issues', allowedRepos: ['org/a', 'org/b'], settingsFields: {}, settings: {}, replacements: [] },
  ];
  const schedules = new Map(['org/a', 'org/b'].map(repo => [repo, { repo, revision: 3, instanceIds: ['todos'] }]));
  const legacy: string[] = [];
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== new URL(baseURL ?? 'http://127.0.0.1:4175').origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body: unknown = {};
    if (['/api/todos', '/api/triage', '/api/bugs', '/api/task-sources'].includes(url.pathname)) legacy.push(url.pathname);
    if (url.pathname === '/api/source-admin/commands' && request.method() === 'POST') {
      const { requestId, ...input } = request.postDataJSON(); writes.push({ path: url.pathname, input });
      const schedule = { repo: input.repo, revision: input.expectedRevision + 1, instanceIds: input.instanceIds }; schedules.set(input.repo, schedule);
      return route.fulfill({ json: { version: 1, requestId, input, status: 'succeeded', result: { kind: 'scheduled', schedule }, message: null } });
    }
    if (url.pathname === '/api/source-admin/validate') return route.fulfill({ json: { ...request.postDataJSON(), validationId: '44444444-4444-4444-8444-444444444444', instanceId: 'todos', evidenceHash: 'b'.repeat(64) } });
    if (url.pathname === '/api/plugins/catalog') body = { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: [{ id: sourceSettingsManifest.id, version: sourceSettingsManifest.version, enabled: true, hash: 'a'.repeat(64) }] };
    if (url.pathname === '/api/context') body = { repos: ['org/a', 'org/b'], jiraBaseUrl: null, jiraEnabled: false };
    if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } };
    if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
    if (url.pathname === '/api/source-admin') {
      if (failSources) return route.fulfill({ status: 503, json: { error: 'Sources temporarily unavailable' } });
      const repo = url.searchParams.get('repo'); const repos = repo ? [repo] : ['org/a', 'org/b'];
      body = { version: 1, repo, repos, sources, schedules: repos.map(repo => schedules.get(repo)), runtimes: repos.map(repo => ({ repo, epoch: '33333333-3333-4333-8333-333333333333', revision: 0, enabled: false })) };
    }
    return route.fulfill({ json: body });
  });
  await page.goto('/config?repo=org/a');
  await page.locator('.section-nav a[href="/source-settings?repo=org%2Fa"]').click();
  const panel = page.locator('[data-panel-instance=\"settings\"] .plugin-source-settings'); await panel.getByLabel('Task source', { exact: true }).selectOption('todos');
  await expect(panel.getByRole('button', { name: 'Save source settings', exact: true })).toBeEnabled();
  await expect(panel.getByLabel('Panel galleon', { exact: true })).toHaveAccessibleDescription('Uses the header selection unless you choose a different galleon here. This changes only this panel.');
  await expect(panel.getByLabel('Source enabled', { exact: true })).toHaveAccessibleDescription('Make this source available for task lists and new runs. Disabling it keeps its settings and tasks.');
  await expect(panel.getByLabel('Allowed galleons', { exact: true })).toHaveAccessibleDescription(/owner\/project/);
  await expect(panel.getByLabel('Source label', { exact: true })).toHaveAccessibleDescription(/\S/);
  await expect(panel.getByLabel('Task source', { exact: true })).toHaveAccessibleDescription(/\S/);
  await expect(panel.getByRole('button', { name: 'Save source settings', exact: true })).toHaveAccessibleDescription('Applies this draft to the source. The saved request and its result appear below.');
  await expect(panel.getByRole('button', { name: 'Save selected sources', exact: true })).toHaveAccessibleDescription('Saves this selection without starting work.');
  await expect(panel.getByRole('button', { name: 'Enable automatic starts', exact: true })).toHaveAccessibleDescription('Starts new work from the selected sources. Resets when Helmsman restarts. Turning it off keeps existing runs going.');
  await expect(panel.getByLabel('Statuses', { exact: true })).toHaveAccessibleDescription('Enter a JSON list of text values, such as ["Ready", "In progress"].');
  await expect(panel.getByLabel('Include blocked tasks', { exact: true })).toHaveJSProperty('indeterminate', true);
  await panel.getByLabel('Statuses', { exact: true }).fill('["In review"]');
  await expect(panel.getByRole('button', { name: 'Use default for Statuses', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Use default for Statuses', exact: true }).click();
  await expect(panel.getByLabel('Statuses', { exact: true })).toHaveValue('');
  await expect(panel.getByRole('button', { name: 'Use default for Statuses', exact: true })).toBeDisabled();
  await panel.getByLabel('Include blocked tasks', { exact: true }).uncheck();
  await expect(panel.getByRole('button', { name: 'Use default for Include blocked tasks', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Use default for Include blocked tasks', exact: true }).click();
  await expect(panel.getByLabel('Include blocked tasks', { exact: true })).toHaveJSProperty('indeterminate', true);


  for (const path of ['/todos', '/triage', '/bugs']) await expect(page.locator(`.page-tabs a[href="${path}?repo=org%2Fa"]`)).toBeVisible();
  await expect.poll(() => panel.evaluate(node => {
    if (!node.isConnected || node.clientWidth === 0) return [{ label: 'Panel awaiting layout', width: 0 }];
    return [...node.querySelectorAll('button')].filter(button => button.checkVisibility()).map(button => ({ label: button.getAttribute('aria-label') ?? button.textContent, width: button.getBoundingClientRect().width })).filter(button => button.width >= Math.min(350, node.clientWidth) - 8);
  })).toEqual([]);
  if (touch) {
    const heights = await panel.locator('button, summary, select, input:not([type=checkbox]), textarea').evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => node.getBoundingClientRect().height));
    expect(heights.every(height => height >= 44)).toBe(true);
  }
  await expect(panel).toHaveScreenshot(touch ? 'task-sources-mobile.png' : 'task-sources.png', { animations: 'disabled' });
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await panel.getByText('Replace source implementation', { exact: true }).click();
  await panel.getByLabel('Replacement connector', { exact: true }).selectOption(JSON.stringify(replacement));
  await panel.getByLabel('Changed by', { exact: true }).fill('test operator');
  await panel.getByLabel('Reason for replacement', { exact: true }).fill('Refresh the installed implementation');
  await panel.getByRole('button', { name: 'Check replacement', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Replace source', exact: true })).toBeEnabled();
  await expect(panel).toHaveScreenshot(touch ? 'task-sources-replacement-mobile.png' : 'task-sources-replacement.png', { animations: 'disabled' });
  await panel.getByLabel('Changed by', { exact: true }).fill('another operator');
  await expect(panel.getByRole('button', { name: 'Replace source', exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
  await panel.getByLabel('Source label', { exact: true }).fill('Draft source name');
  await panel.getByLabel('Panel galleon').selectOption(''); await panel.getByLabel('Panel galleon').selectOption('org/b');
  await expect(panel.getByRole('button', { name: 'Save selected sources' })).toBeEnabled();
  await expect(page.locator('.repo-select')).toHaveValue('org/a'); await expect(page).toHaveURL(url => url.searchParams.get('repo') === 'org/a');
  await expect(panel.getByLabel('Source label', { exact: true })).toHaveValue('Draft source name');
  await panel.getByLabel('Schedule Local todos', { exact: true }).uncheck(); await panel.getByRole('button', { name: 'Save selected sources' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ path: '/api/source-admin/commands', input: { version: 1, kind: 'schedule', repo: 'org/b', instanceIds: [], expectedRevision: 3 } });
  await expect(panel.getByRole('button', { name: 'Refresh settings' })).toBeEnabled(); failSources = true;
  await panel.getByRole('button', { name: 'Refresh settings' }).click();
  await expect(panel.getByRole('alert')).toContainText('unavailable');
  await expect(panel.getByRole('button', { name: 'Save source settings', exact: true })).toHaveCount(0);
  failSources = false;
  await panel.getByRole('button', { name: 'Refresh settings' }).click();
  await expect(panel.getByLabel('Source label', { exact: true })).toHaveValue('Draft source name');
  await expect(panel.getByRole('button', { name: 'Save source settings', exact: true })).toBeEnabled();
  expect(writes).toHaveLength(1); expect(legacy).toEqual([]);
});
});
