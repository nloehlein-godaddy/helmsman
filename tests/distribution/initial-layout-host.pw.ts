import { expect, test } from '@playwright/test';
import { fixture } from './isolated-fixture';

test('independent page defaults seed only fresh layouts and survive replacement and intentional removal', async ({ page, request }) => {
  const host = await fixture();
  host.env.REPO_PROJECT_MAP = 'org/a=TASK';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await host.installAuthorPackage('plugin-sources/helm-alternative');
    await host.cli('select', 'helmsman/helm-page', 'example.helm/page');
    const origin = await host.start();
    const created = await request.post(`${origin}/api/todos?requestId=authored-layout`, {
      data: { repo: 'org/a', title: 'Package-owned initial layout', description: 'Independent default panel.' },
    });
    expect(created.ok()).toBe(true);
    await page.goto(`${origin}/helm?repo=org/a`);
    await expect(page.getByText('This panel is unavailable. Enable or install its plugin to bring it aboard.', { exact: true })).toBeVisible();
    await host.installAuthorPackage('plugin-sources/backlog-alternative');
    await expect(page.locator('.alternative-helm .alternative-backlog')).toContainText('Package-owned initial layout', { timeout: 15_000 });
    await expect(page.locator('[data-panel-instance]:not(:has([data-panel-instance]))')).toHaveCount(1);
    await expect(page.locator('[data-panel-instance]:not(:has([data-panel-instance]))')).toHaveAttribute('data-panel-instance', 'queue');
    await page.reload();
    await expect(page.locator('.alternative-backlog')).toBeVisible();
    await host.cli('select', 'helmsman/helm-page', 'default');
    await expect(page.locator('.plugin-helm .alternative-backlog')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-panel-instance]:not(:has([data-panel-instance]))')).toHaveCount(1);
    await page.getByText('Manage panels', { exact: true }).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('[data-panel-instance]:not(:has([data-panel-instance]))')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.plugin-helm')).toBeVisible();
    await expect(page.locator('[data-panel-instance]:not(:has([data-panel-instance]))')).toHaveCount(0);
    await host.cli('select', 'helmsman/helm-page', 'example.helm/page');
    await expect(page.locator('.alternative-helm')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-panel-instance]:not(:has([data-panel-instance]))')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await host.close(); }
});
