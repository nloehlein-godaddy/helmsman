import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const pluginId = 'example.isolated';
const contribution = `${pluginId}/page`;

async function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', value => { output += String(value); });
    child.stderr.on('data', value => { output += String(value); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`Command timed out: ${output}`)); }, 20_000);
    child.on('error', error => { clearTimeout(timer); fail(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? done(output) : fail(new Error(`Command failed (${code}): ${output}`)); });
  });
}

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-isolated-'));
  const app = join(root, 'application');
  const cwd = join(root, 'operator-data');
  const store = join(root, 'plugins');
  const fakeBin = join(root, 'commands');
  await Promise.all([mkdir(cwd), mkdir(fakeBin), cp(join(sourceRoot, 'release'), app, { recursive: true }),
    cp(fileURLToPath(new URL('./deny-source.mjs', import.meta.url)), join(root, 'deny-source.mjs'))]);
  const commandLog = join(root, 'provider-commands.log');
  for (const name of ['git', 'gh', 'cmux', 'wezterm', 'docker', 'osascript']) {
    await writeFile(join(fakeBin, name), '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$HELMSMAN_TEST_COMMAND_LOG"\nexit 1\n', { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = {
    PATH: `${fakeBin}:${dirname(process.execPath)}`, HELMSMAN_PORT: '0', HELMSMAN_PLUGINS_DIR: store,
    HELMSMAN_DB: join(cwd, 'state.sqlite'), AGENTS_ROOT: cwd, RUNS_DIR: join(cwd, 'runs'),
    JIRA_ENABLED: 'false', SLACK_ENABLED: 'false', SLACK_WATCH_ENABLED: 'false', GITHUB_REVIEW_WATCH_ENABLED: 'false',
    HELMSMAN_TEST_SOURCE: resolve(sourceRoot), HELMSMAN_TEST_COMMAND_LOG: commandLog,
    NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'deny-source.mjs')).href}`,
  };
  const cli = (...args: string[]) => run(process.execPath, [join(app, 'server/helmsman/plugins/cli.js'), ...args], cwd, env);
  let server: ChildProcess | undefined;
  let serverOutput = '';
  let allServerOutput = '';
  async function stop() {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const child = server;
    await new Promise<void>(done => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      child.once('exit', () => { clearTimeout(timer); done(); });
      child.kill('SIGTERM');
    });
    server = undefined;
  }
  async function start(safe = false): Promise<string> {
    await stop();
    serverOutput = '';
    const child = spawn(process.execPath, [join(app, 'server/helmsman/main.js'), ...(safe ? ['--safe-start'] : [])], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server = child;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`Server failed to start: ${serverOutput}`)), 20_000);
      child.stdout?.on('data', data => {
        serverOutput += String(data);
        allServerOutput += String(data);
        const match = /Helmsman[^\n]*:(\d+)/.exec(serverOutput);
        if (match?.[1] && Number(match[1]) > 0) { clearTimeout(timer); done(`http://127.0.0.1:${match[1]}`); }
      });
      child.stderr?.on('data', data => { serverOutput += String(data); allServerOutput += String(data); });
      child.on('error', error => { clearTimeout(timer); fail(error); });
      child.on('exit', code => { clearTimeout(timer); fail(new Error(`Server exited (${code}): ${serverOutput}`)); });
    });
  }
  async function script(name: string, content: string) {
    const path = join(root, name);
    await writeFile(path, content);
    return run(process.execPath, [path], cwd, env);
  }
  async function installSample() {
    const author = join(root, 'independent-author');
    const output = join(author, 'output');
    await mkdir(output, { recursive: true });
    await cp(join(app, 'sdk'), join(author, 'node_modules/@helmsman/plugin-sdk'), { recursive: true });
    await writeFile(join(author, 'package.json'), '{"type":"module"}');
    await writeFile(join(author, 'page.ts'), `import type { PluginPageModule, PluginPageState } from '@helmsman/plugin-sdk';
const page: PluginPageModule = { mount(container, context) {
  const heading = document.createElement('h1'); heading.textContent = 'Isolated TypeScript page';
  const scope = document.createElement('p'); scope.dataset.isolatedScope = '';
  container.replaceChildren(heading, scope);
  const update = (state: PluginPageState): void => { scope.textContent = state.repo ?? 'All'; };
  update(context.state);
  return { update, dispose() { container.replaceChildren(); } };
} };
export default page;
`);
    await run(process.execPath, [join(sourceRoot, 'node_modules/typescript/bin/tsc'), '--strict', '--target', 'ES2023',
      '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--outDir', output, '--noEmitOnError', join(author, 'page.ts')], author,
    { PATH: env.PATH });
    await writeFile(join(output, 'plugin-package.json'), JSON.stringify({ packageVersion: 1,
      manifest: { manifestVersion: 1, id: pluginId, version: '0.1.0', sdkVersion: 1,
        pages: [{ id: 'page', title: 'Isolated TypeScript page', slots: ['helmsman/costs-page'], panes: [] }] },
      node: { minMajor: 22, maxMajorExclusive: 26 }, entries: { page: 'page.js' },
    }));
    const archive = join(root, 'sample.hmp');
    await cli('pack', output, archive);
    await cli('install', archive);
    await cli('enable', pluginId);
    await cli('select', 'helmsman/costs-page', contribution);
    return JSON.parse(await cli('list')) as { plugins: { id: string; hash: string; enabled: boolean }[] };
  }
  async function installAuthorPackage(relative: string) {
    const author = join(root, `author-${relative.replaceAll('/', '-')}`);
    await cp(join(app, relative), author, { recursive: true });
    await cp(join(app, 'sdk'), join(author, 'node_modules/@helmsman/plugin-sdk'), { recursive: true });
    const output = join(author, 'compiled');
    await run(process.execPath, [join(sourceRoot, 'node_modules/typescript/bin/tsc'), '-p', author, '--outDir', output], author, { PATH: env.PATH });
    await cp(join(author, 'plugin-package.json'), join(output, 'plugin-package.json'));
    const descriptor = JSON.parse(await readFile(join(author, 'plugin-package.json'), 'utf8'));
    const archive = join(author, 'plugin.hmp');
    await cli('pack', output, archive);
    await cli('install', archive);
    await cli('enable', descriptor.manifest.id);
    return descriptor;
  }
  return { root, app, cwd, env, commandLog, cli, script, installSample, installAuthorPackage, start, stop,
    output: () => allServerOutput,
    async close() { await stop(); await rm(root, { recursive: true, force: true }); },
  };
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
    await page.goto(`${origin}/plugins/${contribution}`);
    await expect(page.getByRole('heading', { name: 'Isolated TypeScript page' })).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-isolated-scope]')).toHaveText('All');
    await page.goto(`${origin}/outcomes?repo=org/a`);
    await expect(page.locator('[data-isolated-scope]')).toHaveText('org/a');
    await page.goto(`${origin}/runs`);
    await expect(page.locator('.helm')).toHaveAttribute('data-page', 'runs');
    const missing = await request.get(`${origin}/plugin-assets/${pluginId}/${installed.plugins[0]?.hash}/missing.js`);
    expect(missing.status()).toBe(404);
    expect(await missing.text()).not.toContain('<html');
    await host.stop();
    await host.cli('disable', pluginId);
    const disabledOrigin = await host.start();
    await page.goto(`${disabledOrigin}/outcomes`);
    await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
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
    await page.goto(`${origin}/outcomes`);
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
    host.env.AGENT_ADAPTER = 'command';
    host.env.AGENT_CMD = '/usr/bin/false';
    host.env.AGENT_MAX_ATTEMPTS = '1';
    host.env.RUN_HOST = 'detached';
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
    const dashboard = await (await request.get(`${origin}/api/dashboard?repo=org/a`)).json();
    expect(dashboard.snapshot.queue).toContainEqual(expect.objectContaining({ id: todo.id, source: { url: null, instanceId: original.id, instanceRevision: original.revision, ref: { sourceId: original.sourceId, externalId: todo.id } } }));
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
    await expect(page.locator('.todos-view')).toBeVisible();
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
