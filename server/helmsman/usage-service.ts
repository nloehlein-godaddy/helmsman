import type { ProviderUsage, UsageQuery, UsageQueryService, UsageSnapshot, UsageTotals } from '../../src/plugins/usage';
import type { Db, RunRow } from './db';
import { parseProviderUsage, usageRunId, UsageValidationError, UsageConflictError, type UsageRecorder } from './usage-store';

const validRepo = (value: unknown): value is string => typeof value === 'string'
  && /^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(value) && !['.', '..'].includes(value.split('/')[1] ?? '');
const knownAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new UsageValidationError('Expected a UTC timestamp');
  }
  const canonical = new Date(value).toISOString();
  if (canonical.slice(0, 19) !== value.slice(0, 19)) throw new UsageValidationError('Invalid UTC date');
  return canonical;
}

export function parseUsageQuery(input: unknown): UsageQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UsageValidationError('Invalid usage query');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['version', 'repo', 'from', 'to'].includes(key)) || value.version !== 1) {
    throw new UsageValidationError('Unsupported usage query');
  }
  if (value.repo !== null && !validRepo(value.repo)) throw new UsageValidationError('Invalid galleon');
  const from = timestamp(value.from);
  const to = timestamp(value.to);
  const elapsed = Date.parse(to) - Date.parse(from);
  if (elapsed <= 0 || elapsed > 366 * 86_400_000) throw new UsageValidationError('Choose a window from one instant up to 366 days');
  return { version: 1, repo: value.repo as string | null, from, to };
}

function sum(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) throw new UsageValidationError('Usage totals exceed the supported range');
  return total;
}

function reportsByRun(records: readonly ProviderUsage[]): Map<string, ProviderUsage[]> {
  const byRun = new Map<string, ProviderUsage[]>();
  for (const record of records) {
    const reports = byRun.get(record.runId) ?? [];
    reports.push(record);
    byRun.set(record.runId, reports);
  }
  return byRun;
}

function totals(runs: readonly RunRow[], records: readonly ProviderUsage[]): UsageTotals {
  const byRun = reportsByRun(records);
  const knownCosts: number[] = [];
  const observedCosts: number[] = [];
  for (const run of runs) {
    const reports = byRun.get(run.id) ?? [];
    if (reports.length === 0) {
      if (knownAmount(run.costUsd)) { knownCosts.push(run.costUsd); observedCosts.push(run.costUsd); }
      continue;
    }
    const reported = reports.flatMap(item => item.costUsd === null ? [] : [item.costUsd]);
    const observed = sum(reported);
    if (observed !== null) observedCosts.push(observed);
    if (reported.length === reports.length && observed !== null) knownCosts.push(observed);
  }
  const tokens = (key: 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'totalTokens') =>
    sum(records.flatMap(record => record[key] === null ? [] : [record[key]]));
  return {
    observedCostUsd: sum(observedCosts), knownCostUsd: sum(knownCosts), runsWithKnownCost: knownCosts.length,
    runsWithoutUsage: runs.filter(run => !byRun.has(run.id)).length,
    inputTokens: tokens('inputTokens'), cachedInputTokens: tokens('cachedInputTokens'),
    outputTokens: tokens('outputTokens'), totalTokens: tokens('totalTokens'),
  };
}

export function createUsageQueryService(deps: {
  db: Pick<Db, 'runsInWindow'>;
  usage: Pick<UsageRecorder, 'listUsage'>;
}): UsageQueryService {
  return {
    async query(input): Promise<UsageSnapshot> {
      const query = parseUsageQuery(input);
      const rows = deps.db.runsInWindow(query.from, query.to, query.repo);
      if (!Array.isArray(rows)) throw new UsageValidationError('Stored run data is invalid');
      const selected = new Map<string, RunRow>();
      for (const run of rows) {
        if (!run || !validRepo(run.repo) || !['running', 'succeeded', 'failed', 'stopped'].includes(run.status)) {
          throw new UsageValidationError('Stored run data is invalid');
        }
        usageRunId(run.id);
        if (run.endedAt !== null) timestamp(run.endedAt);
        const started = Date.parse(timestamp(run.startedAt));
        if (started < Date.parse(query.from) || started >= Date.parse(query.to)
          || query.repo !== null && run.repo.toLowerCase() !== query.repo.toLowerCase()) continue;
        selected.set(run.id, run);
      }
      const runs = [...selected.values()];
      const stored = deps.usage.listUsage([...selected.keys()]);
      if (!Array.isArray(stored)) throw new UsageValidationError('Stored usage data is invalid');
      const events = new Map<string, ProviderUsage>();
      for (const record of stored.map(parseProviderUsage)) {
        if (!selected.has(record.runId)) continue;
        const key = JSON.stringify([record.runId, record.attempt, record.eventId]);
        const previous = events.get(key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new UsageConflictError('Conflicting usage records');
        events.set(key, record);
      }
      const records = [...events.values()];
      const grouped = reportsByRun(records);
      return {
        version: 1, currency: 'USD', repo: query.repo, window: { from: query.from, to: query.to },
        runs: runs.map(run => {
          const reports = grouped.get(run.id);
          const reportedCostUsd = reports?.length ? sum(reports.flatMap(record => record.costUsd === null ? [] : [record.costUsd]))
            : knownAmount(run.costUsd) ? run.costUsd : null;
          return { runId: run.id, repo: run.repo, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt, reportedCostUsd };
        }),
        records, reported: totals(runs, records),
      };
    },
  };
}
