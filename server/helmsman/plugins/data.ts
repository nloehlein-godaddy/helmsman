import { parseFeedbackSettingsSaveV1, parseFeedbackSettingsSnapshotV1, type FeedbackSettingsSnapshotV1 } from '../../../src/plugins/feedback-settings';
import { persistenceHash, PersistenceConflictError } from '../persistence';
import type { TriggerSelectionRoleV1 } from '../../../src/plugins/trigger';
import { parseWorkflowModeV1, type WorkflowModeV1 } from '../../../src/plugins/workflow';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PluginJson } from '../../../src/plugins/backend';
import { isContributionId, isPluginId } from '../../../src/plugins/manifest';
import { parsePluginPackage, validatePluginSetting, type PluginPackage } from '../../../src/plugins/package';
import { storeConnection } from '../store-connection';
import { immediateTransaction, registerPersistenceWriter } from '../persistence';

export function pluginJson(value: unknown, limits: { maxNodes: number; maxBytes: number; maxDepth?: number } = { maxNodes: 4096, maxBytes: 128 * 1024 }): PluginJson {
  const maxDepth = limits.maxDepth ?? 16;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 64) throw new Error('Invalid plugin JSON depth limit.');
  let nodes = 0;
  function copy(input: unknown, depth: number): PluginJson {
    if (++nodes > limits.maxNodes || depth > maxDepth) throw new Error('Plugin JSON exceeds complexity limits.');
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (!input || typeof input !== 'object' || !Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('Plugin values must be plain JSON data.');
    const result: Record<string, PluginJson> = Object.create(null) as Record<string, PluginJson>;
    for (const key of Reflect.ownKeys(input)) {
      if (Array.isArray(input) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor)
        || Array.isArray(input) && !/^(0|[1-9]\d*)$/.test(key)) throw new Error('Plugin JSON cannot contain accessors or symbols.');
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (!Array.isArray(input)) return Object.freeze(result);
    if (Object.keys(result).length !== input.length) throw new Error('Plugin JSON arrays must be dense.');
    return Object.freeze(Array.from({ length: input.length }, (_, index) => result[String(index)]!));
  }
  const parsed = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(parsed)) > limits.maxBytes) throw new Error('Plugin JSON exceeds its size limit.');
  return parsed;
}

function database(root: string): Database.Database {
  mkdirSync(root, { recursive: true });
  const connection = storeConnection(join(root, 'plugin-data.sqlite'));
  const sql = connection.sql;
  try {
    sql.pragma('busy_timeout = 5000');
    connection.migrate({ owner: 'core.plugins.data', optionalLegacyTables: ['plugin_projection_revisions'], ddl: `CREATE TABLE IF NOT EXISTS plugin_storage_versions (plugin TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_storage (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(plugin,key));
      CREATE TABLE IF NOT EXISTS plugin_settings (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(plugin,key));
      CREATE TABLE IF NOT EXISTS capability_bindings (capability TEXT PRIMARY KEY, provider TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backend_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS builtin_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, package TEXT);
      CREATE TABLE IF NOT EXISTS plugin_projection_revisions (pluginId TEXT PRIMARY KEY,revision INTEGER NOT NULL,artifactHash TEXT NOT NULL,enabled INTEGER NOT NULL)` });
    return sql;
  } catch (error) { sql.close(); throw error; }
}

function key(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[^a-zA-Z0-9_.-]/.test(value)) throw new Error('Invalid plugin storage key.');
}

function settings(sql: Database.Database, pkg: PluginPackage): Readonly<Record<string, PluginJson>> {
  const schema = pkg.backend?.settings ?? {};
  const values: Record<string, PluginJson> = {};
  for (const [name, field] of Object.entries(schema)) values[name] = field.default;
  const rows = sql.prepare('SELECT key, value FROM plugin_settings WHERE plugin = ?').all(pkg.manifest.id) as { key: string; value: string }[];
  for (const row of rows) {
    const field = Object.hasOwn(schema, row.key) ? schema[row.key] : undefined;
    if (!field) throw new Error(`Stored setting is no longer declared: ${row.key}`);
    const value: unknown = JSON.parse(row.value);
    validatePluginSetting(field, value);
    values[row.key] = pluginJson(value);
  }
  return Object.freeze(values);
}

export function readPluginSettings(root: string, pkg: PluginPackage): Readonly<Record<string, PluginJson>> {
  const sql = database(root);
  try { return settings(sql, pkg); } finally { sql.close(); }
}

export function writePluginSettings(root: string, pkg: PluginPackage, input: unknown): Readonly<Record<string, PluginJson>> {
  const values = pluginJson(input);
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Settings must be a JSON object.');
  const schema = pkg.backend?.settings ?? {};
  for (const [name, value] of Object.entries(values)) {
    const field = Object.hasOwn(schema, name) ? schema[name] : undefined;
    if (!field) throw new Error(`Unknown plugin setting: ${name}`);
    validatePluginSetting(field, value);
  }
  const sql = database(root);
  try {
    return sql.transaction(() => {
      for (const [name, value] of Object.entries(values)) sql.prepare('INSERT INTO plugin_settings VALUES(?,?,?) ON CONFLICT(plugin,key) DO UPDATE SET value=excluded.value').run(pkg.manifest.id, name, JSON.stringify(value));
      return settings(sql, pkg);
    })();
  } finally { sql.close(); }
}

