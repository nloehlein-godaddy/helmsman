import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { retainedRunTitle } from './run-title';
import { parseTaskRepo } from '../../src/plugins/tasks';
import { parseRunReadItemV1, parseRunReadListQueryV1, parseRunReadLoadQueryV1, parseRunReadLogPageV1, parseRunReadLogQueryV1,
  parseRunReadPageV1, parseRunReadSummaryV1, RUN_READ_LIMITS } from '../../src/plugins/run-read';
import type { RunReadItemV1, RunReadListQueryV1, RunReadLoadQueryV1, RunReadLogPageV1, RunReadLogQueryV1,
  RunReadPageV1, RunReadSettlementV1, RunReadSummaryV1 } from '../../src/plugins/run-read';
import type { Db, RunEventRow, RunRow } from './db';

export class RunReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface RunReadServerService {
  list(input: RunReadListQueryV1): RunReadPageV1;
  load(input: RunReadLoadQueryV1): RunReadItemV1;
  log(input: RunReadLogQueryV1): RunReadLogPageV1;
}

export function createRunReadService(options: { db: Db; repos(): readonly string[]; settlement?(runId: string): RunReadSettlementV1 | null }): RunReadServerService {
  const secret = randomBytes(32);
  const { db } = options;
  function permitted(repo: string | null): readonly string[] {
    const values = options.repos();
    if (!Array.isArray(values) || values.length > RUN_READ_LIMITS.repos) throw new RunReadError(503, 'Run scope unavailable');
    const repos = [...new Set(values.map(parseTaskRepo))].sort();
    if (repo !== null && !repos.includes(repo)) throw new RunReadError(403, 'Run scope forbidden');
    return repo === null ? repos : [repo];
  }
  function binding(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  function encode(value: object): string {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
  }
  function decode(value: string, expected: string): Record<string, unknown> {
    const [payload, signature, extra] = value.split('.');
    if (!payload || !signature || extra !== undefined) throw new RunReadError(409, 'Run cursor expired or changed');
    const actual = Buffer.from(signature, 'base64url'); const wanted = createHmac('sha256', secret).update(payload).digest();
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new RunReadError(409, 'Run cursor expired or changed');
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>).binding !== expected) throw new RunReadError(409, 'Run cursor scope changed');
    return parsed as Record<string, unknown>;
  }
  function summary(row: RunRow): RunReadSummaryV1 {
    const title = retainedRunTitle(row.taskJson);
    const verdict = row.status === 'succeeded' ? db.latestReviewVerdict(row.id)?.slice(0, 512).replace(/[\uD800-\uDBFF]$/, '') ?? null : null;
    const label = verdict?.match(/^Verdict: (Approve|Request changes|Comment only) — \S/)?.[1];
    const outcome = label === 'Approve' ? 'APPROVE' : label === 'Request changes' ? 'REQUEST_CHANGES' : label === 'Comment only' ? 'COMMENT' : null;
    return parseRunReadSummaryV1({ version: 1, id: row.id, repo: row.repo, displayKey: row.ticketId, ...(title ? { title } : {}), status: row.status, attempt: row.attempt,
      startedAt: row.startedAt, endedAt: row.endedAt, prNumber: row.prNumber, costUsd: row.costUsd,
      feedbackOutcome: db.latestFeedbackOutcome(row.id),
      review: outcome && verdict ? { outcome, verdict } : null, sourceSettlement: row.status === 'running' ? null : options.settlement?.(row.id) ?? null });
  }
  function scopedRun(query: RunReadLoadQueryV1): RunRow | null {
    permitted(query.repo);
    const row = db.getRun(query.runId);
    return row?.repo === query.repo ? row : null;
  }
  function event(row: RunEventRow) {
    const truncated = row.text.length > RUN_READ_LIMITS.logText;
    return { sequence: row.id, at: row.ts, kind: row.kind, text: truncated ? row.text.slice(0, RUN_READ_LIMITS.logText).replace(/[\uD800-\uDBFF]$/, '') : row.text, truncated };
  }
  return Object.freeze<RunReadServerService>({
    list(input) {
      const query = parseRunReadListQueryV1(input); const repos = permitted(query.repo);
      const scope = binding(['runs', query.repo, repos, query.kind]);
      const previous = query.cursor === null ? null : decode(query.cursor, scope);
      const page = db.runReadPage({ repos, kind: query.kind, limit: query.limit + 1,
        ceiling: previous?.ceiling as number | null ?? null,
        after: previous ? { startedAt: previous.startedAt as string, id: previous.id as string } : null });
      const rows = page.runs.slice(0, query.limit); const last = rows.at(-1);
      const nextCursor = page.runs.length > query.limit && last ? encode({ binding: scope, ceiling: page.ceiling, startedAt: last.startedAt, id: last.id }) : null;
      return parseRunReadPageV1({ version: 1, repo: query.repo, items: rows.map(summary), nextCursor }, query, repos);
    },
    load(input) {
      const query = parseRunReadLoadQueryV1(input); const row = scopedRun(query);
      return parseRunReadItemV1({ version: 1, repo: query.repo, runId: query.runId, run: row ? summary(row) : null }, query);
    },
    log(input) {
      const query = parseRunReadLogQueryV1(input); const row = scopedRun(query);
      if (!row) throw new RunReadError(404, 'Run not found');
      const scope = binding(['log', query.repo, query.runId]);
      let rows: RunEventRow[]; let through: number; let earlierTruncated = false; let hasMore = false; let after = 0;
      if (query.cursor === null) {
        const recent = db.recentEvents(query.runId, query.limit + 1, RUN_READ_LIMITS.logText + 1);
        earlierTruncated = recent.length > query.limit; rows = recent.slice(-query.limit); through = rows.at(-1)?.id ?? 0;
      } else {
        const previous = decode(query.cursor, scope);
        after = previous.after as number; through = previous.through as number;
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(through) || through < after) throw new RunReadError(409, 'Run cursor invalid');
        if (after === through) through = db.recentEvents(query.runId, 1, 0)[0]?.id ?? after;
        rows = db.eventPage(query.runId, after, through, query.limit + 1, RUN_READ_LIMITS.logText + 1);
        hasMore = rows.length > query.limit; rows = rows.slice(0, query.limit);
      }
      after = rows.at(-1)?.id ?? after;
      if (!hasMore) after = through;
      return parseRunReadLogPageV1({ version: 1, repo: query.repo, runId: query.runId, events: rows.map(event),
        nextCursor: encode({ binding: scope, after, through }), hasMore, earlierTruncated, workerStatus: row.status }, query);
    },
  });
}
