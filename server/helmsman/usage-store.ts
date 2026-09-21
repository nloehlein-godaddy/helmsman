import type Database from 'better-sqlite3';
import { storeConnection } from './store-connection';
import type { ProviderUsage } from '../../src/plugins/usage';

export class UsageValidationError extends Error {}
export class UsageConflictError extends Error {}

export interface UsageRecorder {
  recordUsage(input: unknown): boolean;
  listUsage(runIds: string[]): ProviderUsage[];
}

export interface UsageStore extends UsageRecorder {
  close(): void;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UsageValidationError('Expected a usage object');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new UsageValidationError(`Invalid ${name}`);
  }
  return value.trim();
}

export function usageRunId(value: unknown): string {
  const id = text(value, 'run ID', 128);
  if (!/^[a-z\d_-]+$/i.test(id)) throw new UsageValidationError('Invalid run ID');
  return id;
}

function number(value: unknown, name: string, integer = false): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || integer && !Number.isSafeInteger(value)) {
    throw new UsageValidationError(`Invalid ${name}`);
  }
  return value;
}

export function parseProviderUsage(input: unknown): ProviderUsage {
  const value = record(input);
  const allowed = ['runId', 'attempt', 'eventId', 'provider', 'model', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens', 'costUsd'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new UsageValidationError('Unknown usage field');
  const attempt = number(value.attempt, 'attempt', true);
  if (attempt === null || attempt < 1 || attempt > 10000) throw new UsageValidationError('Invalid attempt');
  const result: ProviderUsage = {
    runId: usageRunId(value.runId), attempt, eventId: text(value.eventId, 'usage event ID', 256),
    provider: text(value.provider, 'provider', 193),
    model: value.model === undefined || value.model === null ? null : text(value.model, 'model', 160),
    inputTokens: number(value.inputTokens, 'input tokens', true),
    cachedInputTokens: number(value.cachedInputTokens, 'cached input tokens', true),
    outputTokens: number(value.outputTokens, 'output tokens', true),
    totalTokens: number(value.totalTokens, 'total tokens', true), costUsd: number(value.costUsd, 'cost'),
  };
  if (result.inputTokens === null && result.cachedInputTokens === null && result.outputTokens === null && result.totalTokens === null && result.costUsd === null) {
    throw new UsageValidationError('Usage must include tokens or a known cost');
  }
  return result;
}

export function openUsageStore(path: string | Database.Database): UsageStore {
  const connection = storeConnection(path);
  const { sql } = connection;
  try {
    connection.migrate({ owner: 'core.usage', ddl: `CREATE TABLE IF NOT EXISTS outcome_usage (
      runId TEXT NOT NULL, attempt INTEGER NOT NULL, eventId TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (runId, attempt, eventId)
    )` });

    const read = sql.prepare('SELECT runId, attempt, eventId, payload FROM outcome_usage WHERE runId = ? AND attempt = ? AND eventId = ?');
    const list = sql.prepare('SELECT runId, attempt, eventId, payload FROM outcome_usage WHERE runId = ? ORDER BY attempt, eventId');
    const insert = sql.prepare('INSERT INTO outcome_usage (runId, attempt, eventId, payload) VALUES (?, ?, ?, ?)');
    const decode = (row: unknown): ProviderUsage | null => {
      if (row === undefined || row === null) return null;
      const stored = record(row);
      if (typeof stored.payload !== 'string') throw new UsageValidationError('Stored usage data is invalid');
      try {
        const item = parseProviderUsage(JSON.parse(stored.payload));
        if (item.runId !== stored.runId || item.attempt !== stored.attempt || item.eventId !== stored.eventId) {
          throw new UsageValidationError('Stored usage identity is invalid');
        }
        return item;
      }
      catch { throw new UsageValidationError('Stored usage data is invalid'); }
    };
    let closed = false;
    return {
      recordUsage: sql.transaction((input: unknown): boolean => {
        const item = parseProviderUsage(input);
        const prior = decode(read.get(item.runId, item.attempt, item.eventId));
        if (prior) {
          if (JSON.stringify(prior) !== JSON.stringify(item)) throw new UsageConflictError('Usage event already exists with different values');
          return false;
        }
        insert.run(item.runId, item.attempt, item.eventId, JSON.stringify(item));
        return true;
      }).immediate,
      listUsage: runIds => {
        if (!Array.isArray(runIds) || runIds.length > 100000) throw new UsageValidationError('Invalid run selection');
        const ids = [...new Set(runIds.map(usageRunId))];
        return ids.flatMap(id => list.all(id).flatMap(row => { const item = decode(row); return item ? [item] : []; }));
      },
      close() { if (!closed) { closed = true; connection.close(); } },
    };
  } catch (error) { connection.close(); throw error; }
}
