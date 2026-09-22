import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = `sha256:${'a'.repeat(64)}`;

async function readState(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function saveState(path, state) {
  await writeFile(path, JSON.stringify(state));
}

function label(args) {
  const labels = {};
  for (let index = 0; index < args.length; index += 1) if (args[index] === '--label') {
    const [key, value] = String(args[index + 1]).split('=', 2);
    labels[key] = value;
  }
  return labels;
}

function itemByReference(items, value) {
  return Object.values(items).find(item => item.name === value || item.id === value);
}

export async function runDockerMock(args, statePath = process.env.HELMSMAN_DOCKER_FIXTURE_STATE) {
  if (!statePath) throw new Error('Docker fixture state is unavailable');
  const state = await readState(statePath);
  state.commands.push(args);
  const done = async output => { await saveState(statePath, state); if (output) process.stdout.write(`${output}\n`); };
  if (args[0] === 'image' && args[1] === 'inspect') return done(digest);
  if (args[0] === 'network' && args[1] === 'create') {
    const name = args.at(-1); state.networks[name] = { name, id: 'd'.repeat(63) + String(state.next++ % 10), labels: label(args) }; return done(name);
  }
  if (args[0] === 'create') {
    const name = args[args.indexOf('--name') + 1]; state.containers[name] = { name, id: 'c'.repeat(63) + String(state.next++ % 10), labels: label(args), running: false }; return done(state.containers[name].id);
  }
  if (args[0] === 'start') { const item = itemByReference(state.containers, args[1]); if (item) item.running = true; return done(args[1]); }
  if (args[0] === 'exec' || args[0] === 'network' && args[1] === 'connect') return done('');
  if (args[0] === 'ps') {
    const runId = String(args[args.indexOf('--filter') + 1]).slice('label=helmsman.runId='.length);
    return done(Object.values(state.containers).filter(item => item.labels['helmsman.runId'] === runId).map(item => item.name).join('\n'));
  }
  if (args[0] === 'network' && args[1] === 'ls') {
    const runId = String(args[args.indexOf('--filter') + 1]).slice('label=helmsman.runId='.length);
    return done(Object.values(state.networks).filter(item => item.labels['helmsman.runId'] === runId).map(item => item.name).join('\n'));
  }
  if (args[0] === 'inspect') {
    const item = itemByReference(state.containers, args.at(-1));
    if (!item) { await saveState(statePath, state); process.stderr.write('Error: No such container\n'); process.exitCode = 1; return; }
    return done(JSON.stringify({ Id: item.id, Name: `/${item.name}`, Config: { Labels: item.labels }, State: { Running: item.running, Status: item.running ? 'running' : 'exited' } }));
  }
  if (args[0] === 'network' && args[1] === 'inspect') {
    const item = itemByReference(state.networks, args.at(-1));
    if (!item) { await saveState(statePath, state); process.stderr.write('Error: No such network\n'); process.exitCode = 1; return; }
    return done(JSON.stringify({ Id: item.id, Name: item.name, Labels: item.labels }));
  }
  if (args[0] === 'rm') {
    const reference = args.at(-1); const item = itemByReference(state.containers, reference);
    if (!item) { await saveState(statePath, state); process.stderr.write('Error: No such container\n'); process.exitCode = 1; return; }
    delete state.containers[item.name]; return done(item.id);
  }
  if (args[0] === 'network' && args[1] === 'rm') {
    const item = itemByReference(state.networks, args.at(-1));
    if (!item) { await saveState(statePath, state); process.stderr.write('Error: No such network\n'); process.exitCode = 1; return; }
    delete state.networks[item.name]; return done(item.id);
  }
  throw new Error(`Unexpected Docker fixture command: ${args.join(' ')}`);
}

async function waitFor(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(path); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

export async function runDockerHostFixture(input) {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-installed-docker-'));
  const bin = join(root, 'bin');
  const statePath = join(root, 'docker-state.json');
  const previousPath = process.env.PATH;
  const previousState = process.env.HELMSMAN_DOCKER_FIXTURE_STATE;
  let coordinator;
  try {
    await mkdir(bin);
    await saveState(statePath, { next: 1, commands: [], containers: {}, networks: {} });
    const fixtureUrl = pathToFileURL(process.argv[1]).href;
    await writeFile(join(bin, 'docker'), `#!${process.execPath}\nimport(${JSON.stringify(fixtureUrl)}).then(({runDockerMock})=>runDockerMock(process.argv.slice(2))).catch(error=>{console.error(error);process.exitCode=1;});\n`, { mode: 0o700 });
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
    process.env.HELMSMAN_DOCKER_FIXTURE_STATE = statePath;
    const { createDockerExecutionHost } = await import(pathToFileURL(input.providerPath).href);
    const provider = createDockerExecutionHost({ image: 'example/agent:latest' });
    assert.deepEqual(await provider.prepareRun({ version: 1, runId: 'docker-fixture', repo: 'org/repo', mode: 'review' }), { image: digest });

    const repo = join(root, 'repo');
    const skills = join(root, 'skills-root');
    await Promise.all([mkdir(join(repo, '.git'), { recursive: true }), mkdir(join(skills, 'skills'), { recursive: true })]);
    await writeFile(join(repo, '.git', 'config'), '[core]\nfsmonitor = /untrusted\n');
    let mapped;
    const stage = await provider.prepareStage({
      version: 1, runId: 'docker-fixture', repo: 'org/repo', cwd: repo, runtimeRoot: root,
      gateway: { url: 'http://host.docker.internal:8790/', capability: 'scoped-capability' }, configuration: { image: digest },
      transport: 'openai-responses', stage: 'review', skillsPath: skills, reportPath: join(root, 'report.json'), priorReportPath: null,
      reviewOutputPaths: null, clarification: null,
    }, paths => { mapped = paths; return { cmd: 'codex', args: ['exec', 'fixture'] }; });
    assert.deepEqual(mapped, { skillsPath: '/skills', reportPath: '/runtime/report.json', priorReportPath: null, reviewOutputPaths: null, clarification: null });
    assert.ok(stage.command.args.includes(`type=bind,src=${repo},dst=/worktree,readonly`));
    assert.ok(stage.command.args.includes(`type=bind,src=${skills}/skills,dst=/skills/skills,readonly`));
    assert.ok(stage.command.args.includes('HELMSMAN_CAPABILITY=scoped-capability'));
    assert.ok(stage.command.args.includes('HELMSMAN_GATEWAY_URL=http://gateway:8080'));
    await stage.cleanup(false);
    assert.doesNotMatch(await readFile(join(repo, '.git', 'config'), 'utf8'), /untrusted/);
    let state = await readState(statePath);
    assert.equal(Object.values(state.containers).some(item => item.labels['helmsman.runId'] === 'docker-fixture'), false);
    assert.equal(Object.values(state.networks).some(item => item.labels['helmsman.runId'] === 'docker-fixture'), false);

    state.containers['helmsman-stage-docker-fixture-owned'] = { name: 'helmsman-stage-docker-fixture-owned', id: '1'.repeat(64), labels: { 'helmsman.runId': 'docker-fixture' }, running: true };
    state.networks['helmsman-stage-docker-fixture-owned-network'] = { name: 'helmsman-stage-docker-fixture-owned-network', id: '2'.repeat(64), labels: { 'helmsman.runId': 'docker-fixture' } };
    state.containers['helmsman-stage-other-owned'] = { name: 'helmsman-stage-other-owned', id: '3'.repeat(64), labels: { 'helmsman.runId': 'other' }, running: true };
    state.networks['helmsman-stage-other-owned-network'] = { name: 'helmsman-stage-other-owned-network', id: '4'.repeat(64), labels: { 'helmsman.runId': 'other' } };
    await saveState(statePath, state);
    await provider.stopStages('docker-fixture');
    state = await readState(statePath);
    assert.ok(state.containers['helmsman-stage-other-owned']);
    assert.ok(state.networks['helmsman-stage-other-owned-network']);
    assert.equal(state.containers['helmsman-stage-docker-fixture-owned'], undefined);
    assert.equal(state.networks['helmsman-stage-docker-fixture-owned-network'], undefined);

    const worker = join(root, 'worker.mjs');
    const ready = join(root, 'coordinator.ready');
    await writeFile(worker, `import {writeFileSync} from 'node:fs';const timer=setInterval(()=>{},1000);process.once('SIGTERM',()=>{clearInterval(timer);process.send({kind:'helmsman-coordinator-settled',version:1},()=>process.exit(0));});writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>process.exit(2),10000).unref();`);
    const spec = {
      version: 1, runId: 'coordinator-fixture', launchId: 'coordinator-launch', attempt: 1,
      receiptPath: join(root, 'coordinator.receipt'), cmd: process.execPath, args: [worker], cwd: root,
      logPath: join(root, 'coordinator.log'), exitPath: join(root, 'coordinator.exit'), specPath: join(root, 'coordinator.json'),
      wrapperPath: input.wrapperPath, coordinator: true, configuration: { image: digest },
    };
    coordinator = await provider.launch(spec);
    assert.deepEqual(Object.keys(coordinator.identity), ['runId', 'launchId', 'attempt', 'receiptPath']);
    await waitFor(spec.receiptPath);
    await waitFor(ready);
    assert.equal(JSON.parse(await readFile(spec.specPath, 'utf8')).coordinator, true);
    const discovery = await provider.discover(spec, coordinator);
    assert.equal(discovery.status, 'found');
    assert.equal(discovery.evidence.state, 'running');
    assert.equal(await provider.isAlive(coordinator), true);
    await provider.stop(coordinator);
    await waitFor(spec.exitPath);
    coordinator = undefined;
    process.stdout.write('DOCKER_HOST_ACCEPTED\n');
  } finally {
    if (coordinator?.state?.pid) try { process.kill(coordinator.state.pid, 'SIGTERM'); } catch {}
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.HELMSMAN_DOCKER_FIXTURE_STATE; else process.env.HELMSMAN_DOCKER_FIXTURE_STATE = previousState;
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] !== '--docker-mock') {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('Fixture input path is required');
  await runDockerHostFixture(JSON.parse(await readFile(inputPath, 'utf8')));
}
