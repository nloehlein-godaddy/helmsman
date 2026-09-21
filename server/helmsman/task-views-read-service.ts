import { TASK_VIEW_LIMITS, parseTaskTriageReadQueryV1, parseTaskTriageReadSnapshotV1, parseTaskBugsReadSnapshotV1, type TaskTriageReadQueryV1, type TaskViewQualityV1 } from '../../src/plugins/task-views';
import { parseTaskReadSelectionV1, type TaskReadSelectionV1 } from '../../src/plugins/task-read';
import { PersistenceConflictError } from './persistence';
import type { TaskSourceService } from './task-source-service';
import type { WorkRefV1 } from '../../src/plugins/tasks';

export function createTaskViewsReadService(options: { sources: TaskSourceService; repos(): readonly string[]; now?: () => Date;
  relatedRun?(ref: WorkRefV1, repo: string): { repo: string; runId: string } | null }) {
  function check(selection: TaskReadSelectionV1, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!options.repos().includes(selection.repo)) throw new PersistenceConflictError('Task view galleon is unavailable');
    const source = options.sources.instances(selection.repo).find(source => source.id === selection.instanceId);
    if (!source || source.sourceId !== selection.sourceId || source.revision !== selection.instanceRevision) throw new PersistenceConflictError('Task view source changed');
  }
  return {
    async triage(input: TaskTriageReadQueryV1, signal: AbortSignal) {
      const query = parseTaskTriageReadQueryV1(input); const selection = parseTaskReadSelectionV1(query); check(selection, signal);
      const page = await options.sources.listTriage(query, signal); check(selection, signal);
      const parsed = parseTaskTriageReadSnapshotV1({ selection, query, page }, query);
      let relatedRunsQuality: TaskViewQualityV1 = options.relatedRun ? 'complete' : 'unavailable';
      const relatedRuns = parsed.page.items.flatMap(item => {
        try { const related = options.relatedRun?.(item.ref, selection.repo); return related ? [{ ref: item.ref, ...related }] : []; }
        catch { relatedRunsQuality = 'partial'; return []; }
      });
      check(selection, signal); return parseTaskTriageReadSnapshotV1({ ...parsed, relatedRuns, relatedRunsQuality }, query);
    },
    async bugs(input: TaskReadSelectionV1, signal: AbortSignal) {
      const selection = parseTaskReadSelectionV1(input); check(selection, signal);
      const report = await options.sources.readBugs({ ...selection, asOf: (options.now ?? (() => new Date()))().toISOString(), rowLimit: TASK_VIEW_LIMITS.items }, signal);
      check(selection, signal); return parseTaskBugsReadSnapshotV1({ selection, report }, selection);
    },
  };
}
export type TaskViewsReadService = ReturnType<typeof createTaskViewsReadService>;
