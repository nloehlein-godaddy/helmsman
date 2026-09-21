import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  ExecutionHostDiscoveryV1,
  ExecutionHostIdentityV1,
  ExecutionHostLaunchSpecV1,
  ExecutionHostProviderV1,
  ExecutionHostReferenceV1,
  ExecutionHostStageInputV1,
  ExecutionHostStagePathsV1,
  ExecutionHostStageV1,
  PluginJson,
} from '@helmsman/plugin-sdk';
import {
  executionHostProcessStartIdentity,
  isExecutionHostIdentityMatch,
  isExecutionHostProcessOwned,
  readExecutionHostExitReceipt,
  readExecutionHostLaunchReceipt,
} from '@helmsman/plugin-sdk/node';
import { gatewayRelaySource } from './gateway-relay.js';

const exec = promisify(execFile);
const FILE_LIMIT = 256 * 1024;
const safeIdentity = (value: string) => /^[a-z\d_-]{1,128}$/i.test(value);
const safeImage = (value: string) => /^[a-z\d][a-z\d./_:@-]{0,255}$/i.test(value);
const immutableImage = (value: string) => /^sha256:[a-f\d]{64}$/i.test(value) || /@sha256:[a-f\d]{64}$/i.test(value);

export type DockerCommandRunner = (args: readonly string[]) => Promise<{ readonly stdout: string; readonly code: number }>;