export function clearPluginSettings(root: string, pluginId: string, name?: string): void {
  if (!isPluginId(pluginId)) throw new Error('Invalid plugin ID.');
  if (name !== undefined) key(name);
  const sql = database(root);
  try {
    if (name === undefined) sql.prepare('DELETE FROM plugin_settings WHERE plugin=?').run(pluginId);
    else sql.prepare('DELETE FROM plugin_settings WHERE plugin=? AND key=?').run(pluginId, name);
  } finally { sql.close(); }
}

export function openPluginData(root: string, pkg: PluginPackage) {
  const sql = database(root);
  const id = pkg.manifest.id;
  try {
    const existing = sql.prepare('SELECT version FROM plugin_storage_versions WHERE plugin=?').get(id) as { version: number } | undefined;
    if (existing && existing.version !== pkg.backend?.storageVersion) throw new Error('Plugin storage version is incompatible.');
    const values = settings(sql, pkg);
    const releaseWriter = registerPersistenceWriter({ sql, transaction: fn => immediateTransaction(sql, fn), close: () => {} }, `plugin:${id}`);
    return {
      settings: values,
      read(name: string): PluginJson | undefined {
        key(name);
        const row = sql.prepare('SELECT value FROM plugin_storage WHERE plugin=? AND key=?').get(id, name) as { value: string } | undefined;
        return row ? pluginJson(JSON.parse(row.value)) : undefined;
      },
      commit(changes: ReadonlyMap<string, PluginJson | undefined>): void {
        sql.transaction(() => {
          sql.prepare('INSERT INTO plugin_storage_versions VALUES(?,?) ON CONFLICT(plugin) DO NOTHING').run(id, pkg.backend?.storageVersion ?? 1);
          for (const [name, value] of changes) {
            key(name);
            if (value === undefined) sql.prepare('DELETE FROM plugin_storage WHERE plugin=? AND key=?').run(id, name);
            else sql.prepare('INSERT INTO plugin_storage VALUES(?,?,?) ON CONFLICT(plugin,key) DO UPDATE SET value=excluded.value').run(id, name, JSON.stringify(pluginJson(value)));
          }
          const size = sql.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM plugin_storage WHERE plugin=?').get(id) as { count: number; bytes: number };
          if (size.count > 1024 || size.bytes > 8 * 1024 * 1024) throw new Error('Plugin storage quota exceeded.');
        })();
      },
      close() { if (sql.open) { releaseWriter(); sql.close(); } },
    };
  } catch (error) { sql.close(); throw error; }
}

export function readPricingBinding(root: string): string | undefined {
  const sql = database(root);
  try {
    const row = sql.prepare('SELECT provider FROM capability_bindings WHERE capability=?').get('helmsman/pricing') as { provider: unknown } | undefined;
    if (row && !isContributionId(row.provider)) throw new Error('Pricing provider binding is invalid.');
    return row?.provider as string | undefined;
  } finally { sql.close(); }
}

export function selectPricingProvider(root: string, provider: string | null): void {
  if (provider !== null && !isContributionId(provider)) throw new Error('Invalid pricing provider ID.');
  const sql = database(root);
  try {
    sql.transaction(() => {
      sql.prepare("INSERT INTO backend_meta VALUES('defaults-initialized','1') ON CONFLICT(key) DO NOTHING").run();
      if (provider === null) sql.prepare('DELETE FROM capability_bindings WHERE capability=?').run('helmsman/pricing');
      else sql.prepare('INSERT INTO capability_bindings VALUES(?,?) ON CONFLICT(capability) DO UPDATE SET provider=excluded.provider').run('helmsman/pricing', provider);
    })();
  } finally { sql.close(); }
}

export function initializePricingDefault(root: string, provider: string): void {
  if (!isContributionId(provider)) throw new Error('Invalid default pricing provider.');
  const sql = database(root);
  try {
    sql.transaction(() => {
      const first = sql.prepare("INSERT INTO backend_meta VALUES('defaults-initialized','1') ON CONFLICT(key) DO NOTHING").run().changes;
      if (first) sql.prepare('INSERT INTO capability_bindings VALUES(?,?) ON CONFLICT(capability) DO NOTHING').run('helmsman/pricing', provider);
    })();
  } finally { sql.close(); }
}

export function readPullRequestProviderBinding(root: string): string | undefined {
  const sql = database(root);
  try {
    const row = sql.prepare('SELECT provider FROM capability_bindings WHERE capability=?').get('helmsman/pull-request') as { provider: unknown } | undefined;
    if (row && !isContributionId(row.provider)) throw new Error('Pull request provider binding is invalid.');
    return row?.provider as string | undefined;
  } finally { sql.close(); }
}

export function selectPullRequestProvider(root: string, provider: string | null): void {
  if (provider !== null && !isContributionId(provider)) throw new Error('Invalid pull request provider ID.');
  const sql = database(root);
  try {
    sql.transaction(() => {
      if (provider === null) sql.prepare('DELETE FROM capability_bindings WHERE capability=?').run('helmsman/pull-request');
      else sql.prepare('INSERT INTO capability_bindings VALUES(?,?) ON CONFLICT(capability) DO UPDATE SET provider=excluded.provider').run('helmsman/pull-request', provider);
    })();
  } finally { sql.close(); }
}

