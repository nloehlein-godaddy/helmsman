import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AdmissionStore } from './admission-store';
import type { AgentTask } from './agents/adapter';
import { isPrePrAdapter } from './agents/pre-pr';
import type { Db, RunRow } from './db';
import type { AttemptLease, ExecutionAttempt, ExecutionSnapshot, ExecutionSnapshotInput, ExecutionStore } from './execution-store';
import { persistedJson, persistenceHash, PersistenceConflictError, type Persistence } from './persistence';
import type { PluginLifecycle } from './plugins/lifecycle';
import type { OperationStore } from './operations';
import type { DurableRunnerAttempt, DurableRunnerCoordinator } from './runner';
import { parseClarificationChannel, type ClarificationProtocolStore } from './clarification-protocol-store';

export interface RunnerDurabilityOptions {
  persistence: Persistence;
  db: Db;
  executions: ExecutionStore;
  admissions?: AdmissionStore;
  lifecycle?: PluginLifecycle;
  operations?: OperationStore;
  clarificationProtocol?: ClarificationProtocolStore;
  runsDir: string;
  maxConcurrency: number;
  snapshot(run: RunRow, task: AgentTask): ExecutionSnapshotInput;
  verify(snapshot: ExecutionSnapshot): Promise<void>;
  finalize?(run: RunRow, snapshot: ExecutionSnapshot): void;
  now?: () => string;
}

const LEASE_MS = 60_000;

