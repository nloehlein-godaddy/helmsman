import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) test(`clears scoped notification history with retry and new arrivals at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const when = '2026-09-20T12:00:00Z';
  const notification = (sequence: number, repo: string, title: string) => ({ sequence, item: { kind: 'voyage-completed', id: `voyage-${sequence}`, repo, title, prNumber: null,
    prUrl: '', sourceUrl: `/runs?run=run-${sequence}`, author: 'Helmsman', channelName: 'Helmsman voyages', status: 'succeeded',
    runId: `run-${sequence}`, createdAt: when, updatedAt: when, readAt: null, error: null } });
  let rows = [notification(1, 'org/a', 'Finished old task'), notification(2, 'org/b', 'Other galleon task')];
  let sequence = 2; const commands: { repo: string | null; clearToken: string; scopeRepo: string | null }[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body: unknown = {};
    if (url.pathname === '/api/plugins/catalog') body = { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: [{ id: 'helmsman.communication', version: '0.2.0', hash: 'a'.repeat(64), enabled: true }] };
    else if (url.pathname === '/api/context') body = { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null };
    else if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: {} };
    else if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
    else if (url.pathname === '/api/communication/notifications') {
      const repo = url.searchParams.get('repo'); const notifications = rows.filter(row => repo === null || row.item.repo === repo).map(row => row.item);
      body = { version: 1, quality: 'complete', clearToken: `${sequence}:cutoff`, unread: notifications.length,
        health: { enabled: false, status: 'disabled', channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: null }, githubHealth: null, notifications };
    } else if (url.pathname === '/api/communication/notifications/clear') {
      const command = route.request().postDataJSON(); commands.push(command);
      if (commands.length === 1) { rows.push(notification(++sequence, 'org/a', 'Arrived after capture')); return route.fulfill({ status: 503, json: { reason: 'service-unavailable' } }); }
      const cutoff = Number(command.clearToken.split(':')[0]); const before = rows.length;
      rows = rows.filter(row => row.sequence > cutoff || command.repo !== null && row.item.repo !== command.repo);
      body = { version: 1, repo: command.repo, clearToken: command.clearToken, cleared: before - rows.length };
    } else return route.fulfill({ status: 503, json: { reason: 'service-unavailable' } });
    return route.fulfill({ json: body });
  });
  await page.goto('/config?repo=org/a');
  await page.getByRole('button', { name: 'Notifications, 1 unread', exact: true }).click();
  const popover = page.locator('.slack-popover');
  await expect(popover.getByText('Finished old task', { exact: true })).toBeVisible();
  await popover.getByRole('button', { name: 'Clear all notifications', exact: true }).click();
  await expect(popover.getByRole('alert')).toHaveText('Could not clear notifications. Try again.');
  await expect(popover.getByText('Arrived after capture', { exact: true })).toBeVisible();
  await popover.getByRole('button', { name: 'Retry clear all notifications', exact: true }).click();
  await expect(popover.getByText('Finished old task', { exact: true })).toHaveCount(0);
  await expect(popover.getByText('Arrived after capture', { exact: true })).toBeVisible();
  expect(commands.slice(0, 2)).toEqual([{ version: 1, repo: 'org/a', clearToken: '2:cutoff', scopeRepo: 'org/a' }, { version: 1, repo: 'org/a', clearToken: '2:cutoff', scopeRepo: 'org/a' }]);
  const box = await popover.boundingBox(); expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  await popover.screenshot({ path: testInfo.outputPath(`notifications-${width}.png`) });
  await popover.getByRole('button', { name: 'Clear all notifications', exact: true }).click();
  await expect(popover).toContainText('No notifications yet');
  await expect(popover.getByRole('button', { name: 'Clear all notifications', exact: true })).toBeDisabled();
  await page.reload(); await page.getByRole('button', { name: 'Notifications, 0 unread', exact: true }).click();
  await expect(popover).toContainText('No notifications yet');
  await page.locator('.repo-select').selectOption('org/b');
  await expect(page.getByRole('button', { name: 'Notifications, 1 unread', exact: true })).toBeVisible();
  if (!await popover.isVisible()) await page.getByRole('button', { name: 'Notifications, 1 unread', exact: true }).click();
  await expect(popover.getByText('Other galleon task', { exact: true })).toBeVisible(); expect(errors).toEqual([]);
});
