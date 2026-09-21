import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseTaskRepo } from '../../src/plugins/tasks';
import { parseRunReadListQueryV1, parseRunReadSummaryV1 } from '../../src/plugins/run-read';
import type { RunReadListQueryV1, RunReadSettlementV1, RunReadSummaryV1 } from '../../src/plugins/run-read';
import { parseRunInspectExportQueryV1, parseRunInspectHistoryPageV1, parseRunInspectLogPageV1, parseRunInspectLogQueryV1,
  parseRunInspectResolveQueryV1, RUN_INSPECT_LIMITS } from '../../src/plugins/run-inspect';
import type { RunInspectExportMetadataV1, RunInspectExportQueryV1, RunInspectHistoryPageV1, RunInspectLogPageV1, RunInspectLogQueryV1,
  RunInspectResolvedV1, RunInspectResolveQueryV1, RunInspectResultV1, RunInspectTargetV1 } from '../../src/plugins/run-inspect';
import type { Db, RunRow } from './db';

type Reason = Extract<RunInspectResultV1<never>, { status: 'unavailable' }>['reason'];
export class RunInspectError extends Error {
  readonly status: number; readonly reason: Reason;
  constructor(status: number, reason: Reason) { super(reason); this.status = status; this.reason = reason; }
}
export interface RunInspectServerExportV1 { readonly metadata: RunInspectExportMetadataV1; chunks(signal?: AbortSignal): AsyncIterable<Uint8Array>; }
export interface RunInspectServerService {
  resolve(input: RunInspectResolveQueryV1 & { repo: string | null }): RunInspectResolvedV1;
  history(input: RunReadListQueryV1): RunInspectHistoryPageV1;
  log(input: RunInspectLogQueryV1 & { scopeRepo: string | null }): RunInspectLogPageV1;
  openExport(input: RunInspectExportQueryV1 & { scopeRepo: string | null }): RunInspectServerExportV1;
}
export function createRunInspectService(options: { db: Db; repos(): readonly string[]; now?(): string; settlement?(runId: string): RunReadSettlementV1 | null }): RunInspectServerService {
  const { db } = options; const secret = randomBytes(32); const now = options.now ?? (() => new Date().toISOString());
  function permitted(scopeRepo: string | null): readonly string[] {
    const values = options.repos();
    if (!Array.isArray(values) || values.length > 1000) throw new RunInspectError(503, 'service-unavailable');
    const repos = [...new Set(values.map(parseTaskRepo))].sort();
    if (scopeRepo === null) return repos;
    const repo = parseTaskRepo(scopeRepo); if (!repos.includes(repo)) throw new RunInspectError(403, 'forbidden'); return [repo];
  }
  const binding = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  function encode(value: object): string {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
  }
  function decode(cursor: string, expected: string): Record<string, unknown> {
    try {
      const [payload, signature, extra] = cursor.split('.');
      if (!payload || !signature || extra !== undefined) throw new Error();
      const actual = Buffer.from(signature, 'base64url'); const wanted = createHmac('sha256', secret).update(payload).digest();
      if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).binding !== expected) throw new Error();
      return value as Record<string, unknown>;
    } catch { throw new RunInspectError(409, 'cursor-invalid'); }
  }
  function number(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new RunInspectError(409, 'cursor-invalid'); return value;
  }
  function summary(row: RunRow): RunReadSummaryV1 {
    const verdict = row.status === 'succeeded' ? db.latestReviewVerdict(row.id)?.slice(0, 512).replace(/[\uD800-\uDBFF]$/, '') ?? null : null;
    const label = verdict?.match(/^Verdict: (Approve|Request changes|Comment only) — \S/)?.[1];
    const outcome = label === 'Approve' ? 'APPROVE' : label === 'Request changes' ? 'REQUEST_CHANGES' : label === 'Comment only' ? 'COMMENT' : null;
    return parseRunReadSummaryV1({ version: 1, id: row.id, repo: row.repo, displayKey: row.ticketId, status: row.status, attempt: row.attempt,
      startedAt: row.startedAt, endedAt: row.endedAt, prNumber: row.prNumber, costUsd: row.costUsd,
      review: outcome && verdict ? { outcome, verdict } : null, sourceSettlement: row.status === 'running' ? null : options.settlement?.(row.id) ?? null });
  }
  function requireRun(row: RunRow | null, target: RunInspectTargetV1, repos: readonly string[]): RunRow {
    if (!repos.includes(target.repo) || !row || row.id !== target.runId || row.repo !== target.repo) throw new RunInspectError(404, 'not-found');
    if (row.attempt !== target.expectedAttempt) throw new RunInspectError(409, 'attempt-changed'); return row;
  }
  function logBinding(scopeRepo: string | null, repos: readonly string[], target: RunInspectTargetV1, direction: string): string {
    return binding(['log', scopeRepo, repos, target, direction]);
  }
  return Object.freeze<RunInspectServerService>({
    resolve(input) {
      const query = parseRunInspectResolveQueryV1(input); const repos = permitted(input.repo); const run = db.getRun(query.runId);
      if (!run || !repos.includes(run.repo)) throw new RunInspectError(404, 'not-found');
      const row = summary(run);
      return Object.freeze({ version: 1, target: Object.freeze({ repo: row.repo, runId: row.id, expectedAttempt: row.attempt }), observedAt: now() });
    },
    history(input) {
      const query = parseRunReadListQueryV1(input); const repos = permitted(query.repo); const scope = binding(['history', query.repo, repos, query.kind]);
      const previous = query.cursor === null ? null : decode(query.cursor, scope);
      if (previous && (typeof previous.startedAt !== 'string' || !Number.isFinite(Date.parse(previous.startedAt)) || typeof previous.id !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(previous.id))) throw new RunInspectError(409, 'cursor-invalid');
      const page = db.runInspectHistory({ repos, kind: query.kind, limit: query.limit + 1, ceiling: previous ? number(previous.ceiling) : null,
        after: previous ? { startedAt: previous.startedAt as string, id: previous.id as string } : null });
      const rows = page.runs.slice(0, query.limit); const last = rows.at(-1);
      return parseRunInspectHistoryPageV1({ version: 1, repo: query.repo, items: rows.map(summary), total: page.total, totalQuality: 'exact',
        observedAt: now(), coverage: 'insertion-bounded-current-state', nextCursor: page.runs.length > query.limit && last
          ? encode({ binding: scope, ceiling: page.ceiling, startedAt: last.startedAt, id: last.id }) : null }, query, repos);
    },
    log(input) {
      const query = parseRunInspectLogQueryV1(input); const repos = permitted(input.scopeRepo); requireRun(db.getRun(query.target.runId), query.target, repos);
      const scope = logBinding(input.scopeRepo, repos, query.target, query.direction);
      const previous = query.cursor === null ? null : decode(query.cursor, scope);
      const through = previous ? number(previous.through) : null; const position = previous ? number(previous.position) : null;
      if (through !== null && position !== null && position > through) throw new RunInspectError(409, 'cursor-invalid');
      const page = db.runInspectLog({ runId: query.target.runId, expectedAttempt: query.target.expectedAttempt, direction: query.direction,
        through, position, limit: query.limit, textLimit: RUN_INSPECT_LIMITS.logText + 1 });
      const run = requireRun(page.run, query.target, repos);
      const nextPosition = query.direction === 'backward' ? page.events[0]?.id : page.hasLater ? page.events.at(-1)?.id : page.through;
      const nextCursor = query.direction === 'backward' && !page.hasEarlier ? null : encode({ binding: scope, through: page.through, position: nextPosition });
      return parseRunInspectLogPageV1({ version: 1, target: query.target, provenance: 'run-wide', observedAt: now(), workerStatus: run.status,
        events: page.events.map(event => ({ sequence: event.id, at: event.ts, kind: event.kind,
          text: event.text.slice(0, RUN_INSPECT_LIMITS.logText).replace(/[\uD800-\uDBFF]$/, ''), truncated: event.text.length > RUN_INSPECT_LIMITS.logText })),
        throughSequence: page.through, hasEarlier: page.hasEarlier, hasLater: page.hasLater, nextCursor,
        followCursor: query.cursor === null ? encode({ binding: logBinding(input.scopeRepo, repos, query.target, 'forward'), through: page.through, position: page.through }) : null }, query);
    },
    openExport(input) {
      const query = parseRunInspectExportQueryV1(input); const scopeRepo = input.scopeRepo; const repos = permitted(scopeRepo); const scope = binding(repos);
      if (!repos.includes(query.target.repo)) throw new RunInspectError(404, 'not-found');
      const snapshot = db.runInspectWatermark(query.target.runId); requireRun(snapshot.run, query.target, repos);
      const metadata: RunInspectExportMetadataV1 = Object.freeze({ version: 1, target: query.target, provenance: 'run-wide', observedAt: now(),
        throughSequence: snapshot.through, filename: `helmsman-${query.target.runId}.log`, contentType: 'text/plain; charset=utf-8' });
      function check(signal?: AbortSignal) {
        signal?.throwIfAborted(); const latest = permitted(scopeRepo);
        if (binding(latest) !== scope) throw new RunInspectError(409, 'selection-changed');
        requireRun(db.getRun(query.target.runId), query.target, latest);
      }
      return Object.freeze({ metadata, async *chunks(signal?: AbortSignal) {
        const encoder = new TextEncoder(); let after = 0;
        check(signal);
        while (after < snapshot.through) {
          check(signal); const event = db.runInspectEventMetadata(query.target.runId, after, snapshot.through);
          if (!event) throw new RunInspectError(503, 'service-unavailable');
          for (const [field, prefix, length] of [['ts', '[', event.tsBytes], ['kind', '] ', event.kindBytes], ['text', ': ', event.textBytes]] as const) {
            check(signal); yield encoder.encode(prefix);
            if (!Number.isSafeInteger(length) || length < 0) throw new RunInspectError(503, 'service-unavailable');
            for (let offset = 0; offset < length;) {
              check(signal); const expected = Math.min(RUN_INSPECT_LIMITS.exportChunkBytes, length - offset);
              const bytes = db.runInspectEventBytes(query.target.runId, event.id, field, offset, expected);
              if (!bytes || bytes.byteLength !== expected) throw new RunInspectError(503, 'service-unavailable');
              offset += bytes.byteLength; yield bytes;
            }
          }
          check(signal); yield encoder.encode('\n'); after = event.id;
        }
        check(signal);
      } });
    },
  });
}
