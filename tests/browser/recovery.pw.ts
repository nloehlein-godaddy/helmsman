import { expect, test } from '@playwright/test';
import { recoveryPage } from '../../server/helmsman/recovery-page';

test('core recovery preserves header scope and requires evidence for explicit resolution', async ({ page }) => {
  const actions: unknown[] = [];
  const queries: string[] = [];
  await page.addInitScript(() => { localStorage.setItem('runner.repoScope', 'fleet/alpha'); });
  await page.route('**/recovery', route => route.fulfill({ contentType: 'text/html', body: recoveryPage() }));
  await page.route('**/api/context', route => route.fulfill({ json: { repos: ['fleet/alpha', 'fleet/bravo'] } }));
  await page.route('**/api/recovery?*', route => {
    queries.push(new URL(route.request().url()).searchParams.get('repo') ?? '');
    return route.fulfill({ json: { version: 1, mode: 'normal', readOnly: false, errors: [], truncated: false,
      runs: [{ id: 'voyage-1', repo: 'fleet/alpha', status: 'running', attempt: 1, attachment: 'blocked', actions: [] }],
      attempts: [{ runId: 'voyage-1', repo: 'fleet/alpha', attempt: 1, preparation: 'launched', attachment: 'blocked', diagnosticCode: 'ownership-unknown', actions: ['retry-attachment'] }],
      admissions: [], reservations: [{ runId: 'voyage-1', repo: 'fleet/alpha', reason: 'unresolved' }], pins: [], checkpoints: [], lifecycle: [],
      operations: [{ id: 'operation-1', runId: 'voyage-1', type: 'github.review', status: 'uncertain', providerId: 'helmsman.legacy-runtime', actions: ['resolve-operation'] }],
    } });
  });
  await page.route('**/api/recovery/actions', async route => {
    actions.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/recovery');
  await expect(page.getByRole('heading', { name: 'Recovery', exact: true })).toBeVisible();
  await expect(page.locator('#scope')).toHaveText('Galleon: fleet/alpha');
  await expect(page.getByRole('button', { name: 'Retry attachment' })).toBeVisible();
  await expect(page).toHaveScreenshot('core-recovery.png', { fullPage: true });
  await page.getByRole('button', { name: 'Retry attachment' }).click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toEqual({ action: 'retry-attachment', runId: 'voyage-1' });
  await page.getByRole('button', { name: 'Resolve operation' }).click();
  await page.getByLabel('Actor', { exact: true }).fill('operator');
  await page.getByLabel('Reason', { exact: true }).fill('Matched remote review receipt');
  await page.getByLabel('Evidence', { exact: true }).fill('Review 42 on the pinned commit');
  await page.getByRole('button', { name: 'Record resolution' }).click();
  await expect.poll(() => actions.length).toBe(2);
  expect(actions[1]).toMatchObject({ action: 'resolve-operation', id: 'operation-1', actor: 'operator', evidence: { note: 'Review 42 on the pinned commit' }, outcome: 'acknowledged' });
  await page.getByLabel('Recovery filter').selectOption('fleet/bravo');
  await expect.poll(() => queries.at(-1)).toBe('fleet/bravo');
  expect(await page.evaluate(() => localStorage.getItem('runner.repoScope'))).toBe('fleet/alpha');
});
