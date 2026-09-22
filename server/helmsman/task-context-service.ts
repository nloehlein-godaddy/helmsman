import { parseTaskContextQueryV1, parseTaskContextSnapshotV1, type TaskContextQueryV1, type TaskContextSnapshotV1 } from '../../src/plugins/task-context';
import type { Db } from './db';
import type { TaskSourceService } from './task-source-service';
import type { TaskSourceStore, WorkClaimRecord } from './task-sources/store';

export class TaskContextError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface TaskContextServerService { resolve(input: TaskContextQueryV1, signal: AbortSignal): Promise<TaskContextSnapshotV1>; }

export function createTaskContextService(options: { sources: TaskSourceService; store: TaskSourceStore; db: Db; repos(): readonly string[] }): TaskContextServerService {
  function scoped(repo: string): void { if (!options.repos().includes(repo)) throw new TaskContextError(403, 'Task context is outside the galleon scope'); }
  function selectedClaim(query: TaskContextQueryV1): WorkClaimRecord | null {
    const claim = query.claim === 'active' ? options.store.activeClaim(query.ref) : options.store.latestClaim(query.ref);
    const source = options.store.source(query.ref.sourceId);
    return claim && claim.ref.sourceId === query.ref.sourceId && claim.ref.externalId === query.ref.externalId
      && claim.instance.sourceId === query.selection.sourceId && claim.instance.id === query.selection.instanceId && claim.instance.revision === query.selection.instanceRevision
      && source?.revision === claim.sourceRevision && (query.claim === 'active' ? claim.state !== 'settled' : claim.state === 'settled') ? claim : null;
  }
  return Object.freeze<TaskContextServerService>({ async resolve(input, signal) {
    const query = parseTaskContextQueryV1(input); scoped(query.selection.repo);
    let task;
    try { task = await options.sources.load({ ...query.selection, ref: query.ref }, signal); }
    catch (error) { throw error instanceof Error && /revision changed|selection changed|not authorized|unavailable/i.test(error.message) ? new TaskContextError(409, 'Task source selection changed') : error; }
    signal.throwIfAborted();
    if (!task) throw new TaskContextError(404, 'Task not found');
    if (task.revision !== query.taskRevision) throw new TaskContextError(409, 'Task revision changed');
    const claim = selectedClaim(query); const row = claim ? options.db.getRun(claim.runId) : null;
    const run = row && row.repo === query.selection.repo ? { repo: row.repo, runId: row.id, expectedAttempt: row.attempt } : null;
    const pullRequest = run && row && row.prNumber !== null && Number.isSafeInteger(row.prNumber) && row.prNumber > 0
      ? { repo: run.repo, number: row.prNumber, sourceRunId: run.runId } : null;
    return parseTaskContextSnapshotV1({ version: 1, task: { selection: query.selection, ref: query.ref, url: task.url },
      claim: claim ? { id: claim.id, revision: claim.revision, state: claim.state } : null, run, pullRequest }, query);
  } });
}
