import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionHostLaunchSpecV1 } from '@helmsman/plugin-sdk';
import { executionHostProcessStartIdentity, isExecutionHostProcessOwned } from '@helmsman/plugin-sdk/node';
import { createCmuxExecutionHost, createDetachedExecutionHost, createWeztermExecutionHost } from './provider';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<ExecutionHostLaunchSpecV1> {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-host-local-'));
  roots.push(root);
  return {
    version: 1,
    runId: 'run_local',
    launchId: 'launch_local',
    attempt: 1,
    cmd: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    cwd: root,
    logPath: join(root, 'run.log'),
    exitPath: join(root, 'run.exit'),
    specPath: join(root, 'run.json'),
    receiptPath: join(root, 'run.receipt'),
    wrapperPath: join(process.cwd(), 'server/helmsman/run-wrapper.mjs'),
    coordinator: false,
    configuration: null,
  };
}

async function receipt(spec: ExecutionHostLaunchSpecV1): Promise<void> {
  const processStart = await executionHostProcessStartIdentity(process.pid);
  await writeFile(spec.receiptPath, JSON.stringify({ version: 1, runId: spec.runId, launchId: spec.launchId, attempt: spec.attempt, pid: process.pid, processStart }));
}

describe.skipIf(process.platform === 'win32')('local execution host providers', () => {
  it('launches and discovers exact detached wrapper ownership', async () => {
    const spec = await fixture();
    const provider = createDetachedExecutionHost();
    const ref = await provider.launch(spec);
    try {
      expect(ref.identity).toEqual({ runId: spec.runId, launchId: spec.launchId, attempt: 1, receiptPath: spec.receiptPath });
      await vi.waitFor(async () => expect((await provider.discover(spec, ref)).status).toBe('found'));
      expect(await provider.isAlive(ref)).toBe(true);
    } finally {
      await provider.stop(ref);
      await vi.waitFor(async () => expect(await provider.discover(spec, ref)).toMatchObject({ status: 'found', evidence: { state: 'exited' } }));
    }
  });

  it('retains cmux workspace ownership and distinguishes absent inventory', async () => {
    const spec = await fixture();
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[1] === 'new-workspace') {
        await receipt(spec);
        return { stdout: 'workspace:42', code: 0 };
      }
      return { stdout: 'workspace:42 run-launch_local', code: 0 };
    });
    const provider = createCmuxExecutionHost({ socketPath: '/tmp/cmux.sock', run });
    const ref = await provider.launch(spec);
    expect(ref.state).toMatchObject({ kind: 'cmux', workspace: 'workspace:42', pid: process.pid });
    await expect(provider.discover(spec, ref)).resolves.toMatchObject({ status: 'found', evidence: { state: 'running' } });
    run.mockResolvedValue({ stdout: '', code: 0 });
    await rm(spec.receiptPath);
    await expect(provider.discover(spec)).resolves.toMatchObject({ status: 'absent' });
  });

  it('pins WezTerm pane and socket and rejects unknown ownership', async () => {
    const spec = await fixture();
    const run = vi.fn(async (args: readonly string[], socket?: string | null) => {
      expect(socket).toBe('/tmp/wez.sock');
      if (args[1] === 'spawn') {
        await receipt(spec);
        return { stdout: '7\n', code: 0 };
      }
      return { stdout: JSON.stringify([{ pane_id: 7 }]), code: 0 };
    });
    const provider = createWeztermExecutionHost({ bin: '/opt/wezterm', workspace: 'runs', resolveSocket: () => '/tmp/wez.sock', run });
    const ref = await provider.launch(spec);
    expect(ref.state).toMatchObject({ kind: 'wezterm', paneId: '7', socket: '/tmp/wez.sock' });
    await expect(provider.discover(spec, ref)).resolves.toMatchObject({ status: 'found', evidence: { state: 'running' } });
    await expect(provider.isAlive({ ...ref, state: { kind: 'wezterm', paneId: '7' } })).rejects.toThrow('ownership is unknown');
    await expect(provider.stop({ ...ref, identity: { ...ref.identity, launchId: 'other' } })).rejects.toThrow();
  });
});


