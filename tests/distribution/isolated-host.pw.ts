import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitBin } from '../../server/test-support/platform';
import { contribution, fixture, pluginId, pendingCommandCount, run, seedBacklogLayout, sourceRoot } from './isolated-fixture';

async function seedCheckout(host: Awaited<ReturnType<typeof fixture>>, repo: string) {
  const checkout = join(host.cwd, repo.split('/').at(-1)!); const git = gitBin();
  await mkdir(checkout);
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Acceptance']]) await run(git, args, checkout, host.env);
  await writeFile(join(checkout, 'code.txt'), 'initial\n');
  for (const args of [['add', '.'], ['commit', '-m', 'initial'], ['remote', 'add', 'origin', `https://github.com/${repo}.git`]]) await run(git, args, checkout, host.env);
  await writeFile(join(host.root, 'commands/git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const result=spawnSync(${JSON.stringify(git)},process.argv.slice(2),{stdio:'inherit'});process.exit(result.status??1);`, { mode: 0o755 });
}

test('isolated production distribution installs an independently compiled SDK page and reloads its route', async ({ page, request }) => {
  const host = await fixture();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(host.script('prove-isolation.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'package.json'))});`)).rejects.toThrow('Source checkout is unavailable');
    const installed = await host.installSample();
    const origin = await host.start();
    const catalog = await request.get(`${origin}/api/plugins/catalog`);
    expect(catalog.status()).toBe(200);
    expect(await catalog.json()).toMatchObject({ bindings: { 'helmsman/costs-page': contribution } });
    await page.goto(`${origin}/plugins/${contribution}?repo=`);
    await expect(page.getByRole('heading', { name: 'Isolated TypeScript page' })).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-isolated-scope]')).toHaveText('All');
    await page.goto(`${origin}/outcomes?repo=org/a`);
    await expect(page.locator('[data-isolated-scope]')).toHaveText('org/a');
    await page.goto(`${origin}/runs?repo=org/a`);
    await expect(page.locator('[data-plugin-page="helmsman.runs/page"] .plugin-runs')).toBeVisible();
    const missing = await request.get(`${origin}/plugin-assets/${pluginId}/${installed.plugins[0]?.hash}/missing.js`);
    expect(missing.status()).toBe(404);
    expect(await missing.text()).not.toContain('<html');
    await host.stop();
    await host.cli('disable', pluginId);
    const disabledOrigin = await host.start();
    await page.goto(`${disabledOrigin}/outcomes?repo=`);
    await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
    expect(errors).toEqual([]);
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});

test('independent Helm and backlog packages compose in all four pairings with live selection and retained layout', async ({ page, request }) => {
  test.setTimeout(90_000);
  await seedBacklogLayout(page);
  const host = await fixture(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  host.env.REPO_PROJECT_MAP = 'org/a=TASK';
  try {
    await expect(host.script('prove-composition-isolation.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/sdk.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    const helm = await host.installAuthorPackage('plugin-sources/helm-alternative');
    const backlog = await host.installAuthorPackage('plugin-sources/backlog-alternative');
    expect(helm.manifest.id).toBe('example.helm'); expect(backlog.manifest.id).toBe('example.backlog');
    const origin = await host.start();
    async function selectHelm(contribution: string) {
      await host.cli('select', 'helmsman/helm-page', contribution);
      await expect.poll(async () => (await (await request.get(`${origin}/api/plugins/catalog`)).json()).bindings['helmsman/helm-page'] ?? null,
        { timeout: 10_000 }).toBe(contribution === 'default' ? null : contribution);
    }
    const created = await request.post(`${origin}/api/todos?requestId=composition-task`, {
      data: { repo: 'org/a', title: 'One canonical task across four compositions', description: 'Read through the public task service.' },
    });
    expect(created.ok()).toBe(true);
    const task = (await created.json()).todo;
    const taskTitle = `${task.id}: ${task.title}`;
    await page.goto(`${origin}/helm?repo=org/a`);
    await expect(page.locator('.plugin-helm')).toBeVisible();
    const builtinTask = page.locator('.plugin-backlog').getByRole('listitem').filter({ has: page.getByText(task.title, { exact: true }) });
    await expect(builtinTask.getByText(task.title, { exact: true })).toBeVisible();
    await expect(builtinTask.getByText(task.id, { exact: true })).toBeVisible();
    await expect(page.locator('.repo-select')).toHaveValue('org/a');

    await selectHelm('example.helm/page');
    await expect(page.locator('.alternative-helm')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.alternative-helm .plugin-backlog')).toBeVisible();
    await expect(builtinTask.getByText(task.title, { exact: true })).toBeVisible();
    await expect(builtinTask.getByText(task.id, { exact: true })).toBeVisible();
    await expect(page.locator('.plugin-helm')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/helm');

    await selectHelm('default');
    await expect(page.locator('.plugin-helm')).toBeVisible({ timeout: 15_000 });
    await page.getByText('Manage panels', { exact: true }).click();
    await page.getByLabel('Implementation for Backlog', { exact: false }).selectOption('example.backlog/panel');
    await expect(page.locator('.plugin-helm .alternative-backlog').getByText(taskTitle, { exact: true })).toBeVisible();
    await expect(page.locator('.plugin-backlog')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.plugin-helm .alternative-backlog').getByText(taskTitle, { exact: true })).toBeVisible();

    await selectHelm('example.helm/page');
    await expect(page.locator('.alternative-helm .alternative-backlog').getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await page.reload();
    await expect(page.locator('.alternative-helm .alternative-backlog').getByText(taskTitle, { exact: true })).toBeVisible();
    expect(await (await request.get(`${origin}/api/plugins/catalog`)).json()).toMatchObject({ bindings: { 'helmsman/helm-page': 'example.helm/page' } });

    await host.cli('disable', 'example.backlog');
    await expect(page.locator('.alternative-helm')).toBeVisible();
    await expect(page.getByText('This panel is unavailable. Enable or install its plugin to bring it aboard.', { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByText('This panel is unavailable. Enable or install its plugin to bring it aboard.', { exact: true })).toBeVisible();
    await host.cli('enable', 'example.backlog');
    await expect(page.locator('.alternative-helm .alternative-backlog').getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 15_000 });

    await host.cli('disable', 'example.helm');
    await expect(page.getByRole('heading', { name: 'Page unavailable', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.plugin-helm, .alternative-helm')).toHaveCount(0);
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await page.getByRole('tab', { name: 'Config', exact: true }).click();
    await expect(page.locator('.helm')).toHaveAttribute('data-page', 'config');
    const restartedOrigin = await host.start();
    expect(await (await request.get(`${restartedOrigin}/api/plugins/catalog`)).json()).toMatchObject({ bindings: { 'helmsman/helm-page': 'example.helm/page' } });
    await page.goto(`${restartedOrigin}/helm?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'Page unavailable', exact: true })).toBeVisible();
    const recovery = await request.get(`${restartedOrigin}/api/recovery`); expect(recovery.ok()).toBe(true);
    expect(await recovery.json()).toMatchObject({ mode: 'normal', readOnly: false });
    await page.goto(`${restartedOrigin}/recovery`);
    await expect(page.getByRole('heading', { name: 'Recovery', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});

test('external Costs and pricing implementations swap independently while usage, settings and storage survive restart', async ({ page, request }) => {
  const host = await fixture();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await host.installAuthorPackage('examples/plugins/costs-summary');
    const flat = await host.installAuthorPackage('examples/plugins/flat-pricing');
    await host.installAuthorPackage('plugin-sources/costs');
    await host.installAuthorPackage('plugin-sources/pricing');
    await host.cli('configure', flat.manifest.id, JSON.stringify({ usdPerMillionTokens: 2 }));
    await host.cli('select-pricing', 'example.flat-pricing/flat');
    await host.cli('select', 'helmsman/costs-page', 'example.costs-summary/page');
    const dbUrl = pathToFileURL(join(host.app, 'server/helmsman/db.js')).href;
    const usageUrl = pathToFileURL(join(host.app, 'server/helmsman/usage-store.js')).href;
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 1000).toISOString();
    await host.script('seed-costs.mjs', `import { openDb } from ${JSON.stringify(dbUrl)};
import { openUsageStore } from ${JSON.stringify(usageUrl)};
const db = openDb(process.env.HELMSMAN_DB); const usage = openUsageStore(process.env.HELMSMAN_DB);
for (const [id, repo, amount] of [['priced_a','org/a',5],['priced_b','org/b',50]]) {
  db.insertRun({id,ticketId:id,repo,adapter:'codex',status:'succeeded',attempt:1,prNumber:null,startedAt:${JSON.stringify(from)},endedAt:${JSON.stringify(from)},costUsd:amount,worktreePath:null});
  usage.recordUsage({runId:id,attempt:1,eventId:'reported',provider:'codex',model:'gpt-6-astra',inputTokens:10,cachedInputTokens:0,outputTokens:0,totalTokens:10,costUsd:amount});
  usage.recordUsage({runId:id,attempt:1,eventId:'unreported',provider:'codex',model:'gpt-6-astra',inputTokens:1000000,cachedInputTokens:0,outputTokens:0,totalTokens:1000000,costUsd:null});
} usage.close(); db.close();`);
    const query = new URLSearchParams({ version: '1', repo: 'org/a', from, to });
    let origin = await host.start();
    let measured = await (await request.get(`${origin}/api/usage/v1?${query}`)).json();
    expect(measured).toMatchObject({ reported: { observedCostUsd: 5, knownCostUsd: null }, records: [{ runId: 'priced_a' }, { runId: 'priced_a' }] });
    expect(await (await request.get(`${origin}/api/pricing/v1?${query}`)).json()).toMatchObject({ estimatedUnreportedCostUsd: 2 });
    await page.goto(`${origin}/outcomes?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'Independent Costs' })).toBeVisible();
    await expect(page.locator('[data-recorded-usage]')).toContainText('Reported spend: $5.0000 USD');
    await expect(page.locator('[data-estimated-usage]')).toContainText('Unreported usage estimate: $2.0000 USD');
    await page.reload();
    await expect(page.locator('[data-estimated-usage]')).toContainText('$2.0000 USD');
    await host.stop();
    const dataUrl = pathToFileURL(join(host.app, 'server/helmsman/plugins/data.js')).href;
    expect(await host.script('inspect-plugin-data.mjs', `import { openPluginData } from ${JSON.stringify(dataUrl)};
const data=openPluginData(process.env.HELMSMAN_PLUGINS_DIR,${JSON.stringify(flat)}); console.log(data.read('last-rate')); data.close();`)).toBe('2\n');
    origin = await host.start();
    expect(await (await request.get(`${origin}/api/pricing/v1?${query}`)).json()).toMatchObject({ estimatedUnreportedCostUsd: 2 });
    await host.stop();
    await host.cli('disable', 'example.costs-summary');
    await host.cli('disable', 'example.flat-pricing');
    origin = await host.start();
    await page.goto(`${origin}/outcomes?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
    expect(await (await request.get(`${origin}/api/usage/v1?${query}`)).json()).toEqual(measured);
    expect((await request.get(`${origin}/api/pricing/v1?${query}`)).status()).toBe(503);
    const telemetryUrl = pathToFileURL(join(host.app, 'server/helmsman/run-telemetry.js')).href;
    expect(await host.script('record-with-plugins-disabled.mjs', `import { openDb } from ${JSON.stringify(dbUrl)};
import { openUsageStore } from ${JSON.stringify(usageUrl)}; import { openRunTelemetry } from ${JSON.stringify(telemetryUrl)};
const db=openDb(process.env.HELMSMAN_DB), usage=openUsageStore(process.env.HELMSMAN_DB);
const telemetry=openRunTelemetry(process.env.HELMSMAN_DB,usage); const run=db.getRun('priced_a');
const cost=telemetry.record(run,{ticketId:'priced_a',title:'Measured event',repo:'org/a',jiraBaseUrl:''},
  {kind:'usage',provider:'claude-code',model:'claude-sonnet',costUsd:3,usage:{inputTokens:10,cachedInputTokens:1000,outputTokens:0,totalTokens:1010}},100);
db.updateRun(run.id,{costUsd:cost}); console.log(db.getRun(run.id).costUsd);
telemetry.close(); usage.close(); db.close();`)).toBe('8\n');
    measured = await (await request.get(`${origin}/api/usage/v1?${query}`)).json();
    expect(measured).toMatchObject({ reported: { observedCostUsd: 8, knownCostUsd: null } });
    expect(measured.records).toHaveLength(3);
    await host.stop();
    await host.cli('select', 'helmsman/costs-page', 'example.full-costs/page');
    await host.cli('disable', 'example.flat-pricing');
    origin = await host.start();
    expect((await request.get(`${origin}/api/pricing/v1?${query}`)).status()).toBe(503);
    await page.goto(`${origin}/outcomes?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'Costs & Outcomes' })).toBeVisible();
    await expect(page.locator('.outcome-stats').first()).toContainText('$8.00');
    await expect(page.locator('section.outcomes-view')).toContainText('Pricing provider unavailable');
    expect(await (await request.get(`${origin}/api/usage/v1?${query}`)).json()).toEqual(measured);
    await host.stop();
    await host.cli('select-pricing', 'example.standard-pricing/standard');
    await host.cli('select', 'helmsman/costs-page', 'helmsman.costs/page');
    origin = await host.start();
    expect(await (await request.get(`${origin}/api/pricing/v1?${query}`)).json()).toMatchObject({ estimatedUnreportedCostUsd: 10 });
    await page.goto(`${origin}/outcomes?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'Costs & Outcomes' })).toBeVisible();
    await expect(page.locator('section.outcomes-view')).toContainText('$10.00 estimated');
    expect(await (await request.get(`${origin}/api/usage/v1?${query}`)).json()).toEqual(measured);
    expect(errors).toEqual([]);
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});

test('safe start preserves blocked runs and artifacts and rejects every provider action', async ({ page, request }) => {
  const host = await fixture();
  try {
    const installed = await host.installSample();
    const marker = join(host.cwd, 'retained-worktree', 'keep.txt');
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, 'Retain this worktree.');
    const dbUrl = pathToFileURL(join(host.app, 'server/helmsman/db.js')).href;
    const row = { id: 'blocked_run', ticketId: 'TEST-1', repo: 'org/a', adapter: 'pre-pr-codex', status: 'running', attempt: 1,
      prNumber: null, startedAt: '2026-09-20T00:00:00Z', endedAt: null, costUsd: null, worktreePath: dirname(marker),
      hostKind: 'detached', hostRef: JSON.stringify({ kind: 'detached', pid: 999999 }), taskJson: '{"private":"must-not-leak"}' };
    await host.script('seed.mjs', `import { openDb } from ${JSON.stringify(dbUrl)}; const db = openDb(process.env.HELMSMAN_DB); db.insertRun(${JSON.stringify(row)}); db.close();`);
    const artifact = join(host.env.HELMSMAN_PLUGINS_DIR!, 'artifacts', `${installed.plugins[0]?.hash}.json`);
    const before = await readFile(artifact);
    const origin = await host.start(true);
    const recovery = await request.get(`${origin}/api/recovery`);
    expect(recovery.status()).toBe(200);
    const diagnostics = await recovery.json();
    expect(diagnostics).toMatchObject({ mode: 'safe-start', readOnly: true, runs: [expect.objectContaining({ id: 'blocked_run' })] });
    expect(JSON.stringify(diagnostics)).not.toContain('must-not-leak');
    await page.goto(`${origin}/recovery`);
    await expect(page.getByRole('heading', { name: 'Safe start' })).toBeVisible();
    await expect(page.locator('script')).toHaveCount(0);
    for (const path of ['/api/cmux/tabs', '/api/clarifications/poll']) expect((await request.get(`${origin}${path}`)).status()).toBe(503);
    for (const path of ['/api/runs', '/api/agents/start', '/api/campaigns', '/api/config', '/api/webhooks/github']) {
      expect((await request.post(`${origin}${path}`, { data: {} })).status()).toBe(503);
    }
    expect(await (await request.get(`${origin}/api/slack`)).json()).toMatchObject({ health: { enabled: false, status: 'disabled' } });
    await page.goto(`${origin}/outcomes?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
    await host.stop();
    const persisted = JSON.parse(await host.script('inspect.mjs', `import { openDb } from ${JSON.stringify(dbUrl)}; const db = openDb(process.env.HELMSMAN_DB); console.log(JSON.stringify(db.getRun('blocked_run'))); db.close();`));
    expect(persisted).toMatchObject(row);
    expect(await readFile(marker, 'utf8')).toBe('Retain this worktree.');
    expect(await readFile(artifact)).toEqual(before);
    expect(await readFile(host.commandLog, 'utf8').catch(() => '')).toBe('');
  } finally { await host.close(); }
});

test('normal recovery retains legacy ownership across restart and backs up only an offline persistence set', async ({ request }) => {
  const host = await fixture();
  try {
    await host.installSample();
    const marker = join(host.cwd, 'legacy-worktree', 'keep.txt');
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, 'Retained legacy execution');
    const module = (name: string) => pathToFileURL(join(host.app, 'server/helmsman', name)).href;
    await host.script('seed-legacy.mjs', `
      import { openDb } from ${JSON.stringify(module('db.js'))};
      const db = openDb(process.env.HELMSMAN_DB);
      db.insertRun({ id:'legacy_active',repo:'org/a',ticketId:'OLD-1',adapter:'codex',status:'running',attempt:1,
        prNumber:null,startedAt:'2026-09-20T00:00:00.000Z',endedAt:null,costUsd:null,worktreePath:${JSON.stringify(dirname(marker))},
        hostKind:'detached',hostRef:JSON.stringify({kind:'detached',pid:999999}),
        taskJson:JSON.stringify({repo:'org/a',ticketId:'OLD-1',title:'Old work',jiraBaseUrl:'https://jira.example.test'}) });
      db.close();
    `);
    const origin = await host.start();
    const snapshot = await (await request.get(`${origin}/api/recovery?repo=org%2Fa`)).json();
    expect(snapshot).toMatchObject({ mode: 'normal', runs: [expect.objectContaining({ id: 'legacy_active', status: 'running', protected: true })],
      reservations: [expect.objectContaining({ runId: 'legacy_active', repo: 'org/a' })] });
    await expect(run(process.execPath, [join(host.app, 'server/helmsman/main.js')], host.cwd, host.env)).rejects.toThrow('active database writer');
    const backup = join(host.root, 'consistent-backup');
    await expect(host.cli('backup', backup)).rejects.toThrow('active database writer');
    const portBefore = await readFile(join(host.env.RUNS_DIR!, '.gateway-port.json'), 'utf8');
    await host.stop();
    await host.cli('backup', backup);
    const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
    expect(manifest.files).toHaveLength(3);
    const restarted = await host.start();
    expect(await readFile(join(host.env.RUNS_DIR!, '.gateway-port.json'), 'utf8')).toBe(portBefore);
    expect(await (await request.get(`${restarted}/api/recovery?repo=org%2Fa`)).json()).toMatchObject({
      runs: [expect.objectContaining({ id: 'legacy_active', status: 'running', protected: true })],
    });
    expect(await readFile(marker, 'utf8')).toBe('Retained legacy execution');
  } finally { await host.close(); }
});


test('task source adoption preserves local identity and disabled state through the production API and restart', async ({ page, request }) => {
  const host = await fixture();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    host.env.REPO_PROJECT_MAP = 'org/a=TASK';
    host.env.AGENT_MAX_ATTEMPTS = '1';
    host.env.RUN_HOST = 'detached';
    await host.installPreflightFailureAgent();
    await seedCheckout(host, 'org/a');
    const descriptor = await host.installAuthorPackage('plugin-sources/local-tasks-alternative');
    let origin = await host.start();
    const instances = (await (await request.get(`${origin}/api/task-sources?repo=org/a`)).json()).instances;
    const original = instances.find((instance: { providerId: string }) => instance.providerId === 'helmsman.todos/todos');
    expect(original).toMatchObject({ available: true, desiredEnabled: true });
    const input = { title: 'Preserved task', description: 'Use the public source protocol', acceptanceCriteria: '', priority: 'P2', repo: 'org/a' };
    const created = await request.post(`${origin}/api/todos?requestId=isolated-create`, { data: input });
    expect(created.ok()).toBe(true);
    const todo = (await created.json()).todo;
    expect((await (await request.post(`${origin}/api/todos?requestId=isolated-create`, { data: input })).json()).todo).toEqual(todo);
    const listed = await request.get(`${origin}/api/task-sources/${original.id}/tasks?revision=${original.revision}&repo=org/a`);
    expect(listed.ok()).toBe(true);
    expect((await listed.json()).items).toContainEqual(expect.objectContaining({ url: null, repo: 'org/a', displayKey: todo.id, ref: { sourceId: original.sourceId, externalId: todo.id } }));
    const options = await (await request.get(`${origin}/api/task-sources/adoption?sourceId=${original.sourceId}`)).json();
    const candidate = options.candidates.find((item: { providerId: string }) => item.providerId.startsWith(`${descriptor.manifest.id}/`));
    expect(candidate).toBeDefined();
    const validated = await request.post(`${origin}/api/task-sources/adoption/validate`, { data: {
      sourceId: original.sourceId, sourceRevision: options.sourceRevision, ...candidate, repo: 'org/a', actor: 'integration-test', reason: 'Replace provider through public contracts',
    } });
    expect(validated.ok()).toBe(true);
    const validation = await validated.json();
    const committed = await request.post(`${origin}/api/task-sources/adoption/commit`, { data: { validationId: validation.validationId } });
    expect(committed.ok()).toBe(true);
    expect((await (await request.get(`${origin}/api/todos`)).json()).todos).toEqual([todo]);
    const disabled = await request.post(`${origin}/api/task-sources/${validation.instanceId}/enablement`, { data: { instanceRevision: 1, desiredEnabled: false } });
    expect(disabled.ok()).toBe(true);
    origin = await host.start();
    const restarted = (await (await request.get(`${origin}/api/task-sources?repo=org/a`)).json()).instances;
    expect(restarted.find((item: { id: string }) => item.id === validation.instanceId)).toMatchObject({ desiredEnabled: false, available: false, revision: 2 });
    await page.goto(`${origin}/todos?repo=org/a`);
    await expect(page.locator('.plugin-todos').first()).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/todos');
    expect(new URL(page.url()).searchParams.get('repo')).toBe('org/a');
    expect((await request.post(`${origin}/api/task-sources/${validation.instanceId}/enablement`, { data: { instanceRevision: 2, desiredEnabled: true } })).ok()).toBe(true);
    expect((await (await request.get(`${origin}/api/todos`)).json()).todos).toEqual([todo]);
    const launch = await request.post(`${origin}/api/agents/launch`, { data: { mode: 'source', repo: 'org/a',
      sourceInstanceId: validation.instanceId, sourceInstanceRevision: 3, workRef: { sourceId: original.sourceId, externalId: todo.id } } });
    expect(launch.ok()).toBe(true);
    const { runId } = await launch.json();
    await expect.poll(async () => (await (await request.get(`${origin}/api/agents/${runId}`)).json()).status, { timeout: 15_000 }).toBe('failed');
    await expect.poll(async () => (await (await request.get(`${origin}/api/todos`)).json()).todos[0]?.state).toBe('todo');
    expect((await (await request.get(`${origin}/api/todos`)).json()).todos[0]?.runId).toBeNull();
    expect(errors).toEqual([]);
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});


test('operator-seeded Jira stays on its namespace through an explicit provider refresh after an app upgrade', async ({ request }) => {
  const host = await fixture();
  try {
    const issue = { id: '101', key: 'TASK-1', fields: { summary: 'Retained Jira identity', updated: '2026-09-20T00:00:00.000Z',
      description: 'Do the task', status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } }, project: { key: 'TASK' }, assignee: null } };
    const broker = join(host.root, 'jira-fixture.mjs');
    await writeFile(broker, `const original=globalThis.fetch; globalThis.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url??String(input));
      if(url.origin!=='https://fixture.atlassian.net') return original(input,init);
      if(init?.method && init.method!=='GET') throw new Error('Read-only refresh attempted a mutation');
      if(url.pathname==='/rest/api/3/myself') return Response.json({accountId:'same-subject'});
      if(url.pathname==='/_edge/tenant_info') return Response.json({}, {status:404});
      if(url.pathname==='/rest/api/3/search/jql') return Response.json({issues:[${JSON.stringify(issue)}],isLast:true});
      if(url.pathname==='/rest/api/3/issue/101') return Response.json(${JSON.stringify(issue)});
      return Response.json({}, {status:404});
    };`);
    Object.assign(host.env, { JIRA_ENABLED: 'true', JIRA_BASE_URL: 'https://fixture.atlassian.net', JIRA_EMAIL: 'fixture@example.test', JIRA_API_TOKEN: 'fixture-token',
      JIRA_PROJECT: 'TASK', JIRA_ASSIGNEE: 'same-subject', REPO_PROJECT_MAP: 'org/a=TASK', NODE_OPTIONS: `${host.env.NODE_OPTIONS} --import=${pathToFileURL(broker).href}` });
    let origin = await host.start();
    const original = (await (await request.get(`${origin}/api/task-sources?repo=org/a`)).json()).instances.find((value: { providerId: string }) => value.providerId === 'helmsman.jira/issues');
    expect(original).toMatchObject({ available: true, identityLevel: 'operator-seeded' });
    const query = `revision=${original.revision}&repo=org/a`;
    const tasks = await (await request.get(`${origin}/api/task-sources/${original.id}/tasks?${query}`)).json();
    expect(tasks.items[0]?.ref).toEqual({ sourceId: original.sourceId, externalId: '101' });
    await host.stop();
    const entry = join(host.app, 'server/helmsman/application.js');
    await writeFile(entry, `${await readFile(entry, 'utf8')}\n`);
    origin = await host.start();
    const unavailable = (await (await request.get(`${origin}/api/task-sources?repo=org/a`)).json()).instances.find((value: { id: string }) => value.id === original.id);
    expect(unavailable.available).toBe(false);
    const options = await (await request.get(`${origin}/api/task-sources/refresh?sourceId=${original.sourceId}`)).json();
    expect(options.candidates).toHaveLength(1);
    const response = await request.post(`${origin}/api/task-sources/refresh/validate`, { data: { sourceId: original.sourceId, sourceRevision: options.sourceRevision,
      ...options.candidates[0], repo: 'org/a', actor: 'integration-test', reason: 'Refresh the same provider after application upgrade' } });
    expect(response.ok()).toBe(true);
    const validation = await response.json();
    expect((await request.post(`${origin}/api/task-sources/refresh/commit`, { data: { validationId: validation.validationId } })).ok()).toBe(true);
    host.env.JIRA_ENABLED = 'false';
    origin = await host.start();
    const refreshed = (await (await request.get(`${origin}/api/task-sources?repo=org/a`)).json()).instances.find((value: { id: string }) => value.id === validation.instanceId);
    expect(refreshed).toMatchObject({ sourceId: original.sourceId, identityLevel: 'operator-seeded', desiredEnabled: true, available: true });
    const after = await (await request.get(`${origin}/api/task-sources/${refreshed.id}/tasks?revision=${refreshed.revision}&repo=org/a`)).json();
    expect(after.items[0]?.ref).toEqual(tasks.items[0]?.ref);
    expect((await request.get(`${origin}/api/task-sources/adoption?sourceId=${original.sourceId}`)).status()).toBe(409);
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});

test('independently compiled Running and Recent panels keep scoped run commands durable in the isolated production host', async ({ page, request }) => {
  test.setTimeout(90_000);
  await seedBacklogLayout(page);
  const host = await fixture(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER,org/c=RETRY'; host.env.AGENT_MAX_CONCURRENCY = '8'; host.env.AGENT_MAX_ATTEMPTS = '1'; host.env.RUN_HOST = 'detached';
  try {
    await expect(host.script('prove-run-panel-isolation.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/sdk.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await host.installAuthorPackage('plugin-sources/running', 'example.running', { buildScript: true });
    const recentPackage = await host.installAuthorPackage('plugin-sources/recent', 'example.recent', { buildScript: true });
    await host.cli('select-agent', 'helmsman.agent-claude/claude-code');
    await host.cli('select-agent-reviewers', 'helmsman.agent-claude/claude-code');
    const checkout = join(host.cwd, 'c'); const bare = join(host.root, 'retry-remote.git'); const git = gitBin();
    await mkdir(checkout);
    for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Acceptance']]) await run(git, args, checkout, host.env);
    await writeFile(join(checkout, 'code.txt'), 'initial\n');
    for (const args of [['add', '.'], ['commit', '-m', 'initial'], ['clone', '--bare', checkout, bare], ['remote', 'add', 'origin', 'https://github.com/org/c.git']]) await run(git, args, checkout, host.env);
    await writeFile(join(host.root, 'commands/git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'); const args=process.argv.slice(2); if(args[0]==='fetch') args[args.indexOf('origin')]=${JSON.stringify(bare)}; const result=spawnSync(${JSON.stringify(git)},args,{stdio:'inherit'}); process.exit(result.status??1);`, { mode: 0o755 });
    await writeFile(join(host.root, 'commands/gh'), `#!${process.execPath}\nif(process.argv[2]==='repo'&&process.argv[3]==='view') console.log(JSON.stringify({nameWithOwner:'org/c',defaultBranchRef:{name:'main'}})); else process.exit(1);`, { mode: 0o755 });
    const dbUrl = pathToFileURL(join(host.app, 'server/helmsman/db.js')).href;
    await host.script('seed-run-panels.mjs', `import { openDb } from ${JSON.stringify(dbUrl)};
const db = openDb(process.env.HELMSMAN_DB);
const now = new Date().toISOString();
for (const [id,repo,status,ticketId] of [['active_a','org/a','running','TASK-1'],['active_b','org/b','running','OTHER-1'],['failed_a','org/c','failed','freeform'],['review_a','org/a','succeeded','review']]) {
  db.insertRun({id,repo,status,ticketId,adapter:'codex',attempt:3,prNumber:id==='review_a'?7:null,startedAt:now,endedAt:status==='running'?null:now,costUsd:null,worktreePath:null,
    launchJson:id==='failed_a'?JSON.stringify({repo,mode:'freeform',task:'Repeat the isolated task requirements'}):null});
}
db.appendEvent('review_a','review-verdict','Verdict: Request changes — Add a regression test.',now);
db.close();`);
    const origin = await host.start();
    const admitted = await request.post(`${origin}/api/agents/launch`, { data: { mode: 'freeform', repo: 'org/c', task: 'Retain provider bindings for a deliberately failed retry fixture.' } });
    expect(admitted.ok(), await admitted.text()).toBe(true);
    const retryableId = (await admitted.json()).runId;
    expect(typeof retryableId).toBe('string');
    await expect.poll(async () => (await (await request.get(`${origin}/api/agents/${retryableId}`)).json()).status, { timeout: 25_000 }).toBe('failed');
    const inventory = await (await request.get(`${origin}/api/recovery?repo=org/c`)).json();
    const checkpoints = inventory.checkpoints?.filter((checkpoint: { runId?: string }) => checkpoint?.runId === retryableId) ?? [];
    expect(checkpoints).toEqual([expect.objectContaining({ id: expect.any(String), state: 'resumable' })]);
    const retired = await request.post(`${origin}/api/recovery/actions`, { data: { action: 'retire-checkpoint', id: checkpoints[0]?.id,
      actor: 'integration-test', reason: 'Discard the failed fixture checkpoint before starting a fresh retry.', evidence: { runId: retryableId, fixture: true } } });
    expect(retired.ok(), await retired.text()).toBe(true);
    const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(host.app, `server/helmsman/${name}.js`)).href);
    expect(await host.script('cleanup-retry-fixture.mjs', `import {openPersistence} from ${moduleUrl('persistence')};
import {openExecutionOwnership} from ${moduleUrl('execution-ownership')};
import {openExecutionStore} from ${moduleUrl('execution-store')};
import {createExecutionCleanup} from ${moduleUrl('execution-cleanup')};
import {describeLocalCheckout,withWorktreeMaintenance,verifyWorktreeAbsent,removeCleanWorktreeAt} from ${moduleUrl('worktree')};
const persistence=openPersistence(process.env.HELMSMAN_DB);try{
  const runId=${JSON.stringify(retryableId)},checkout=describeLocalCheckout(process.env.AGENTS_ROOT,'org/c',runId);
  const executions=openExecutionStore(persistence,Date.now,{preferSchema:2});
  const cleanup=createExecutionCleanup({persistence,executions,withMaintenance:withWorktreeMaintenance,
    verifyAbsent:async(repo,path)=>{if(!await verifyWorktreeAbsent(repo,path))throw new Error('Fixture workspace remains');}});
  await cleanup.remove({runId,repoDirectory:checkout.path,commonDirectory:checkout.commonDirectory,workspace:checkout.workspacePath,
    remove:async()=>{if(!await verifyWorktreeAbsent(checkout.path,checkout.workspacePath))await removeCleanWorktreeAt(checkout.path,checkout.workspacePath);}});
  console.log(openExecutionOwnership(persistence).get(runId)?.state);
}finally{persistence.close();}`)).toBe('released\n');
    await page.goto(`${origin}/helm?repo=org/a`); await expect(page.locator('.plugin-helm')).toBeVisible();
    await page.getByText('Manage panels', { exact: true }).click();
    for (const name of ['running', 'recent']) {
      if (await page.locator(`.plugin-${name}`).count() === 0) {
        await page.getByLabel('Panel to add', { exact: true }).selectOption(`helmsman.${name}/panel`);
        await page.getByRole('button', { name: 'Add panel', exact: true }).click();
      }
      await expect(page.locator(`.plugin-${name}`)).toBeVisible();
    }
    await expect(page.locator('.plugin-running').getByText('TASK-1', { exact: true })).toBeVisible();
    await expect(page.locator('.plugin-running').getByText('OTHER-1', { exact: true })).toHaveCount(0);
    await expect(page.locator('.plugin-recent').getByText('Worker: succeeded', { exact: true })).toBeVisible();
    await page.getByLabel('Implementation for Running', { exact: false }).selectOption('example.running/panel');
    await page.getByLabel('Implementation for Recent', { exact: false }).selectOption('example.recent/panel');
    await page.getByLabel(`Scope for ${recentPackage.manifest.panels[0].title}`, { exact: false }).selectOption('all');
    await page.getByText('Manage panels', { exact: true }).click();
    await expect(page.locator('.plugin-running').getByText('TASK-1', { exact: true })).toBeVisible();
    await expect(page.locator('.plugin-recent').getByText('Review recommendation: Request changes — Verdict: Request changes — Add a regression test.', { exact: true })).toBeVisible();
    await page.locator('.plugin-running').getByRole('button', { name: /^Stop / }).click();
    await expect(page.locator('.plugin-running').getByText('Stop requested. Worker status is reported separately.', { exact: true })).toBeVisible();
    await expect(page.locator('.plugin-running').getByText('Worker: Underway', { exact: true })).toBeVisible();
    const historical = page.locator('.plugin-recent [data-run-id="failed_a"]');
    await historical.getByRole('button', { name: /^Retry / }).click();
    await expect(historical.getByText('Request rejected: Legacy agent bindings cannot be migrated by retry. Continue the original retained voyage or start a new voyage.', { exact: true })).toBeVisible();
    await page.locator(`.plugin-recent [data-run-id="${retryableId}"]`).getByRole('button', { name: /^Retry / }).click();
    await expect(page.locator('.plugin-recent').getByText('Retry accepted. The original worker outcome is unchanged.', { exact: true })).toBeVisible();
    const newRun = page.locator('.plugin-recent').getByRole('link', { name: 'Open new voyage', exact: true });
    const href = await newRun.getAttribute('href'); const runUrl = new URL(href!, origin);
    expect(runUrl.searchParams.get('repo')).toBe('org/a'); expect(runUrl.searchParams.get('runRepo')).toBe('org/c');
    const commandRunId = runUrl.searchParams.get('run'); expect(commandRunId).toBeTruthy();
    await page.reload();
    await expect(page.locator('.plugin-running').getByText('Stop requested. Worker status is reported separately.', { exact: true })).toBeVisible();
    await expect(newRun).toHaveAttribute('href', href!);
    await expect(page.locator('.plugin-recent [data-run-id="failed_a"]').getByText('Worker: failed', { exact: true })).toBeVisible();
    const duplicate = await request.post(`${origin}/api/run-commands`, { headers: { 'X-Helmsman-Contribution': 'helmsman.recent/panel' },
      data: { version: 1, repo: 'org/c', requestId: '00000000-0000-4000-8000-000000000077', action: 'retry', target: { runId: retryableId, expectedAttempt: 1 } } });
    expect(duplicate.ok()).toBe(true); expect(await duplicate.json()).toMatchObject({ status: 'rejected' });
    await host.cli('disable', 'example.recent');
    await expect(page.getByText('This panel is unavailable. Enable or install its plugin to bring it aboard.', { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.reload(); await expect(page.locator('.plugin-recent')).toHaveCount(0);
    await host.cli('enable', 'example.recent');
    await expect(newRun).toHaveAttribute('href', href!, { timeout: 15_000 });
    const recovery = await request.get(`${origin}/api/recovery`); expect(recovery.ok()).toBe(true);
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});

test('source-denied New Run and Underway packages preserve typed task identity, drafts and launch receipts', async ({ page, request }) => {
  test.setTimeout(90_000);
  await seedBacklogLayout(page);
  const host = await fixture(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  host.env.AGENT_MAX_ATTEMPTS = '1'; host.env.AGENT_MAX_CONCURRENCY = '8'; host.env.RUN_HOST = 'detached';
  try {
    await expect(host.script('prove-launch-panel-isolation.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/newrun/panel.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await host.installPreflightFailureAgent();
    await seedCheckout(host, 'org/a');
    await host.installAuthorPackage('plugin-sources/newrun', 'example.newrun');
    await host.installAuthorPackage('plugin-sources/underway', 'example.underway');
    const origin = await host.start();
    const created = await request.post(`${origin}/api/todos?requestId=newrun-isolated-create`, { data: { title: 'Canonical isolated task', description: 'Run only the isolated fake command', acceptanceCriteria: '', priority: 'P2', repo: 'org/a' } });
    expect(created.ok()).toBe(true); const todo = (await created.json()).todo;
    const underwayCreated = await request.post(`${origin}/api/todos?requestId=underway-isolated-create`, { data: { title: 'Unfinished isolated task', description: 'Keep assigned unfinished work visible', acceptanceCriteria: '', priority: 'P2', repo: 'org/a' } });
    expect(underwayCreated.ok()).toBe(true); const unfinished = (await underwayCreated.json()).todo;
    expect((await request.put(`${origin}/api/todos/${unfinished.id}?requestId=underway-isolated-state`, { data: { state: 'in_review' } })).ok()).toBe(true);
    const instances = (await (await request.get(`${origin}/api/task-sources?repo=org/a`)).json()).instances;
    const local = instances.find((instance: { providerId: string }) => instance.providerId === 'helmsman.todos/todos');
    expect(local).toMatchObject({ available: true, readViews: expect.arrayContaining(['underway']) });
    const commands: Record<string, unknown>[] = []; const delivered: Record<string, unknown>[] = []; let loseNext = true;
    await page.route('**/api/run-commands', async route => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      const response = await route.fetch(); delivered.push(await response.json() as Record<string, unknown>);
      if (loseNext) { loseNext = false; await route.abort('failed'); } else await route.fulfill({ response });
    });
    await page.goto(`${origin}/helm?repo=org/a`); await expect(page.locator('.plugin-helm')).toBeVisible();
    await page.getByText('Manage panels', { exact: true }).click();
    for (const name of ['newrun', 'underway']) {
      await page.getByLabel('Panel to add', { exact: true }).selectOption(`example.${name}/panel`);
      await page.getByRole('button', { name: 'Add panel', exact: true }).click(); await expect(page.locator(`.plugin-${name}`)).toBeVisible();
    }
    await page.getByText('Manage panels', { exact: true }).click();
    const newrun = page.locator('.plugin-newrun'); const underway = page.locator('.plugin-underway');
    const unfinishedTask = underway.getByRole('listitem').filter({ has: page.getByText('Unfinished isolated task', { exact: true }) });
    await expect(unfinishedTask.getByText('Unfinished isolated task', { exact: true })).toBeVisible();
    await expect(unfinishedTask.getByText(unfinished.id, { exact: true })).toBeVisible();
    await newrun.getByLabel('Task instructions', { exact: true }).fill('A retained draft for org/a');
    await newrun.getByRole('button', { name: 'Save draft', exact: true }).click();
    await page.locator('.repo-select').selectOption('org/b');
    await newrun.getByLabel('Task instructions', { exact: true }).fill('A different draft for org/b');
    await newrun.getByRole('button', { name: 'Save draft', exact: true }).click(); await page.reload();
    await expect(newrun.getByLabel('Task instructions', { exact: true })).toHaveValue('A different draft for org/b');
    await expect(unfinishedTask).toHaveCount(0);
    await page.locator('.repo-select').selectOption('org/a');
    await expect(newrun.getByLabel('Task instructions', { exact: true })).toHaveValue('A retained draft for org/a');
    await newrun.getByLabel('Launch mode', { exact: true }).selectOption('source');
    const sourceChoice = () => newrun.getByLabel('Task source', { exact: true }).locator('option').evaluateAll((options, instanceId) =>
      options.find(option => { try { return JSON.parse((option as HTMLOptionElement).value)[2] === instanceId; } catch { return false; } })?.getAttribute('value'), local.id);
    await expect.poll(sourceChoice).toBeTruthy();
    const sourceOption = await sourceChoice();
    expect(sourceOption).toBeTruthy(); await newrun.getByLabel('Task source', { exact: true }).selectOption(sourceOption!);
    await newrun.getByLabel('Task key', { exact: true }).fill(todo.id); await newrun.getByRole('button', { name: 'Find task', exact: true }).click();
    await expect(newrun.getByLabel('Task', { exact: true })).toHaveValue(JSON.stringify([local.sourceId, todo.id]));
    await newrun.getByRole('button', { name: 'Weigh anchor', exact: true }).click();
    await expect(newrun.getByText('org/a · source · delivery unconfirmed', { exact: true })).toBeVisible();
    expect(commands[0]).toMatchObject({ action: 'launch', repo: 'org/a', launch: { mode: 'source', workRef: { sourceId: local.sourceId, externalId: todo.id }, sourceInstanceId: local.id, sourceInstanceRevision: local.revision } });
    expect(delivered[0]).toMatchObject({ status: 'accepted', action: 'launch', repo: 'org/a' });
    await page.reload();
    const stalePeer = await page.context().newPage();
    await stalePeer.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: undefined }); });
    await stalePeer.goto(`${origin}/helm?repo=org/a`);
    const staleNewrun = stalePeer.locator('.plugin-newrun');
    await expect(staleNewrun.getByRole('button', { name: 'Retry delivery', exact: true })).toBeEnabled();
    let stalePosts = 0;
    stalePeer.on('request', request => { if (new URL(request.url()).pathname === '/api/run-commands' && request.method() === 'POST') stalePosts++; });
    await newrun.getByRole('button', { name: 'Retry delivery', exact: true }).click();
    await expect(newrun.getByRole('link', { name: 'Open voyage', exact: true })).toBeVisible();
    expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]); expect(delivered[1]).toEqual(delivered[0]);
    const href = await newrun.getByRole('link', { name: 'Open voyage', exact: true }).getAttribute('href');
    expect(new URL(href!, origin).searchParams.get('run')).toBe(delivered[0]?.runId);
    await page.reload(); await expect(newrun.getByRole('link', { name: 'Open voyage', exact: true })).toHaveAttribute('href', href!);
    await newrun.getByRole('button', { name: 'Dismiss request', exact: true }).click(); await expect(newrun.getByRole('heading', { name: 'Saved launch requests', exact: true })).toHaveCount(0);
    await expect.poll(() => pendingCommandCount(page, 'helmsman.run-commands', 'example.newrun/panel')).toBe(0);
    await staleNewrun.getByRole('button', { name: 'Retry delivery', exact: true }).click();
    await expect(staleNewrun.getByRole('heading', { name: 'Saved launch requests', exact: true })).toHaveCount(0);
    expect(stalePosts).toBe(0);
    expect(await pendingCommandCount(page, 'helmsman.run-commands', 'example.newrun/panel')).toBe(0);
    await stalePeer.close();
    await page.reload(); await expect(newrun.getByRole('heading', { name: 'Saved launch requests', exact: true })).toHaveCount(0);
    await expect.poll(async () => (await (await request.get(`${origin}/api/agents/${delivered[0]?.runId}`)).json()).status, { timeout: 15_000 }).toBe('failed');
    await expect(underway.getByText('Not ready for a new run.', { exact: true })).toBeVisible();
    await expect(underway.getByRole('button', { name: 'Launch', exact: true })).toHaveCount(0);
    expect(commands).toHaveLength(2);
    await host.cli('disable', 'example.newrun');
    await expect(page.getByText('This panel is unavailable. Enable or install its plugin to bring it aboard.', { exact: true })).toBeVisible({ timeout: 15_000 });
    await host.cli('enable', 'example.newrun'); await expect(newrun.getByLabel('Task key', { exact: true })).toHaveValue(todo.id, { timeout: 15_000 });
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});