export function initializePullRequestProviderDefault(root: string, provider: string): void {
  if (!isContributionId(provider)) throw new Error('Invalid default pull request provider.');
  const sql = database(root);
  try { sql.prepare('INSERT INTO capability_bindings VALUES(?,?) ON CONFLICT(capability) DO NOTHING').run('helmsman/pull-request', provider); }
  finally { sql.close(); }
}

export function readCommunicationProviderBinding(root: string): string | undefined {
  const sql = database(root);
  try {
    const row = sql.prepare('SELECT provider FROM capability_bindings WHERE capability=?').get('helmsman/communication') as { provider: unknown } | undefined;
    if (row && !isContributionId(row.provider)) throw new Error('Communication provider binding is invalid.');
    return row?.provider as string | undefined;
  } finally { sql.close(); }
}

export function selectCommunicationProvider(root: string, provider: string | null): void {
  if (provider !== null && !isContributionId(provider)) throw new Error('Invalid communication provider ID.');
  const sql = database(root);
  try {
    if (provider === null) sql.prepare('DELETE FROM capability_bindings WHERE capability=?').run('helmsman/communication');
    else sql.prepare('INSERT INTO capability_bindings VALUES(?,?) ON CONFLICT(capability) DO UPDATE SET provider=excluded.provider').run('helmsman/communication', provider);
  } finally { sql.close(); }
}

export function initializeCommunicationProviderDefault(root: string, provider: string): void {
  if (!isContributionId(provider)) throw new Error('Invalid default communication provider.');
  const sql = database(root);
  try { sql.prepare('INSERT INTO capability_bindings VALUES(?,?) ON CONFLICT(capability) DO NOTHING').run('helmsman/communication', provider); }
  finally { sql.close(); }
}

export function migrateCommunicationProviderDefault(root: string, previous: string, replacement: string): void {
  if (!isContributionId(previous) || !isContributionId(replacement)) throw new Error('Invalid communication provider migration.');
  const sql = database(root);
  try {
    sql.transaction(() => {
      const first = sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO NOTHING')
        .run(`communication-default:${previous}:${replacement}`, '1').changes;
      if (first) sql.prepare('UPDATE capability_bindings SET provider=? WHERE capability=? AND provider=?')
        .run(replacement, 'helmsman/communication', previous);
    })();
  } finally { sql.close(); }
}

export function readSchedulingProviderSelection(root: string): { providerId: string | null; revision: string } {
  const sql = database(root);
  try {
    const row = sql.prepare('SELECT value FROM backend_meta WHERE key=?').get('scheduling-selection-v1') as { value: string } | undefined;
    if (!row) return { providerId: null, revision: 'unselected' };
    const value = JSON.parse(row.value) as { providerId?: unknown; revision?: unknown } | null;
    if (!value || value.providerId !== null && !isContributionId(value.providerId) || typeof value.revision !== 'string'
      || !/^[a-f\d-]{36}$/.test(value.revision)) throw new Error('Invalid scheduling provider selection');
    return { providerId: value.providerId as string | null, revision: value.revision };
  } finally { sql.close(); }
}
export function selectSchedulingProvider(root: string, providerId: string | null): void {
  if (providerId !== null && !isContributionId(providerId)) throw new Error('Invalid scheduling provider ID');
  const sql = database(root);
  try { sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('scheduling-selection-v1', JSON.stringify({ providerId, revision: randomUUID() })); }
  finally { sql.close(); }
}

export function initializeSchedulingInterval(root: string, pkg: PluginPackage, legacyIntervalMs: number): void {
  const field = pkg.backend?.settings.intervalMs;
  if (!field || field.type !== 'number') throw new Error('Scheduling interval setting is unavailable');
  const intervalMs = Number.isSafeInteger(legacyIntervalMs) ? Math.max(250, Math.min(3_600_000, legacyIntervalMs)) : 60_000;
  validatePluginSetting(field, intervalMs);
  const sql = database(root);
  try { immediateTransaction(sql, () => {
    const first = sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(`scheduling-interval-migrated:${pkg.manifest.id}`, '1').changes;
    if (first) sql.prepare('INSERT INTO plugin_settings VALUES(?,?,?) ON CONFLICT(plugin,key) DO NOTHING').run(pkg.manifest.id, 'intervalMs', JSON.stringify(intervalMs));
  }); } finally { sql.close(); }
}

export function builtinPluginEnabled(root: string, pkg: PluginPackage): boolean {
  const sql = database(root);
  try {
    sql.prepare('INSERT INTO builtin_plugins VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET package=excluded.package').run(pkg.manifest.id, JSON.stringify(pkg));
    const row = sql.prepare('SELECT enabled FROM builtin_plugins WHERE id=?').get(pkg.manifest.id) as { enabled: unknown };
    if (!row || row.enabled !== 0 && row.enabled !== 1) throw new Error('Invalid builtin activation state.');
    return row.enabled === 1;
  } finally { sql.close(); }
}

export function setBuiltinPluginEnabled(root: string, id: string, enabled: boolean): void {
  if (!isPluginId(id) || !id.startsWith('helmsman.')) throw new Error('Invalid builtin plugin ID.');
  const sql = database(root);
  try { sql.prepare('INSERT INTO builtin_plugins VALUES(?,?,NULL) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled').run(id, enabled ? 1 : 0); }
  finally { sql.close(); }
}

