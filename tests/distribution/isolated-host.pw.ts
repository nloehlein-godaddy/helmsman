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
  return { root, app, cwd, env, commandLog, cli, script, installSample, start, stop,
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
