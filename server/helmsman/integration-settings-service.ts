import { randomUUID } from 'node:crypto';
import { isContributionId } from '../../src/plugins/manifest';
import { parseGithubSettingsSaveInputV1, parseGithubSettingsSnapshotInputV1, parseGithubSettingsSnapshotV1, parseGithubSettingsValuesV1, type GithubSettingsValuesV1 } from '../../src/plugins/github-settings';
import { parseJiraSettingsRotateTokenInputV1, parseJiraSettingsSnapshotInputV1, parseJiraSettingsSnapshotV1 } from '../../src/plugins/jira-settings';
import { ClarificationServiceError } from './clarification-service-common';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistenceHash, PersistenceValidationError, type Persistence } from './persistence';

export type IntegrationSettingsNamespace = 'helmsman.github/settings' | 'helmsman.jira/settings';
export interface IntegrationSettingsServerOptions {
  readonly persistence: Persistence;
  githubValues(): GithubSettingsValuesV1;
  writeGithub(values: GithubSettingsValuesV1): void;
  githubTokenSet(): boolean;
  jiraTokenSet(): boolean;
  writeJiraToken(token: string): void;
  sourceConfigured(): boolean;
  bootstrapEnabled(): boolean;
  authorize(caller: string, namespace: IntegrationSettingsNamespace): void;
  afterGithubSave?(values: GithubSettingsValuesV1): void;
}
const DDL = `CREATE TABLE integration_settings_revisions (namespace TEXT PRIMARY KEY, revision INTEGER NOT NULL)`;
export function createIntegrationSettingsService(options: IntegrationSettingsServerOptions) {
  const { persistence } = options; const { sql } = persistence; const generation = randomUUID();
  migrateOwned(sql, { owner: 'core.integration-settings', version: 1, checksum: persistenceHash(DDL), tables: ['integration_settings_revisions'], validateLegacy: () => null,
    apply: () => sql.exec(DDL), validateCurrent: () => validateTableColumns(sql, 'integration_settings_revisions', ['namespace', 'revision']) });
  function authorize(caller: string, namespace: IntegrationSettingsNamespace) {
    if (!isContributionId(caller)) throw new ClarificationServiceError(403, 'forbidden'); options.authorize(caller, namespace);
  }
  function revision(namespace: IntegrationSettingsNamespace): number {
    const row = sql.prepare('SELECT revision FROM integration_settings_revisions WHERE namespace=?').get(namespace) as { revision: unknown } | undefined;
    const value = row?.revision ?? 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new PersistenceValidationError('Integration settings revision is invalid'); return value;
  }
  function advance(namespace: IntegrationSettingsNamespace) {
    const next = revision(namespace) + 1; if (!Number.isSafeInteger(next)) throw new PersistenceValidationError('Integration settings revision limit reached');
    sql.prepare('INSERT INTO integration_settings_revisions VALUES (?,?) ON CONFLICT(namespace) DO UPDATE SET revision=excluded.revision').run(namespace, next);
  }
  function githubSnapshot() {
    const namespace = 'helmsman.github/settings'; const values = parseGithubSettingsValuesV1(options.githubValues()); const tokenSet = options.githubTokenSet();
    return parseGithubSettingsSnapshotV1({ version: 1, scope: 'global', namespace, values, tokenSet,
      revision: persistenceHash({ generation, namespace, version: revision(namespace), values, tokenSet }) });
  }
  function jiraSnapshot() {
    const namespace = 'helmsman.jira/settings'; const values = { tokenSet: options.jiraTokenSet(), sourceConfigured: options.sourceConfigured(), bootstrapEnabled: options.bootstrapEnabled() };
    return parseJiraSettingsSnapshotV1({ version: 1, scope: 'global', namespace, ...values,
      revision: persistenceHash({ generation, namespace, version: revision(namespace), ...values }) });
  }
  return Object.freeze({
    githubSnapshot(caller: string, input: unknown) {
      parseGithubSettingsSnapshotInputV1(input); authorize(caller, 'helmsman.github/settings'); return persistence.transaction(githubSnapshot);
    },
    saveGithub(caller: string, value: unknown) {
      const input = parseGithubSettingsSaveInputV1(value); authorize(caller, input.namespace);
      const result = persistence.transaction(() => {
        if (githubSnapshot().revision !== input.expectedRevision) throw new ClarificationServiceError(409, 'conflict');
        options.writeGithub(input.values); advance(input.namespace); return githubSnapshot();
      });
      try { options.afterGithubSave?.(result.values); } catch { /* Committed settings remain authoritative if a watcher cannot be notified. */ }
      return result;
    },
    jiraSnapshot(caller: string, input: unknown) {
      parseJiraSettingsSnapshotInputV1(input); authorize(caller, 'helmsman.jira/settings'); return persistence.transaction(jiraSnapshot);
    },
    rotateJiraToken(caller: string, value: unknown) {
      const input = parseJiraSettingsRotateTokenInputV1(value); authorize(caller, input.namespace);
      return persistence.transaction(() => {
        if (jiraSnapshot().revision !== input.expectedRevision) throw new ClarificationServiceError(409, 'conflict');
        options.writeJiraToken(input.token); advance(input.namespace); return jiraSnapshot();
      });
    },
  });
}
export type IntegrationSettingsServerService = ReturnType<typeof createIntegrationSettingsService>;
