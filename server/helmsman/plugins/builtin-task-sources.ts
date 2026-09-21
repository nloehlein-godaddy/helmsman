import { parsePluginPackage } from '../../../src/plugins/package';
import todos from '../../../src/plugins/todos/provider';
import jira from '../../../src/plugins/jira/backend';
import type { BuiltinBackendPlugin } from './backend';

export const builtinTaskSources: readonly BuiltinBackendPlugin[] = [
  { package: parsePluginPackage({ packageVersion: 1,
    manifest: { manifestVersion: 1, id: 'helmsman.todos', version: '0.1.0', sdkVersion: 1, pages: [] },
    node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
    backend: { entry: 'provider.js', provides: [{ id: 'helmsman/task-source', version: 1, localId: 'todos' }],
      taskSources: { todos: { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: ['create', 'update', 'delete'], access: ['local-records'], readViews: ['underway', 'history'] } },
      settings: {}, storageVersion: 1 } }, { allowBuiltin: true }), module: todos },
  { package: parsePluginPackage({ packageVersion: 1,
    manifest: { manifestVersion: 1, id: 'helmsman.jira', version: '0.1.0', sdkVersion: 1, pages: [] },
    node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
    backend: { entry: 'backend.js', provides: [{ id: 'helmsman/task-source', version: 1, localId: 'issues' }],
      taskSources: { issues: { identityFormats: ['jira.issue-id/v1'], effectIds: ['assign', 'transition', 'retain-claim'], commandIds: [], access: ['connection-http'], readViews: ['underway', 'history'] } },
      settings: {}, storageVersion: 1 } }, { allowBuiltin: true }), module: jira },
];
