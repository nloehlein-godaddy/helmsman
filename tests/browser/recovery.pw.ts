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
      sourceClaims: [{ claimId: 'source-claim-1', runId: 'completed-voyage', repo: 'fleet/alpha', sourceId: 'local-collection', providerId: 'example.local/todos', state: 'settling', processStatus: 'succeeded', settlementReason: 'Source completion is pending.', actions: ['retry-source-settlement'] }],
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
  await expect(page.getByRole('cell', { name: 'succeeded', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry source settlement' }).click();
  await expect.poll(() => actions.length).toBe(3);
  expect(actions[2]).toEqual({ action: 'retry-source-settlement', claimId: 'source-claim-1' });
  await page.getByLabel('Recovery filter').selectOption('fleet/bravo');
  await expect.poll(() => queries.at(-1)).toBe('fleet/bravo');
  expect(await page.evaluate(() => localStorage.getItem('runner.repoScope'))).toBe('fleet/alpha');
});

const command = {
  caller: 'example.launch/panel', requestId: '00000000-0000-4000-8000-000000000001', repo: 'fleet/alpha',
  action: 'retry', assignedRunId: 'assigned-child', attempt: 1, targetRunId: 'original-voyage', targetAttempt: 2,
  status: 'recovery-required', message: 'Delivery requires reconciliation.', receiptHash: 'a'.repeat(64), actions: ['resolve-run-command'],
};

test('assignment recovery permits only non-application and restores other operation outcomes', async ({ page }) => {
  const actions: unknown[] = [];
  await page.route(url => url.pathname === '/recovery', route => route.fulfill({ contentType: 'text/html', body: recoveryPage() }));
  await page.route('**/api/context', route => route.fulfill({ json: { repos: ['fleet/alpha'] } }));
  await page.route('**/api/recovery?*', route => route.fulfill({ json: { ...snapshot([]), operations: [
    { id: 'assignment-1', type: 'source-remote-action.assign-self', status: 'uncertain', providerId: 'example.jira/issues', actions: ['resolve-operation'] },
    { id: 'review-1', type: 'github.review', status: 'uncertain', providerId: 'example.github/reviews', actions: ['resolve-operation'] },
  ] } }));
  await page.route('**/api/recovery/actions', async route => { actions.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
  await page.goto('/recovery?repo=fleet/alpha');
  const assignment = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'assignment-1', exact: true }) });
  const review = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'review-1', exact: true }) });
  await assignment.getByRole('button', { name: 'Resolve operation' }).click();
  await expect(page.locator('#outcome option')).toHaveCount(1);
  await expect(page.locator('#outcome')).toHaveValue('definitely-not-applied');
  await expect(page.locator('#outcome option[value="acknowledged"]')).toHaveCount(0);
  await expect(page.locator('#action-help')).toContainText('requires provider reconciliation');
  await page.getByLabel('Actor', { exact: true }).fill('operator');
  await page.getByLabel('Reason', { exact: true }).fill('Confirmed no assignment');
  await page.getByLabel('Evidence', { exact: true }).fill('Verified request was not applied');
  await page.getByRole('button', { name: 'Record resolution' }).click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({ id: 'assignment-1', outcome: 'definitely-not-applied' });
  await review.getByRole('button', { name: 'Resolve operation' }).click();
  await expect(page.locator('#outcome option')).toHaveCount(2);
  await expect(page.locator('#outcome')).toHaveValue('acknowledged');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await assignment.getByRole('button', { name: 'Resolve operation' }).click();
  await expect(page.locator('#outcome option')).toHaveCount(1);
  await expect(page.locator('#outcome')).toHaveValue('definitely-not-applied');
});
function snapshot(commands: unknown[], readOnly = false) {
  return { version: 1, mode: readOnly ? 'safe-start' : 'normal', readOnly, errors: [], truncated: false, commands,
    runs: [], attempts: [], sourceClaims: [], admissions: [], reservations: [], pins: [], checkpoints: [], lifecycle: [], operations: [] };
}
async function commandPage(page: import('@playwright/test').Page, readOnly = false) {
  await page.route(url => url.pathname === '/recovery', route => route.fulfill({ contentType: 'text/html', body: recoveryPage() }));
  await page.route('**/api/context', route => route.fulfill({ json: { repos: ['fleet/alpha', 'fleet/bravo'] } }));
  await page.route('**/api/recovery?*', route => route.fulfill({ json: snapshot([command, { ...command, requestId: 'protected-request', actions: [] }], readOnly) }));
  await page.goto('/recovery?repo=fleet/alpha');
  await expect(page.getByRole('heading', { name: 'Run commands', exact: true })).toBeVisible();
}