export function builtinPluginPackage(root: string, id: string): PluginPackage | null {
  const sql = database(root);
  try {
    const row = sql.prepare('SELECT package FROM builtin_plugins WHERE id=?').get(id) as { package: string | null } | undefined;
    const pkg = row?.package ? parsePluginPackage(JSON.parse(row.package), { allowBuiltin: true }) : null;
    if (pkg && pkg.manifest.id !== id) throw new Error('Built-in plugin package identity differs from its stored owner');
    return pkg;
  } finally { sql.close(); }
}

export function readBuiltinPluginStates(root: string): readonly { id: string; enabled: boolean; package: PluginPackage | null }[] {
  const sql = database(root);
  try {
    const rows = sql.prepare('SELECT * FROM builtin_plugins ORDER BY id').all() as Array<{ id: string; enabled: number; package: string | null }>;
    return rows.map(row => {
      if (!isPluginId(row.id) || !row.id.startsWith('helmsman.') || ![0, 1].includes(row.enabled)) throw new Error('Invalid builtin plugin state');
      const pkg = row.package ? parsePluginPackage(JSON.parse(row.package), { allowBuiltin: true }) : null;
      if (pkg && pkg.manifest.id !== row.id) throw new Error('Built-in plugin package identity differs from its stored owner');
      return { id: row.id, enabled: row.enabled === 1, package: pkg };
    });
  } finally { sql.close(); }
}

export function projectPluginData(root: string, input: { pluginId: string; artifactHash: string; desiredEnabled: boolean; revision: number }): void {
  if (!isPluginId(input.pluginId) || !/^[a-f\d]{64}$/.test(input.artifactHash) || !Number.isSafeInteger(input.revision) || input.revision < 1 || typeof input.desiredEnabled !== 'boolean') throw new Error('Invalid plugin data projection');
  const sql = database(root);
  try {
    immediateTransaction(sql, () => {
      const prior = sql.prepare('SELECT * FROM plugin_projection_revisions WHERE pluginId=?').get(input.pluginId) as { revision: number; artifactHash: string; enabled: number } | undefined;
      if (prior && prior.revision > input.revision) return;
      if (prior?.revision === input.revision && (prior.artifactHash !== input.artifactHash || prior.enabled !== Number(input.desiredEnabled))) throw new Error('Plugin projection revision has conflicting content');
      if (input.pluginId.startsWith('helmsman.') && input.pluginId !== 'helmsman.legacy-runtime') {
        sql.prepare('INSERT INTO builtin_plugins VALUES(?,?,NULL) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled').run(input.pluginId, Number(input.desiredEnabled));
      }
      sql.prepare('INSERT INTO plugin_projection_revisions VALUES(?,?,?,?) ON CONFLICT(pluginId) DO UPDATE SET revision=excluded.revision,artifactHash=excluded.artifactHash,enabled=excluded.enabled')
        .run(input.pluginId, input.revision, input.artifactHash, Number(input.desiredEnabled));
    });
  } finally { sql.close(); }
}

export interface AgentProviderSelections { readonly writer: string | null; readonly reviewers: readonly string[] | null; readonly revision: string; }
function agentSelection(sql: Database.Database): AgentProviderSelections {
  const row = sql.prepare('SELECT value FROM backend_meta WHERE key=?').get('agent-selection-v1') as { value: string } | undefined;
  if (!row) return { writer: null, reviewers: null, revision: 'unselected' };
  const value = pluginJson(JSON.parse(row.value)) as unknown as AgentProviderSelections;
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 || value.writer !== null && !isContributionId(value.writer)
    || value.reviewers !== null && (!Array.isArray(value.reviewers) || value.reviewers.length > 8 || value.reviewers.some(id => !isContributionId(id)) || new Set(value.reviewers).size !== value.reviewers.length)
    || typeof value.revision !== 'string' || !/^[a-f\d-]{36}$/.test(value.revision)) throw new Error('Invalid agent provider selection');
  return value;
}
export function readAgentProviderSelection(root: string): AgentProviderSelections {
  const sql = database(root); try { return agentSelection(sql); } finally { sql.close(); }
}
function writeAgentSelection(sql: Database.Database, value: Pick<AgentProviderSelections, 'writer' | 'reviewers'>): void {
  sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('agent-selection-v1', JSON.stringify({ ...value, revision: randomUUID() }));
}
export function selectAgentProvider(root: string, writer: string | null): void {
  if (writer !== null && !isContributionId(writer)) throw new Error('Invalid agent provider ID');
  const sql = database(root);
  try { immediateTransaction(sql, () => { const current = agentSelection(sql); writeAgentSelection(sql, { writer, reviewers: current.reviewers }); }); } finally { sql.close(); }
}
export function selectAgentReviewers(root: string, reviewers: readonly string[] | null): void {
  if (reviewers !== null && (!Array.isArray(reviewers) || reviewers.length > 8 || reviewers.some(id => !isContributionId(id)) || new Set(reviewers).size !== reviewers.length)) throw new Error('Select distinct agent review providers');
  const sql = database(root);
  try { immediateTransaction(sql, () => { const current = agentSelection(sql); writeAgentSelection(sql, { writer: current.writer, reviewers }); }); } finally { sql.close(); }
}
export function initializeAgentProviderSelection(root: string, defaults: { writer: string; reviewers: readonly string[] | null }): void {
  if (!isContributionId(defaults.writer) || defaults.reviewers !== null && (!Array.isArray(defaults.reviewers) || defaults.reviewers.length > 8
    || defaults.reviewers.some(id => !isContributionId(id)) || new Set(defaults.reviewers).size !== defaults.reviewers.length)) throw new Error('Invalid initial agent provider selection');
  const sql = database(root);
  try { immediateTransaction(sql, () => {
    const first = sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO NOTHING').run('agent-selection-initialized-v1', '1').changes;
    if (first && !sql.prepare('SELECT 1 FROM backend_meta WHERE key=?').get('agent-selection-v1')) writeAgentSelection(sql, defaults);
  }); } finally { sql.close(); }
}
export function initializeCommandAgentSettings(root: string, pkg: PluginPackage, legacyTemplate: string | null): boolean {
  const field = pkg.backend?.settings.commandTemplate;
  if (!field || field.type !== 'string') throw new Error('Command agent setting is unavailable');
  const sql = database(root);
  try { return immediateTransaction(sql, () => {
    sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(`command-agent-migrated:${pkg.manifest.id}`, '1');
    const configured = sql.prepare('SELECT 1 FROM plugin_settings WHERE plugin=? AND key=?').get(pkg.manifest.id, 'commandTemplate');
    return Boolean(legacyTemplate?.trim()) && !configured;
  }); } finally { sql.close(); }
}

