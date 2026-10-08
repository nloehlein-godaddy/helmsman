import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, seedBacklogLayout, sourceRoot } from './isolated-fixture';

test('source-denied Activity and PR packages preserve real source counts and truthful unavailable history through disablement and restart', async ({ page, request }) => {
  test.setTimeout(120_000);
  await seedBacklogLayout(page); const host = await fixture(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  try {
    await expect(host.script('prove-activity-isolation.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/activity/panel.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    for (const name of ['activity', 'repoprs', 'shipped']) await host.installAuthorPackage(`plugin-sources/${name}`, `example.${name}`);
    let origin = await host.start();
    const created = await request.post(`${origin}/api/todos?requestId=activity-complete-a`, { data: { repo: 'org/a', title: 'Real source completion', description: 'A real persisted local source record.' } });
    expect(created.ok()).toBe(true); const task = (await created.json()).todo;
    expect((await request.put(`${origin}/api/todos/${task.id}?requestId=activity-complete-a-state`, { data: { state: 'done' } })).ok()).toBe(true);
    const otherCreated = await request.post(`${origin}/api/todos?requestId=activity-complete-b`, { data: { repo: 'org/b', title: 'Other repository completion', description: 'Must stay outside the selected source history.' } });
    expect(otherCreated.ok()).toBe(true); const other = (await otherCreated.json()).todo;
    expect((await request.put(`${origin}/api/todos/${other.id}?requestId=activity-complete-b-state`, { data: { state: 'done' } })).ok()).toBe(true);
    const sources = (await (await request.get(`${origin}/api/task-sources?repo=org/a`)).json()).instances;
    const local = sources.find((source: { providerId: string }) => source.providerId === 'helmsman.todos/todos');
    expect(local).toMatchObject({ available: true, readViews: expect.arrayContaining(['history']) });
    const readHistory = async (revision: number) => request.get(`${origin}/api/activity-read/${local.id}?${new URLSearchParams({ repo: 'org/a', revision: String(revision), sourceId: local.sourceId })}`);
    const response = await readHistory(local.revision); expect(response.ok()).toBe(true); const snapshot = await response.json();
    expect(snapshot.history.throughputQuality).toBe('complete'); expect(snapshot.history.historyQuality).toBe('partial');
    expect(snapshot.history.days.reduce((sum: number, day: { completed: number }) => sum + day.completed, 0)).toBe(1);
    expect(snapshot.history.events.some((event: { ref: { externalId: string }; kind: string }) => event.ref.externalId === task.id && event.kind === 'completed')).toBe(true);
    expect(snapshot.history.events.every((event: { ref: { externalId: string } }) => event.ref.externalId !== other.id)).toBe(true);
    await page.goto(`${origin}/helm?repo=org/a`); await expect(page.locator('.plugin-helm')).toBeVisible();
    await page.locator('[data-helm-focus="page:edit"]').click();
    for (const name of ['activity', 'repoprs', 'shipped']) {
      await page.getByLabel('Panel to add', { exact: true }).selectOption(`example.${name}/panel`);
      await page.getByRole('button', { name: 'Add panel', exact: true }).click(); await expect(page.locator(`.plugin-${name}`)).toBeVisible();
    }
    await page.locator('[data-helm-focus="page:edit"]').click();
    const activity = page.locator('.plugin-activity'); const repoprs = page.locator('.plugin-repoprs'); const shipped = page.locator('.plugin-shipped');
    await expect(activity.locator('dd')).toHaveCount(7); await expect(activity.locator('dd').last()).toHaveText('1');
    await expect(activity.getByText(new RegExp(`${task.id} completed`))).toBeVisible(); await expect(activity.getByText(new RegExp(other.id))).toHaveCount(0);
    await expect(activity.getByText('Source event history is partial.', { exact: true })).toBeVisible();
    await expect(activity.getByText(/Pull request activity unavailable/)).toBeVisible();
    await expect(repoprs.getByText(/Pull requests are unavailable/)).toBeVisible(); await expect(shipped.getByText(/Pull requests are unavailable/)).toBeVisible();
    await expect(repoprs.getByText(/No open pull requests|No open bounties/)).toHaveCount(0); await expect(shipped.getByText(/No recent pull requests|No recent bounties/)).toHaveCount(0);
    await page.reload(); await expect(activity.locator('dd').last()).toHaveText('1');
    const disabled = await request.post(`${origin}/api/task-sources/${local.id}/enablement`, { data: { instanceRevision: local.revision, desiredEnabled: false } });
    expect(disabled.ok()).toBe(true); const disabledRevision = (await disabled.json()).instance.revision;
    await activity.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(activity.getByText('Source disabled.', { exact: true })).toBeVisible(); await expect(activity.locator('dd')).toHaveCount(0);
    await page.reload(); await expect(activity.getByText('Source disabled.', { exact: true })).toBeVisible(); await expect(activity.locator('dd')).toHaveCount(0);
    expect((await readHistory(local.revision)).status()).toBe(409);
    const enabled = await request.post(`${origin}/api/task-sources/${local.id}/enablement`, { data: { instanceRevision: disabledRevision, desiredEnabled: true } }); expect(enabled.ok()).toBe(true);
    await activity.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(activity.locator('dd').last()).toHaveText('1');
    for (const name of ['activity', 'repoprs', 'shipped']) await host.cli('disable', `example.${name}`);
    await expect(page.locator('.plugin-activity, .plugin-repoprs, .plugin-shipped')).toHaveCount(0, { timeout: 15_000 }); await page.reload();
    await expect(page.getByText('This panel is unavailable. Enable or install its plugin to bring it aboard.', { exact: true })).toHaveCount(3);
    for (const name of ['activity', 'repoprs', 'shipped']) await host.cli('enable', `example.${name}`);
    await expect(activity.locator('dd').last()).toHaveText('1', { timeout: 15_000 });
    host.env.HELMSMAN_PORT = new URL(origin).port; origin = await host.start(); await page.goto(`${origin}/helm?repo=org/a`);
    await expect(activity.locator('dd').last()).toHaveText('1'); await expect(repoprs.getByText(/Pull requests are unavailable/)).toBeVisible(); await expect(shipped.getByText(/Pull requests are unavailable/)).toBeVisible();
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
    const commands = (await readFile(host.commandLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    expect(commands.filter(command => !command.endsWith(' worktree list --porcelain') && command !== `${join(host.root, 'commands/git')} -C ${host.app}/ rev-parse HEAD`)).toEqual([]);
  } finally { await host.close(); }
});
