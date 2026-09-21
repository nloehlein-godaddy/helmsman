import { expect, test } from '@playwright/test';
import { fixture, pendingCommandCount } from './isolated-fixture';
const id = 'example.source-settings';
const headers = { 'X-Helmsman-Contribution': `${id}/panel` };

test('independent source settings resolves configuration response loss after removing the last allowed galleon', async ({ page, request }) => {
  const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK';
  try {
    await host.installAuthorPackage('plugin-sources/source-settings', id); const origin = await host.start();
    const initial = await (await request.get(`${origin}/api/source-admin?repo=org/a`, { headers })).json(); const source = initial.sources.find((value: { providerId: string }) => value.providerId.includes('todos'));
    expect(source).toBeTruthy(); await page.goto(`${origin}/plugins/${id}/page?repo=org/a`);
    await page.getByRole('combobox', { name: 'Source instance' }).selectOption(source.target.instanceId);
    await page.getByRole('textbox', { name: 'Source label', exact: true }).fill('Configured independently');
    await page.getByRole('textbox', { name: 'Allowed galleons (one owner/project per line)', exact: true }).fill('');
    const sent: unknown[] = []; await page.route('**/api/source-admin/commands', async route => { sent.push(route.request().postDataJSON()); await route.fetch(); await route.abort('failed'); });
    await page.getByRole('button', { name: 'Apply source configuration', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved request', exact: true })).toBeVisible(); await page.reload();
    const stalePeer = await page.context().newPage();
    await stalePeer.goto(`${origin}/plugins/${id}/page?repo=org/a`);
    await expect(stalePeer.getByRole('button', { name: 'Retry original settings request', exact: true })).toBeEnabled();
    let stalePosts = 0;
    stalePeer.on('request', request => { if (new URL(request.url()).pathname === '/api/source-admin/commands' && request.method() === 'POST') stalePosts++; });
    await page.getByRole('button', { name: 'Check saved request', exact: true }).click(); await page.getByRole('button', { name: 'Accept outcome and dismiss', exact: true }).click();
    await expect.poll(() => pendingCommandCount(page, 'helmsman.source-admin', `${id}/panel`)).toBe(0);
    await stalePeer.getByRole('button', { name: 'Retry original settings request', exact: true }).click();
    await expect(stalePeer.getByRole('button', { name: 'Retry original settings request', exact: true })).toHaveCount(0);
    expect(stalePosts).toBe(0);
    expect(await pendingCommandCount(page, 'helmsman.source-admin', `${id}/panel`)).toBe(0);
    await stalePeer.close();
    await expect(page.getByRole('button', { name: 'Accept outcome and dismiss', exact: true })).toHaveCount(0); expect(sent).toHaveLength(1);
    const after = await (await request.get(`${origin}/api/source-admin`, { headers })).json(); expect(after.sources.find((value: { target: { instanceId: string } }) => value.target.instanceId === source.target.instanceId)).toMatchObject({ label: 'Configured independently', allowedRepos: [], target: { instanceRevision: source.target.instanceRevision + 1 } });
    await page.getByRole('combobox', { name: 'Administration galleon' }).selectOption('');
    await expect(page.getByRole('textbox', { name: 'Source label', exact: true })).toHaveValue('Configured independently');
    await page.setViewportSize({ width: 1440, height: 1500 }); await expect(page.locator('.plugin-source-settings').first()).toHaveScreenshot('source-settings-independent.png', { mask: [page.getByRole('combobox', { name: 'Source instance' })] });
  } finally { await host.close(); }
});

test('independent settings saves automatic source selection and never reenables from a historical runtime receipt after restart', async ({ page, request }) => {
  const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK';
  try {
    await host.installAuthorPackage('plugin-sources/source-settings', id); const origin = await host.start();
    await page.goto(`${origin}/plugins/${id}/page?repo=org/a`);
    const schedule = page.getByRole('checkbox', { name: /^Schedule / }); await expect(schedule.first()).toBeVisible(); for (const checkbox of await schedule.all()) await checkbox.uncheck();
    await page.getByRole('button', { name: 'Save automatic source selection', exact: true }).click(); await page.getByRole('button', { name: 'Accept outcome and dismiss', exact: true }).click();
    await page.getByRole('button', { name: 'Enable automatic starts', exact: true }).click(); await expect(page.getByText('Current process automatic starts: enabled.', { exact: true })).toBeVisible();
    const before = await (await request.get(`${origin}/api/source-admin?repo=org/a`, { headers })).json(); expect(before.schedules[0].instanceIds).toEqual([]); expect(before.runtimes[0].enabled).toBe(true);
    await host.stop(); host.env.HELMSMAN_PORT = new URL(origin).port; expect(await host.start()).toBe(origin); await page.reload();
    await expect(page.getByText('Current process automatic starts: disabled.', { exact: true })).toBeVisible(); await expect(page.getByText(/This is a historical receipt/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enable automatic starts', exact: true })).toBeDisabled(); await page.getByRole('button', { name: 'Accept outcome and dismiss', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Enable automatic starts', exact: true })).toBeEnabled();
    const after = await (await request.get(`${origin}/api/source-admin?repo=org/a`, { headers })).json(); expect(after.runtimes[0]).toMatchObject({ enabled: false, revision: 0 }); expect(after.runtimes[0].epoch).not.toBe(before.runtimes[0].epoch);
  } finally { await host.close(); }
});

test('independent replacement UI refuses stale pinned validation after a source configuration changes', async ({ page, request }) => {
  const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK';
  try {
    await host.installAuthorPackage('plugin-sources/source-settings', id); await host.installAuthorPackage('plugin-sources/local-tasks-alternative'); const origin = await host.start();
    const initial = await (await request.get(`${origin}/api/source-admin?repo=org/a`, { headers })).json(); const source = initial.sources.find((value: { replacements: unknown[] }) => value.replacements.length);
    expect(source).toBeTruthy(); await page.goto(`${origin}/plugins/${id}/page?repo=org/a`); await page.getByRole('combobox', { name: 'Source instance' }).selectOption(source.target.instanceId);
    await page.getByRole('combobox', { name: 'Replacement candidate' }).selectOption(JSON.stringify(source.replacements[0])); await page.getByRole('textbox', { name: 'Replacement actor' }).fill('test operator'); await page.getByRole('textbox', { name: 'Replacement reason' }).fill('Independent implementation');
    await page.getByRole('button', { name: 'Validate replacement', exact: true }).click(); await expect(page.getByRole('button', { name: 'Apply validated replacement', exact: true })).toBeEnabled();
    const changed = await request.post(`${origin}/api/source-admin/commands`, { headers, data: { version: 1, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'configure', repo: 'org/a', target: source.target, changes: { label: 'Concurrent configuration', desiredEnabled: source.desiredEnabled, allowedRepos: source.allowedRepos, settings: source.settings } } }); expect(changed.ok()).toBe(true);
    await page.getByRole('button', { name: 'Apply validated replacement', exact: true }).click(); await expect(page.getByText(/^rejected:/)).toBeVisible();
    const after = await (await request.get(`${origin}/api/source-admin?repo=org/a`, { headers })).json(); expect(after.sources.find((value: { target: { instanceId: string } }) => value.target.instanceId === source.target.instanceId)).toMatchObject({ current: true, label: 'Concurrent configuration' });
    await expect(page.getByRole('textbox', { name: 'Replacement actor' })).toHaveValue('test operator'); await expect(page.getByRole('button', { name: 'Reconcile replacement draft', exact: true })).toBeVisible();
  } finally { await host.close(); }
});
