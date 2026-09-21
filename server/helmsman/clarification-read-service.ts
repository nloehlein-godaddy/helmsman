import type { Clarification } from '../../src/data/clarifications';
import { CLARIFICATION_READ_LIMITS, parseClarificationReadListQueryV1, parseClarificationReadLoadQueryV1, parseClarificationReadItemV1, parseClarificationReadPageV1,
  type ClarificationReadItemV1, type ClarificationReadListQueryV1, type ClarificationReadLoadQueryV1, type ClarificationReadPageV1 } from '../../src/plugins/clarification-read';
import type { ClarificationStore } from './clarifications';
import type { ExecutionStore } from './execution-store';
import type { ExecutionControls } from './execution-controls';
import type { Persistence } from './persistence';
import { authorizeClarification, clarificationClock, clarificationScope, ClarificationServiceError, createClarificationCursors, type ClarificationAuthority } from './clarification-service-common';

export interface ClarificationServerOptions extends ClarificationAuthority {
  persistence: Persistence;
  clarifications: ClarificationStore;
  executions: ExecutionStore;
  controls: ExecutionControls;
  repos(): readonly string[];
  now?(): string;
}
export interface ClarificationReadServerService {
  list(caller: string, query: ClarificationReadListQueryV1, scopeRepo: string | null): ClarificationReadPageV1;
  load(caller: string, query: ClarificationReadLoadQueryV1, scopeRepo: string | null): ClarificationReadItemV1;
}
export interface ClarificationRow extends Omit<Clarification, 'required'> { required: number; }
type Run = { id: string; repo: string; attempt: number; status: string };
export function createClarificationAccess(options: ClarificationServerOptions) {
  const { sql } = options.persistence;
  const now = () => clarificationClock(options.now ?? (() => new Date().toISOString()));
  const question = (id: string) => sql.prepare('SELECT * FROM clarifications WHERE id=?').get(id) as ClarificationRow | undefined;
  const run = (id: string) => sql.prepare('SELECT id,repo,attempt,status FROM runs WHERE id=?').get(id) as Run | undefined;
  function project(row: ClarificationRow, observedAt: string): ClarificationReadItemV1 {
    const provenance = options.clarifications.protocol.provenance(row.id);
    if (!provenance) throw new ClarificationServiceError(503, 'service-unavailable');
    const current = run(row.runId);
    let reason: Exclude<ClarificationReadItemV1['answerability'], { available: true }>['reason'] | null = null;
    if (provenance.kind === 'legacy-unproven') reason = 'provenance-unknown';
    else if (current && provenance.attempt !== current.attempt) reason = 'different-attempt';
    else if (row.state !== 'pending') reason = 'not-pending';
    else if (!current || current.repo !== row.repo) reason = 'run-unavailable';
    else if (current.status !== 'running') reason = 'run-inactive';
    else if (options.controls.isStopRequested({ runId: current.id, attempt: current.attempt })) reason = 'stop-requested';
    else if (row.timeoutAt !== null && row.timeoutAt <= observedAt) reason = 'deadline-expired';
    else {
      try {
        const attempt = options.executions.attempt({ runId: current.id, attempt: current.attempt });
        const snapshot = attempt && options.executions.snapshot(attempt.snapshotId);
        const channel = snapshot && options.clarifications.protocol.verify(snapshot);
        if (!snapshot || snapshot.runId !== row.runId || snapshot.repo !== row.repo || snapshot.attempt !== current.attempt
          || channel?.channelId !== provenance.channelId || channel?.attempt !== provenance.attempt) reason = 'channel-unavailable';
      } catch { reason = 'channel-unavailable'; }
    }
    return parseClarificationReadItemV1({ version: 1, id: row.id, runId: row.runId, repo: row.repo, revision: provenance.revision,
      prompt: row.question, required: row.required === 1, owner: row.owner, contactId: row.contactId, state: row.state, answer: row.answer,
      createdAt: row.createdAt, timeoutAt: row.timeoutAt, answeredAt: row.answeredAt,
      provenance: { kind: provenance.kind, attempt: provenance.attempt, channelId: provenance.channelId }, currentAttempt: current?.attempt ?? null,
      blocksPublication: row.required === 1 && row.state !== 'answered',
      answerability: reason === null ? { available: true, reason: null } : { available: false, reason } });
  }
  return { now, question, run, project };
}
export function createClarificationReadService(options: ClarificationServerOptions): ClarificationReadServerService {
  const { sql } = options.persistence; const access = createClarificationAccess(options); const cursors = createClarificationCursors();
  return {
    list(caller, raw, scopeRepo) {
      authorizeClarification(options, caller, 'clarification-read');
      const query = parseClarificationReadListQueryV1(raw); const permitted = options.repos();
      const repos = clarificationScope(permitted, scopeRepo, query.repo);
      const states = [...query.states].sort();
      const binding = cursors.binding({ caller, scopeRepo, permitted: [...permitted].sort(), repos, runId: query.runId, states, order: 'createdAt-desc-id-desc' });
      const after = query.cursor === null ? null : cursors.decode(query.cursor, binding);
      return options.persistence.transaction(() => {
        const observedAt = access.now(); const args: (string | number)[] = [...repos];
        const predicates = [repos.length ? `repo IN (${repos.map(() => '?').join(',')})` : '0'];
        if (query.runId !== null) { predicates.push('runId=?'); args.push(query.runId); }
        if (states.length) { predicates.push(`state IN (${states.map(() => '?').join(',')})`); args.push(...states); }
        const where = predicates.join(' AND ');
        const total = (sql.prepare(`SELECT COUNT(*) AS total FROM clarifications WHERE ${where}`).get(...args) as { total: number }).total;
        if (after) { predicates.push('(createdAt<? OR (createdAt=? AND id<?))'); args.push(after.createdAt, after.createdAt, after.id); }
        const rows = sql.prepare(`SELECT * FROM clarifications WHERE ${predicates.join(' AND ')} ORDER BY createdAt DESC,id DESC LIMIT ?`).all(...args, query.limit + 1) as ClarificationRow[];
        const items: ClarificationReadItemV1[] = []; let bytes = 8192;
        for (const row of rows.slice(0, query.limit)) {
          const item = access.project(row, observedAt); const size = Buffer.byteLength(JSON.stringify(item)) + 1;
          if (bytes + size > CLARIFICATION_READ_LIMITS.responseBytes) break;
          bytes += size; items.push(item);
        }
        const last = items.at(-1);
        if (rows.length && !last) throw new ClarificationServiceError(503, 'service-unavailable');
        return parseClarificationReadPageV1({ version: 1, repo: query.repo, items, total, observedAt,
          nextCursor: rows.length > items.length && last ? cursors.encode(binding, last) : null }, query, repos);
      });
    },
    load(caller, raw, scopeRepo) {
      authorizeClarification(options, caller, 'clarification-read');
      const query = parseClarificationReadLoadQueryV1(raw); clarificationScope(options.repos(), scopeRepo, query.repo);
      return options.persistence.transaction(() => {
        const row = access.question(query.questionId);
        if (!row || row.runId !== query.runId || row.repo !== query.repo) throw new ClarificationServiceError(404, 'not-found');
        return access.project(row, access.now());
      });
    },
  };
}
