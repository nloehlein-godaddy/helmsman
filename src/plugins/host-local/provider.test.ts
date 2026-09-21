import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionHostLaunchSpecV1 } from '@helmsman/plugin-sdk';
import { executionHostProcessStartIdentity } from '@helmsman/plugin-sdk/node';
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

describe('local execution host providers', () => {
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