const defaultRun: DockerCommandRunner = async args => {
  const [bin = 'docker', ...rest] = args;
  const { stdout } = await exec(bin, [...rest], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return { stdout, code: 0 };
};

type LocalState = { readonly kind: 'local'; readonly pid: number; readonly processStart: string };
type DockerState = { readonly kind: 'docker'; readonly containerId: string };

function reference(identity: ExecutionHostIdentityV1, state: LocalState | DockerState): ExecutionHostReferenceV1 {
  return { version: 1, identity: {
    runId: identity.runId,
    launchId: identity.launchId,
    attempt: identity.attempt,
    receiptPath: identity.receiptPath,
  }, state };
}

function stateObject(ref: ExecutionHostReferenceV1): Record<string, unknown> {
  if (!ref.state || typeof ref.state !== 'object' || Array.isArray(ref.state)) throw new Error('Docker execution host ownership state is invalid');
  return ref.state as Record<string, unknown>;
}

function localState(ref: ExecutionHostReferenceV1): LocalState {
  const value = stateObject(ref);
  if (value.kind !== 'local' || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1
    || typeof value.processStart !== 'string' || !value.processStart
    || Object.keys(value).some(key => !['kind', 'pid', 'processStart'].includes(key))) {
    throw new Error('Local coordinator ownership is unknown');
  }
  return value as LocalState;
}

function dockerState(ref: ExecutionHostReferenceV1): DockerState {
  const value = stateObject(ref);
  if (value.kind !== 'docker' || typeof value.containerId !== 'string' || !/^[a-f\d]{12,64}$/i.test(value.containerId)
    || Object.keys(value).some(key => !['kind', 'containerId'].includes(key))) {
    throw new Error('Docker container ownership is unknown');
  }
  return value as DockerState;
}

function configuration(value: PluginJson): { image: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Docker run configuration is invalid');
  const row = value as Record<string, PluginJson>;
  if (Object.keys(row).length !== 1 || typeof row.image !== 'string' || !safeImage(row.image) || !immutableImage(row.image)) {
    throw new Error('Docker run configuration must contain an immutable image digest');
  }
  return { image: row.image };
}

async function writeSpec(spec: ExecutionHostLaunchSpecV1): Promise<void> {
  await writeFile(spec.specPath, JSON.stringify({
    version: 1,
    runId: spec.runId,
    launchId: spec.launchId,
    attempt: spec.attempt,
    cmd: spec.cmd,
    args: spec.args,
    cwd: spec.cwd,
    logPath: spec.logPath,
    exitPath: spec.exitPath,
    receiptPath: spec.receiptPath,
  }), { mode: 0o600 });
}

async function launchCoordinator(spec: ExecutionHostLaunchSpecV1): Promise<ExecutionHostReferenceV1> {
  const receipt = await readExecutionHostLaunchReceipt(spec);
  if (receipt) {
    const processStart = receipt.processStart;
    if (!processStart) throw new Error('Existing coordinator ownership is unverifiable');
    const ref = reference(spec, { kind: 'local', pid: receipt.pid, processStart });
    const discovered = await discoverCoordinator(spec, ref);
    if (discovered.status === 'found') return discovered.ref;
    throw new Error(discovered.status === 'unknown' ? discovered.reason : 'Existing coordinator requires reconciliation');
  }
  await writeSpec(spec);
  const child = spawn(process.execPath, [spec.wrapperPath, spec.specPath], { detached: true, stdio: 'ignore' });
  await new Promise<void>((done, reject) => {
    child.once('spawn', done);
    child.once('error', reject);
  });
  child.unref();
  if (!child.pid) throw new Error('Local coordinator did not return a process identity');
  const processStart = await executionHostProcessStartIdentity(child.pid);
  if (!processStart) throw new Error('Local coordinator process ownership is unavailable');
  return reference(spec, { kind: 'local', pid: child.pid, processStart });
}

async function discoverCoordinator(spec: ExecutionHostLaunchSpecV1, ref?: ExecutionHostReferenceV1): Promise<ExecutionHostDiscoveryV1> {
  if (ref && !isExecutionHostIdentityMatch(spec, ref.identity)) return { status: 'unknown', reason: 'Coordinator reference belongs to another attempt' };
  let receipt;
  try { receipt = await readExecutionHostLaunchReceipt(spec); }
  catch (error) { return { status: 'unknown', reason: error instanceof Error ? error.message : 'Coordinator receipt is invalid' }; }
  if (!receipt?.processStart) return { status: 'unknown', reason: 'Coordinator ownership receipt is unavailable' };
  const owned = ref ?? reference(spec, { kind: 'local', pid: receipt.pid, processStart: receipt.processStart });
  let state: LocalState;
  try { state = localState(owned); }
  catch (error) { return { status: 'unknown', reason: error instanceof Error ? error.message : 'Coordinator state is invalid' }; }
  if (state.pid !== receipt.pid || state.processStart !== receipt.processStart) return { status: 'unknown', reason: 'Coordinator reference does not match its receipt' };
  try {
    const exit = await readExecutionHostExitReceipt(spec);
    if (exit) return { status: 'found', ref: owned, evidence: { launchId: spec.launchId, runId: spec.runId, attempt: spec.attempt, state: 'exited', exitCode: exit.exitCode } };
    if (await isExecutionHostProcessOwned(state.pid, state.processStart)) {
      return { status: 'found', ref: owned, evidence: { launchId: spec.launchId, runId: spec.runId, attempt: spec.attempt, state: 'running' } };
    }
    const completed = await readExecutionHostExitReceipt(spec);
    return completed
      ? { status: 'found', ref: owned, evidence: { launchId: spec.launchId, runId: spec.runId, attempt: spec.attempt, state: 'exited', exitCode: completed.exitCode } }
      : { status: 'unknown', reason: 'Coordinator process ownership cannot be verified and no exit receipt exists' };
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : 'Coordinator evidence is invalid' };
  }
}

function dockerError(error: unknown): string {
  return String((error as { stderr?: unknown })?.stderr ?? (error instanceof Error ? error.message : error));
}

function missingDockerObject(error: unknown): boolean {
  return /No such (?:object|container|network)|not found/i.test(dockerError(error));
}

interface ContainerInspection {
  Id?: unknown;
  Name?: unknown;
  State?: { Running?: unknown; Status?: unknown };
  Config?: { Labels?: Record<string, unknown> };
}