test('run command recovery retains exact identity and requires explicit audited resolution', async ({ page }) => {
  const actions: unknown[] = [];
  await page.route('**/api/recovery/actions', async route => { actions.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
  await commandPage(page);
  const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Request', exact: true }) });
  await expect(table.getByRole('cell').filter({ hasText: 'Original target: original-voyage · attempt 2' })).toHaveCount(2);
  await expect(table.getByRole('cell').filter({ hasText: 'Assigned: assigned-child · attempt 1' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Resolve as not admitted', exact: true })).toHaveCount(1);
  await expect(page).toHaveScreenshot('run-command-recovery.png', { fullPage: true });
  await page.getByRole('button', { name: 'Resolve as not admitted', exact: true }).click();
  expect(actions).toEqual([]);
  await expect(page.locator('#action-title')).toContainText(command.requestId);
  await expect(page.locator('#action-help')).toContainText('does not stop or cancel existing work');
  await page.getByRole('button', { name: 'Record resolution' }).click();
  expect(actions).toEqual([]);
  await page.getByLabel('Actor', { exact: true }).fill('operator');
  await page.getByLabel('Reason', { exact: true }).fill('Resolve retained undelivered request');
  await page.getByLabel('Evidence', { exact: true }).fill('Inspected command and absence of retained execution evidence');
  await page.getByRole('button', { name: 'Record resolution' }).click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toEqual({ action: 'resolve-run-command', caller: command.caller, requestId: command.requestId,
    repo: command.repo, receiptHash: command.receiptHash, actor: 'operator', reason: 'Resolve retained undelivered request',
    evidence: { note: 'Inspected command and absence of retained execution evidence' } });
  await expect(page.locator('#status')).toContainText('choose Check request, then dismiss the terminal receipt');
  await expect(page.locator('#resolution')).toBeHidden();
});

test('stale command resolution keeps operator evidence and never substitutes a newer proof', async ({ page }) => {
  const actions: Record<string, unknown>[] = [];
  await page.route('**/api/recovery/actions', async route => {
    actions.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 409, json: { error: 'Command evidence changed. Refresh Recovery before resolving.' } });
  });
  await commandPage(page);
  await page.getByRole('button', { name: 'Resolve as not admitted', exact: true }).click();
  await page.getByLabel('Actor', { exact: true }).fill('operator');
  await page.getByLabel('Reason', { exact: true }).fill('Keep my reason');
  await page.getByLabel('Evidence', { exact: true }).fill('Keep my evidence');
  let refreshed = false;
  await page.route('**/api/recovery?*', async route => { refreshed = true; await route.fulfill({ json: snapshot([{ ...command, receiptHash: 'b'.repeat(64) }]) }); });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => refreshed).toBe(true);
  await page.getByRole('button', { name: 'Record resolution' }).click();
  await expect(page.locator('#status')).toContainText('Command evidence changed');
  await expect(page.getByLabel('Evidence', { exact: true })).toHaveValue('Keep my evidence');
  expect(actions[0]?.receiptHash).toBe(command.receiptHash);
  await page.getByLabel('Recovery filter').selectOption('fleet/bravo');
  await expect(page.locator('#resolution')).toBeHidden();
  expect(actions).toHaveLength(1);
});

test('safe-start command diagnostics suppress mutation controls', async ({ page }) => {
  await commandPage(page, true);
  await expect(page.getByRole('button', { name: 'Resolve as not admitted', exact: true })).toHaveCount(0);
  await expect(page.locator('#notice')).toContainText('read-only');
  await expect(page.getByRole('cell').filter({ hasText: command.requestId })).toBeVisible();
});


test('a lost resolution response requires an explicit retry with the same request and evidence', async ({ page }) => {
  const actions: unknown[] = [];
  await page.route('**/api/recovery/actions', async route => {
    actions.push(route.request().postDataJSON());
    if (actions.length === 1) await route.abort('failed');
    else await route.fulfill({ json: { ok: true } });
  });
  await commandPage(page);
  await page.getByRole('button', { name: 'Resolve as not admitted', exact: true }).click();
  await page.getByLabel('Actor', { exact: true }).fill('operator');
  await page.getByLabel('Reason', { exact: true }).fill('Confirm undelivered command');
  await page.getByLabel('Evidence', { exact: true }).fill('Retained records checked');
  await page.getByRole('button', { name: 'Record resolution' }).click();
  await expect(page.locator('#status')).toContainText('Failed to fetch');
  await expect(page.locator('#resolution')).toBeVisible();
  expect(actions).toHaveLength(1);
  await page.getByRole('button', { name: 'Record resolution' }).click();
  await expect.poll(() => actions.length).toBe(2);
  expect(actions[1]).toEqual(actions[0]);
  await expect(page.locator('#status')).toContainText('choose Check request');
});

test('source command recovery retains the selected proof through refresh and lost responses', async ({ page }) => {
  const original = { caller: 'example.todos/panel', requestId: '00000000-0000-4000-8000-000000000123', repo: 'fleet/alpha',
    sourceId: '00000000-0000-4000-8000-000000000111', instanceId: 'source-instance', action: 'update', commandId: 'update',
    target: { ref: { sourceId: '00000000-0000-4000-8000-000000000111', externalId: 'TODO-7' }, expectedRevision: '12' },
    status: 'recovery-required', message: 'Source command delivery needs reconciliation.', receiptHash: 'a'.repeat(64), actions: ['resolve-source-command'] };
  let receiptHash = original.receiptHash; const submitted: unknown[] = []; let resolved = false;
  await page.route('**/recovery?*', route => route.fulfill({ contentType: 'text/html', body: recoveryPage() }));
  await page.route('**/api/context', route => route.fulfill({ json: { repos: ['fleet/alpha'] } }));
  await page.route('**/api/recovery?*', route => route.fulfill({ json: { version: 1, readOnly: false, errors: [], sourceCommands: resolved ? [] : [{ ...original, receiptHash }] } }));
  await page.route('**/api/recovery/actions', async route => {
    submitted.push(route.request().postDataJSON());
    if (submitted.length === 1) await route.abort('failed');
    else { resolved = true; await route.fulfill({ json: { ok: true } }); }
  });
  await page.goto('/recovery?repo=fleet%2Falpha');
  await page.getByRole('button', { name: 'Resolve as not applied', exact: true }).click();
  await expect(page.locator('#action-help')).toContainText('without editing or deleting any task');
  await page.getByLabel('Actor', { exact: true }).fill('operator');
  await page.getByLabel('Reason', { exact: true }).fill('Verified local receipt absence');
  await page.getByLabel('Evidence', { exact: true }).fill('Original task revision retained');
  await expect(page).toHaveScreenshot('source-command-recovery.png', { fullPage: true });
  receiptHash = 'b'.repeat(64); await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Record resolution', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(1); await expect(page.locator('#resolution')).toBeVisible();
  await page.getByRole('button', { name: 'Record resolution', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(2);
  expect(submitted[0]).toEqual(submitted[1]); expect(submitted[0]).toMatchObject({ action: 'resolve-source-command', receiptHash: original.receiptHash, requestId: original.requestId });
  await expect(page.getByRole('button', { name: 'Resolve as not applied', exact: true })).toHaveCount(0);
});
