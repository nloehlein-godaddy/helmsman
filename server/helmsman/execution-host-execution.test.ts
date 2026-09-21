// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionHostProviderV1, ExecutionHostReferenceV1 } from '../../src/plugins/execution-host';
import { loadConfig } from '../config';
import type { AgentTask } from './agents/adapter';
import type { RunRow } from './db';
import { executionHostAdapter, parsePluginHostRef, verifyHostExecution, retainedLegacyHostKind } from './execution-host-execution';
import { parseExecutionHostRetainedProviderV1 } from './execution-host-providers';
import { legacyExecutionSnapshot } from './legacy-execution-snapshot';
import { openExecutionStore } from './execution-store';
import { openPersistence } from './persistence';

const identity = { runId: 'run-1', launchId: 'launch-1', attempt: 1, receiptPath: '/runs/spec.receipt' };
const reference: ExecutionHostReferenceV1 = { version: 1, identity, state: { process: 'retained-process' } };
const metadata = { version: 1 as const, label: 'Custom executor', workspace: 'clone' as const, stageExecution: 'isolated' as const };
const spec = { ...identity, cmd: 'worker', args: [], cwd: '/worktree', logPath: '/runs/log', exitPath: '/runs/exit', specPath: '/runs/spec' };
const providerId = 'example.host/executor';
function fixture() {
  const record = parseExecutionHostRetainedProviderV1({ version: 1, origin: 'external', metadata, settings: { cluster: 'original' },
    binding: { providerId, pluginId: 'example.host', artifactHash: 'a'.repeat(64), contractVersion: 1 } });
  const artifact = { pluginId: 'helmsman.runtime', artifactHash: 'b'.repeat(64), packageVersion: '1.0.0', requires: [] };
  const task: AgentTask = { repo: 'org/repo', ticketId: 'T-1', title: 'Run on retained host', jiraBaseUrl: '', task: 'Execute', executionHost: record,
    hostRuntime: { pluginsRoot: '/plugins', runtimeArtifactsRoot: '/runtime', artifacts: [{ pluginId: 'example.host', artifactHash: record.binding.artifactHash, packageVersion: '1.0.0', requires: [] }] },
    hostConfiguration: { image: 'immutable-image' }, hostIsolation: { runId: 'run-1', gatewayUrl: 'http://host.docker.internal:8790', capability: 'private-gateway-token' } };
  const run = { id: 'run-1', attempt: 1, repo: task.repo, adapter: 'codex' } as RunRow;
  return { task, run, artifact, config: loadConfig({}) };
}

describe('retained execution host integration', () => {
  it('pins custom host artifacts and opaque references while excluding ephemeral gateway authority', () => {
    const f = fixture(); const persistence = openPersistence(':memory:'); const executions = openExecutionStore(persistence);
    try {
      const attempt = executions.prepare({ snapshot: legacyExecutionSnapshot({ ...f, host: 'plugin' }), launchId: identity.launchId,
        paths: { worktree: '/worktree', log: spec.logPath, exit: spec.exitPath, spec: spec.specPath }, maxConcurrency: 1 });
      const snapshot = executions.snapshot(attempt.snapshotId)!;
      expect(snapshot.bindings.filter(binding => binding.role === 'host')).toEqual([expect.objectContaining({ capability: 'helmsman/execution-host', contributionId: providerId })]);
      expect(JSON.stringify(snapshot)).not.toContain('private-gateway-token');
      expect(executions.pins('example.host')).toHaveLength(1);
      expect(() => verifyHostExecution(f.task, snapshot)).not.toThrow();
      expect(() => verifyHostExecution({ ...f.task, hostConfiguration: { image: 'current-image' } }, snapshot)).toThrow('immutable snapshot');
      expect(() => verifyHostExecution({ ...f.task, executionHost: { ...f.task.executionHost!, settings: { cluster: 'current' } } }, snapshot)).toThrow('immutable snapshot');
      const lease = executions.lease(identity, 30_000)!;
      executions.ready(lease); executions.markLaunching(lease);
      const ref = parsePluginHostRef({ kind: 'plugin', providerId, reference, ownership: identity });
      expect(() => executions.recordLaunch(lease, { ...ref, providerId: 'example.other/executor' }, { launchId: identity.launchId })).toThrow('retained launch binding');
      executions.recordLaunch(lease, ref, { launchId: identity.launchId });
      expect(executions.attempt(identity)?.hostRef).toEqual(ref);
    } finally { persistence.close(); }
  });

  it('recovers a prepared legacy host from its immutable binding before a native reference exists', () => {
    const f = fixture();
    const task = { ...f.task, executionHost: undefined, hostRuntime: undefined, hostConfiguration: undefined, hostIsolation: undefined };
    const snapshot = legacyExecutionSnapshot({ ...f, task, host: 'cmux' });
    expect(retainedLegacyHostKind({ hostKind: null }, snapshot)).toBe('cmux');
    expect(() => retainedLegacyHostKind({ hostKind: 'detached' }, snapshot)).toThrow('original legacy execution host');
    expect(() => retainedLegacyHostKind({}, { ...snapshot, bindings: [] })).toThrow('original legacy execution host');
  });

  it('rejects cross-attempt ownership before invoking stop or discovery', async () => {
    const provider: ExecutionHostProviderV1 = { metadata: { ...metadata, workspace: 'worktree', stageExecution: 'local' },
      prepareRun: async () => null, launch: vi.fn(async () => reference), discover: vi.fn(async () => ({ status: 'unknown' as const, reason: 'Receipt unavailable' })),
      isAlive: vi.fn(async () => true), stop: vi.fn(async () => {}) };
    const host = executionHostAdapter({ runId: identity.runId, providerId, provider, configuration: null, wrapperPath: '/runtime/wrapper.mjs', runtimeRoot: '/runtime' });
    const ref = await host.launch(spec);
    await expect(host.discover!(spec, ref)).resolves.toEqual({ status: 'unknown' as const, reason: 'Receipt unavailable' });
    const other = { ...reference, identity: { ...identity, runId: 'other-run' } };
    await expect(host.stop({ kind: 'plugin', providerId, reference: other, ownership: other.identity })).rejects.toThrow('another retained provider or run');
    expect(provider.stop).not.toHaveBeenCalled();
    await expect(host.discover!({ ...spec, attempt: 2 }, ref)).rejects.toThrow('another attempt');
    expect(provider.discover).toHaveBeenCalledTimes(1);
    vi.mocked(provider.launch).mockResolvedValue(other);
    await expect(host.launch(spec)).rejects.toThrow('another launch identity');
  });
});
