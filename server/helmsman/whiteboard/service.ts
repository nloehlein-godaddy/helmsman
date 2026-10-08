import { boundWhiteboardDiff } from './evidence';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { WhiteboardSnapshotV1, WhiteboardTargetV1 } from '../../../src/plugins/whiteboard';
import { parsePullRequestInspectTargetV1, type PullRequestInspectDiffV1, type PullRequestInspectTargetV1 } from '../../../src/plugins/pull-request-inspect';
import type { RunRow } from '../db';
import type { PullRequestInspectServerService } from '../pull-request-inspect-service';
import { clarificationScope } from '../clarification-service-common';
import { protocolRecord } from '../agent-protocol';
import { redactText } from '../postmortem/evidence';
import { openWhiteboardStore, type WhiteboardRecord } from './store';
import type { WhiteboardClient, WhiteboardDocument } from './client';
import { parseWhiteboardDocument, validateWhiteboardSources } from './generator';

export class WhiteboardError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string) { super(reason); this.status = status; this.reason = reason; }
}
export interface WhiteboardEvidence {
  readonly version: 1; readonly target: WhiteboardTargetV1; readonly title: string;
  readonly comparison: PullRequestInspectTargetV1; readonly diff: PullRequestInspectDiffV1;
  readonly run: { readonly id: string; readonly attempt: number; readonly status: string; readonly ticketId: string } | null;
}
export interface WhiteboardServerService {
  read(target: WhiteboardTargetV1, signal?: AbortSignal): Promise<WhiteboardSnapshotV1>;
  explain(target: WhiteboardTargetV1, signal?: AbortSignal): Promise<WhiteboardSnapshotV1>;
  open(target: WhiteboardTargetV1, signal?: AbortSignal): Promise<WhiteboardSnapshotV1>;
  dispose(): void;
}

