import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture } from './isolated-fixture';

test('isolated Recovery resolves only absent commands with durable audited replay and no execution', async ({ page, request }) => {
  test.setTimeout(120_000);
  const host = await fixture(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  const caller = 'example.missing/panel';
  const identities = {
    absent: '00000000-0000-4000-8000-000000000101',
    unrelated: '00000000-0000-4000-8000-000000000102',
    foreign: '00000000-0000-4000-8000-000000000103',
  };
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(host.app, `server/helmsman/${name}.js`)).href);
  try {
    await host.start(); await host.stop();
    const seeded = JSON.parse(await host.script('seed-command-recovery.mjs', `
      import { openPersistence } from ${moduleUrl('persistence')};
      import { openExecutionStore } from ${moduleUrl('execution-store')};
      import { openAdmissionStore } from ${moduleUrl('admission-store')};
      import { openRunCommandStore } from ${moduleUrl('run-command-store')};
      const persistence = openPersistence(process.env.HELMSMAN_DB);
      try {
        const executions = openExecutionStore(persistence);
        const admissions = openAdmissionStore(persistence, executions);
        const store = openRunCommandStore(persistence);
        const records = {};
        for (const [kind, requestId] of Object.entries(${JSON.stringify(identities)})) {
          const record = store.put(${JSON.stringify(caller)}, { version: 1, requestId, repo: kind === 'foreign' ? 'org/b' : 'org/a',
            action: 'launch', launch: { mode: 'freeform', task: 'Retained command requiring explicit recovery' } });
          store.settle(record.caller, { ...record.receipt, status: 'recovery-required', message: 'Injected lost delivery evidence' });
          records[kind] = record.assignedRunId;
          if (kind === 'unrelated') {
            admissions.admit({ runId: record.assignedRunId, repo: 'org/a', request: { unrelated: true }, settings: {},
              artifacts: [{ pluginId: 'example.retained', artifactHash: 'a'.repeat(64), packageVersion: '1.0.0', requires: [] }] }, 10);
            admissions.fail(record.assignedRunId, 'Retained failed admission must still block command resolution');
          }
        }
        console.log(JSON.stringify(records));
      } finally { persistence.close(); }
    `)) as Record<keyof typeof identities, string>;
    let origin = await host.start(true);
    const safeInventory = await (await request.get(`${origin}/api/recovery?repo=org/a`)).json();
    expect(safeInventory).toMatchObject({ readOnly: true, commands: expect.any(Array) });
    expect(safeInventory.commands).toHaveLength(2);
    expect(safeInventory.commands.every((entry: { actions: unknown[] }) => entry.actions.length === 0)).toBe(true);
    expect((await request.post(`${origin}/api/recovery/actions`, { data: { action: 'resolve-run-command' } })).status()).toBe(503);
    origin = await host.start();
    const recovery = await request.get(`${origin}/api/recovery?repo=org/a`);
    expect(recovery.ok()).toBe(true);
    const inventory = await recovery.json();
    expect(inventory.commands).toHaveLength(2);
    const absent = inventory.commands.find((entry: { requestId: string }) => entry.requestId === identities.absent);
    const unrelated = inventory.commands.find((entry: { requestId: string }) => entry.requestId === identities.unrelated);
    expect(absent).toMatchObject({ caller, assignedRunId: seeded.absent, actions: ['resolve-run-command'] });
    expect(unrelated).toMatchObject({ caller, assignedRunId: seeded.unrelated, actions: [] });
    const resolution = { action: 'resolve-run-command', caller, requestId: identities.absent, repo: 'org/a', receiptHash: absent.receiptHash,
      actor: 'distribution-test', reason: 'Verified retained evidence is absent', evidence: { note: 'Isolated copied host with no worker execution' } };
    expect((await request.post(`${origin}/api/recovery/actions`, { data: { ...resolution, requestId: identities.unrelated, receiptHash: unrelated.receiptHash } })).status()).toBe(409);
    expect((await request.post(`${origin}/api/recovery/actions`, { data: { ...resolution, repo: 'org/b' } })).status()).toBe(409);
    expect((await request.post(`${origin}/api/recovery/actions`, { data: { ...resolution, receiptHash: '0'.repeat(64) } })).status()).toBe(409);
    await page.goto(`${origin}/recovery?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'Run commands', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resolve as not admitted', exact: true })).toHaveCount(1);
    await expect(page.getByRole('cell').filter({ hasText: identities.foreign })).toHaveCount(0);
    await page.getByRole('button', { name: 'Resolve as not admitted', exact: true }).click();
    await page.getByLabel('Actor', { exact: true }).fill(resolution.actor);
    await page.getByLabel('Reason', { exact: true }).fill(resolution.reason);
    await page.getByLabel('Evidence', { exact: true }).fill(resolution.evidence.note);
    let delivered: unknown;
    await page.route('**/api/recovery/actions', async route => {
      delivered = route.request().postDataJSON();
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      await route.abort('failed');
    }, { times: 1 });
    await page.getByRole('button', { name: 'Record resolution', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(/fetch|network|failed/i);
    expect(delivered).toEqual(resolution);
    const receipt = async (requestId = identities.absent, repo = 'org/a') => {
      const response = await request.get(`${origin}/api/run-commands/${requestId}?repo=${encodeURIComponent(repo)}`,
        { headers: { 'X-Helmsman-Contribution': caller } });
      expect(response.ok()).toBe(true); return response.json();
    };
    const resolved = await receipt();
    expect(resolved).toMatchObject({ status: 'rejected', runId: null, attempt: null,
      resolution: { version: 1, kind: 'not-admitted', runId: seeded.absent, attempt: 1 } });
    expect(resolved.resolution.id).toMatch(/^[a-f\d-]{36}$/i);
    await page.getByRole('button', { name: 'Record resolution', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Command resolution recorded.');
    expect(await receipt()).toEqual(resolved);
    expect((await request.post(`${origin}/api/recovery/actions`, { data: { ...resolution, reason: 'Different evidence' } })).status()).toBe(409);
    expect((await receipt(identities.unrelated)).status).toBe('recovery-required');
    expect((await receipt(identities.foreign, 'org/b')).status).toBe('recovery-required');
    host.env.HELMSMAN_PORT = new URL(origin).port; origin = await host.start();
    expect((await request.post(`${origin}/api/recovery/actions`, { data: resolution })).ok()).toBe(true);
    expect(await receipt()).toEqual(resolved);
    await page.goto(`${origin}/recovery?repo=org/a`);
    await expect(page.getByRole('cell').filter({ hasText: identities.unrelated })).toBeVisible();
    await expect(page.getByRole('cell').filter({ hasText: identities.absent })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resolve as not admitted', exact: true })).toHaveCount(0);
    await host.stop();
    const durable = JSON.parse(await host.script('inspect-command-recovery.mjs', `
      import { openPersistence } from ${moduleUrl('persistence')};
      const persistence = openPersistence(process.env.HELMSMAN_DB);
      try {
        const count = table => persistence.sql.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count;
        console.log(JSON.stringify({ runs: count('runs'), attempts: count('execution_attempts'), admissions: count('execution_admissions'),
          resolutions: count('run_command_resolutions'), audit: persistence.sql.prepare('SELECT actor,reason,evidence FROM run_command_resolutions').get() }));
      } finally { persistence.close(); }
    `));
    expect(durable).toEqual({ runs: 0, attempts: 0, admissions: 1, resolutions: 1,
      audit: { actor: resolution.actor, reason: resolution.reason, evidence: JSON.stringify(resolution.evidence) } });
    expect(errors).toEqual([]);
    expect(host.output()).not.toContain('Source checkout is unavailable');
    const commands = (await readFile(host.commandLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    expect(commands.filter(command => !command.endsWith(' worktree list --porcelain') && command !== `${join(host.root, 'commands/git')} -C ${host.app}/ rev-parse HEAD`)).toEqual([]);
  } finally { await host.close(); }
});
