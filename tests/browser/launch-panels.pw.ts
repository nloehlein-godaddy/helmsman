import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';

const sourceId = '11111111-1111-4111-8111-111111111111';
const builtinIds = ['helmsman.costs', 'helmsman.helm', 'helmsman.backlog', 'helmsman.newrun', 'helmsman.underway'];
function task(repo: string) { return { version: 1, ref: { sourceId, externalId: '10042' }, repo, revision: 'r1', displayKey: 'TASK-42',
  title: `Scoped work for ${repo}`, state: 'ready', priority: 2, url: null,
  requirements: { description: 'Implement the scoped task', acceptanceCriteria: [], links: [] }, providerData: { version: 1 } }; }
async function setup(page: Page) {
  await page.addInitScript(() => { if (localStorage.getItem('helmsman.rackLayout') === null) localStorage.setItem('helmsman.rackLayout', JSON.stringify([[{ panels: ['backlog'], active: 'backlog', collapsed: false }]])); });
  const commands: Record<string, unknown>[] = []; const receipts = new Map<string, unknown>();
  const state = { loseNext: false, lookupGate: null as Promise<void> | null };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()); if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body: unknown = {};
    if (url.pathname === '/api/plugins/catalog') body = { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(builtinIds) };
    if (url.pathname === '/api/context') body = { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null };
    if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } };
    if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
    if (url.pathname === '/api/task-sources') body = { instances: [{ id: 'tasks', sourceId, revision: 2, label: 'Issue source',
      desiredEnabled: true, available: true, allowedRepos: ['org/a', 'org/b'], readViews: ['underway'] }] };
    if (url.pathname === '/api/task-sources/tasks/lookup') { if (state.lookupGate) await state.lookupGate; body = { ref: { sourceId, externalId: '10042' } }; }
    if (url.pathname === '/api/task-sources/tasks/tasks') body = url.searchParams.has('externalId') ? { task: task(url.searchParams.get('repo')!) }
      : { items: [task(url.searchParams.get('repo')!)], nextCursor: null };
    if (url.pathname === '/api/run-commands') {
      const command = route.request().postDataJSON() as Record<string, unknown>; commands.push(command);
      if (state.loseNext) { state.loseNext = false; return route.abort('failed'); }
      body = { version: 1, repo: command.repo, requestId: command.requestId, action: command.action, status: 'accepted', runId: 'isolated-run', attempt: 1, message: null };
      receipts.set(String(command.requestId), body);
    } else if (url.pathname.startsWith('/api/run-commands/')) body = receipts.get(url.pathname.split('/').at(-1)!) ?? null;
    await route.fulfill({ json: body }).catch(() => {});
  });
  await page.goto('/helm?repo=org/a'); await expect(page.locator('.plugin-helm')).toBeVisible();
  await page.locator('[data-helm-focus="page:edit"]').click();
  for (const name of ['newrun', 'underway']) {
    await page.getByLabel('Panel to add', { exact: true }).selectOption(`helmsman.${name}/panel`);
    await page.getByRole('button', { name: 'Add panel', exact: true }).click(); await expect(page.locator(`.plugin-${name}`)).toBeVisible();
  }
  await page.locator('[data-helm-focus="page:edit"]').click();
  return { commands, state, newrun: page.locator('.plugin-newrun'), underway: page.locator('.plugin-underway') };
}