async function treeFixture(ignoreTerm = false, exitParent = false, lifetime = 9500): Promise<ExecutionHostLaunchSpecV1> {
  const spec = await fixture();
  const descendant = `
    const fs = require('node:fs');
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    fs.writeFileSync('descendant-ready', String(process.pid));
    setTimeout(() => fs.writeFileSync('late-write', 'escaped'), 750);
    const interval = setInterval(() => fs.writeFileSync('ticks', String(Date.now())), 20);
    setTimeout(() => { clearInterval(interval); process.exit(0); }, ${lifetime - 500});
  `;
  const worker = `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    fs.writeFileSync('supervisor-pid', String(process.ppid));
    spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
    ${exitParent ? "const wait = setInterval(() => { if (fs.existsSync('descendant-ready')) process.exit(0); }, 10);" : `setTimeout(() => process.exit(0), ${lifetime});`}
  `;
  return { ...spec, args: ['-e', worker] };
}

async function waitForFile(path: string): Promise<void> {
  await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 4000, interval: 20 });
}

async function settled(spec: ExecutionHostLaunchSpecV1, provider: ReturnType<typeof createDetachedExecutionHost>, ref: Awaited<ReturnType<typeof provider.launch>>): Promise<void> {
  await vi.waitFor(async () => expect(await provider.discover(spec, ref)).toMatchObject({ status: 'found', evidence: { state: 'exited' } }), { timeout: 8000, interval: 25 });
}

describe.skipIf(process.platform === 'win32')('owned local worker trees', () => {
  it.each(['detached', 'cmux', 'wezterm'] as const)('settles ordinary descendants before the %s exit receipt without signalling the terminal group', async kind => {
    const spec = await treeFixture();
    let terminalChild: ChildProcess | undefined;
    const launchTerminalWrapper = () => { terminalChild = spawn(process.execPath, [spec.wrapperPath, spec.specPath], { stdio: 'ignore' }); };
    const provider = kind === 'detached' ? createDetachedExecutionHost() : kind === 'cmux'
      ? createCmuxExecutionHost({ run: async args => {
        if (args[1] === 'new-workspace') launchTerminalWrapper();
        return { stdout: 'workspace:42 run-launch_local', code: 0 };
      } })
      : createWeztermExecutionHost({ resolveSocket: () => '/test/socket', run: async args => {
        if (args[1] === 'spawn') { launchTerminalWrapper(); return { stdout: '7', code: 0 }; }
        return { stdout: JSON.stringify([{ pane_id: 7 }]), code: 0 };
      } });
    const ref = await provider.launch(spec);
    try {
      await waitForFile(join(spec.cwd, 'descendant-ready'));
      await provider.stop(ref);
      await settled(spec, provider, ref);
      await new Promise(resolve => setTimeout(resolve, 900));
      expect(existsSync(join(spec.cwd, 'late-write'))).toBe(false);
      if (terminalChild) await vi.waitFor(() => expect(terminalChild?.exitCode).toBe(0));
    } finally {
      if (await provider.isAlive(ref)) { await provider.stop(ref); await settled(spec, provider, ref); }
    }
  }, 12000);

  it('escalates TERM-ignoring descendants before publishing the terminal receipt', async () => {
    const spec = await treeFixture(true);
    const provider = createDetachedExecutionHost();
    const ref = await provider.launch(spec);
    try {
      await waitForFile(join(spec.cwd, 'ticks'));
      await provider.stop(ref);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(existsSync(spec.exitPath)).toBe(false);
      await settled(spec, provider, ref);
      const ticks = await readFile(join(spec.cwd, 'ticks'), 'utf8');
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(await readFile(join(spec.cwd, 'ticks'), 'utf8')).toBe(ticks);
    } finally {
      if (await provider.isAlive(ref)) { await provider.stop(ref); await settled(spec, provider, ref); }
    }
  }, 12000);

  it('settles background descendants when their main worker exits successfully', async () => {
    const spec = await treeFixture(false, true);
    const provider = createDetachedExecutionHost();
    const ref = await provider.launch(spec);
    await settled(spec, provider, ref);
    expect(JSON.parse(await readFile(spec.exitPath, 'utf8')).exitCode).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(existsSync(join(spec.cwd, 'late-write'))).toBe(false);
  });

  it('refuses a mismatched process-start identity without signalling the worker', async () => {
    const spec = await treeFixture();
    const provider = createDetachedExecutionHost();
    const ref = await provider.launch(spec);
    try {
      await waitForFile(join(spec.cwd, 'descendant-ready'));
      const state = ref.state as { kind: string; pid: number; processStart: string };
      const wrongStart = `${state.processStart}:wrong`;
      const wrong = { ...ref, state: { ...state, processStart: wrongStart } };
      await expect(provider.stop(wrong)).rejects.toThrow('ownership is unknown');
      await writeFile(spec.receiptPath, JSON.stringify({ version: 1, ...ref.identity, pid: state.pid, processStart: wrongStart }));
      await expect(provider.stop(wrong)).rejects.toThrow('Refusing to stop an unverified');
      expect(await isExecutionHostProcessOwned(state.pid, state.processStart)).toBe(true);
      expect(existsSync(spec.exitPath)).toBe(false);
      await writeFile(spec.receiptPath, JSON.stringify({ version: 1, ...ref.identity, pid: state.pid, processStart: state.processStart }));
    } finally {
      await provider.stop(ref);
      await settled(spec, provider, ref);
    }
  });
});