async function inspectContainer(run: DockerCommandRunner, identity: ExecutionHostIdentityV1, id: string): Promise<ContainerInspection> {
  const result = await run(['docker', 'inspect', '--type', 'container', '--format', '{{json .}}', id]);
  if (result.code !== 0) throw new Error('Docker ownership inspection failed');
  const value: unknown = JSON.parse(result.stdout);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Docker returned invalid ownership data');
  const container = value as ContainerInspection;
  if (typeof container.Id !== 'string' || !/^[a-f\d]{12,64}$/i.test(container.Id)
    || container.Config?.Labels?.['helmsman.runId'] !== identity.runId
    || container.Config?.Labels?.['helmsman.launchId'] !== identity.launchId
    || container.Config?.Labels?.['helmsman.attempt'] !== String(identity.attempt)) {
    throw new Error('Docker container ownership does not match this attempt');
  }
  return container;
}

async function discoverContainer(run: DockerCommandRunner, spec: ExecutionHostLaunchSpecV1, ref?: ExecutionHostReferenceV1): Promise<ExecutionHostDiscoveryV1> {
  if (ref && !isExecutionHostIdentityMatch(spec, ref.identity)) return { status: 'unknown', reason: 'Docker reference belongs to another attempt' };
  let expectedId = `helmsman-${spec.launchId}`;
  if (ref) {
    try { expectedId = dockerState(ref).containerId; }
    catch (error) { return { status: 'unknown', reason: error instanceof Error ? error.message : 'Docker state is invalid' }; }
  }
  let container: ContainerInspection;
  try { container = await inspectContainer(run, spec, expectedId); }
  catch (error) {
    if (missingDockerObject(error)) {
      if (ref) {
        try {
          const exit = await readExecutionHostExitReceipt(spec);
          if (exit) return { status: 'found', ref, evidence: { launchId: spec.launchId, runId: spec.runId, attempt: spec.attempt, state: 'exited', exitCode: exit.exitCode } };
        } catch (receiptError) { return { status: 'unknown', reason: receiptError instanceof Error ? receiptError.message : 'Docker exit receipt is invalid' }; }
      }
      return { status: 'absent', evidence: `Docker reports no container for ${spec.launchId}` };
    }
    return { status: 'unknown', reason: dockerError(error) };
  }
  if (ref && container.Id !== dockerState(ref).containerId) return { status: 'unknown', reason: 'Docker container identity changed' };
  const owned = ref ?? reference(spec, { kind: 'docker', containerId: String(container.Id) });
  if (container.State?.Running === true) return { status: 'found', ref: owned, evidence: { launchId: spec.launchId, runId: spec.runId, attempt: spec.attempt, state: 'running' } };
  if (container.State?.Running !== false || !['exited', 'dead'].includes(String(container.State?.Status))) {
    return { status: 'unknown', reason: 'Docker container has unresolved process state' };
  }
  try {
    const exit = await readExecutionHostExitReceipt(spec);
    return exit
      ? { status: 'found', ref: owned, evidence: { launchId: spec.launchId, runId: spec.runId, attempt: spec.attempt, state: 'exited', exitCode: exit.exitCode } }
      : { status: 'unknown', reason: 'Stopped Docker container has no matching worker exit receipt' };
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : 'Docker exit receipt is invalid' };
  }
}

