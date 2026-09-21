import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginJson } from '../../../src/plugins/backend';
import { isContributionId, isPluginId } from '../../../src/plugins/manifest';
import { parsePluginPackage, validatePluginSetting, type PluginPackage } from '../../../src/plugins/package';
import { storeConnection } from '../store-connection';
import { immediateTransaction, registerPersistenceWriter } from '../persistence';

export function pluginJson(value: unknown, limits = { maxNodes: 4096, maxBytes: 128 * 1024 }): PluginJson {
  let nodes = 0;
  function copy(input: unknown, depth: number): PluginJson {
    if (++nodes > limits.maxNodes || depth > 16) throw new Error('Plugin JSON exceeds complexity limits.');
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