it.skipIf(process.platform === 'win32')('withholds terminal evidence while a crashed supervisor leaves live workers', async () => {
  const spec = await treeFixture(false, false, 1600);
  const provider = createDetachedExecutionHost();
  const ref = await provider.launch(spec);
  await waitForFile(join(spec.cwd, 'ticks'));
  const pid = Number(await readFile(join(spec.cwd, 'supervisor-pid'), 'utf8'));
  const start = await executionHostProcessStartIdentity(pid);
  expect(await isExecutionHostProcessOwned(pid, start)).toBe(true);
  process.kill(pid, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(existsSync(spec.exitPath)).toBe(false);
  const before = await readFile(join(spec.cwd, 'ticks'), 'utf8');
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(await readFile(join(spec.cwd, 'ticks'), 'utf8')).not.toBe(before);
  await settled(spec, provider, ref);
  expect(JSON.parse(await readFile(spec.exitPath, 'utf8')).exitCode).toBe(1);
});

it.skipIf(process.platform === 'win32')('cleans the owned group after its wrapper owner crashes without inventing a receipt', async () => {
  const spec = await treeFixture();
  const provider = createDetachedExecutionHost();
  const ref = await provider.launch(spec);
  await waitForFile(join(spec.cwd, 'descendant-ready'));
  const state = ref.state as { pid: number; processStart: string };
  expect(await isExecutionHostProcessOwned(state.pid, state.processStart)).toBe(true);
  process.kill(state.pid, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 900));
  expect(existsSync(join(spec.cwd, 'late-write'))).toBe(false);
  expect(existsSync(spec.exitPath)).toBe(false);
  expect(await provider.discover(spec, ref)).toMatchObject({ status: 'unknown' });
});

it('refuses new Windows local launches while preserving receipt inspection', async () => {
  const spec = await fixture();
  await receipt(spec);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  try {
    for (const provider of [createDetachedExecutionHost(), createCmuxExecutionHost(), createWeztermExecutionHost()]) {
      await expect(provider.prepareRun({} as never)).rejects.toThrow('POSIX process-group supervision');
      await expect(provider.launch(spec)).rejects.toThrow('POSIX process-group supervision');
    }
  } finally { Object.defineProperty(process, 'platform', descriptor); }
  expect((await createDetachedExecutionHost().discover(spec)).status).toBe('found');
});

