import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionHostLaunchSpecV1 } from './execution-host';
import {
  executionHostProcessStartIdentity,
  isExecutionHostIdentityMatch,
  isExecutionHostProcessOwned,
  readExecutionHostExitReceipt,
  readExecutionHostLaunchReceipt,
} from './execution-host-node';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<ExecutionHostLaunchSpecV1> {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-host-node-'));
  roots.push(root);
  return {
    version: 1,
    runId: 'run_one',
    launchId: 'launch_one',
    attempt: 2,
    cmd: process.execPath,
    args: [],
    cwd: root,
    logPath: join(root, 'run.log'),
    exitPath: join(root, 'run.exit'),
    specPath: join(root, 'run.json'),
    receiptPath: join(root, 'run.receipt'),
    wrapperPath: join(root, 'wrapper.mjs'),
    coordinator: false,
    configuration: null,
  };
}

describe('execution host Node evidence', () => {
  it('reads only exact matching launch and exit receipts', async () => {
    const spec = await fixture();
    const processStart = await executionHostProcessStartIdentity(process.pid);
    const receipt = { version: 1, runId: spec.runId, launchId: spec.launchId, attempt: spec.attempt, pid: process.pid, processStart };
    await writeFile(spec.receiptPath, JSON.stringify(receipt));
    await writeFile(spec.exitPath, JSON.stringify({ ...receipt, exitCode: 0 }));
    const launch = await readExecutionHostLaunchReceipt(spec);
    const exit = await readExecutionHostExitReceipt(spec);
    expect(launch).toEqual({ ...receipt, receiptPath: spec.receiptPath });
    expect(exit).toEqual({ ...receipt, receiptPath: spec.receiptPath, exitCode: 0 });
    expect(launch).not.toHaveProperty('cmd');
    expect(exit).not.toHaveProperty('configuration');
    await expect(isExecutionHostProcessOwned(process.pid, processStart)).resolves.toBe(true);
    await expect(readExecutionHostLaunchReceipt({ ...spec, attempt: 3 })).rejects.toThrow('does not match');
  });

  it('rejects mismatched exit ownership and compares the complete durable identity', async () => {
    const spec = await fixture();
    const receipt = { version: 1, runId: spec.runId, launchId: spec.launchId, attempt: spec.attempt, pid: process.pid, processStart: 'other' };
    await writeFile(spec.receiptPath, JSON.stringify(receipt));
    await writeFile(spec.exitPath, JSON.stringify({ ...receipt, pid: process.pid + 1, exitCode: 1 }));
    await expect(readExecutionHostExitReceipt(spec)).rejects.toThrow('matching launch receipt');
    expect(isExecutionHostIdentityMatch(spec, { ...spec, receiptPath: `${spec.receiptPath}.other` })).toBe(false);
    expect(isExecutionHostIdentityMatch(spec, spec)).toBe(true);
  });

  it('bounds receipt files before parsing them', async () => {
    const spec = await fixture();
    await writeFile(spec.receiptPath, ' '.repeat(64 * 1024 + 1));
    await expect(readExecutionHostLaunchReceipt(spec)).rejects.toThrow('size limit');
    await writeFile(spec.exitPath, ' '.repeat(64 * 1024 + 1));
    await expect(readExecutionHostExitReceipt(spec)).rejects.toThrow('size limit');
  });
});