test('authored launch panels retain scoped drafts and request identity through reload and explicit acknowledgment', async ({ page }) => {
  const f = await setup(page);
  await f.newrun.getByLabel('Task instructions', { exact: true }).fill('Draft for galleon A');
  await f.newrun.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.locator('.repo-select').selectOption('org/b');
  await f.newrun.getByLabel('Task instructions', { exact: true }).fill('Draft for galleon B');
  await f.newrun.getByRole('button', { name: 'Save draft', exact: true }).click(); await page.reload();
  await expect(f.newrun.getByLabel('Task instructions', { exact: true })).toHaveValue('Draft for galleon B');
  await page.locator('.repo-select').selectOption('org/a');
  await expect(f.newrun.getByLabel('Task instructions', { exact: true })).toHaveValue('Draft for galleon A');
  await f.newrun.getByLabel('Launch mode', { exact: true }).selectOption('source');
  await f.newrun.getByLabel('Task source', { exact: true }).selectOption({ label: 'Issue source' });
  await f.newrun.getByLabel('Task key', { exact: true }).fill('OLD-42');
  await f.newrun.getByRole('button', { name: 'Find task', exact: true }).click();
  await expect(f.newrun.getByLabel('Task', { exact: true })).toHaveValue(JSON.stringify([sourceId, '10042']));
  await expect(f.newrun).toHaveScreenshot('source-launch-form.png', { animations: 'disabled' });
  await expect(f.underway.getByText('Scoped work for org/a', { exact: true })).toBeVisible();
  await expect(f.underway.getByText('TASK-42', { exact: true })).toBeVisible();
  await expect(f.underway).toHaveScreenshot('underway-source-tasks.png', { animations: 'disabled' });
  await f.newrun.getByText('Model and effort', { exact: true }).click();
  await f.newrun.getByLabel('Model (optional)', { exact: true }).fill('gpt-6-astra');
  await f.newrun.getByLabel('Effort', { exact: true }).selectOption('high');
  f.state.loseNext = true; await f.newrun.getByRole('button', { name: 'Weigh anchor', exact: true }).click();
  await expect(f.newrun.getByText('org/a · source · delivery unconfirmed', { exact: true })).toBeVisible();
  const first = f.commands[0]!; expect(first).toMatchObject({ repo: 'org/a', launch: { mode: 'source', workRef: { sourceId, externalId: '10042' }, sourceInstanceId: 'tasks', sourceInstanceRevision: 2, model: 'gpt-6-astra', effort: 'high' } });
  await page.reload(); await expect(f.newrun.getByRole('button', { name: 'Retry delivery', exact: true })).toBeVisible();
  await f.newrun.getByRole('button', { name: 'Check request', exact: true }).click();
  await expect(f.newrun.getByText(/No recorded receipt is available/)).toBeVisible();
  await f.newrun.getByRole('button', { name: 'Retry delivery', exact: true }).click();
  await expect(f.newrun.getByRole('link', { name: 'Open voyage', exact: true })).toHaveAttribute('href', '/runs?repo=org%2Fa&run=isolated-run');
  expect(f.commands).toHaveLength(2); expect(f.commands[1]).toEqual(first);
  await page.reload(); await expect(f.newrun.getByRole('button', { name: 'Dismiss request', exact: true })).toBeVisible();
  await f.newrun.getByRole('button', { name: 'Dismiss request', exact: true }).click();
  await expect(f.newrun.getByRole('heading', { name: 'Saved launch requests', exact: true })).toHaveCount(0);
  await page.reload(); await expect(f.newrun.getByRole('heading', { name: 'Saved launch requests', exact: true })).toHaveCount(0);
  await expect(f.newrun.getByLabel('Task key', { exact: true })).toHaveValue('OLD-42');
  await f.underway.getByRole('button', { name: 'Launch', exact: true }).click();
  await expect(f.underway.getByText('Launch accepted.', { exact: true })).toBeVisible();
  expect(f.commands.at(-1)).toMatchObject({ repo: 'org/a', launch: { mode: 'source', workRef: { sourceId, externalId: '10042' } } });
});

test('draft storage failure preserves text and blocks mutation until saving recovers', async ({ page }) => {
  const f = await setup(page);
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    const state = window as Window & { failDraftWrites?: boolean }; state.failDraftWrites = true;
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
      if (state.failDraftWrites && this.name === 'helmsman.composition-layouts' && args[1] === 'readwrite') throw new DOMException('Storage unavailable', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await f.newrun.getByLabel('Task instructions', { exact: true }).fill('Keep this unsaved task');
  await expect(f.newrun.getByText(/Draft could not be saved/)).toBeVisible();
  await f.newrun.getByRole('button', { name: 'Weigh anchor', exact: true }).click();
  await expect(f.newrun.getByLabel('Task instructions', { exact: true })).toHaveValue('Keep this unsaved task'); expect(f.commands).toEqual([]);
  await page.evaluate(() => { (window as Window & { failDraftWrites?: boolean }).failDraftWrites = false; });
  await f.newrun.getByRole('button', { name: 'Save draft', exact: true }).click(); await expect(f.newrun.getByText(/Draft could not be saved/)).toHaveCount(0);
  await page.reload(); await expect(f.newrun.getByLabel('Task instructions', { exact: true })).toHaveValue('Keep this unsaved task');
});

test('scope cancellation fences a late typed lookup and preserves its original galleon draft', async ({ page }) => {
  const f = await setup(page); let release!: () => void;
  f.state.lookupGate = new Promise<void>(resolve => { release = resolve; });
  await f.newrun.getByLabel('Launch mode', { exact: true }).selectOption('source');
  await f.newrun.getByLabel('Task source', { exact: true }).selectOption({ label: 'Issue source' });
  await f.newrun.getByLabel('Task key', { exact: true }).fill('OLD-42');
  const lookup = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/lookup'));
  await f.newrun.getByRole('button', { name: 'Find task', exact: true }).click(); await lookup;
  await page.locator('.repo-select').selectOption('org/b'); release();
  await expect(f.newrun.getByLabel('Launch mode', { exact: true })).toHaveValue('freeform');
  await expect(f.newrun.getByText('Galleon: org/b', { exact: true })).toBeVisible();
  await expect(f.newrun.getByText('TASK-42: Scoped work for org/a', { exact: true })).toHaveCount(0); expect(f.commands).toEqual([]);
  await page.locator('.repo-select').selectOption('org/a');
  await expect(f.newrun.getByLabel('Task key', { exact: true })).toHaveValue('OLD-42');
  await expect(f.newrun.getByLabel('Task', { exact: true })).toHaveValue('');
});
