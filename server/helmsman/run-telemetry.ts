import type Database from 'better-sqlite3';
import { storeConnection } from './store-connection';
import type { AgentEvent, AgentTask } from './agents/adapter';
import type { RunRow } from './db';
import type { UsageRecorder } from './usage-store';
import { parseAgentSelectionV1 } from './agent-providers';

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

function providerId(run: RunRow, event: AgentEvent): string {
  return event.provider ?? run.adapter.replace(/^(?:pre-pr:|docker-review:)/, '');
}

function costReporting(run: RunRow, task: AgentTask): 'delta' | 'cumulative' {
  if (run.adapter.startsWith('pre-pr:') || run.adapter.startsWith('docker-review:') || task.review && task.dockerExecution) return 'delta';
  if (!task.agentSelection) return 'delta';
  const provider = run.adapter;
  const selection = parseAgentSelectionV1(task.agentSelection);
  const retained = [selection.writer, ...selection.reviewers].find(record => record.binding.providerId === provider || record.binding.providerId.endsWith(`/${provider}`));
  return retained?.metadata.costReporting ?? 'delta';
}

function validCost(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

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
      const provider = providerId(run, event);
      const model = event.model ?? task.model ?? null;
      insert.run(run.id, run.attempt, byteOffset, event.kind, provider, model, event.effort ?? task.effort ?? null,
        event.stage ?? null, event.round ?? null, event.eventId ?? null);
      const usage = usageStore.listUsage([run.id]);
      const cumulative = costReporting(run, task) === 'cumulative';
      const reportedCost = validCost(event.costUsd) && cumulative
        ? Math.max(0, event.costUsd - usage.filter(item => item.attempt === run.attempt && item.provider === provider && item.costUsd !== null
          && /^log:\d+$/.test(item.eventId) && Number(item.eventId.slice(4)) < byteOffset)
          .reduce((sum, item) => sum + (item.costUsd ?? 0), 0))
        : event.costUsd;
      if (event.usage && Object.keys(event.usage).length || reportedCost !== undefined) {
        usageStore.recordUsage({ runId: run.id, attempt: run.attempt, eventId: `log:${byteOffset}`,
          provider, model, ...event.usage, costUsd: reportedCost ?? null });
      }
      const costs = usageStore.listUsage([run.id]).flatMap(item => item.costUsd === null ? [] : [item.costUsd]);
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