export interface ExecutionHostProviderSelection { readonly providerId: string | null; readonly revision: string; }
function executionHostSelection(sql: Database.Database): ExecutionHostProviderSelection {
  const row = sql.prepare('SELECT value FROM backend_meta WHERE key=?').get('execution-host-selection-v1') as { value: string } | undefined;
  if (!row) return { providerId: null, revision: 'initial' };
  const value = pluginJson(JSON.parse(row.value)) as unknown as ExecutionHostProviderSelection;
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 || value.providerId !== null && !isContributionId(value.providerId)
    || typeof value.revision !== 'string' || !/^[a-f\d-]{36}$/.test(value.revision)) throw new Error('Invalid execution host selection');
  return value;
}
export function readExecutionHostProviderSelection(root: string): ExecutionHostProviderSelection {
  const sql = database(root); try { return executionHostSelection(sql); } finally { sql.close(); }
}
function writeExecutionHostSelection(sql: Database.Database, providerId: string | null): void {
  sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('execution-host-selection-v1', JSON.stringify({ providerId, revision: randomUUID() }));
}
export function selectExecutionHostProvider(root: string, providerId: string | null): void {
  if (providerId !== null && !isContributionId(providerId)) throw new Error('Invalid execution host provider ID');
  const sql = database(root); try { immediateTransaction(sql, () => writeExecutionHostSelection(sql, providerId)); } finally { sql.close(); }
}
export function executionHostProviderSelectionInitialized(root: string): boolean {
  const sql = database(root);
  try { return Boolean(sql.prepare('SELECT 1 FROM backend_meta WHERE key IN (?,?)').get('execution-host-selection-initialized-v1', 'execution-host-selection-v1')); } finally { sql.close(); }
}
export function initializeExecutionHostProviderSelection(root: string, providerId: string): void {
  if (!isContributionId(providerId)) throw new Error('Invalid initial execution host provider ID');
  const sql = database(root);
  try { immediateTransaction(sql, () => {
    const first = sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO NOTHING').run('execution-host-selection-initialized-v1', '1').changes;
    if (first && !sql.prepare('SELECT 1 FROM backend_meta WHERE key=?').get('execution-host-selection-v1')) writeExecutionHostSelection(sql, providerId);
  }); } finally { sql.close(); }
}
export function initializeExecutionHostSettings(root: string, pkg: PluginPackage, input: Readonly<Record<string, PluginJson>>): void {
  const sql = database(root);
  try { immediateTransaction(sql, () => {
    const first = sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(`execution-host-settings-initialized-v1:${pkg.manifest.id}`, '1').changes;
    if (!first) return;
    const values = pluginJson(input);
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Execution host settings must be a JSON object');
    if (!pkg.backend?.executionHosts) throw new Error('Execution host package declaration is required');
    for (const [name, value] of Object.entries(values)) {
      const field = Object.hasOwn(pkg.backend.settings, name) ? pkg.backend.settings[name] : undefined;
      if (!field) throw new Error('Unknown initial execution host setting'); validatePluginSetting(field, value);
    }
    for (const [name, value] of Object.entries(values)) sql.prepare('INSERT INTO plugin_settings VALUES(?,?,?) ON CONFLICT(plugin,key) DO NOTHING').run(pkg.manifest.id, name, JSON.stringify(value));
  }); } finally { sql.close(); }
}