async function linkOutput(path: string, target: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink() || await readlink(path) !== target) throw new Error(`Docker output path is occupied: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') await symlink(target, path);
    else throw error;
  }
}

function mount(source: string, target: string, readOnly = false): string {
  if (source.includes(',') || /[\r\n]/.test(source)) throw new Error('Unsupported Docker mount path');
  return `type=bind,src=${resolve(source)},dst=${target}${readOnly ? ',readonly' : ''}`;
}

async function launchContainer(run: DockerCommandRunner, spec: ExecutionHostLaunchSpecV1): Promise<ExecutionHostReferenceV1> {
  const image = configuration(spec.configuration).image;
  const git = await lstat(join(spec.cwd, '.git')).catch(() => null);
  if (git?.isFile()) throw new Error('Docker host requires a standalone Git clone');
  const discovered = await discoverContainer(run, spec);
  if (discovered.status === 'found') return discovered.ref;
  if (discovered.status === 'unknown') throw new Error(discovered.reason);
  const runtime = join(dirname(spec.specPath), `${spec.launchId}.docker-runtime`);
  await rm(runtime, { recursive: true, force: true });
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const staged = {
    version: 1,
    runId: spec.runId,
    launchId: spec.launchId,
    attempt: spec.attempt,
    cmd: spec.cmd,
    args: spec.args,
    cwd: '/worktree',
    logPath: '/runtime/worker.log',
    exitPath: '/runtime/worker.exit',
    receiptPath: '/runtime/worker.receipt',
  };
  await writeFile(spec.specPath, JSON.stringify(spec), { mode: 0o600 });
  await copyFile(spec.wrapperPath, join(runtime, 'run-wrapper.mjs'));
  await writeFile(join(runtime, 'spec.json'), JSON.stringify(staged), { mode: 0o600 });
  await writeFile(join(runtime, 'worker.log'), '', { mode: 0o600, flag: 'ax' });
  await linkOutput(spec.logPath, join(runtime, 'worker.log'));
  await linkOutput(spec.exitPath, join(runtime, 'worker.exit'));
  await linkOutput(spec.receiptPath, join(runtime, 'worker.receipt'));
  const result = await run(['docker', 'run', '--detach', '--name', `helmsman-${spec.launchId}`,
    '--label', `helmsman.runId=${spec.runId}`, '--label', `helmsman.launchId=${spec.launchId}`, '--label', `helmsman.attempt=${spec.attempt}`,
    '--workdir', '/worktree', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--mount', mount(spec.cwd, '/worktree'), '--mount', mount(runtime, '/runtime'),
    '--env', 'HELMSMAN_RUNTIME=/runtime', '--network', 'none', '--entrypoint', 'node', image,
    '/runtime/run-wrapper.mjs', '/runtime/spec.json']);
  const containerId = result.stdout.trim();
  if (result.code !== 0 || !/^[a-f\d]{12,64}$/i.test(containerId)) throw new Error('Docker returned an invalid container identity');
  return reference(spec, { kind: 'docker', containerId });
}

async function boundedFile(path: string, missing = false): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if (missing && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  });
  if (!file) return Buffer.alloc(0);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > FILE_LIMIT) throw new Error('Docker stage output must be a bounded regular file');
    const bytes = Buffer.alloc(FILE_LIMIT + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > FILE_LIMIT) throw new Error('Docker stage output exceeded its limit');
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

async function safeWrite(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); } finally { await file.close(); }
}

async function sanitizeGit(cwd: string, repo: string): Promise<void> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid Docker repository');
  const gitDir = join(cwd, '.git');
  const inspect = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error('Unsafe Docker Git metadata');
    if (info.isDirectory()) for (const name of await readdir(path)) await inspect(join(path, name));
  };
  if (!(await lstat(gitDir)).isDirectory()) throw new Error('Docker Git directory was replaced');
  await inspect(gitDir);
  for (const name of ['alternates', 'http-alternates']) {
    if (await lstat(join(gitDir, 'objects', 'info', name)).catch(() => null)) throw new Error('Docker Git object alternates are not allowed');
  }
  await safeWrite(join(gitDir, 'config'), Buffer.from(`[core]\nrepositoryformatversion = 0\nbare = false\nhooksPath = /dev/null\nfsmonitor = false\nsshCommand = false\n[remote "origin"]\nurl = https://github.com/${repo}.git\nfetch = +refs/heads/*:refs/remotes/origin/*\n`));
}

function stagePaths(input: ExecutionHostStageInputV1): ExecutionHostStagePathsV1 {
  return {
    skillsPath: input.skillsPath ? '/skills' : null,
    reportPath: input.reportPath ? '/runtime/report.json' : null,
    priorReportPath: input.priorReportPath ? '/runtime/prior-report.json' : null,
    reviewOutputPaths: input.reviewOutputPaths ? { markdown: '/runtime/review.md', comments: '/runtime/review-comments.json' } : null,
    clarification: input.clarification ? { questionsPath: '/runtime/questions.jsonl', answersPath: '/runtime/answers.jsonl' } : null,
  };
}

