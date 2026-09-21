import { expect, test } from '@playwright/test';
import { fixture } from './isolated-fixture';

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
    await page.getByRole('button', { name: 'Check request', exact: true }).click();
    await page.getByRole('button', { name: 'Apply saved result', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Apply saved result', exact: true })).toHaveCount(0);
    expect(submitted).toHaveLength(1);
    await expect(page.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Newer unsent instructions');
    await page.getByRole('button', { name: 'Refresh Todos', exact: true }).click();
    await page.getByRole('button', { name: 'Save Todo', exact: true }).click();
    await page.getByRole('button', { name: 'Apply saved result', exact: true }).click();
    await expect.poll(async () => (await (await request.get(`${origin}/api/todos?repo=org/a`)).json()).todos[0]?.description).toBe('Newer unsent instructions');
    await page.getByRole('button', { name: 'Refresh Todos', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save Todo', exact: true })).toBeEnabled();
    await page.setViewportSize({ width: 1440, height: 1600 });
    await expect(page.locator('.plugin-todos').first()).toHaveScreenshot('todos-authored-editor.png');
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
