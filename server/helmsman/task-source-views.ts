import { parseTaskTriageQueryV1, parseTaskTriagePageV1, parseTaskBugsQueryV1, parseTaskBugsReportV1,
  type TaskTriageQueryV1, type TaskBugsQueryV1 } from '../../src/plugins/task-views';
import type { SourceCallContextV1, SourceInstanceV1 } from '../../src/plugins/tasks';
import type { TaskSourceRegistry } from './task-sources/registry';
import { awaitSourceResult } from './source-await';

export class TaskSourceViewUnavailableError extends Error {}
type Selection = { instanceId: string; instanceRevision: number };
export function createTaskSourceViews(options: {
  registry: TaskSourceRegistry;
  selected(instanceId: string, revision: number, repo: string): SourceInstanceV1;
  context(instance: SourceInstanceV1, repo: string, signal: AbortSignal): SourceCallContextV1;
  assertScope(instance: SourceInstanceV1, repo: string, purpose: 'admission'): void;
}) {
  return {
    async listTriage(input: TaskTriageQueryV1 & Selection, signal: AbortSignal) {
      const query = parseTaskTriageQueryV1(input); const instance = options.selected(input.instanceId, input.instanceRevision, query.repo);
      const registration = options.registry.resolve(instance, 'admission');
      if (!registration.declaration.readViews?.includes('triage') || !registration.provider.listTriage) throw new TaskSourceViewUnavailableError('This source does not provide Triage');
      signal.throwIfAborted();
      const result = await awaitSourceResult(registration.provider.listTriage(query, options.context(instance, query.repo, signal)), signal);
      signal.throwIfAborted(); options.assertScope(instance, query.repo, 'admission');
      return parseTaskTriagePageV1(result, query, instance.sourceId);
    },
    async readBugs(input: TaskBugsQueryV1 & Selection, signal: AbortSignal) {
      const query = parseTaskBugsQueryV1(input); const instance = options.selected(input.instanceId, input.instanceRevision, query.repo);
      const registration = options.registry.resolve(instance, 'admission');
      if (!registration.declaration.readViews?.includes('bugs') || !registration.provider.readBugs) throw new TaskSourceViewUnavailableError('This source does not provide Bugs');
      signal.throwIfAborted();
      const result = await awaitSourceResult(registration.provider.readBugs(query, options.context(instance, query.repo, signal)), signal);
      signal.throwIfAborted(); options.assertScope(instance, query.repo, 'admission');
      return parseTaskBugsReportV1(result, query, instance.sourceId);
    },
  };
}