async function prepareStage(run: DockerCommandRunner, input: ExecutionHostStageInputV1,
  renderCommand: (paths: ExecutionHostStagePathsV1) => { cmd: string; args: readonly string[] }): Promise<ExecutionHostStageV1> {
  const image = configuration(input.configuration).image;
  const gateway = new URL(input.gateway.url);
  if (gateway.protocol !== 'http:' || gateway.hostname !== 'host.docker.internal' || gateway.username || gateway.password
    || gateway.search || gateway.hash || gateway.pathname !== '/') throw new Error('Invalid Docker stage gateway');
  if (!(await lstat(join(input.cwd, '.git'))).isDirectory()) throw new Error('Docker stage requires a standalone Git clone');
  const runtimeRoot = resolve(input.runtimeRoot || tmpdir());
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const runtime = await mkdtemp(join(runtimeRoot, 'helmsman-stage-'));
  const suffix = `${input.runId.slice(0, 80)}-${randomUUID()}`;
  const name = `helmsman-stage-${suffix}`;
  const relayName = `${name}-relay`;
  const network = `${name}-network`;
  const isolatedGateway = 'http://gateway:8080';
  let timer: ReturnType<typeof setInterval> | undefined;
  let relay: Promise<void> = Promise.resolve();
  let relayError: unknown;
  let questionBytes = 0;
  const control = async (args: readonly string[]) => { const result = await run(['docker', ...args]); if (result.code !== 0) throw new Error('Docker stage command failed'); };
  const remove = async (kind: 'container' | 'network', id: string) => {
    try { await control(kind === 'container' ? ['rm', '--force', id] : ['network', 'rm', id]); }
    catch (error) { if (!missingDockerObject(error)) throw error; }
  };
  const stop = () => remove('container', name);
  const teardown = async () => { await remove('container', relayName); await remove('network', network); };
  try {
    await mkdir(join(runtime, 'home'), { mode: 0o700 });
    if (input.transport === 'openai-responses') {
      await mkdir(join(runtime, 'codex-home'), { mode: 0o700 });
      await writeFile(join(runtime, 'codex-home', 'config.toml'), `model_provider = "helmsman"\n[model_providers.helmsman]\nname = "Helmsman"\nbase_url = ${JSON.stringify(`${isolatedGateway}/openai/v1`)}\nenv_key = "HELMSMAN_CAPABILITY"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
    }
    if (input.priorReportPath) await copyFile(input.priorReportPath, join(runtime, 'prior-report.json'));
    const syncClarification = async () => {
      if (!input.clarification) return;
      const questions = await boundedFile(join(runtime, 'questions.jsonl'), true);
      if (questions.length < questionBytes) throw new Error('Docker clarification log was truncated');
      if (questions.length > questionBytes) {
        const handle = await open(input.clarification.questionsPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(questions.subarray(questionBytes)); } finally { await handle.close(); }
        questionBytes = questions.length;
      }
      await safeWrite(join(runtime, 'answers.jsonl'), await boundedFile(input.clarification.answersPath, true));
    };
    await syncClarification();
    if (input.clarification) timer = setInterval(() => {
      relay = relay.then(syncClarification).catch(error => { relayError = error; void stop().catch(() => undefined); });
    }, 500);
    const child = renderCommand(stagePaths(input));
    const readOnly = input.stage === 'review' || input.stage === 'pr-review';
    const args = ['run', '--rm', '--name', name, '--label', `helmsman.runId=${input.runId}`,
      '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--workdir', '/worktree', '--network', network,
      '--mount', mount(input.cwd, '/worktree', readOnly), '--mount', mount(runtime, '/runtime'),
      ...(input.skillsPath ? ['--mount', mount(join(input.skillsPath, 'skills'), '/skills/skills', true)] : []),
      '--env', 'HOME=/runtime/home', ...(input.transport === 'openai-responses' ? ['--env', 'CODEX_HOME=/runtime/codex-home'] : []),
      '--env', 'GIT_AUTHOR_NAME=Helmsman', '--env', 'GIT_AUTHOR_EMAIL=helmsman@localhost',
      '--env', 'GIT_COMMITTER_NAME=Helmsman', '--env', 'GIT_COMMITTER_EMAIL=helmsman@localhost',
      ...(input.transport === 'openai-responses'
        ? ['--env', `HELMSMAN_CAPABILITY=${input.gateway.capability}`]
        : ['--env', `ANTHROPIC_API_KEY=${input.gateway.capability}`, '--env', `ANTHROPIC_BASE_URL=${isolatedGateway}/anthropic`]),
      '--env', `HELMSMAN_GATEWAY_URL=${isolatedGateway}`, '--env', `HELMSMAN_REPO=${input.repo}`,
      '--entrypoint', child.cmd, image, ...child.args];
    await control(['network', 'create', '--internal', '--label', `helmsman.runId=${input.runId}`, network]);
    await control(['create', '--name', relayName, '--label', `helmsman.runId=${input.runId}`, '--network', 'bridge',
      '--add-host', 'host.docker.internal:host-gateway', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--entrypoint', 'node', image,
      '--input-type=module', '-e', gatewayRelaySource, gateway.origin, '8080']);
    await control(['network', 'connect', '--alias', 'gateway', network, relayName]);
    await control(['start', relayName]);
    await control(['exec', relayName, 'node', '-e', "(async()=>{for(let i=0;i<30;i++){try{if((await fetch('http://127.0.0.1:8080/health')).status===204)return;}catch{}await new Promise(r=>setTimeout(r,100));}process.exitCode=1;})()"]);
    return { command: { cmd: 'docker', args }, stop,
      async cleanup(success) {
        if (timer) clearInterval(timer);
        await stop();
        await teardown();
        try {
          await sanitizeGit(input.cwd, input.repo);
          await relay;
          if (relayError) throw relayError;
          await syncClarification();
          if (success && input.reviewOutputPaths) {
            const markdown = await boundedFile(join(runtime, 'review.md'));
            const comments = await boundedFile(join(runtime, 'review-comments.json'));
            if (!markdown.toString('utf8').trim() || !Array.isArray(JSON.parse(comments.toString('utf8')))) throw new Error('Docker review output is incomplete');
            await safeWrite(input.reviewOutputPaths.markdown, markdown);
            await safeWrite(input.reviewOutputPaths.comments, comments);
          } else if (success && input.reportPath) await safeWrite(input.reportPath, await boundedFile(join(runtime, 'report.json')));
        } finally { await rm(runtime, { recursive: true, force: true }); }
      } };
  } catch (error) {
    if (timer) clearInterval(timer);
    await stop().catch(() => undefined);
    await teardown().catch(() => undefined);
    await rm(runtime, { recursive: true, force: true });
    throw error;
  }
}

async function stopStages(run: DockerCommandRunner, runId: string): Promise<void> {
  if (!safeIdentity(runId)) throw new Error('Invalid Docker stage run identity');
  const containers = await run(['docker', 'ps', '--all', '--filter', `label=helmsman.runId=${runId}`, '--format', '{{.Names}}']);
  if (containers.code !== 0) throw new Error('Docker stage inventory is unavailable');
  for (const name of containers.stdout.split(/\r?\n/).filter(Boolean)) {
    const inspected = await run(['docker', 'inspect', '--type', 'container', '--format', '{{json .}}', name]);
    const value: unknown = JSON.parse(inspected.stdout);
    const row = value && typeof value === 'object' && !Array.isArray(value) ? value as ContainerInspection : null;
    if (inspected.code !== 0 || typeof row?.Id !== 'string' || !/^[a-f\d]{12,64}$/i.test(row.Id)
      || row.Config?.Labels?.['helmsman.runId'] !== runId || row.Name !== `/${name}`
      || !name.startsWith(`helmsman-stage-${runId.slice(0, 80)}-`)) {
      throw new Error('Refusing to remove an unverified Docker stage container');
    }
    const removed = await run(['docker', 'rm', '--force', row.Id]);
    if (removed.code !== 0) throw new Error('Docker stage container cleanup failed');
  }
  const networks = await run(['docker', 'network', 'ls', '--filter', `label=helmsman.runId=${runId}`, '--format', '{{.Name}}']);
  if (networks.code !== 0) throw new Error('Docker stage network inventory is unavailable');
  for (const name of networks.stdout.split(/\r?\n/).filter(Boolean)) {
    const inspected = await run(['docker', 'network', 'inspect', '--format', '{{json .}}', name]);
    const value: unknown = JSON.parse(inspected.stdout);
    const row = value && typeof value === 'object' && !Array.isArray(value) ? value as { Id?: unknown; Name?: unknown; Labels?: Record<string, unknown> } : null;
    if (inspected.code !== 0 || typeof row?.Id !== 'string' || !/^[a-f\d]{12,64}$/i.test(row.Id)
      || row.Labels?.['helmsman.runId'] !== runId || row.Name !== name
      || !name.startsWith(`helmsman-stage-${runId.slice(0, 80)}-`) || !name.endsWith('-network')) {
      throw new Error('Refusing to remove an unverified Docker stage network');
    }
    const removed = await run(['docker', 'network', 'rm', row.Id]);
    if (removed.code !== 0) throw new Error('Docker stage network cleanup failed');
  }
}

export interface DockerExecutionHostOptions {
  readonly image: string;
  readonly run?: DockerCommandRunner;
}

export function createDockerExecutionHost(options: DockerExecutionHostOptions): ExecutionHostProviderV1 {
  if (!safeImage(options.image)) throw new Error('Docker image setting is invalid');
  const run = options.run ?? defaultRun;
  return {
    metadata: { version: 1, label: 'Docker', workspace: 'clone', stageExecution: 'isolated' },
    async prepareRun() {
      const result = await run(['docker', 'image', 'inspect', '--format', '{{.Id}}', options.image]);
      if (result.code !== 0) throw new Error('Docker image inspection failed');
      const image = result.stdout.trim();
      if (!safeImage(image) || !/^sha256:[a-f\d]{64}$/i.test(image)) throw new Error('Docker image has no immutable image ID');
      return { image };
    },
    launch(spec) { return spec.coordinator ? launchCoordinator(spec) : launchContainer(run, spec); },
    discover(spec, ref) { return spec.coordinator ? discoverCoordinator(spec, ref) : discoverContainer(run, spec, ref); },
    async isAlive(ref) {
      if (stateObject(ref).kind === 'local') {
        const state = localState(ref);
        const receipt = await readExecutionHostLaunchReceipt(ref.identity);
        if (!receipt || receipt.pid !== state.pid || receipt.processStart !== state.processStart) throw new Error('Local coordinator ownership is unknown');
        return isExecutionHostProcessOwned(state.pid, state.processStart);
      }
      const state = dockerState(ref);
      const container = await inspectContainer(run, ref.identity, state.containerId);
      if (container.Id !== state.containerId || typeof container.State?.Running !== 'boolean') throw new Error('Docker container state is unknown');
      return container.State.Running;
    },
    async stop(ref) {
      if (stateObject(ref).kind === 'local') {
        const state = localState(ref);
        const receipt = await readExecutionHostLaunchReceipt(ref.identity);
        if (!receipt || receipt.pid !== state.pid || receipt.processStart !== state.processStart
          || !await isExecutionHostProcessOwned(state.pid, state.processStart)) throw new Error('Refusing to stop an unverified local coordinator');
        process.kill(state.pid, 'SIGTERM');
        return;
      }
      const state = dockerState(ref);
      const container = await inspectContainer(run, ref.identity, state.containerId);
      if (container.Id !== state.containerId) throw new Error('Refusing to stop an unverified Docker container');
      if (container.State?.Running === false && ['exited', 'dead'].includes(String(container.State.Status))) return;
      if (container.State?.Running !== true) throw new Error('Docker container state is unknown');
      const stopped = await run(['docker', 'stop', '--time', '10', state.containerId]);
      if (stopped.code !== 0) throw new Error('Docker stop failed; process ownership remains unresolved');
    },
    prepareStage(input, renderCommand) { return prepareStage(run, input, renderCommand); },
    stopStages(runId) { return stopStages(run, runId); },
  };
}
