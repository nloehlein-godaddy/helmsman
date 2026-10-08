import { expect, test, type Route } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';

test('run panels retain exact-attempt requests across reload and keep worker, review, and settlement outcomes distinct', async ({ page, browser }) => {
  await page.clock.setFixedTime(new Date('2026-09-20T12:30:00.000Z'));
  const enabled = new Set(['helmsman.costs', 'helmsman.helm', 'helmsman.backlog', 'helmsman.running', 'helmsman.recent']);
  const commands: { requestId: string; repo: string; action: string; target: { runId: string; expectedAttempt: number } }[] = [];
  const receipts = new Map<string, unknown>();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const base = { version: 1, repo: 'org/a', attempt: 3, startedAt: '2026-09-20T12:00:00.000Z', endedAt: null, prNumber: null, costUsd: null, review: null, sourceSettlement: null };
  const reviewId = `created-${'abc123de'.repeat(8)}`;
  const rows = [{ ...base, id: 'active-run', displayKey: 'TASK-41', status: 'running' },
    { ...base, id: 'failed-run', displayKey: 'TASK-40', status: 'failed', endedAt: '2026-09-20T12:15:00.000Z', costUsd: 1.25, sourceSettlement: { state: 'pending' } },
    { ...base, id: reviewId, displayKey: 'Review', status: 'succeeded', prNumber: 7, endedAt: '2026-09-20T12:10:00.000Z', review: { outcome: 'REQUEST_CHANGES', verdict: 'Verdict: Request changes — Hidden-only preview content can pass the new reuse health gate. Add a regression test before merging.' }, sourceSettlement: { state: 'operator-required' } }];
  const routeHandler = async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body: unknown = {};
    if (url.pathname === '/api/plugins/catalog') body = { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog([...enabled]) };
    if (url.pathname === '/api/context') body = { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null };
    if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } };
    if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
    if (url.pathname === '/api/task-sources') body = { instances: [] };
    if (url.pathname === '/api/run-read') body = { version: 1, repo: url.searchParams.get('repo'), items: rows.filter(row => row.repo === url.searchParams.get('repo') && (url.searchParams.get('kind') === 'running' ? row.status === 'running' : row.status !== 'running')), nextCursor: null };
    if (url.pathname === '/api/run-commands') {
      const command = route.request().postDataJSON(); commands.push(command);
      body = { version: 1, requestId: command.requestId, repo: command.repo, action: command.action,
        status: command.action === 'stop' ? 'accepted' : 'pending', runId: command.action === 'stop' ? command.target.runId : 'new-run', attempt: command.action === 'stop' ? command.target.expectedAttempt : 1, message: null };
      receipts.set(command.requestId, { ...body as object, status: 'accepted' });
    }
    if (url.pathname.startsWith('/api/run-commands/')) body = receipts.get(url.pathname.split('/').at(-1)!) ?? null;
    return route.fulfill({ json: body });
  };
  await page.route('**/*', routeHandler);
  await page.goto('/helm?repo=org/a'); await expect(page.locator('.plugin-helm')).toBeVisible();
  await page.locator('[data-helm-focus="page:edit"]').click();
  for (const name of ['running', 'recent']) {
    if (await page.locator(`.plugin-${name}`).count() === 0) {
      await page.getByLabel('Panel to add', { exact: true }).selectOption(`helmsman.${name}/panel`);
      await page.getByRole('button', { name: 'Add panel', exact: true }).click();
    }
    await expect(page.locator(`.plugin-${name}`)).toBeVisible();
  }
  await page.locator('[data-helm-focus="page:edit"]').click();
  const active = page.locator('.plugin-running'); const recent = page.locator('.plugin-recent');
  await expect(active.getByText('TASK-41', { exact: true })).toBeVisible();
  await expect(recent.getByRole('button', { name: 'Worker: succeeded', exact: true })).toBeVisible();
  await expect(recent.locator(`[data-run-id="${reviewId}"]`).getByRole('button', { name: /^Retry / })).toHaveCount(0);
  const phosphor = recent.locator('.run-phosphor').first();
  await expect(phosphor).toBeVisible();
  expect(await phosphor.evaluate(async el => {
    const face = await document.fonts.load('16px "Helmsman Phosphor Regular"', (el as HTMLElement).dataset.glyph);
    return face.length > 0 && face.every(font => font.status === 'loaded');
  })).toBe(true);
  await expect(active).toHaveScreenshot('running-panel.png', { animations: 'disabled' });
  await expect(recent).toHaveScreenshot('recent-panel.png', { animations: 'disabled' });
  await expect(recent.getByRole('button', { name: 'Copy run ID' })).toHaveCount(0);
  await expect(recent.getByText('Spend unknown', { exact: true })).toHaveCount(0);
  const identity = recent.getByRole('link', { name: 'Open run abc123deabc1', exact: true });
  await expect(identity).toHaveText('abc123deabc1');
  await expect(identity).toHaveAttribute('href', `/runs?repo=org%2Fa&runRepo=org%2Fa&run=${reviewId}`);
  const clock = recent.getByRole('button', { name: 'Start time', exact: true }).last();
  const started = recent.locator(`[data-run-id="${reviewId}"] .run-tooltip`).filter({ hasText: 'Started' });
  await clock.hover(); await expect(started).toBeVisible();
  await page.mouse.move(0, 0); await clock.focus(); await expect(started).toBeVisible();
  await clock.press('Escape'); await expect(started).toBeHidden();
  await identity.focus();
  const touchContext = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 1200 }, storageState: await page.context().storageState({ indexedDB: true }) });
  const touchPage = await touchContext.newPage();
  touchPage.on('pageerror', error => errors.push(error.message));
  await touchPage.clock.setFixedTime(new Date('2026-09-20T12:30:00.000Z'));
  await touchPage.route('**/*', routeHandler);
  await touchPage.goto('http://127.0.0.1:4175/helm?repo=org/a');
  const mobileRecent = touchPage.locator('.plugin-recent');
  await expect(mobileRecent).toBeVisible();
  await expect(mobileRecent).toHaveScreenshot('recent-panel-mobile.png', { animations: 'disabled' });
  expect(await mobileRecent.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const mobileClock = mobileRecent.getByRole('button', { name: 'Start time', exact: true }).last();
  const mobileTime = mobileRecent.locator(`[data-run-id="${reviewId}"] .run-tooltip`).filter({ hasText: 'Started' });
  const clockBounds = await mobileClock.boundingBox();
  expect(clockBounds?.height).toBeGreaterThanOrEqual(44); expect(clockBounds?.width).toBeGreaterThanOrEqual(44);
  await mobileClock.tap(); await expect(mobileTime).toBeVisible();
  expect(await mobileRecent.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await mobileClock.tap(); await expect(mobileTime).toBeHidden();
  await touchContext.close();
  await active.getByRole('button', { name: /^Stop / }).click();
  await expect(active.getByText('Stop requested. Worker status is reported separately.', { exact: true })).toBeVisible();
  await expect(active.getByText('Worker: Underway', { exact: true })).toBeVisible();
  await recent.getByRole('button', { name: /^Retry / }).click();
  await expect(recent.getByRole('button', { name: 'Check request', exact: true })).toBeEnabled();
  expect(commands).toHaveLength(2); expect(commands[0]).toMatchObject({ action: 'stop', repo: 'org/a', target: { runId: 'active-run', expectedAttempt: 3 } });
  expect(commands[1]).toMatchObject({ action: 'retry', repo: 'org/a', target: { runId: 'failed-run', expectedAttempt: 3 } });
  await page.reload();
  await expect(active.getByText('Stop requested. Worker status is reported separately.', { exact: true })).toBeVisible();
  await expect(recent.getByRole('button', { name: 'Check request', exact: true })).toBeEnabled();
  expect(commands).toHaveLength(2);
  await recent.getByRole('button', { name: 'Check request', exact: true }).click();
  await expect(recent.getByRole('link', { name: 'Open new voyage', exact: true })).toHaveAttribute('href', '/runs?repo=org%2Fa&runRepo=org%2Fa&run=new-run');
  await expect(recent.getByRole('button', { name: 'Worker: failed', exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
  enabled.delete('helmsman.recent');
  await expect(page.locator('.plugin-recent')).toHaveCount(0);
  await expect(page.locator('#helm-body-recent').getByText('This panel is unavailable. Enable or install its plugin to bring it aboard.', { exact: true })).toBeVisible();
  enabled.add('helmsman.recent');
  await expect(recent.getByRole('link', { name: 'Open new voyage', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