export type NativeTerminalSelectionKind = 'terminal' | 'browser';
export interface NativeTerminalProviderSelection { readonly providerId: string | null; readonly revision: string; }
function nativeTerminalSelectionKey(kind: NativeTerminalSelectionKind): string {
  if (kind !== 'terminal' && kind !== 'browser') throw new Error('Invalid native terminal selection kind');
  return `native-terminal-selection-v1:${kind}`;
}
function nativeTerminalSelection(sql: Database.Database, kind: NativeTerminalSelectionKind): NativeTerminalProviderSelection {
  const row = sql.prepare('SELECT value FROM backend_meta WHERE key=?').get(nativeTerminalSelectionKey(kind)) as { value: string } | undefined;
  if (!row) return { providerId: null, revision: 'initial' };
  const value = pluginJson(JSON.parse(row.value)) as unknown as NativeTerminalProviderSelection;
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 || value.providerId !== null && !isContributionId(value.providerId)
    || typeof value.revision !== 'string' || !/^[a-f\d-]{36}$/.test(value.revision)) throw new Error('Invalid native terminal provider selection');
  return value;
}
export function readNativeTerminalProviderSelection(root: string, kind: NativeTerminalSelectionKind): NativeTerminalProviderSelection {
  const sql = database(root); try { return nativeTerminalSelection(sql, kind); } finally { sql.close(); }
}
function writeNativeTerminalSelection(sql: Database.Database, kind: NativeTerminalSelectionKind, providerId: string | null): void {
  sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(nativeTerminalSelectionKey(kind), JSON.stringify({ providerId, revision: randomUUID() }));
}
export function selectNativeTerminalProvider(root: string, kind: NativeTerminalSelectionKind, providerId: string | null): void {
  if (providerId !== null && !isContributionId(providerId)) throw new Error('Invalid native terminal provider ID');
  const sql = database(root); try { immediateTransaction(sql, () => writeNativeTerminalSelection(sql, kind, providerId)); } finally { sql.close(); }
}
export function nativeTerminalProviderSelectionInitialized(root: string, kind: NativeTerminalSelectionKind): boolean {
  const key = nativeTerminalSelectionKey(kind); const sql = database(root);
  try { return Boolean(sql.prepare('SELECT 1 FROM backend_meta WHERE key IN (?,?)').get(`${key}:initialized`, key)); } finally { sql.close(); }
}
export function initializeNativeTerminalProviderSelection(root: string, kind: NativeTerminalSelectionKind, providerId: string): void {
  const key = nativeTerminalSelectionKey(kind); const sql = database(root);
  try { immediateTransaction(sql, () => {
    const first = sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(`${key}:initialized`, '1').changes;
    if (!first || sql.prepare('SELECT 1 FROM backend_meta WHERE key=?').get(key)) return;
    if (!isContributionId(providerId)) throw new Error('Invalid initial native terminal provider ID');
    writeNativeTerminalSelection(sql, kind, providerId);
  }); } finally { sql.close(); }
}
export function initializeNativeTerminalSettings(root: string, pkg: PluginPackage, input: Readonly<Record<string, PluginJson>>): void {
  const sql = database(root);
  try { immediateTransaction(sql, () => {
    const first = sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(`native-terminal-settings-initialized-v1:${pkg.manifest.id}`, '1').changes;
    if (!first) return;
    const values = pluginJson(input);
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Native terminal settings must be a JSON object');
    if (!pkg.backend?.nativeTerminals) throw new Error('Native terminal package declaration is required');
    for (const [name, value] of Object.entries(values)) {
      const field = Object.hasOwn(pkg.backend.settings, name) ? pkg.backend.settings[name] : undefined;
      if (!field) throw new Error('Unknown initial native terminal setting'); validatePluginSetting(field, value);
    }
    for (const [name, value] of Object.entries(values)) sql.prepare('INSERT INTO plugin_settings VALUES(?,?,?) ON CONFLICT(plugin,key) DO NOTHING').run(pkg.manifest.id, name, JSON.stringify(value));
  }); } finally { sql.close(); }
}