export function createRunnerDurability(options: RunnerDurabilityOptions): DurableRunnerCoordinator {
  const { persistence, db, executions } = options;
  const now = options.now ?? (() => new Date().toISOString());
  function session(initial: ExecutionAttempt): DurableRunnerAttempt {
    let lease: AttemptLease | null = executions.lease(initial, LEASE_MS);
    if (!lease) throw new PersistenceConflictError('Another coordinator owns this execution attempt');
    const snapshot = executions.snapshot(initial.snapshotId);
    if (!snapshot) throw new PersistenceConflictError('Execution snapshot is unavailable');
    const owned = (): AttemptLease => {
      if (!lease) throw new PersistenceConflictError('Execution attachment has closed');
      return lease;
    };
    return {
      launchId: initial.launchId, attempt: initial.attempt,
      paths: { logPath: initial.paths.log, exitPath: initial.paths.exit, specPath: initial.paths.spec, receiptPath: `${initial.paths.spec}.receipt` },
      preparation: initial.preparation, hostRef: initial.hostRef, terminalStatus: initial.outcome?.status ?? null,
      ready(worktreePath) { persistence.transaction(() => {
        executions.setWorktree(owned(), worktreePath);
        executions.ready(owned());
        db.updateRun(initial.runId, { worktreePath });
      }); },
      launching: () => executions.markLaunching(owned()),
      launched(ref, evidence) { persistence.transaction(() => {
        executions.recordLaunch(owned(), ref, persistedJson(evidence));
        db.updateRun(initial.runId, { hostKind: ref.kind, hostRef: JSON.stringify(ref) });
      }); },
      attachment(state, reason) {
        executions.recordAttachment(owned(), state, state === 'attached' ? null : {
          code: `attachment-${state}`, message: reason ?? 'Execution attachment needs reconciliation', retryable: true, details: null,
        });
      },
      terminal(value) {
        if (!Number.isSafeInteger(value.exitCode)) throw new PersistenceConflictError('Verified worker exit evidence is required');
        const current = executions.attempt(initial);
        executions.recordOutcome(owned(), { status: value.status, endedAt: current?.outcome?.endedAt ?? now(),
          evidence: persistedJson({ exitCode: value.exitCode, ownership: value.evidence }) });
      },
      finalize(row) { persistence.transaction(() => {
        executions.assertLease(owned());
        if (row.id !== initial.runId || row.attempt !== initial.attempt || row.status === 'running') throw new PersistenceConflictError('Final execution status is invalid');
        const current = executions.attempt(initial);
        if (!current?.outcome) throw new PersistenceConflictError('Execution cannot finalize without terminal evidence');
        if (isPrePrAdapter(row.adapter) && row.status !== 'succeeded' && row.worktreePath) {
          executions.retainCheckpoint({ id: `${row.id}:${row.attempt}:pre-pr`, runId: row.id, attempt: row.attempt,
            snapshotId: snapshot.id, format: 'helmsman.pre-pr.pending-validation', formatVersion: 1, state: 'resumable',
            artifacts: persistedJson({ worktreePath: row.worktreePath, logPath: row.logPath ?? null,
              exitPath: row.exitPath ?? null, specPath: row.specPath ?? null, needsInspection: true }) });
        }
        options.finalize?.(row, snapshot);
        if (row.status === 'succeeded' && row.attempt > 1) {
          const priorCheckpoint = executions.checkpoint(`${row.id}:${row.attempt - 1}:pre-pr`);
          if (priorCheckpoint?.state === 'resumable') executions.retireCheckpoint(priorCheckpoint.id,
            { actor: 'helmsman', reason: `Continuation attempt ${row.attempt} completed successfully` });
        }
        db.updateRun(row.id, { ...row, endedAt: row.endedAt ?? current.outcome.endedAt });
        executions.releasePins('execution', snapshot.id);
        executions.releaseReservation(row.id, current.outcome.evidence);
      }); },
      renew() {
        const next = executions.renew(owned(), LEASE_MS);
        if (!next) throw new PersistenceConflictError('Execution ownership lease was lost');
        lease = next;
      },
      close() {
        if (!lease) return;
        const releasing = lease;
        lease = null;
        executions.releaseLease(releasing);
      },
    };
  }
  return {
    async prepare(run, task) {
      const input = options.snapshot(run, task);
      if (options.clarificationProtocol && task.clarification) {
        const channel = parseClarificationChannel(task.clarification);
        if (!channel || channel.runId !== run.id || channel.attempt !== run.attempt) throw new PersistenceConflictError('New execution requires a prepared clarification channel');
        const snapshotTask = input.task && typeof input.task === 'object' && !Array.isArray(input.task) ? input.task as Record<string, unknown> : null;
        if (persistenceHash(parseClarificationChannel(snapshotTask?.clarification)) !== persistenceHash(channel)) throw new PersistenceConflictError('Execution snapshot must retain the prepared clarification channel');
        input.schemas = [...input.schemas.filter(schema => schema.owner !== 'core.clarification-protocol'), { owner: 'core.clarification-protocol', minimum: 1, maximum: 1 }];
      }
      const attempt = persistence.transaction(() => {
        const previousRun = db.getRun(run.id);
        if (previousRun && options.operations?.list({ runId: run.id }).some(operation => operation.status !== 'completed')) {
          throw new PersistenceConflictError('Settle the previous attempt’s external operations before continuing or retrying');
        }
        if (previousRun?.status === 'failed' && isPrePrAdapter(previousRun.adapter)) {
          const checkpoint = executions.checkpoint(`${run.id}:${previousRun.attempt}:pre-pr`);
          const retained = checkpoint ? executions.snapshot(checkpoint.snapshotId) : null;
          if (checkpoint?.state !== 'resumable' || !retained || !task.prePrResume) throw new PersistenceConflictError('Continuation requires its retained resumable checkpoint');
          for (const field of ['artifacts', 'bindings', 'settings', 'workflowSnapshotId'] as const) {
            if (persistenceHash(input[field]) !== persistenceHash(retained[field])) throw new PersistenceConflictError('Continuation bindings changed; a validated checkpoint migration is required');
          }
          input.provenance = { kind: 'admission', evidence: { checkpointId: checkpoint.id, checkpointSnapshotId: checkpoint.snapshotId } };
        }
        options.lifecycle?.assertAdmission(input);
        const base = join(options.runsDir, `${run.id}.attempt-${run.attempt}`);
        const prepared = executions.prepare({ snapshot: input, launchId: randomUUID(), maxConcurrency: options.maxConcurrency,
          paths: { worktree: run.worktreePath, log: `${base}.log`, exit: `${base}.exit`, spec: `${base}.json` } });
        if (options.clarificationProtocol) {
          const snapshot = executions.snapshot(prepared.snapshotId);
          if (!snapshot) throw new PersistenceConflictError('Prepared execution snapshot is unavailable');
          options.clarificationProtocol.bind(snapshot);
        }
        const row = { ...run, logPath: prepared.paths.log, exitPath: prepared.paths.exit, specPath: prepared.paths.spec, logOffset: 0 };
        const existing = db.getRun(run.id);
        if (existing) {
          if (existing.attempt !== run.attempt - 1) throw new PersistenceConflictError('Execution attempt sequence changed');
          const previous = executions.attempt({ runId: run.id, attempt: existing.attempt });
          if (!previous?.outcome) throw new PersistenceConflictError('Prior attempt has no proven process outcome');
          executions.releasePins('execution', previous.snapshotId);
          db.updateRun(run.id, row);
        } else db.insertRun(row);
        if (run.attempt === 1 && options.admissions?.get(run.id)) options.admissions.started(run.id);
        return prepared;
      });
      return session(attempt);
    },
    async recover(row) {
      const attempt = executions.attempt({ runId: row.id, attempt: row.attempt });
      if (!attempt) throw new PersistenceConflictError('Legacy voyage needs verified binding and ownership adoption before attachment');
      const snapshot = executions.snapshot(attempt.snapshotId);
      if (!snapshot) throw new PersistenceConflictError('Retained execution snapshot is unavailable');
      options.clarificationProtocol?.verify(snapshot);
      if (row.repo !== snapshot.repo || row.worktreePath !== attempt.paths.worktree || row.logPath !== attempt.paths.log
        || row.exitPath !== attempt.paths.exit || row.specPath !== attempt.paths.spec) throw new PersistenceConflictError('Run paths or scope differ from the retained execution');
      await options.verify(snapshot);
      options.lifecycle?.assertObligation(snapshot);
      return session(attempt);
    },
    cleanupEligibility: runId => executions.cleanupEligibility(runId),
  };
}