it.skipIf(process.platform === 'win32')('lets a staged coordinator settle its separate process group before recording Stop', async () => {
  const base = await fixture();
  const stage = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    setInterval(() => fs.writeFileSync('stage-ticks', String(Date.now())), 20);
    setTimeout(() => process.exit(0), 8000);
  `;
  const coordinator = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(stage)}], { detached: true, stdio: 'ignore' });
    process.on('SIGTERM', () => setTimeout(() => child.kill('SIGKILL'), 5200));
    child.on('exit', () => process.send({ kind: 'helmsman-coordinator-settled', version: 1 }, () => process.exit(1)));
  `;
  const spec = { ...base, args: ['-e', coordinator], coordinator: true };
  const provider = createDetachedExecutionHost();
  const ref = await provider.launch(spec);
  await waitForFile(join(spec.cwd, 'stage-ticks'));
  await provider.stop(ref);
  await settled(spec, provider, ref);
  const before = await readFile(join(spec.cwd, 'stage-ticks'), 'utf8');
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(await readFile(join(spec.cwd, 'stage-ticks'), 'utf8')).toBe(before);
}, 12000);

it.skipIf(process.platform === 'win32').each(['signal', 'exception', 'exit'] as const)('does not invent stage settlement after a coordinator %s', async crash => {
  const base = await fixture();
  const stage = `
    const fs = require('node:fs');
    setInterval(() => fs.writeFileSync('stage-ticks', String(Date.now())), 20);
    setTimeout(() => process.exit(0), 1200);
  `;
  const coordinator = `
    const fs = require('node:fs');
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(stage)}], { detached: true, stdio: 'ignore' });
    const wait = setInterval(() => { if (fs.existsSync('stage-ticks')) { ${crash === 'signal' ? "process.kill(process.pid, 'SIGKILL');" : crash === 'exception' ? "throw new Error('Unexpected coordinator exception');" : "process.exit(1);"} } }, 10);
  `;
  const spec = { ...base, args: ['-e', coordinator], coordinator: true };
  const provider = createDetachedExecutionHost();
  const ref = await provider.launch(spec);
  await waitForFile(join(spec.cwd, 'stage-ticks'));
  await vi.waitFor(async () => expect(await provider.discover(spec, ref)).toMatchObject({ status: 'unknown' }));
  expect(existsSync(spec.exitPath)).toBe(false);
  const before = await readFile(join(spec.cwd, 'stage-ticks'), 'utf8');
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(await readFile(join(spec.cwd, 'stage-ticks'), 'utf8')).not.toBe(before);
  await new Promise(resolve => setTimeout(resolve, 1250));
  expect(existsSync(spec.exitPath)).toBe(false);
});

it.skipIf(process.platform === 'win32').each([0, 3])('accepts explicit settlement from real stage runtime after worker exit %s', async code => {
  const base = await fixture();
  const runtime = join(process.cwd(), 'server/helmsman/pre-pr-runtime.ts');
  const settlement = join(process.cwd(), 'server/helmsman/coordinator-settlement.ts');
  const coordinator = `
    import { executePrePrStage } from ${JSON.stringify(runtime)};
    import { acknowledgeCoordinatorSettlement } from ${JSON.stringify(settlement)};
    try {
      await executePrePrStage({ id: 'fixture', buildCommand: () => ({ cmd: process.execPath, args: ['-e', 'process.exit(${code})'] }), parseLine: () => null },
        { repo: 'org/repo', ticketId: 'fixture', title: 'Fixture', jiraBaseUrl: '' }, process.cwd(), () => {}, new AbortController().signal);
    } catch { process.exitCode = 1; }
    await acknowledgeCoordinatorSettlement();
  `;
  const spec = { ...base, args: ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', coordinator], coordinator: true };
  const provider = createDetachedExecutionHost();
  const ref = await provider.launch(spec);
  await settled(spec, provider, ref);
  expect(JSON.parse(await readFile(spec.exitPath, 'utf8')).exitCode).toBe(code === 0 ? 0 : 1);
});
