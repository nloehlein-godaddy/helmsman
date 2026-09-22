// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDb } from './db';
import { RunBus } from './event-bus';
import { openExecutionStore } from './execution-store';
import { openPersistence } from './persistence';
import { openRunTelemetry } from './run-telemetry';
import { createRunnerDurability } from './runner-durability';
import { startRun, type RunnerDeps } from './runner';
import { openUsageStore } from './usage-store';

it.each([
  { maxCostUsd: null, attempts: 3, exitCode: 1, status: 'failed' },
  { maxCostUsd: 0.5, attempts: 1, exitCode: 1, status: 'failed' },
  { maxCostUsd: 0.75, attempts: 1, exitCode: 1, status: 'failed' },
  { maxCostUsd: 1.5, attempts: 2, exitCode: 1, status: 'failed' },
  { maxCostUsd: 0.5, attempts: 1, exitCode: 0, status: 'succeeded' },
])('enforces a $maxCostUsd cap after final telemetry without changing $status settlement', async ({ maxCostUsd, attempts, exitCode, status }) => {
  const root = await mkdtemp(join(tmpdir(), 'runner-final-cost-'));
  const persistence = openPersistence(join(root, 'state.sqlite'));
  try {
    const db = openDb(persistence.sql); const executions = openExecutionStore(persistence);
    const usage = openUsageStore(persistence.sql); const telemetry = openRunTelemetry(persistence.sql, usage);
    const task = { repo: 'owner/repo', ticketId: 'rerun', title: 'Update branch', jiraBaseUrl: '', task: 'local fixture', prBranch: 'fix/fixture' };
    const artifact = { pluginId: 'example.runtime', artifactHash: 'a'.repeat(64), packageVersion: '1', requires: [] };
    const durable = createRunnerDurability({ persistence, db, executions, runsDir: root, maxConcurrency: 1, verify: async () => {},
      snapshot: run => ({ version: 1, runId: run.id, attempt: run.attempt, repo: run.repo, logicalWork: { source: 'fixture', instance: 'local', taskId: task.ticketId },
        task, workflowSnapshotId: null, artifacts: [artifact], settings: {}, schemas: [], provenance: { kind: 'admission', evidence: null },
        bindings: [{ role: 'host', capability: 'host', contractVersion: 1, contributionId: 'detached', pluginId: artifact.pluginId,
          artifactHash: artifact.artifactHash, connectionId: null, credentialHandle: null }] }) });
    const launches: { attempt: number; priorCost: number | null }[] = [];
    const ref = { kind: 'detached' as const, pid: 123 };
    const stop = vi.fn(async () => {});
    const deps: RunnerDeps = { db, durable, bus: new RunBus(), runsDir: root, genId: () => 'terminal-cost', now: () => new Date().toISOString(),
      pollIntervalMs: 5, maxAttempts: 3, maxCostUsd, recordAgentEvent: telemetry.record,
      adapter: { id: 'example.agent/worker', buildCommand: () => ({ cmd: 'fixture-only', args: [] }), parseLine: JSON.parse },
      createWorktree: async () => ({ path: root, branch: task.prBranch }), createWorktreeFromBranch: async () => ({ path: root, branch: task.prBranch }), removeWorktree: async () => {},
      host: { kind: 'detached', launch: async spec => {
        launches.push({ attempt: spec.attempt!, priorCost: db.getRun(spec.runId)?.costUsd ?? null });
        const receipt = { version: 1, runId: spec.runId, launchId: spec.launchId, attempt: spec.attempt, pid: 123, processStart: 'bounded-fake-worker' };
        await writeFile(spec.logPath, JSON.stringify({ kind: 'usage', text: 'Final provider cost', costUsd: 0.75 }));
        await writeFile(spec.receiptPath!, JSON.stringify(receipt));
        await writeFile(spec.exitPath, JSON.stringify({ ...receipt, exitCode }));
        return ref;
      }, stop, isAlive: async () => false, discover: async spec => ({ status: 'found', ref,
        evidence: { runId: spec.runId, launchId: spec.launchId!, attempt: spec.attempt!, state: 'exited', exitCode } }) } };
    await startRun(task, deps);
    expect(db.getRun('terminal-cost')).toMatchObject({ attempt: attempts, costUsd: 0.75 * attempts, status });
    expect(launches).toEqual(Array.from({ length: attempts }, (_, index) => ({ attempt: index + 1, priorCost: index ? index * 0.75 : null })));
    expect(usage.listUsage(['terminal-cost'])).toHaveLength(attempts);
    expect(executions.reservations()).toEqual([]);
    expect(executions.attempt({ runId: 'terminal-cost', attempt: attempts })?.outcome?.status).toBe(status);
    expect(stop).not.toHaveBeenCalled();
  } finally { persistence.close(); await rm(root, { recursive: true, force: true }); }
});
