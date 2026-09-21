import { expect, test } from '@playwright/test';
import { fixture, pendingCommandCount } from './isolated-fixture';

test('independent Todo package preserves drafts and one durable create through response loss and reload', async ({ page, request }) => {
  const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER'; const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await host.installAuthorPackage('plugin-sources/todos-ui', 'example.todos-view');
    const origin = await host.start();
    await page.goto(`${origin}/plugins/example.todos-view/page?repo=org/a`);
    await page.getByRole('button', { name: 'New Todo', exact: true }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Independent durable Todo');
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Original submitted instructions');
    const submitted: unknown[] = [];
    await page.route('**/api/source-commands', async route => {
      submitted.push(route.request().postDataJSON());
      const result = await route.fetch(); expect(result.ok()).toBe(true); await route.abort('failed');
    }, { times: 1 });
    await page.getByRole('button', { name: 'Create Todo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check request', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Newer unsent instructions');
    await page.getByRole('button', { name: 'Save drafts', exact: true }).click();
    await expect.poll(async () => (await (await request.get(`${origin}/api/todos?repo=org/a`)).json()).todos.length).toBe(1);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Newer unsent instructions');
    const stalePeer = await page.context().newPage();
    await stalePeer.goto(`${origin}/plugins/example.todos-view/page?repo=org/a`);
    await expect(stalePeer.getByRole('button', { name: 'Retry delivery', exact: true })).toBeEnabled();
    let stalePosts = 0;
    stalePeer.on('request', request => { if (new URL(request.url()).pathname === '/api/source-commands' && request.method() === 'POST') stalePosts++; });
    await page.getByRole('button', { name: 'Check request', exact: true }).click();
    await page.getByRole('button', { name: 'Apply saved result', exact: true }).click();
    await expect.poll(() => pendingCommandCount(page, 'helmsman.source-commands', 'example.todos-view/panel')).toBe(0);
    await stalePeer.getByRole('button', { name: 'Retry delivery', exact: true }).click();
    await expect(stalePeer.getByRole('button', { name: 'Retry delivery', exact: true })).toHaveCount(0);
    expect(stalePosts).toBe(0);
    expect(await pendingCommandCount(page, 'helmsman.source-commands', 'example.todos-view/panel')).toBe(0);
    expect((await (await request.get(`${origin}/api/todos?repo=org/a`)).json()).todos).toHaveLength(1);
    await stalePeer.close();
    await expect(page.getByRole('button', { name: 'Apply saved result', exact: true })).toHaveCount(0);
    expect(submitted).toHaveLength(1);
    await expect(page.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Newer unsent instructions');
    await page.getByRole('button', { name: 'Refresh Todos', exact: true }).click();
    await page.getByRole('button', { name: 'Save Todo', exact: true }).click();
    await page.getByRole('button', { name: 'Apply saved result', exact: true }).click();
    await expect.poll(async () => (await (await request.get(`${origin}/api/todos?repo=org/a`)).json()).todos[0]?.description).toBe('Newer unsent instructions');
    await page.getByRole('button', { name: 'Refresh Todos', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save Todo', exact: true })).toBeEnabled();
    await page.setViewportSize({ width: 1440, height: 2000 });
    await expect(page.locator('.plugin-todos').first()).toHaveScreenshot('todos-authored-editor.png', { mask: [page.locator('.plugin-source-settings .admin-toggle')] });
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Keep this draft through source configuration');
    const sources = await (await request.get(`${origin}/api/task-sources?repo=org/a`)).json();
    const source = sources.instances.find((value: { providerId: string }) => value.providerId === 'helmsman.todos/todos'); expect(source).toBeTruthy();
    const configured = await request.post(`${origin}/api/task-sources/${source.id}/configuration`, { data: { instanceRevision: source.revision, label: 'Configured source', desiredEnabled: source.desiredEnabled, allowedRepos: source.allowedRepos, settings: source.settings } }); expect(configured.ok()).toBe(true);
    await page.getByRole('button', { name: 'Refresh Todos', exact: true }).click(); await expect(page.getByRole('button', { name: 'Save Todo', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Reconcile with current revision', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Keep this draft through source configuration');
    await page.getByRole('button', { name: 'Save Todo', exact: true }).click(); await page.getByRole('button', { name: 'Apply saved result', exact: true }).click();
    await expect.poll(async () => (await (await request.get(`${origin}/api/todos?repo=org/a`)).json()).todos[0]?.description).toBe('Keep this draft through source configuration');
    expect(errors).toEqual([]);
  } finally { await host.close(); }
});

test('independent Todo editor moves a source-qualified task and deletes only after explicit confirmation', async ({ page, request }) => {
  const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  try {
    await host.installAuthorPackage('plugin-sources/todos-ui', 'example.todos-view'); const origin = await host.start();
    const created = await request.post(`${origin}/api/todos?requestId=authored-move`, { data: { repo: 'org/a', title: 'Move this Todo', description: 'Keep its canonical task identity.' } });
    expect(created.ok()).toBe(true); const original = (await created.json()).todo;
    await page.goto(`${origin}/plugins/example.todos-view/page?repo=org/a`);
    await page.getByRole('button', { name: /^Move this Todo/ }).click();
    await page.getByRole('combobox', { name: 'Destination galleon', exact: true }).selectOption('org/b');
    await page.getByRole('button', { name: 'Save Todo', exact: true }).click();
    await page.getByRole('button', { name: 'Apply saved result', exact: true }).click();
    await expect.poll(async () => (await (await request.get(`${origin}/api/todos?repo=org/b`)).json()).todos[0]?.id).toBe(original.id);
    await expect(page).toHaveURL(/repo=org%2Fa|repo=org\/a/);
    await page.getByRole('button', { name: 'Use org/b for this panel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Delete Todo', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Delete Todo', exact: true }).click();
    expect((await (await request.get(`${origin}/api/todos?repo=org/b`)).json()).todos).toHaveLength(1);
    await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
    await page.getByRole('button', { name: 'Apply saved result', exact: true }).click();
    await expect.poll(async () => (await (await request.get(`${origin}/api/todos?repo=org/b`)).json()).todos.length).toBe(0);
  } finally { await host.close(); }
});

test('older Todo recovery retains the original request after response loss and never reissues an unresolved mutation', async ({ page, request }) => {
  const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  const confirmedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const unknownId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const input = { repo: 'org/a', title: 'Original compatibility request', description: 'Confirmed through its original receipt.' };
  const originalKey = JSON.stringify(['/api/todos', 'POST', input]);
  const unknownKey = JSON.stringify(['/api/todos', 'POST', { ...input, title: 'Unrecorded compatibility request' }]);
  const writes: string[] = [];
  page.on('request', value => { if (value.method() === 'POST' && new URL(value.url()).pathname.match(/^\/api\/(todos|source-commands)$/)) writes.push(value.url()); });
  try {
    await host.installAuthorPackage('plugin-sources/todos-ui', 'example.todos-view'); const origin = await host.start();
    await page.goto(`${origin}/plugins/example.todos-view/page?repo=org/a`);
    await page.evaluate(({ originalKey, unknownKey, confirmedId, unknownId }) => {
      sessionStorage.setItem('helmsman.todos.pending-mutations.v1', JSON.stringify([[originalKey, confirmedId], [unknownKey, unknownId]]));
    }, { originalKey, unknownKey, confirmedId, unknownId });
    await page.route(`**/api/todos?requestId=${confirmedId}`, async route => { const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort('failed'); }, { times: 1 });
    await page.evaluate(async ({ input, confirmedId }) => {
      try { await fetch(`/api/todos?requestId=${confirmedId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); } catch { }
    }, { input, confirmedId });
    await page.getByRole('button', { name: 'Refresh Todos', exact: true }).click();
    await page.getByRole('button', { name: 'Use All galleons to inspect older requests', exact: true }).click();
    const confirmed = page.locator('.todo-request').filter({ hasText: confirmedId }); const unresolved = page.locator('.todo-request').filter({ hasText: unknownId });
    await confirmed.getByRole('button', { name: 'Check original request', exact: true }).click();
    await expect(confirmed).toContainText('succeeded');
    await unresolved.getByRole('button', { name: 'Check original request', exact: true }).click();
    await expect(unresolved).toContainText('unrecorded');
    await expect(unresolved.getByRole('button', { name: 'Dismiss confirmed older request', exact: true })).toHaveCount(0);
    await confirmed.getByRole('button', { name: 'Dismiss confirmed older request', exact: true }).click();
    await expect(confirmed).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('helmsman.todos.pending-mutations.v1') ?? '[]'))).toEqual([[unknownKey, unknownId]]);
    await page.reload(); await unresolved.getByRole('button', { name: 'Check original request', exact: true }).click(); await expect(unresolved).toContainText('unrecorded');
    expect(writes).toEqual([`${origin}/api/todos?requestId=${confirmedId}`]);
    expect((await (await request.get(`${origin}/api/todos?repo=org/a`)).json()).todos).toHaveLength(1);
  } finally { await host.close(); }
});

test('All-source Todos preserve source-qualified search and persisted launch readiness', async ({ page, request }) => {
  const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  try {
    await host.installAuthorPackage('plugin-sources/todos-ui', 'example.todos-view'); const origin = await host.start();
    for (const [repo, title, priority, description] of [['org/a', 'Undescribed draft', 'P2', ''], ['org/b', 'Urgent other-galleon task', 'P1', 'Distinct acceptance phrase']]) {
      const response = await request.post(`${origin}/api/todos?requestId=${title!.replaceAll(' ', '-')}`, { data: { repo, title, priority, description } }); expect(response.ok()).toBe(true);
    }
    await page.goto(`${origin}/plugins/example.todos-view/page`);
    await expect(page.locator('.todo-row')).toHaveCount(2);
    await expect(page.locator('.todo-row').first()).toContainText('Urgent other-galleon task');
    await page.getByRole('searchbox', { name: 'Search Todos', exact: true }).fill('Distinct acceptance phrase');
    await expect(page.locator('.todo-row')).toHaveCount(1); await expect(page.locator('.todo-row')).toContainText('org/b');
    await page.getByRole('searchbox', { name: 'Search Todos', exact: true }).fill(''); await expect(page.locator('.todo-row')).toHaveCount(2);
    await page.getByRole('button', { name: /^Undescribed draft/ }).click();
    await expect(page.getByRole('button', { name: 'Weigh anchor', exact: true })).toBeDisabled();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('An unsaved description');
    await expect(page.getByRole('button', { name: 'Weigh anchor', exact: true })).toBeDisabled();
    await expect(page.locator('.todo-editor')).toContainText('Save your changes before starting a run.');
  } finally { await host.close(); }
});


test('builtin Todo pane links retain one draft, reveal its hidden editor and include Automatic starts', async ({ page }) => {
  const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK';
  try {
    const origin = await host.start(); await page.goto(`${origin}/todos?repo=org/a&pane=new`);
    await expect(page.locator('[data-plugin-page="helmsman.todos-ui/page"]')).toBeVisible(); await expect(page.getByRole('heading', { name: 'Automatic starts', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Retained pane-link draft'); await page.getByRole('button', { name: 'Save drafts', exact: true }).click();
    await page.reload(); await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Retained pane-link draft'); await expect(page.getByRole('combobox', { name: 'Saved draft' }).locator('option')).toHaveCount(2);
    await page.getByRole('button', { name: 'Hide Todo editor', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toBeHidden();
    await page.goto(`${origin}/todos?repo=org/a&pane=list`); await expect(page.getByRole('searchbox', { name: 'Search Todos', exact: true })).toBeFocused(); await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Retained pane-link draft');
    await page.goto(`${origin}/todos?repo=org/a&pane=new&panel=missing`); await expect(page.getByText(/requested panel \(missing\)/)).toBeVisible(); await expect(page.getByRole('combobox', { name: 'Saved draft' }).locator('option')).toHaveCount(2);
    await page.goto(`${origin}/source-settings?repo=org/a`); await expect(page.locator('[data-plugin-page="helmsman.source-settings/page"]')).toBeVisible(); await expect(page.getByRole('combobox', { name: 'Source instance' })).toBeVisible();
    await page.goto(`${origin}/todos?repo=org/a&pane=new`); await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Retained pane-link draft'); await expect(page.getByRole('combobox', { name: 'Saved draft' }).locator('option')).toHaveCount(2);
  } finally { await host.close(); }
});

test('selected Todo page replacement retains its saved layout and draft through disablement and default selection', async ({ page }) => {
  test.setTimeout(90_000); const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK';
  try {
    await host.installAuthorPackage('plugin-sources/todos-ui', 'example.todos-view'); await host.cli('select', 'helmsman/todos-page', 'example.todos-view/page'); const origin = await host.start();
    await page.goto(`${origin}/todos?repo=org/a`); await expect(page.locator('[data-plugin-page="example.todos-view/page"]')).toBeVisible(); await page.getByRole('button', { name: 'New Todo', exact: true }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Draft owned by installed implementation'); await page.getByRole('button', { name: 'Save drafts', exact: true }).click(); await page.reload(); await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Draft owned by installed implementation');
    await host.cli('disable', 'example.todos-view'); await expect(page.locator('[data-plugin-page="example.todos-view/page"]')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-plugin-page="helmsman.todos-ui/page"]')).toHaveCount(0);
    await expect(page.getByText('This page is unavailable. Choose another view or restore its plugin.', { exact: true })).toBeVisible();
    await host.cli('enable', 'example.todos-view'); await expect(page.locator('[data-plugin-page="example.todos-view/page"]')).toBeVisible({ timeout: 15_000 }); await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Draft owned by installed implementation');
    await host.cli('select', 'helmsman/todos-page', 'default'); await expect(page.locator('[data-plugin-page="helmsman.todos-ui/page"]')).toBeVisible({ timeout: 15_000 }); await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Draft owned by installed implementation');
    await expect(page.getByRole('combobox', { name: 'Saved draft' }).locator('option')).toHaveCount(2); await expect(page.getByRole('heading', { name: 'Automatic starts', exact: true })).toBeVisible();
  } finally { await host.close(); }
});
