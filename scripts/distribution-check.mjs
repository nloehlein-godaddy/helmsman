import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDistribution, copyDistributionDocumentation } from './build-distribution.mjs';

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

test('compiled interactive helpers preserve prompts and run with source access denied', async () => {
  const module = name => pathToFileURL(join(installation, 'server', 'helmsman', name)).href;
  const fixture = join(cwd, 'interactive-fixture.cjs');
  await writeFile(fixture, `const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    require('node:readline').createInterface({input:process.stdin}).once('line',line=>{
      const input=JSON.parse(line); if(input.message.content !== '🦜'.repeat(5000)) process.exit(9);
      send({type:'system',subtype:'init',session_id:'compiled-session'});
      setTimeout(()=>send({type:'result',subtype:'success',result:'compiled interactive works'}),20);
    });`);
  const { stdout } = await isolated(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { basename, join } from 'node:path';
    import { randomUUID } from 'node:crypto';
    import { interactiveAgentCommand } from ${JSON.stringify(module('interactive-agent.js'))};
    import { instructionDirectory, readInstructions } from ${JSON.stringify(module('instruction-channel.js'))};
    const channelId=randomUUID(); const runs=join(process.cwd(),'interactive-runs');
    const instructions={runId:'compiled-run',attempt:1,channelId,directory:instructionDirectory(runs,'compiled-run',1,channelId)};
    const task={ticketId:'T-1',title:'Task',repo:'org/project',jiraBaseUrl:'',instructions};
    const command=interactiveAgentCommand(task,'fixture/agent',{protocol:'claude-stream-json',command:{cmd:process.execPath,args:[${JSON.stringify(fixture)}]},
      initialInput:{prompt:'🦜'.repeat(5000),model:null,effort:null}},null);
    assert.equal(basename(command.args[0]),'interactive-agent-cli.js');
    assert(command.args.slice(1).every(argument=>argument.startsWith('--input=')&&argument.length<=256));
    const result=execFileSync(command.cmd,command.args,{encoding:'utf8',timeout:10000});
    assert.match(result,/compiled interactive works/);
    assert.equal((await readInstructions(instructions.directory,true)).available,false);
    console.log('compiled interactive ready');
  `]);
  assert.equal(stdout.trim(), 'compiled interactive ready');
});

test('compiled coordinators and run wrapper execute without a TypeScript loader', async () => {
  for (const [name, message] of [['pre-pr-cli.js', 'Pre-PR worker input is required'], ['docker-review-cli.js', 'Invalid isolated review task'], ['feedback-update-cli.js', 'Feedback worker input is required']]) {
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

test('copied release guides and author READMEs have complete local documentation links', async () => {
  const output = join(temporary, 'documentation-release');
  const sourceReadme = await readFile(join(root, 'src/plugins/run-viewer/README.md'));
  const sourceGuide = await readFile(join(root, 'docs/task-source-authoring.md'));
  await buildDistribution({ outDir: output });
  assert.deepEqual(await readFile(join(root, 'src/plugins/run-viewer/README.md')), sourceReadme);
  assert.deepEqual(await readFile(join(root, 'docs/task-source-authoring.md')), sourceGuide);
  const viewer = await readFile(join(output, 'plugin-sources/run-viewer/README.md'), 'utf8');
  assert.match(viewer, /\]\(\.\.\/\.\.\/docs\/run-presentation-authoring\.md\)/);
  const source = await readFile(join(output, 'docs/task-source-authoring.md'), 'utf8');
  assert.match(source, /\]\(\.\.\/plugin-sources\/source-settings\/README\.md\)/);
  assert.match(await readFile(join(output, 'plugin-sources/jira/README.md'), 'utf8'), /https:\/\/github\.com\/nloehlein-godaddy\/helmsman\/blob\/master\/src\/plugins\/jira\/views\.test\.ts/);
  for (const name of ['plugin-architecture-plan.md', 'plugin-implementation-progress.md', 'plugin-phase-e4-implementation.md', 'recovery.md', 'helmsman-process.html']) assert.ok((await lstat(join(output, 'docs', name))).isFile());
  for (const name of ['browser.pw.ts', 'playwright.config.ts', 'panel.test.ts']) await assert.rejects(readFile(join(output, 'plugin-sources/run-viewer', name)), { code: 'ENOENT' });
  let checked = 0;
  async function audit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await audit(path);
      else if (/\.(?:md|html)$/i.test(entry.name)) {
        const contents = (await readFile(path, 'utf8')).replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
        const links = [...contents.matchAll(/\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)].map(match => match[1]);
        links.push(...[...contents.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map(match => match[1]));
        for (const link of links) {
          if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(link)) continue;
          const target = resolve(dirname(path), decodeURIComponent(link.split(/[?#]/)[0]));
          assert.ok(!relative(output, target).startsWith('..'), `${relative(output, path)} escapes the release: ${link}`);
          assert.ok((await lstat(target)).isFile() || (await lstat(target)).isDirectory(), `${relative(output, path)} missing ${link}`);
          checked++;
        }
      }
    }
  }
  for (const directory of ['docs', 'plugin-sources', 'examples', 'docker']) await audit(join(output, directory));
  assert.ok(checked > 50, `Expected a connected documentation graph; checked ${checked} links`);
});

test('documentation closure follows safe markdown, reference and HTML links without copying repository code', async () => {
  const source = join(temporary, 'documentation-source'); const output = join(temporary, 'documentation-fixture');
  await mkdir(join(source, 'docs'), { recursive: true }); await mkdir(join(source, 'src/logic'), { recursive: true });
  await mkdir(join(source, 'src/plugins/example'), { recursive: true }); await mkdir(join(output, 'plugin-sources/example'), { recursive: true });
  await writeFile(join(source, 'src/logic/private.ts'), 'export const privateRuntime = true;');
  await writeFile(join(source, 'README.md'), '[Start](docs/start.md#start)');
  await writeFile(join(source, 'docs/image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(source, 'docs/child guide.md'), '# Child\n[Readme](../README.md)');
  const contents = '# Start\n[Child](<child guide.md#child>)\n[Reference][child]\n[child]: <child guide.md> "Title"\n<img src="image.svg">\n[Source](../src/logic/private.ts#L1)\n[External](https://example.org/remote)\n```ts\n[Literal](../../outside-secret)\n```\n';
  await writeFile(join(source, 'docs/start.md'), contents);
  await writeFile(join(source, 'src/plugins/example/README.md'), '[Guide](../../../docs/start.md#start)');
  await cp(join(source, 'src/plugins/example/README.md'), join(output, 'plugin-sources/example/README.md'));
  const options = { sourceRoot: source, packages: ['example'], guides: ['start.md'] };
  await copyDistributionDocumentation(output, options);
  const rewritten = await readFile(join(output, 'docs/start.md'), 'utf8');
  assert.match(rewritten, /<child%20guide\.md#child>/); assert.match(rewritten, /\[child\]: <child%20guide\.md> "Title"/);
  assert.match(rewritten, /https:\/\/github\.com\/nloehlein-godaddy\/helmsman\/blob\/master\/src\/logic\/private\.ts#L1/);
  assert.match(rewritten, /\[Literal\]\(\.\.\/\.\.\/outside-secret\)/); assert.match(rewritten, /https:\/\/example\.org\/remote/);
  assert.equal(await readFile(join(output, 'plugin-sources/example/README.md'), 'utf8'), '[Guide](../../docs/start.md#start)');
  assert.equal(await readFile(join(source, 'docs/start.md'), 'utf8'), contents);
  assert.ok((await lstat(join(output, 'docs/child guide.md'))).isFile()); assert.ok((await lstat(join(output, 'docs/image.svg'))).isFile());
  await assert.rejects(readFile(join(output, 'src/logic/private.ts')), { code: 'ENOENT' });
  await writeFile(join(source, 'docs/start.md'), '[Escape](../../outside-secret)');
  await assert.rejects(copyDistributionDocumentation(output, options), /escapes the source repository/);
  await writeFile(join(source, 'docs/start.md'), '[Missing](missing.md)');
  await assert.rejects(copyDistributionDocumentation(output, options), { code: 'ENOENT' });
  await writeFile(join(temporary, 'outside-secret'), 'never copy');
  await symlink(join(temporary, 'outside-secret'), join(source, 'docs/linked.md'));
  await writeFile(join(source, 'docs/start.md'), '[Symlink](linked.md)');
  await assert.rejects(copyDistributionDocumentation(output, options), /cannot contain symlinks/);
  await writeFile(join(source, 'docs/start.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(copyDistributionDocumentation(output, options), /bounded file budget/);
});

test('independent source adopts existing local work and runs a durable claim after restart without application source', async () => {
  const state = join(temporary, 'source-state');
  await mkdir(state);
  const cli = (...args) => isolated([join(installation, 'server/helmsman/plugins/cli.js'), '--dir', join(state, 'plugins'), '--db', join(state, 'state.sqlite'), ...args]);
  for (const name of ['todos', 'local-tasks-alternative']) {
    const author = join(temporary, `source-author-${name}`);
    await cp(join(installation, 'plugin-sources', name), author, { recursive: true });
    await cp(join(installation, 'sdk'), join(author, 'node_modules/@helmsman/plugin-sdk'), { recursive: true });
    await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', author], { cwd: author, timeout: 20_000 });
    const descriptor = JSON.parse(await readFile(join(author, 'plugin-package.json'), 'utf8'));
    await cp(join(author, 'plugin-package.json'), join(author, 'dist/plugin-package.json'));
    const javascript = await readFile(join(author, 'dist', descriptor.backend.entry), 'utf8');
    assert.doesNotMatch(javascript, /from\s+['"](?:@helmsman|\.\.\/)/);
    const archive = join(temporary, `${name}.hmp`);
    await cli('pack', join(author, 'dist'), archive);
    await cli('install', archive);
    await cli('enable', descriptor.manifest.id);
    await rm(author, { recursive: true });
  }
  const fixture = join(temporary, 'source-adoption.mjs');
  await cp(join(root, 'tests/distribution/source-adoption.mjs'), fixture);
  const adopted = await isolated([fixture, installation, 'adopt', state]);
  assert.match(adopted.stdout, /independent source adopted and claim committed/);
  await cli('disable', 'example.local-todos');
  const resumed = await isolated([fixture, installation, 'resume', state]);
  assert.match(resumed.stdout, /independent source worker completed after restart/);
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

test('feedback source packages build and pack using only the distributed public SDK', async () => {
  for (const name of ['product-feedback', 'feedback-github']) {
    const author = join(temporary, `feedback-author-${name}`);
    await cp(join(installation, 'plugin-sources', name), author, { recursive: true });
    await cp(join(installation, 'sdk'), join(author, 'node_modules/@helmsman/plugin-sdk'), { recursive: true });
    await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', author], { cwd: author, timeout: 20_000 });
    const descriptor = JSON.parse(await readFile(join(author, 'plugin-package.json'), 'utf8'));
    descriptor.manifest.id = `independent.${name}`;
    await writeFile(join(author, 'dist/plugin-package.json'), JSON.stringify(descriptor));
    const archive = join(temporary, `${name}.hmp`);
    const packed = await isolated([join(installation, 'server/helmsman/plugins/cli.js'), '--dir', join(temporary, 'feedback-plugins'), 'pack', join(author, 'dist'), archive]);
    assert.match(packed.stdout, new RegExp(`Packed independent\\.${name}`));
  }
});
