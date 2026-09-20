import type Database from 'better-sqlite3';
import { storeConnection } from './store-connection';
import type { AgentEvent, AgentTask } from './agents/adapter';
import type { RunRow } from './db';
import type { UsageRecorder } from './usage-store';

export interface RunTelemetryCompletion {
  runId: string;
  failureStage: string | null;
  correctionRounds: number | null;
}

export interface RunTelemetry {
  record(run: RunRow, task: AgentTask, event: AgentEvent, byteOffset: number): number | null;
  complete(run: RunRow): void;
  close(): void;
}

export function openRunTelemetry(path: string | Database.Database, usageStore: UsageRecorder, onComplete?: (completion: RunTelemetryCompletion) => void): RunTelemetry {
  const connection = storeConnection(path);
  const { sql } = connection;
  connection.migrate({ owner: 'core.telemetry', ddl: `CREATE TABLE IF NOT EXISTS run_lifecycle (
    runId TEXT NOT NULL, attempt INTEGER NOT NULL, byteOffset INTEGER NOT NULL,
    kind TEXT NOT NULL, provider TEXT, model TEXT, effort TEXT, stage TEXT, round INTEGER,
    providerEventId TEXT, PRIMARY KEY(runId, attempt, byteOffset)
  )` });

  const insert = sql.prepare(`INSERT OR IGNORE INTO run_lifecycle
    (runId,attempt,byteOffset,kind,provider,model,effort,stage,round,providerEventId) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const latestFailure = sql.prepare("SELECT stage FROM run_lifecycle WHERE runId = ? AND attempt = ? AND kind = 'error' AND stage IS NOT NULL ORDER BY attempt DESC, byteOffset DESC LIMIT 1");
  const rounds = sql.prepare('SELECT MAX(round) AS round FROM run_lifecycle WHERE runId = ?');
  return {
    record(run, task, event, byteOffset) {
      if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) throw new Error('Invalid log offset for telemetry');
      const provider = event.provider ?? run.adapter.replace(/^pre-pr:/, '');
      const model = event.model ?? task.model ?? null;
      insert.run(run.id, run.attempt, byteOffset, event.kind, provider, model, event.effort ?? task.effort ?? null,
        event.stage ?? null, event.round ?? null, event.eventId ?? null);
      if (event.usage && Object.keys(event.usage).length || event.costUsd !== undefined) {
        usageStore.recordUsage({ runId: run.id, attempt: run.attempt, eventId: `log:${byteOffset}`,
          provider, model, ...event.usage, costUsd: event.costUsd ?? null });
      }
      const usage = usageStore.listUsage([run.id]);
      const costs = usage.flatMap(item => item.costUsd === null ? [] : [item.costUsd]);
      return costs.length ? costs.reduce((sum, value) => sum + value, 0) : run.costUsd;
    },
    complete(run) {
      if (!onComplete) return;
      const failure = latestFailure.get(run.id, run.attempt) as { stage: string | null } | undefined;
      const corrections = rounds.get(run.id) as { round: number | null } | undefined;
      onComplete({ runId: run.id,
        failureStage: run.status === 'failed' ? failure?.stage ?? 'execution' : null,
        correctionRounds: corrections?.round === null || corrections?.round === undefined ? null : Math.max(0, corrections.round - 1) });
    },
    close() { connection.close(); },
  };
}
