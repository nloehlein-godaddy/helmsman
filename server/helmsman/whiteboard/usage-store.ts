import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { storeConnection } from '../store-connection';
import type { WhiteboardEvidence } from './service';
import type { WhiteboardGenerationUsage } from './generator';

export function openWhiteboardUsageStore(sql: Database.Database) {
  storeConnection(sql).migrate({ owner: 'core.whiteboard-usage', ddl: `CREATE TABLE whiteboard_usage (
    responseId TEXT PRIMARY KEY, targetKey TEXT NOT NULL, target TEXT NOT NULL, model TEXT NOT NULL,
    inputTokens INTEGER, cachedInputTokens INTEGER, outputTokens INTEGER, totalTokens INTEGER, recordedAt TEXT NOT NULL
  );` });
  return {
    record(evidence: WhiteboardEvidence, usage: WhiteboardGenerationUsage): void {
      if (typeof usage.id !== 'string' || !usage.id.length || usage.id.length > 2048 || /[\x00-\x20\x7f]/.test(usage.id) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(usage.model)
        || [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.totalTokens].some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))) throw new TypeError('Invalid Whiteboard usage');
      const target = JSON.stringify(evidence.target); const targetKey = createHash('sha256').update(target).digest('hex');
      const existing = sql.prepare('SELECT targetKey, model, inputTokens, cachedInputTokens, outputTokens, totalTokens FROM whiteboard_usage WHERE responseId=?').get(usage.id) as Record<string, unknown> | undefined;
      if (existing) {
        if (existing.targetKey !== targetKey || ['model', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'].some(key => existing[key] !== usage[key as keyof WhiteboardGenerationUsage])) throw new Error('Conflicting Whiteboard usage');
        return;
      }
      sql.prepare('INSERT INTO whiteboard_usage VALUES (@id,@targetKey,@target,@model,@inputTokens,@cachedInputTokens,@outputTokens,@totalTokens,@recordedAt)').run({ ...usage, targetKey, target, recordedAt: new Date().toISOString() });
    },
  };
}
