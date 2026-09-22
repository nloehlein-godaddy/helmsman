import type { Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
export const pluginId = 'example.isolated';
export const contribution = `${pluginId}/page`;

export async function seedBacklogLayout(page: Page): Promise<void> {
  await page.addInitScript(() => { if (localStorage.getItem('helmsman.rackLayout') === null) localStorage.setItem('helmsman.rackLayout', JSON.stringify([[{ panels: ['backlog'], active: 'backlog', collapsed: false }]])); });
}

export async function pendingCommandCount(page: Page, database: string, caller: string): Promise<number> {
  return page.evaluate(({ database, caller }) => new Promise<number>((resolve, reject) => {
    const opened = indexedDB.open(database, 1);
    opened.onerror = () => reject(opened.error);
    opened.onupgradeneeded = () => opened.transaction?.abort();
    opened.onsuccess = () => {
      const connection = opened.result;
      const transaction = connection.transaction('pending', 'readonly');
      const request = transaction.objectStore('pending').index('caller').count(caller);
      transaction.oncomplete = () => { connection.close(); resolve(request.result); };
      transaction.onabort = () => { connection.close(); reject(transaction.error); };
    };
  }), { database, caller });
}

export async function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
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

export async function fixture(options: { distribution?: string } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-isolated-'));
  const app = join(root, 'application');
  const cwd = join(root, 'operator-data');
  const store = join(root, 'plugins');
  const fakeBin = join(root, 'commands');
  await Promise.all([mkdir(cwd), mkdir(fakeBin), cp(options.distribution ?? join(sourceRoot, 'release'), app, { recursive: true }),
    cp(fileURLToPath(new URL('./deny-source.mjs', import.meta.url)), join(root, 'deny-source.mjs'))]);
  const commandLog = join(root, 'provider-commands.log');
  for (const name of ['git', 'gh', 'codex', 'claude', 'cmux', 'wezterm', 'docker', 'osascript']) {
    await writeFile(join(fakeBin, name), '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$HELMSMAN_TEST_COMMAND_LOG"\nexit 1\n', { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = {
    PATH: `${fakeBin}:${dirname(process.execPath)}`, HELMSMAN_PORT: '0', HELMSMAN_PLUGINS_DIR: store,
    HELMSMAN_DB: join(cwd, 'state.sqlite'), AGENTS_ROOT: cwd, RUNS_DIR: join(cwd, 'runs'),
    JIRA_ENABLED: 'false', SLACK_ENABLED: 'false', SLACK_WATCH_ENABLED: 'false', GITHUB_REVIEW_WATCH_ENABLED: 'false',
    HELMSMAN_TEST_SOURCE: resolve(sourceRoot), HELMSMAN_TEST_COMMAND_LOG: commandLog,
    GOCAAS_API_KEY: 'fixture-gocaas-key',
    NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'deny-source.mjs')).href}`,
  };
  const cli = (...args: string[]) => run(process.execPath, [join(app, 'server/helmsman/plugins/cli.js'), ...args], cwd, env);
  let compilerPath: Promise<string> | null = null;
  function compiler(): Promise<string> {
    compilerPath ??= (async () => {
      const toolchain = join(root, 'toolchain/typescript');
      await cp(join(sourceRoot, 'node_modules/typescript'), toolchain, { recursive: true });
      return join(toolchain, 'bin/tsc');
    })();
    return compilerPath;
  }
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
    await run(process.execPath, [await compiler(), '--strict', '--target', 'ES2023',
      '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--outDir', output, '--noEmitOnError', join(author, 'page.ts')], author,
    env);
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
  async function installAuthorPackage(relative: string, replacementId?: string, options: { buildScript?: boolean } = {}) {
    const author = join(root, `author-${relative.replaceAll('/', '-')}`);
    await cp(join(app, relative), author, { recursive: true });
    await cp(join(app, 'sdk'), join(author, 'node_modules/@helmsman/plugin-sdk'), { recursive: true });
    const output = join(author, options.buildScript ? 'dist' : 'compiled');
    if (options.buildScript) {
      await cp(dirname(dirname(await compiler())), join(author, 'node_modules/typescript'), { recursive: true });
      await run(process.execPath, [join(author, 'build.mjs')], author, env);
    } else await run(process.execPath, [await compiler(), '-p', author, '--outDir', output], author, env);
    await cp(join(author, 'plugin-package.json'), join(output, 'plugin-package.json'));
    const descriptor = JSON.parse(await readFile(join(author, 'plugin-package.json'), 'utf8'));
    if (replacementId) {
      const previousId = descriptor.manifest.id;
      descriptor.manifest.id = replacementId;
      for (const page of descriptor.manifest.pages ?? []) for (const instance of page.composition?.initialLayout?.instances ?? []) {
        if (typeof instance.contributionId === 'string' && instance.contributionId.startsWith(`${previousId}/`)) instance.contributionId = `${replacementId}/${instance.contributionId.slice(previousId.length + 1)}`;
      }
      await writeFile(join(output, 'plugin-package.json'), JSON.stringify(descriptor));
    }
    const archive = join(author, 'plugin.hmp');
    await cli('pack', output, archive);
    await cli('install', archive);
    await cli('enable', descriptor.manifest.id);
    return descriptor;
  }
  async function installPreflightFailureAgent() {
    const id = 'example.preflight-failure'; const source = join(root, 'preflight-agent'); await mkdir(source);
    await writeFile(join(source, 'backend.js'), `export default {activate(context){const models={model:null,effort:null};context.registerAgent('worker',{
metadata:{version:1,label:'Preflight fixture',defaults:models,review:{low:models,medium:models,high:models},reviewSkills:['helmsman-isolated-fixture-missing-skill'],reviewDelegation:'native-subagents',supportsPrePr:true,docker:'openai-responses',costReporting:'delta'},
buildCommand(){return {cmd:'codex',args:[]};},parseLine(){return null;}});}};`);
    await writeFile(join(source, 'plugin-package.json'), JSON.stringify({ packageVersion: 1,
      manifest: { manifestVersion: 1, id, version: '0.1.0', sdkVersion: 1, pages: [] }, node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
      backend: { entry: 'backend.js', provides: [{ id: 'helmsman/agent', version: 1, localId: 'worker' }], agents: { worker: { access: ['process-description'] } }, settings: {}, storageVersion: 1 } }));
    const archive = join(root, 'preflight-agent.hmp'); await cli('pack', source, archive); await cli('install', archive); await cli('enable', id);
    await cli('select-agent', `${id}/worker`); await cli('select-agent-reviewers', `${id}/worker`); env.PRE_PR_REVIEWER_COUNT = '1';
  }
  return { root, app, cwd, env, commandLog, cli, script, installSample, installAuthorPackage, installPreflightFailureAgent, start, stop,
    output: () => allServerOutput,
    async close() { await stop(); await rm(root, { recursive: true, force: true }); },
  };
}
