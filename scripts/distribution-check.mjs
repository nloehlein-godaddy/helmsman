import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDistribution } from './build-distribution.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
let temporary;
let installation;
let cwd;

before(async () => {
  temporary = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-distribution-'));
  installation = join(temporary, 'installation');
  cwd = join(temporary, 'unrelated-working-directory');
  await mkdir(cwd);
  await cp(join(root, 'release'), installation, { recursive: true });
  await cp(join(root, 'tests', 'distribution', 'deny-source.mjs'), join(temporary, 'deny-source.mjs'));
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

function isolated(args, strict = false) {
  const permissions = strict ? ['--permission', `--allow-fs-read=${temporary}`, `--allow-fs-write=${temporary}`, '--allow-addons'] : [];
  return run(process.execPath, [...permissions, ...args], { cwd,
    env: { PATH: process.env.PATH, HOME: cwd, USERPROFILE: cwd, HELMSMAN_TEST_SOURCE: root.replace(/[\\/]$/, ''),
      ...(!strict ? { NODE_OPTIONS: `--import=${pathToFileURL(join(temporary, 'deny-source.mjs')).href}` } : {}) }, timeout: 20_000 });
}

test('compiled CLI uses bundled native dependencies with application source denied', async () => {
  const metadata = JSON.parse(await readFile(join(installation, 'package.json'), 'utf8'));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  assert.equal(metadata.engines.node, `>=${nodeMajor}.0.0 <${nodeMajor + 1}.0.0`);
  assert.deepEqual(metadata.os, [process.platform]);
  assert.deepEqual(metadata.cpu, [process.arch]);
  const inventory = JSON.parse(await readFile(join(installation, '.helmsman-distribution.json'), 'utf8'));
  assert.equal(inventory.nodeAbi, process.versions.modules);
  const entry = join(installation, 'server', 'helmsman', 'plugins', 'cli.js');
  const { stdout } = await isolated([entry, '--dir', join(cwd, 'plugins'), 'list'], true);
  assert.deepEqual(JSON.parse(stdout), { plugins: [], bindings: {} });
  const check = await isolated(['--input-type=module', '-e', `
    import { readFile } from 'node:fs/promises';
    try { await readFile(${JSON.stringify(join(root, 'package.json'))}); process.exit(2); }
    catch (error) { if (error.code !== 'ERR_ACCESS_DENIED') throw error; }
    console.log('source denied');
  `], true);
  assert.equal(check.stdout.trim(), 'source denied');
});

test('compiled workflow preparation finds its prompts and helpers outside the original working directory', async () => {
  const module = name => pathToFileURL(join(installation, 'server', 'helmsman', name)).href;
  const { stdout } = await isolated(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile, readFile } from 'node:fs/promises';
    import { basename, join } from 'node:path';
    import { applicationRoot } from ${JSON.stringify(module('runtime-paths.js'))};
    import { prePrAdapter } from ${JSON.stringify(module('agents/pre-pr.js'))};
    import { dockerReviewAdapter } from ${JSON.stringify(module('agents/docker-review.js'))};
    import { codexAdapter } from ${JSON.stringify(module('agents/codex.js'))};
    import { prepareExecution } from ${JSON.stringify(module('prepare-run.js'))};
    const task = { ticketId: 'T-1', title: 'Example', repo: 'org/example', jiraBaseUrl: '' };
    const command = prePrAdapter(codexAdapter, process.cwd()).buildCommand(task);
    assert.equal(command.args.length, 2);
    assert.equal(basename(command.args[0]), 'pre-pr-cli.js');
    const review = dockerReviewAdapter(codexAdapter).buildCommand({ ...task, review: true, dockerExecution: {} });
    assert.equal(basename(review.args[0]), 'docker-review-cli.js');
    await readFile(join(applicationRoot(), 'dist', 'index.html'));
    await readFile(join(applicationRoot(), 'server', 'helmsman', 'run-wrapper.mjs'));
    await readFile(join(applicationRoot(), 'server', 'helmsman', 'docker-gateway-relay.mjs'));
    const skills = join(process.cwd(), 'skills');
    await mkdir(join(skills, 'review-agent'), { recursive: true });
    await writeFile(join(skills, 'review-agent', 'SKILL.md'), '# Review');
    const prepared = await prepareExecution({ runId: 'test_1', runsDir: join(process.cwd(), 'runs'),
      workflowDbPath: join(process.cwd(), 'workflows.sqlite'), task, workflow: 'review',
      reviewSettings: { reviewerCount: 1, maxRounds: 1, stageTimeoutMinutes: 5 }, skillsRoots: [skills] });
    assert.match(prepared.snapshotId, /^[a-f0-9]{64}$/);
    console.log('workflow ready');
  `]);
  assert.equal(stdout.trim(), 'workflow ready');
});

test('compiled coordinators and run wrapper execute without a TypeScript loader', async () => {
  for (const [name, message] of [['pre-pr-cli.js', 'Pre-PR worker input is required'], ['docker-review-cli.js', 'Invalid Docker review task']]) {
    await assert.rejects(isolated([join(installation, 'server', 'helmsman', name)]), error => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).text, message);
      assert.doesNotMatch(error.stderr, /MODULE_NOT_FOUND|\.ts/);
      return true;
    });
  }
  const specPath = join(cwd, 'wrapper-spec.json');
  const logPath = join(cwd, 'wrapper.log');
  const exitPath = join(cwd, 'wrapper.exit');
  await writeFile(specPath, JSON.stringify({ cmd: process.execPath, args: ['--input-type=module', '-e',
    `import { readFileSync } from 'node:fs';
     try { readFileSync(${JSON.stringify(join(root, 'package.json'))}); process.exit(2); }
     catch (error) { if (!error.message.includes('Source checkout is unavailable')) throw error; }
     console.log('compiled wrapper works');`], cwd, logPath, exitPath }));
  await isolated([join(installation, 'server', 'helmsman', 'run-wrapper.mjs'), specPath]);
  assert.equal(await readFile(exitPath, 'utf8'), '0');
  assert.equal((await readFile(logPath, 'utf8')).trim(), 'compiled wrapper works');
});

test('packaged SDK type-checks a separately authored TypeScript plugin without application imports', async () => {
  const author = join(temporary, 'plugin-author');
  await mkdir(join(author, 'node_modules', '@helmsman'), { recursive: true });
  await cp(join(installation, 'sdk'), join(author, 'node_modules', '@helmsman', 'plugin-sdk'), { recursive: true });
  await writeFile(join(author, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(author, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext',
    target: 'ES2023', strict: true, types: [], outDir: './dist' }, include: ['page.ts'] }));
  await writeFile(join(author, 'page.ts'), `import type { PluginPageModule, PluginPageState } from '@helmsman/plugin-sdk';
    const page: PluginPageModule = {
      mount(container, context) {
        const update = (state: PluginPageState) => { container.textContent = state.repo ?? 'All'; };
        update(context.state);
        return { update, dispose() { container.replaceChildren(); } };
      }
    };
    export default page;
  `);
  await run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(author, 'tsconfig.json')], { cwd: author, timeout: 20_000 });
  const javascript = await readFile(join(author, 'dist', 'page.js'), 'utf8');
  assert.match(javascript, /export default page/);
  assert.doesNotMatch(javascript, /@helmsman|\.ts['"]/);
  const manifest = JSON.parse(await readFile(join(installation, 'examples', 'plugins', 'scope-summary', 'plugin-package.json'), 'utf8'));
  manifest.manifest.id = 'independent.typescript';
  manifest.entries.page = 'dist/page.js';
  await writeFile(join(author, 'plugin-package.json'), JSON.stringify(manifest));
  await rm(join(author, 'node_modules'), { recursive: true, force: true });
  await rm(join(author, 'page.ts'));
  const { stdout } = await isolated([join(installation, 'server', 'helmsman', 'plugins', 'cli.js'),
    'pack', author, join(temporary, 'typescript-plugin.json')]);
  assert.match(stdout, /Packed independent.typescript/);
});

test('rebuild refuses runtime data, user changes, and symlinks without deleting any bytes', async () => {
  const output = join(temporary, 'protected-output');
  await buildDistribution({ outDir: output });
  const marker = await readFile(join(output, '.helmsman-distribution.json'));
  for (const local of ['.helmsman.sqlite', '.helmsman-runs/logs/active.log', 'custom-data/nested/user.txt', 'server/extra-user-file.txt']) {
    const path = join(output, local);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'preserve runtime data');
    await assert.rejects(buildDistribution({ outDir: output }), /untracked data/);
    assert.equal(await readFile(path, 'utf8'), 'preserve runtime data');
    assert.deepEqual(await readFile(join(output, '.helmsman-distribution.json')), marker);
    if (local.startsWith('server/')) await rm(path);
    else await rm(join(output, local.split('/')[0]), { recursive: true });
  }
  const generated = join(output, 'sdk', 'index.js');
  const original = await readFile(generated);
  await writeFile(generated, 'user modification');
  await assert.rejects(buildDistribution({ outDir: output }), /modified/);
  assert.equal(await readFile(generated, 'utf8'), 'user modification');
  await writeFile(generated, original);
  await symlink(generated, join(output, 'extra-link'));
  await assert.rejects(buildDistribution({ outDir: output }), /untracked|symlink/);
  assert.deepEqual(await readFile(generated), original);
  await rm(join(output, 'extra-link'));
  await symlink(output, join(temporary, 'output-link'));
  await assert.rejects(buildDistribution({ outDir: join(temporary, 'output-link') }), /symlink/);
  assert.deepEqual(await readFile(generated), original);
  await rm(generated);
  await symlink(join(output, 'sdk', 'index.d.ts'), generated);
  await assert.rejects(buildDistribution({ outDir: output }), /symlink/);
});

test('rebuild detects files created while staging and retains prior output after a clean replacement', async () => {
  const parent = join(temporary, 'concurrent-rebuild');
  await mkdir(parent);
  const output = join(parent, 'release');
  await buildDistribution({ outDir: output });
  const data = join(output, 'active-run.sqlite');
  let injected = false;
  const watcher = watch(parent, (_event, filename) => {
    if (!injected && filename?.toString().startsWith('.helmsman-build-')) {
      injected = true;
      writeFileSync(data, 'concurrent runtime data');
    }
  });
  try { await assert.rejects(buildDistribution({ outDir: output }), /untracked data/); }
  finally { watcher.close(); }
  assert.equal(injected, true);
  assert.equal(await readFile(data, 'utf8'), 'concurrent runtime data');
  await rm(data);
  const before = await readFile(join(output, '.helmsman-distribution.json'));
  await buildDistribution({ outDir: output });
  const backups = (await readdir(parent)).filter(name => name.startsWith('release.previous-'));
  assert.equal(backups.length, 1);
  const retained = join(parent, backups[0]);
  assert.deepEqual(await readFile(join(retained, '.helmsman-distribution.json')), before);
  assert.deepEqual(await readFile(join(output, '.helmsman-distribution.json')), before);
  await writeFile(join(retained, 'late-writer.sqlite'), 'late runtime data');
  assert.equal(await readFile(join(retained, 'late-writer.sqlite'), 'utf8'), 'late runtime data');
});