export interface WorkflowProviderSelection { readonly providerId: string | null; readonly revision: string; }
function workflowSelectionKey(kind: WorkflowModeV1): string {
  parseWorkflowModeV1(kind);
  return `workflow-selection-v1:${kind}`;
}
function workflowSelection(sql: Database.Database, kind: WorkflowModeV1): WorkflowProviderSelection {
  const row = sql.prepare('SELECT value FROM backend_meta WHERE key=?').get(workflowSelectionKey(kind)) as { value: string } | undefined;
  if (!row) return { providerId: null, revision: 'initial' };
  const value = pluginJson(JSON.parse(row.value)) as unknown as WorkflowProviderSelection;
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 || value.providerId !== null && !isContributionId(value.providerId)
    || typeof value.revision !== 'string' || !/^[a-f\d-]{36}$/.test(value.revision)) throw new Error('Invalid workflow provider selection');
  return value;
}
export function readWorkflowProviderSelection(root: string, kind: WorkflowModeV1): WorkflowProviderSelection {
  const sql = database(root); try { return workflowSelection(sql, kind); } finally { sql.close(); }
}
function writeWorkflowSelection(sql: Database.Database, kind: WorkflowModeV1, providerId: string | null): void {
  sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(workflowSelectionKey(kind), JSON.stringify({ providerId, revision: randomUUID() }));
}
export function selectWorkflowProvider(root: string, kind: WorkflowModeV1, providerId: string | null): void {
  if (providerId !== null && !isContributionId(providerId)) throw new Error('Invalid workflow provider ID');
  const sql = database(root); try { immediateTransaction(sql, () => writeWorkflowSelection(sql, kind, providerId)); } finally { sql.close(); }
}
export function workflowProviderSelectionInitialized(root: string, kind: WorkflowModeV1): boolean {
  const key = workflowSelectionKey(kind); const sql = database(root);
  try { return Boolean(sql.prepare('SELECT 1 FROM backend_meta WHERE key IN (?,?)').get(`${key}:initialized`, key)); } finally { sql.close(); }
}
export function initializeWorkflowProviderSelection(root: string, kind: WorkflowModeV1, providerId: string): void {
  const key = workflowSelectionKey(kind); const sql = database(root);
  try { immediateTransaction(sql, () => {
    const first = sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(`${key}:initialized`, '1').changes;
    if (!first || sql.prepare('SELECT 1 FROM backend_meta WHERE key=?').get(key)) return;
    if (!isContributionId(providerId)) throw new Error('Invalid initial workflow provider ID');
    writeWorkflowSelection(sql, kind, providerId);
  }); } finally { sql.close(); }
}
export function initializeWorkflowSettings(root: string, pkg: PluginPackage, input: Readonly<Record<string, PluginJson>>): void {
  const sql = database(root);
  try { immediateTransaction(sql, () => {
    const first = sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(`workflow-settings-initialized-v1:${pkg.manifest.id}`, '1').changes;
    if (!first) return;
    const values = pluginJson(input);
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Workflow settings must be a JSON object');
    if (!pkg.backend?.workflows) throw new Error('Workflow package declaration is required');
    for (const [name, value] of Object.entries(values)) {
      const field = Object.hasOwn(pkg.backend.settings, name) ? pkg.backend.settings[name] : undefined;
      if (!field) throw new Error('Unknown initial workflow setting'); validatePluginSetting(field, value);
    }
    for (const [name, value] of Object.entries(values)) sql.prepare('INSERT INTO plugin_settings VALUES(?,?,?) ON CONFLICT(plugin,key) DO NOTHING').run(pkg.manifest.id, name, JSON.stringify(value));
  }); } finally { sql.close(); }
}

export function initializeWorkflowReviewerSelection(root: string, reviewerIds: readonly string[]): void {
  const sql = database(root);
  try { immediateTransaction(sql, () => {
    const first = sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO NOTHING').run('workflow-reviewers-initialized-v1', '1').changes;
    if (!first) return;
    const current = agentSelection(sql);
    if (current.reviewers !== null) return;
    if (!Array.isArray(reviewerIds) || reviewerIds.length < 1 || reviewerIds.length > 8 || reviewerIds.some(id => !isContributionId(id)) || new Set(reviewerIds).size !== reviewerIds.length) throw new Error('Invalid initial workflow reviewer selection');
    writeAgentSelection(sql, { writer: current.writer, reviewers: reviewerIds });
  }); } finally { sql.close(); }
}

