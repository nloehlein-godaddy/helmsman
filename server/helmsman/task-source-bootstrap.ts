import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config';
import type { SourceBindingV1 } from '../../src/plugins/tasks';
import type { TaskSourceStore } from './task-sources/store';
import { createSourceConversionCoordinator } from './task-sources/conversion';
import type { TaskSourceRegistry } from './task-sources/registry';
import type { SourceConnectionStore } from './task-source-connections';
import { bootstrapJiraSourceConnection, jiraConnectionIdentity, type JiraSourceCredentialResolver } from './task-source-jira-connection';

export async function bootstrapTaskSources(options: {
  store: TaskSourceStore;
  connections: SourceConnectionStore;
  registry: TaskSourceRegistry;
  config: AppConfig;
  repos: readonly string[];
  jiraCredentials: JiraSourceCredentialResolver;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}) {
  const { store } = options;
  const diagnostics: string[] = [];
  function builtin(providerId: string): SourceBindingV1 | null {
    return options.registry.list('obligation').find(item => item.binding.providerId === providerId)?.binding ?? null;
  }
  const existingLocal = store.sources().find(source => source.provisioningKey === 'legacy-todos');
  let local = existingLocal ?? null;
  if (!local) {
    const binding = builtin('helmsman.todos/todos');
    if (binding) {
      const collectionId = randomUUID();
      local = store.provision({ provisioningKey: 'legacy-todos', label: 'Todos', storageLayout: 'legacy-todos', collectionId,
        identityEvidence: { version: 1, level: 'verified', authority: { protocol: 'helmsman.local-collection/v1', authorityId: collectionId, identityFormat: 'helmsman.local-task/v1' },
          verifiedAt: new Date().toISOString(), proof: { collectionId } }, binding, settings: {}, allowedRepos: [...new Set(options.repos)] }).source;
    } else diagnostics.push('The local task provider is unavailable; Todos remain preserved.');
  }
  let jira = store.sources().find(source => source.provisioningKey === 'legacy-jira') ?? null;
  if (!jira && options.config.jira) {
    const provider = builtin('helmsman.jira/issues');
    if (provider) {
      try {
        const connection = await bootstrapJiraSourceConnection({ store: options.connections, provisioningKey: 'legacy-jira', credentialHandle: 'jira-primary',
          resolveConfig: options.jiraCredentials, signal: options.signal, fetcher: options.fetcher });
        const config = options.config;
        jira = store.provision({ provisioningKey: 'legacy-jira', label: 'Jira', storageLayout: 'remote', identityEvidence: jiraConnectionIdentity(connection),
          binding: { ...provider, connectionId: connection.id, credentialHandle: connection.credentialHandle }, desiredEnabled: config.jiraEnabled,
          settings: { baseUrl: connection.origin, project: config.jira!.project, projectByRepo: config.repoProjectMap,
            assigneeAccountId: config.botAccountId ?? connection.subject, progressStatus: config.statusInProgress, reviewStatus: config.statusInReview,
            readyStatuses: [config.statusBacklog, config.statusTodo], backlogStatus: config.statusBacklog, todoStatus: config.statusTodo,
            jql: config.jira!.jql ?? '', assignee: config.jira!.assignee }, allowedRepos: [...new Set(options.repos)] }).source;
      } catch { diagnostics.push('Jira source identity could not be verified. Its existing work remains protected; restore the configured connection and restart.'); }
    } else diagnostics.push('The Jira task provider is unavailable; existing Jira work remains protected.');
  }
  if (local) {
    const conversion = createSourceConversionCoordinator(store);
    const audited = conversion.audit();
    conversion.convert({ expectedAuditHash: audited.hash, todoSourceId: local.id, jiraSourceId: jira?.id });
    conversion.reconcile({ sourceIds: [local.id, ...(jira ? [jira.id] : [])] });
  }
  return { todoSourceId: local?.id ?? null, jiraSourceId: jira?.id ?? null, diagnostics };
}
