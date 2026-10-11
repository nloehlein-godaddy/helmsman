import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { fixture, sourceRoot } from './isolated-fixture';

test('source-denied authored campaigns preserve scoped drafts and exact durable commands without launching work', async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const host = await fixture();
  const errors: string[] = [];
  const caller = 'example.authored-campaigns/panel';
  const headers = { 'x-helmsman-contribution': caller };
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(host.script('deny-campaigns-source.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/campaigns/page.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
    const descriptor = await host.installAuthorPackage('plugin-sources/campaigns', 'example.authored-campaigns', { buildScript: true });
    expect(descriptor.manifest.id).toBe('example.authored-campaigns');
    await host.cli('select', 'helmsman/campaigns-page', 'example.authored-campaigns/page');
    let origin = await host.start();
    expect((await request.get(`${origin}/api/campaigns?repo=org%2Fa`)).status()).toBe(410);
    expect((await request.post(`${origin}/api/campaigns?repo=org%2Fa`, { data: { name: 'Private bypass', workflowRef: 'coding@1', concurrency: 1 } })).status()).toBe(410);

    let lostCreate: { command: { requestId: string; repo: string; action: string } } | null = null;
    let loseCreateResponse = true;
    await page.route('**/api/campaign-service/commands', async route => {
      const submitted = route.request().postDataJSON() as { command: { requestId: string; repo: string; action: string } };
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      if (loseCreateResponse && submitted.command.action === 'create') {
        lostCreate = submitted;
        loseCreateResponse = false;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });

    await page.goto(`${origin}/campaigns?repo=org/a`);
    const panel = page.locator('.campaign-page');
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(panel.locator('[data-scope-inherit]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh page', exact: true })).toHaveCount(1);
    await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
    const create = panel.locator('form[data-campaign-create]');
    await create.getByLabel('Campaign name').fill('Isolated campaign');
    await create.getByText('Execution settings', { exact: true }).click();
    await create.getByLabel('Active task limit').fill('2');
    await create.getByRole('button', { name: 'Create campaign', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry original request', exact: true })).toBeVisible();
    expect(lostCreate).not.toBeNull();
    await page.getByRole('button', { name: 'Retry original request', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'Isolated campaign', exact: true })).toBeVisible();

    const scopedListResponse = await request.get(`${origin}/api/campaign-service/list?version=1&repo=org%2Fa&scopeRepo=org%2Fa`, { headers });
    expect(scopedListResponse.status()).toBe(200);
    const scopedList = await scopedListResponse.json() as { campaigns: { id: string; name: string; repo: string }[] };
    expect(scopedList.campaigns).toEqual([expect.objectContaining({ name: 'Isolated campaign', repo: 'org/a' })]);
    const campaignId = scopedList.campaigns[0]!.id;

    await page.getByRole('button', { name: 'Show all campaigns', exact: true }).click();
    await expect(panel.locator('.campaign-scope').getByText('All campaigns', { exact: true })).toBeVisible();
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(panel.getByRole('button', { name: 'Isolated campaign', exact: true })).toBeVisible();
    await expect(create.getByRole('button', { name: 'Create campaign', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Use selected galleon', exact: true }).click();
    await expect(panel.locator('[data-scope-inherit]')).toHaveCount(0);

    const phaseForm = panel.locator('form[data-campaign-phase-create]');
    await phaseForm.getByLabel('New phase').fill('Pilot phase');
    await phaseForm.getByRole('button', { name: 'Add phase', exact: true }).click();
    await expect(panel.getByRole('heading', { name: /1\. Pilot phase/ })).toBeVisible();
    const importForm = panel.locator('form[data-campaign-import]').first();
    const jsonl = [
      JSON.stringify({ key: 'default', task: 'Default galleon task', title: 'Default task' }),
      JSON.stringify({ key: 'override', repo: 'org/b', task: 'Explicit override task', title: 'Override task' }),
    ].join('\n');
    await importForm.getByLabel('Import format').selectOption('jsonl');
    await importForm.getByLabel('Task data').fill(jsonl);
    await importForm.getByRole('button', { name: 'Preview tasks', exact: true }).click();
    const preview = panel.locator('.campaign-preview');
    await expect(preview).toContainText('2 unique records');
    await expect(preview).toContainText('org/a · Default galleon task');
    await expect(preview).toContainText('org/b · Explicit override task');

    await page.screenshot({ path: testInfo.outputPath('campaigns-desktop.png'), fullPage: true });
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await preview.scrollIntoViewIfNeeded();
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(preview.getByRole('heading', { name: 'Check tasks before importing', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('campaigns-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });

    await preview.getByRole('button', { name: 'Import tasks', exact: true }).click();
    await expect(panel.getByRole('cell', { name: 'Default task', exact: true })).toBeVisible();
    await expect(panel.getByRole('cell', { name: 'Override task', exact: true })).toBeVisible();
    await expect(panel.getByRole('cell', { name: 'Queued', exact: true })).toHaveCount(2);

    const staleContent = JSON.stringify({ key: 'stale', task: 'Keep this stale draft', title: 'Stale draft' });
    await importForm.getByLabel('Task data').fill(staleContent);
    const detailResponse = await request.get(`${origin}/api/campaign-service/detail?version=1&repo=org%2Fa&campaignId=${encodeURIComponent(campaignId)}&scopeRepo=org%2Fa`, { headers });
    expect(detailResponse.status()).toBe(200);
    const detail = await detailResponse.json() as { revision: string };
    const externalPhase = await request.post(`${origin}/api/campaign-service/commands`, { headers, data: { command: { version: 1, repo: 'org/a', requestId: randomUUID(), action: 'add-phase', target: { campaignId, revision: detail.revision }, name: 'External revision change' }, scopeRepo: 'org/a' } });
    expect(externalPhase.status()).toBe(200);
    expect(await externalPhase.json()).toMatchObject({ status: 'succeeded', result: { kind: 'phase' } });
    await importForm.getByRole('button', { name: 'Preview tasks', exact: true }).click();
    await expect(panel).toContainText('Campaign changed; refresh before submitting a new command');
    await expect(importForm.getByLabel('Task data')).toHaveValue(staleContent);
    await expect(importForm.getByRole('button', { name: 'Use latest revision and preview again', exact: true })).toBeVisible();

    const finish = panel.getByRole('button', { name: 'Finish phase…', exact: true }).first();
    await finish.click();
    await expect(panel).toContainText('Cancel queued tasks and let active tasks finish.');
    await panel.getByRole('button', { name: 'Cancel queued tasks and finish', exact: true }).click();
    await expect(panel.getByText('Finished', { exact: true }).first()).toBeVisible();
    await expect(panel.getByRole('cell', { name: 'Cancelled', exact: true })).toHaveCount(2);

    await page.unroute('**/api/campaign-service/commands');
    const lostRequestId = lostCreate!.command.requestId;
    origin = await host.start();
    const retainedReceipt = await request.get(`${origin}/api/campaign-service/receipts/${lostRequestId}?repo=org%2Fa&scopeRepo=org%2Fa`, { headers });
    expect(retainedReceipt.status()).toBe(200);
    expect(await retainedReceipt.json()).toMatchObject({ requestId: lostRequestId, status: 'succeeded', input: { action: 'create', repo: 'org/a', name: 'Isolated campaign' }, result: { kind: 'created', campaign: { id: campaignId } } });
    const restartedList = await request.get(`${origin}/api/campaign-service/list?version=1&repo=org%2Fa&scopeRepo=org%2Fa`, { headers });
    expect((await restartedList.json() as { campaigns: unknown[] }).campaigns).toHaveLength(1);
    await page.goto(`${origin}/campaigns?repo=org/a`);
    await expect(panel.getByRole('heading', { name: 'Isolated campaign', exact: true })).toBeVisible();

    await host.cli('disable', 'example.authored-campaigns');
    await page.goto(`${origin}/campaigns?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'Page unavailable', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally {
    await host.close();
  }
});