export interface TriggerProviderSelection { readonly providerId: string | null; readonly revision: string; }
function triggerSelectionKey(kind: TriggerSelectionRoleV1): string {
  if (!['campaign', 'slack-review', 'github-review', 'github-webhook'].includes(kind)) throw new Error('Invalid trigger selection role');
  return `trigger-selection-v1:${kind}`;
}
function triggerSelection(sql: Database.Database, kind: TriggerSelectionRoleV1): TriggerProviderSelection {
  const row = sql.prepare('SELECT value FROM backend_meta WHERE key=?').get(triggerSelectionKey(kind)) as { value: string } | undefined;
  if (!row) return { providerId: 'default', revision: 'initial' };
  const value = pluginJson(JSON.parse(row.value)) as unknown as TriggerProviderSelection;
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 || value.providerId !== null && value.providerId !== 'default' && !isContributionId(value.providerId)
    || typeof value.revision !== 'string' || !/^[a-f\d-]{36}$/.test(value.revision)) throw new Error('Invalid trigger provider selection');
  return value;
}
export function readTriggerProviderSelection(root: string, kind: TriggerSelectionRoleV1): TriggerProviderSelection {
  const sql = database(root); try { return triggerSelection(sql, kind); } finally { sql.close(); }
}
function writeTriggerSelection(sql: Database.Database, kind: TriggerSelectionRoleV1, providerId: string | null): void {
  if (providerId !== null && providerId !== 'default' && !isContributionId(providerId)) throw new Error('Invalid trigger provider ID');
  sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(triggerSelectionKey(kind), JSON.stringify({ providerId, revision: randomUUID() }));
}
export function selectTriggerProvider(root: string, kind: TriggerSelectionRoleV1, providerId: string | null): void {
  const sql = database(root); try { immediateTransaction(sql, () => writeTriggerSelection(sql, kind, providerId)); } finally { sql.close(); }
}
export function triggerProviderSelectionInitialized(root: string, kind: TriggerSelectionRoleV1): boolean {
  const key = triggerSelectionKey(kind); const sql = database(root);
  try { return Boolean(sql.prepare('SELECT 1 FROM backend_meta WHERE key IN (?,?)').get(`${key}:initialized`, key)); } finally { sql.close(); }
}
export function initializeTriggerProviderSelection(root: string, kind: TriggerSelectionRoleV1, providerId: string | null): void {
  const key = triggerSelectionKey(kind); const sql = database(root);
  try { immediateTransaction(sql, () => {
    const first = sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(`${key}:initialized`, '1').changes;
    if (!first || sql.prepare('SELECT 1 FROM backend_meta WHERE key=?').get(key)) return;
    writeTriggerSelection(sql, kind, providerId);
  }); } finally { sql.close(); }
}
export function initializeTriggerSettings(root: string, pkg: PluginPackage, input: Readonly<Record<string, PluginJson>>): void {
  const sql = database(root);
  try { immediateTransaction(sql, () => {
    const first = sql.prepare('INSERT INTO backend_meta VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(`trigger-settings-initialized-v1:${pkg.manifest.id}`, '1').changes;
    if (!first) return;
    const values = pluginJson(input);
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Trigger settings must be a JSON object');
    if (!pkg.backend?.triggers) throw new Error('Trigger package declaration is required');
    for (const [name, value] of Object.entries(values)) {
      const field = Object.hasOwn(pkg.backend.settings, name) ? pkg.backend.settings[name] : undefined;
      if (!field) throw new Error('Unknown initial trigger setting'); validatePluginSetting(field, value);
    }
    for (const [name, value] of Object.entries(values)) sql.prepare('INSERT INTO plugin_settings VALUES(?,?,?) ON CONFLICT(plugin,key) DO NOTHING').run(pkg.manifest.id, name, JSON.stringify(value));
  }); } finally { sql.close(); }
}

export function readFeedbackTrackerProviderBinding(root: string): string | undefined {
  const sql = database(root);
  try {
    const row = sql.prepare('SELECT provider FROM capability_bindings WHERE capability=?').get('helmsman/feedback-tracker') as { provider: unknown } | undefined;
    if (row && !isContributionId(row.provider)) throw new Error('Feedback tracker provider binding is invalid.');
    return row?.provider as string | undefined;
  } finally { sql.close(); }
}

export function selectFeedbackTrackerProvider(root: string, provider: string | null): void {
  if (provider !== null && !isContributionId(provider)) throw new Error('Invalid feedback tracker provider ID.');
  const sql = database(root);
  try {
    sql.transaction(() => {
      if (provider === null) sql.prepare('DELETE FROM capability_bindings WHERE capability=?').run('helmsman/feedback-tracker');
      else sql.prepare('INSERT INTO capability_bindings VALUES(?,?) ON CONFLICT(capability) DO UPDATE SET provider=excluded.provider').run('helmsman/feedback-tracker', provider);
    })();
  } finally { sql.close(); }
}

function feedbackSettings(sql: Database.Database, packages: readonly PluginPackage[]): FeedbackSettingsSnapshotV1 {
  const row = sql.prepare('SELECT provider FROM capability_bindings WHERE capability=?').get('helmsman/feedback-tracker') as { provider: string } | undefined;
  const providers = packages.flatMap(pkg => (pkg.backend?.provides ?? []).filter(value => value.id === 'helmsman/feedback-tracker').map(value => ({
    id: `${pkg.manifest.id}/${value.localId}`, label: `${pkg.manifest.id}/${value.localId}`, fields: pkg.backend?.settings ?? {}, values: settings(sql, pkg),
  }))).sort((a, b) => a.id.localeCompare(b.id));
  const snapshot = { version: 1, selected: row?.provider ?? null, providers };
  return parseFeedbackSettingsSnapshotV1({ ...snapshot, revision: persistenceHash({ snapshot, packages }) });
}
export function readFeedbackSettings(root: string, packages: readonly PluginPackage[]): FeedbackSettingsSnapshotV1 {
  const sql = database(root); try { return sql.transaction(() => feedbackSettings(sql, packages))(); } finally { sql.close(); }
}
export function writeFeedbackSettings(root: string, packages: readonly PluginPackage[], raw: unknown): FeedbackSettingsSnapshotV1 {
  const input = parseFeedbackSettingsSaveV1(raw); const sql = database(root);
  try { return immediateTransaction(sql, () => {
    const current = feedbackSettings(sql, packages);
    if (input.expectedRevision !== current.revision) throw new PersistenceConflictError('Feedback settings changed. Reload before saving.');
    if (input.selected === null) {
      if (Object.keys(input.values).length) throw new Error('Disabled feedback must not change tracker settings');
      sql.prepare('DELETE FROM capability_bindings WHERE capability=?').run('helmsman/feedback-tracker');
    } else {
      const provider = current.providers.find(value => value.id === input.selected);
      if (!provider || Object.keys(input.values).length !== Object.keys(provider.fields).length) throw new Error('Feedback tracker settings are unavailable');
      for (const [key, value] of Object.entries(input.values)) { const field = Object.hasOwn(provider.fields, key) ? provider.fields[key] : undefined; if (!field) throw new Error('Unknown feedback tracker setting'); validatePluginSetting(field, value); }
      const pluginId = provider.id.split('/')[0]!;
      for (const [key, value] of Object.entries(input.values)) sql.prepare('INSERT INTO plugin_settings VALUES(?,?,?) ON CONFLICT(plugin,key) DO UPDATE SET value=excluded.value').run(pluginId, key, JSON.stringify(value));
      sql.prepare('INSERT INTO capability_bindings VALUES(?,?) ON CONFLICT(capability) DO UPDATE SET provider=excluded.provider').run('helmsman/feedback-tracker', input.selected);
    }
    return feedbackSettings(sql, packages);
  }); } finally { sql.close(); }
}
