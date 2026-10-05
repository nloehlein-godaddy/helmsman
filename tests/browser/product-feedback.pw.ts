import { expect, test } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';
import type { FeedbackCommandV1 } from '../../src/plugins/feedback-command';
for (const width of [1440, 390]) test(`feedback configuration, retained drafts and uncertain recovery at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  const destination = { id: 'github-issues:org/app', label: 'org/app issues', url: 'https://github.com/org/app/issues', revision: 'a'.repeat(64) };
  let enabled = false; let command: FeedbackCommandV1 | null = null; let sends = 0; let retries = 0;
  let snapshot = { version: 1, revision: 'b'.repeat(64), selected: null as string | null, providers: [{ id: 'helmsman.feedback-github/issues', label: 'GitHub Issues', fields: { enabled: { type: 'boolean', default: false }, repository: { type: 'string', default: '', maxLength: 256 }, labels: { type: 'string', default: '', maxLength: 512 } }, values: { enabled: false, repository: '', labels: '' } }] };
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()); if (url.origin !== 'http://127.0.0.1:4175') return route.abort(); if (!url.pathname.startsWith('/api/')) return route.continue();
    let body: unknown = {};
    if (url.pathname === '/api/plugins/catalog') body = { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.product-feedback']) };
    if (url.pathname === '/api/context') body = { repos: ['org/project'], jiraEnabled: false, jiraBaseUrl: null };
    if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } };
    if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
    if (url.pathname === '/api/task-sources') body = { instances: [] };
    if (url.pathname === '/api/feedback-settings') {
      if (route.request().method() === 'POST') { const input = route.request().postDataJSON(); expect(input.expectedRevision).toBe(snapshot.revision); snapshot = { ...snapshot, revision: 'c'.repeat(64), selected: input.selected, providers: [{ ...snapshot.providers[0]!, values: input.values }] }; enabled = true; }
      body = snapshot;
    }
    if (url.pathname === '/api/feedback-command/destination') body = enabled ? destination : null;
    if (url.pathname === '/api/feedback-command') { sends++; command = route.request().postDataJSON().command; return route.abort('failed'); }
    if (url.pathname === '/api/feedback-command/retry') {
      retries++; expect(route.request().postDataJSON().command).toEqual(command); if (!command) throw new Error('missing command'); const { requestId, ...input } = command;
      body = { version: 1, requestId, input, status: 'succeeded', reason: null, result: { id: '9', url: 'https://github.com/org/app/issues/9' } };
    }
    return route.fulfill({ json: body });
  });
  await page.goto('/config?repo=org/project'); await expect(page.locator('.footer-controls [data-product-feedback]')).toHaveAttribute('href', '/feedback-settings?repo=org%2Fproject'); await expect(page.locator('.footer-controls [data-pirate-mode]')).toBeVisible(); await page.locator('.footer-controls [data-product-feedback]').click();
  await expect(page.getByRole('heading', { name: 'Feedback settings', exact: true })).toBeVisible(); await expect(page.getByRole('link', { name: 'Send product feedback' })).toHaveCount(0);
  await page.getByLabel('Feedback tracker').selectOption('helmsman.feedback-github/issues'); await page.getByLabel('repository', { exact: true }).fill('org/app'); await page.getByLabel('enabled', { exact: true }).check(); await page.getByRole('button', { name: 'Save feedback settings' }).click();
  await expect(page.getByText('Feedback settings saved.', { exact: false })).toBeVisible(); expect(sends).toBe(0); await page.reload();
  await expect(page.locator('.footer-controls [data-product-feedback]')).toHaveAttribute('href', '/product-feedback?repo=org%2Fproject'); await page.locator('.footer-controls [data-product-feedback]').click(); await page.getByLabel('Title', { exact: true }).fill('<img src=x> Feedback bug'); await page.getByLabel('Feedback', { exact: true }).fill('My original steps');
  await page.reload(); await expect(page.getByLabel('Title', { exact: true })).toHaveValue('<img src=x> Feedback bug'); await expect(page.getByLabel('Feedback', { exact: true })).toHaveValue('My original steps');
  await page.getByRole('button', { name: 'Submit feedback' }).click(); await expect(page.getByRole('button', { name: 'Check original submission' })).toBeVisible(); expect(sends).toBe(1);
  enabled = false; await page.reload(); await expect(page.getByText('Original body', { exact: true })).toHaveCount(0); await expect(page.getByText('My original steps', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Submit feedback' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check original submission' }).click(); await expect(page.getByRole('link', { name: 'Open submitted feedback' })).toBeVisible(); expect(sends).toBe(1); expect(retries).toBe(1); await expect(page.locator('img[src=x]')).toHaveCount(0);
  if (width <= 640) {
    const metadata = await page.locator('.footer-meta').boundingBox(); const controls = await page.locator('.footer-controls').boundingBox();
    expect(metadata).not.toBeNull(); expect(controls).not.toBeNull(); expect(controls!.y).toBeLessThan(metadata!.y + metadata!.height);
    expect(metadata!.x + metadata!.width).toBeLessThanOrEqual(controls!.x);
    const footer = page.locator('.app-footer');
    const before = await footer.boundingBox();
    await expect(page.locator('.footer-about-content')).toBeHidden();
    await page.locator('.footer-about > summary').click();
    await expect(page.locator('.footer-about-content')).toBeVisible();
    const about = await page.locator('.footer-about-content').boundingBox();
    expect(about).not.toBeNull();
    expect(about!.x).toBeGreaterThanOrEqual(0);
    expect(about!.x + about!.width).toBeLessThanOrEqual(width);
    expect((await footer.boundingBox())?.height).toBe(before?.height);
    await page.locator('.footer-about > summary').click();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); expect(errors).toEqual([]);
  await testInfo.attach('feedback-receipt', { body: await page.screenshot({ path: testInfo.outputPath('feedback-receipt.png'), fullPage: true }), contentType: 'image/png' });
});