export function createWhiteboardService(options: {
  sql: Database.Database; getRun(id: string): RunRow | null; repos(): readonly string[];
  inspect: PullRequestInspectServerService; repositoryPath(repo: string): string | null;
  client: WhiteboardClient; generate(evidence: WhiteboardEvidence, signal: AbortSignal): Promise<WhiteboardDocument>;
}): WhiteboardServerService {
  const store = openWhiteboardStore(options.sql);
  const operations = new Map<string, Promise<WhiteboardSnapshotV1>>();
  const lifetime = new AbortController();
  const keyOf = (target: WhiteboardTargetV1) => createHash('sha256').update(JSON.stringify(target.kind === 'run'
    ? ['run', target.repo, target.runId, target.expectedAttempt]
    : ['pull-request', target.repo, target.number, target.baseSha, target.headSha])).digest('hex');
  const snapshot = (target: WhiteboardTargetV1, record: WhiteboardRecord | null): WhiteboardSnapshotV1 => ({ version: 1, target,
    status: record?.status ?? 'absent', sessionId: record?.sessionId ?? null, baseSha: record?.baseSha ?? null,
    headSha: record?.headSha ?? null, message: record?.message ?? null });
  function check(target: WhiteboardTargetV1): RunRow | null {
    clarificationScope(options.repos(), null, target.repo);
    if (target.kind !== 'run') return null;
    const run = options.getRun(target.runId);
    if (!run || run.repo !== target.repo) throw new WhiteboardError(404, 'not-found');
    if (run.attempt !== target.expectedAttempt) throw new WhiteboardError(409, 'attempt-changed');
    return run;
  }
  function retainedComparison(run: RunRow): PullRequestInspectTargetV1 {
    let task: Record<string, unknown> | null;
    try { task = run.taskJson ? protocolRecord(JSON.parse(run.taskJson)) ?? null : null; } catch { throw new WhiteboardError(409, 'invalid-retained-target'); }
    const source = protocolRecord(task?.pullRequestSource);
    if (!source?.target) throw new WhiteboardError(409, 'pinned-comparison-required');
    let comparison: PullRequestInspectTargetV1;
    try { comparison = parsePullRequestInspectTargetV1(source.target); } catch { throw new WhiteboardError(409, 'invalid-retained-target'); }
    if (comparison.repo !== run.repo || comparison.number !== run.prNumber || task?.prHeadSha !== undefined && task.prHeadSha !== comparison.headSha) throw new WhiteboardError(409, 'invalid-retained-target');
    return comparison;
  }
  function checkStored(target: WhiteboardTargetV1, record: WhiteboardRecord | null): void {
    if (target.kind !== 'run' || !record) return;
    const run = check(target); if (!run) throw new WhiteboardError(404, 'not-found');
    const comparison = retainedComparison(run);
    if (record.baseSha !== comparison.baseSha || record.headSha !== comparison.headSha) throw new WhiteboardError(409, 'comparison-changed');
  }
  async function evidence(target: WhiteboardTargetV1, signal: AbortSignal): Promise<WhiteboardEvidence> {
    const run = check(target);
    if (!options.repositoryPath(target.repo)) throw new WhiteboardError(503, 'repository-unavailable');
    let comparison: PullRequestInspectTargetV1;
    if (target.kind === 'pull-request') comparison = { repo: target.repo, number: target.number, baseSha: target.baseSha, headSha: target.headSha };
    else {
      if (!run) throw new WhiteboardError(404, 'not-found');
      comparison = retainedComparison(run);
    }
    const detail = await options.inspect.detail({ version: 1, repo: target.repo, number: comparison.number }, signal);
    if (detail.target.headSha !== comparison.headSha) throw new WhiteboardError(409, 'head-changed');
    if (detail.target.baseSha !== comparison.baseSha) throw new WhiteboardError(409, 'base-changed');
    const diff = await options.inspect.diff({ version: 1, target: comparison }, signal);
    if (diff.target.repo !== comparison.repo || diff.target.number !== comparison.number || diff.target.baseSha !== comparison.baseSha || diff.target.headSha !== comparison.headSha) throw new WhiteboardError(502, 'invalid-comparison');
    check(target); signal.throwIfAborted();
    const result: WhiteboardEvidence = { version: 1, target, title: redactText(detail.title), comparison,
      diff: boundWhiteboardDiff({ ...diff, files: diff.files.map(file => ({ ...file, patch: file.patch === null ? null : redactText(file.patch) })) }),
      run: run ? { id: run.id, attempt: run.attempt, status: run.status, ticketId: run.ticketId } : null };
    if (Buffer.byteLength(JSON.stringify(result)) > 400 * 1024) throw new WhiteboardError(413, 'evidence-too-large');
    return result;
  }
  async function create(target: WhiteboardTargetV1, signal?: AbortSignal): Promise<WhiteboardSnapshotV1> {
    signal?.throwIfAborted(); lifetime.signal.throwIfAborted(); check(target);
    const key = keyOf(target); const saved = store.read(key);
    checkStored(target, saved);
    if (saved && saved.status !== 'failed') return snapshot(target, saved);
    const active = operations.get(key); if (active) return active;
    if (operations.size >= 8) throw new WhiteboardError(503, 'busy');
    const controller = AbortSignal.any([lifetime.signal, AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
    const operation = (async () => {
      await options.client.check(controller);
      const input = await evidence(target, controller);
      if (saved?.sessionId && (saved.baseSha !== input.comparison.baseSha || saved.headSha !== input.comparison.headSha)) throw new WhiteboardError(409, 'comparison-changed');
      const record: WhiteboardRecord = { key, target: JSON.stringify(target), status: 'creating', sessionId: saved?.sessionId ?? null,
        baseSha: input.comparison.baseSha, headSha: input.comparison.headSha, evidence: saved?.sessionId ? saved.evidence : JSON.stringify(input), document: saved?.sessionId ? saved.document : null, message: null };
      if (saved) store.save(record); else store.insert(record);
      let creating = false;
      try {
        const document = parseWhiteboardDocument(record.sessionId && saved?.document ? JSON.parse(saved.document) : await options.generate(input, controller));
        validateWhiteboardSources(document, record.sessionId ? JSON.parse(record.evidence) as WhiteboardEvidence : input);
        controller.throwIfAborted(); check(target);
        const current = await options.inspect.detail({ version: 1, repo: target.repo, number: input.comparison.number }, controller);
        if (current.target.headSha !== input.comparison.headSha || current.target.baseSha !== input.comparison.baseSha) throw new WhiteboardError(409, 'head-changed');
        controller.throwIfAborted(); check(target);
        record.document = JSON.stringify(document); store.save(record);
        if (!record.sessionId) {
          const repositoryPath = options.repositoryPath(target.repo);
          if (!repositoryPath) throw new WhiteboardError(503, 'repository-unavailable');
          creating = true;
          const sessionId = await options.client.create({ repositoryPath, title: input.title, baseSha: record.baseSha, headSha: record.headSha }, controller);
          if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new WhiteboardError(502, 'invalid-session');
          record.sessionId = sessionId; store.save(record); creating = false;
        }
        controller.throwIfAborted(); check(target);
        await options.client.write(record.sessionId, document, controller);
        controller.throwIfAborted(); check(target);
        record.status = 'ready'; store.save(record);
        return snapshot(target, record);
      } catch {
        record.status = creating ? 'recovery-required' : 'failed';
        record.message = creating ? 'Whiteboard creation could not be confirmed. Reconcile the existing session before retrying.' : 'Explanation could not be completed. Retry when the service is available.';
        store.save(record); return snapshot(target, record);
      }
    })().finally(() => operations.delete(key));
    operations.set(key, operation); return operation;
  }
  return {
    async read(target, signal) { signal?.throwIfAborted(); check(target); const record = store.read(keyOf(target)); checkStored(target, record); return snapshot(target, record); },
    explain: create,
    async open(target, signal) {
      const controller = AbortSignal.any([lifetime.signal, AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
      controller.throwIfAborted(); check(target); const record = store.read(keyOf(target));
      checkStored(target, record);
      if (record?.status !== 'ready' || !record.sessionId) throw new WhiteboardError(409, 'session-not-ready');
      await options.client.open(record.sessionId, controller);
      controller.throwIfAborted(); check(target); checkStored(target, record);
      return snapshot(target, record);
    },
    dispose() { lifetime.abort(); },
  };
}
