// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detachedHost, discoverRunHost, readExitEvidence, readLaunchReceipt, type LaunchSpec } from './run-host';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(args = ['-e', 'process.exit(3)']) {
  const root = await mkdtemp(join(tmpdir(), 'host-evidence-')); roots.push(root);
  const spec: LaunchSpec = { runId: 'run1', launchId: 'launch1', attempt: 1, cmd: process.execPath, args, cwd: root,
    logPath: join(root, 'log'), exitPath: join(root, 'exit'), specPath: join(root, 'spec'), receiptPath: join(root, 'receipt') };
  return { root, spec, host: detachedHost(join(import.meta.dirname, 'run-wrapper.mjs')) };
}

it('writes ownership before worker effects and pairs the exit marker with this attempt', async () => {
  const { spec, host } = await fixture();
  const ref = await host.launch(spec);
  await vi.waitFor(async () => expect(await readLaunchReceipt(spec)).toMatchObject({ launchId: 'launch1', attempt: 1, pid: ref.kind === 'detached' ? ref.pid : 0 }), { timeout: 10_000 });
  await vi.waitFor(async () => expect(await readExitEvidence(spec)).toMatchObject({ exitCode: 3, launchId: 'launch1' }), { timeout: 10_000 });
  expect(await discoverRunHost(host, spec, ref)).toMatchObject({ status: 'found', evidence: { state: 'exited', exitCode: 3 } });
  await expect(readExitEvidence({ ...spec, attempt: 2, launchId: 'launch2' })).rejects.toThrow('does not match');
  const again = await host.launch(spec);
  expect(again).toMatchObject({ kind: 'detached', pid: ref.kind === 'detached' ? ref.pid : 0 });
});

it('keeps a missing receipt, reused PID, and wrong host ref unresolved', async () => {
  const { spec, host } = await fixture();
  expect(await discoverRunHost(host, spec)).toMatchObject({ status: 'unknown' });
  await writeFile(spec.receiptPath!, JSON.stringify({ version: 1, launchId: spec.launchId, runId: spec.runId, attempt: 1, pid: process.pid, processStart: 'another-process' }));
  expect(await discoverRunHost(host, spec)).toMatchObject({ status: 'unknown' });
  expect(await discoverRunHost(host, spec, { kind: 'detached', pid: process.pid + 1 })).toMatchObject({ status: 'unknown' });
  await expect(host.launch(spec)).rejects.toThrow('cannot be verified');
});

it('does not execute two workers when wrappers race for the same durable receipt', async () => {
  const { spec, host } = await fixture(['-e', "require('node:fs').appendFileSync('effects','once\\n')"]);
  await Promise.all([host.launch(spec), host.launch(spec)]);
  await vi.waitFor(async () => expect((await readExitEvidence(spec))?.exitCode).toBe(0), { timeout: 10_000 });
  expect(await readFile(join(spec.cwd, 'effects'), 'utf8')).toBe('once\n');
});

it('reports unavailable legacy discovery as unknown without probing a boolean liveness API', async () => {
  const { spec } = await fixture();
  const isAlive = vi.fn(async () => false);
  expect(await discoverRunHost({ kind: 'detached', launch: vi.fn(), stop: vi.fn(), isAlive }, spec)).toMatchObject({ status: 'unknown' });
  expect(isAlive).not.toHaveBeenCalled();
});
