import { ACTIVITY_READ_LIMITS, activityReadWindow, parseActivityReadSnapshotV1 } from '../../src/plugins/activity-read';
import { parseTaskReadSelectionV1, type TaskReadSelectionV1 } from '../../src/plugins/task-read';
import { PersistenceConflictError } from './persistence';
import type { TaskSourceService } from './task-source-service';

export function createActivityReadService(options: { sources: TaskSourceService; repos(): readonly string[]; now?: () => Date }) {
  return {
    async query(input: TaskReadSelectionV1, signal: AbortSignal) {
      const selection = parseTaskReadSelectionV1(input); signal.throwIfAborted();
      const check = () => {
        signal.throwIfAborted();
        if (!options.repos().includes(selection.repo)) throw new PersistenceConflictError('Activity repository is unavailable');
        const source = options.sources.instances(selection.repo).find(source => source.id === selection.instanceId);
        if (!source || source.sourceId !== selection.sourceId || source.revision !== selection.instanceRevision) throw new PersistenceConflictError('Activity source changed');
      };
      check();
      const window = activityReadWindow((options.now ?? (() => new Date()))());
      const history = await options.sources.readHistory({ ...selection, ...window, eventLimit: ACTIVITY_READ_LIMITS.events }, signal);
      check();
      return parseActivityReadSnapshotV1({ selection, history }, selection);
    },
  };
}
export type ActivityReadService = ReturnType<typeof createActivityReadService>;
