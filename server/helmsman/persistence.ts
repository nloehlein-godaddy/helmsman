import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { PluginJson } from '../../src/plugins/backend';

export interface Persistence {
  readonly sql: Database.Database;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export class PersistenceConflictError extends Error {}
export class PersistenceValidationError extends Error {}
const applicationStartupTokens = new WeakMap<Database.Database, string>();

export function persistedJson(input: unknown): PluginJson {
  let nodes = 0;
  const visiting = new Set<object>();
  function copy(value: unknown, depth: number): PluginJson {
    if (++nodes > 100_000 || depth > 32) throw new PersistenceValidationError('Persisted JSON exceeds complexity limits');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || visiting.has(value)
      || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new PersistenceValidationError('Persisted values must be acyclic plain JSON');
    }
    visiting.add(value);
    const result: Record<string, PluginJson> = Object.create(null) as Record<string, PluginJson>;
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor)
        || Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) throw new PersistenceValidationError('Invalid persisted JSON property');
      result[key] = copy(descriptor.value, depth + 1);
    }
    visiting.delete(value);
    if (!Array.isArray(value)) return Object.freeze(result);
    if (Object.keys(result).length !== value.length) throw new PersistenceValidationError('Persisted arrays must be dense');
    return Object.freeze(Array.from({ length: value.length }, (_, index) => result[String(index)]!));
  }
  const result = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 5_000_000) throw new PersistenceValidationError('Persisted JSON exceeds byte limit');
  return result;
}

export function stableJson(input: unknown): string {
  const value = persistedJson(input);
  function encode(item: PluginJson): string {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    const object = item as Readonly<Record<string, PluginJson>>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${encode(object[key]!)}`).join(',')}}`;
  }
  return encode(value);
}

export function persistenceHash(input: unknown): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

export function immediateTransaction<T>(sql: Database.Database, fn: () => T): T {
  const action = () => {
    const result = fn();
    if (result && typeof result === 'object' && 'then' in result) throw new PersistenceValidationError('Persistence transactions must be synchronous');
    return result;
  };
  return sql.inTransaction ? sql.transaction(action)() : sql.transaction(action).immediate();
}

export function ensurePersistenceMetadata(sql: Database.Database): void {
  immediateTransaction(sql, () => sql.exec(`
    CREATE TABLE IF NOT EXISTS migration_ledger (
      owner TEXT NOT NULL, version INTEGER NOT NULL, checksum TEXT NOT NULL,
      appliedAt TEXT NOT NULL, baseline INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(owner, version)
    );
    CREATE TABLE IF NOT EXISTS migration_steps (
      owner TEXT NOT NULL, migration TEXT NOT NULL, step TEXT NOT NULL,
      checksum TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(owner, migration, step)
    );
    CREATE TABLE IF NOT EXISTS persistence_writers (
      token TEXT PRIMARY KEY, pid INTEGER NOT NULL, owner TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS persistence_intents (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL,
      payload TEXT NOT NULL, targets TEXT NOT NULL, acknowledged TEXT NOT NULL,
      createdAt TEXT NOT NULL, UNIQUE(owner, revision)
    );
  `));
}

export function openPersistence(path: string): Persistence {
  if (typeof path !== 'string' || !path) throw new PersistenceValidationError('Database path is required');
  const sql = new Database(path);
  try {
    sql.pragma('busy_timeout = 5000');
    sql.pragma('journal_mode = WAL');
    ensurePersistenceMetadata(sql);
    return { sql, transaction: fn => immediateTransaction(sql, () => {
      const startups = sql.prepare("SELECT token,pid FROM persistence_writers WHERE owner='application-startup'").all() as Array<{ token: string; pid: number }>;
      for (const startup of startups) {
        if (startup.token === applicationStartupTokens.get(sql) && startup.pid === process.pid) continue;
        if (!Number.isSafeInteger(startup.pid) || startup.pid < 1) throw new PersistenceConflictError('Invalid application startup ownership requires reconciliation');
        try { process.kill(startup.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') { sql.prepare('DELETE FROM persistence_writers WHERE token=?').run(startup.token); continue; }
        }
        throw new PersistenceConflictError('Stop the active database writer before mutation: application-startup');
      }
      return fn();
    }), close: () => { if (sql.open) sql.close(); } };
  } catch (error) { sql.close(); throw error; }
}

export function registerPersistenceWriter(persistence: Persistence, owner: string): () => void {
  if (!owner || owner.length > 200) throw new PersistenceValidationError('Writer owner is required');
  const token = randomUUID();
  persistence.transaction(() => persistence.sql.prepare('INSERT INTO persistence_writers VALUES (?, ?, ?)').run(token, process.pid, owner));
  return () => {
    if (persistence.sql.open) persistence.transaction(() => persistence.sql.prepare('DELETE FROM persistence_writers WHERE token = ?').run(token));
  };
}

export function claimApplicationStartup(persistence: Persistence): { ready(): void; close(): void } {
  const { sql } = persistence;
  if (applicationStartupTokens.has(sql)) throw new PersistenceConflictError('Application startup is already claimed on this connection');
  const token = randomUUID();
  persistence.transaction(() => {
    assertMaintenanceAvailable(sql);
    sql.prepare('INSERT INTO persistence_writers VALUES (?,?,?)').run(token, process.pid, 'application-startup');
  });
  applicationStartupTokens.set(sql, token);
  let state: 'starting' | 'ready' | 'closed' = 'starting';
  return {
    ready() {
      if (state === 'ready') return;
      if (state !== 'starting') throw new PersistenceConflictError('Application startup claim is closed');
      persistence.transaction(() => {
        const result = sql.prepare("UPDATE persistence_writers SET owner='application' WHERE token=? AND pid=? AND owner='application-startup'").run(token, process.pid);
        if (result.changes !== 1) throw new PersistenceConflictError('Application startup ownership changed');
      });
      applicationStartupTokens.delete(sql);
      state = 'ready';
    },
    close() {
      if (state === 'closed') return;
      if (sql.open) persistence.transaction(() => { sql.prepare('DELETE FROM persistence_writers WHERE token=? AND pid=?').run(token, process.pid); });
      applicationStartupTokens.delete(sql);
      state = 'closed';
    },
  };
}

export function assertMaintenanceAvailable(sql: Database.Database): void {
  if (!sql.inTransaction) throw new PersistenceConflictError('Maintenance requires an immediate transaction');
  const writers = sql.prepare('SELECT token, pid, owner FROM persistence_writers').all() as Array<{ token: string; pid: number; owner: string }>;
  for (const writer of writers) {
    if (!Number.isSafeInteger(writer.pid) || writer.pid < 1) throw new PersistenceConflictError('Invalid writer ownership requires reconciliation');
    if (writer.token === applicationStartupTokens.get(sql) && writer.pid === process.pid && writer.owner === 'application-startup') continue;
    let alive = true;
    try { process.kill(writer.pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') alive = false;
    }
    if (alive) throw new PersistenceConflictError(`Stop the active database writer before migration: ${writer.owner}`);
    sql.prepare('DELETE FROM persistence_writers WHERE token = ?').run(writer.token);
  }
}

export interface PersistenceIntent {
  id: string;
  owner: string;
  revision: number;
  payload: PluginJson;
  targets: readonly string[];
  acknowledged: readonly string[];
  createdAt: string;
}

function intent(row: { payload: string; targets: string; acknowledged: string } & Omit<PersistenceIntent, 'payload' | 'targets' | 'acknowledged'>): PersistenceIntent {
  const result = { ...row, payload: persistedJson(JSON.parse(row.payload)), targets: JSON.parse(row.targets) as unknown, acknowledged: JSON.parse(row.acknowledged) as unknown };
  const targets = result.targets;
  if (!Array.isArray(targets) || targets.some(value => typeof value !== 'string')
    || !Array.isArray(result.acknowledged) || result.acknowledged.some(value => typeof value !== 'string' || !targets.includes(value))) {
    throw new PersistenceValidationError('Invalid persistence intent targets');
  }
  return result as PersistenceIntent;
}

export function writePersistenceIntent(persistence: Persistence, input: Omit<PersistenceIntent, 'acknowledged' | 'createdAt'>): PersistenceIntent {
  if (!input?.id || !input.owner || !Number.isSafeInteger(input.revision) || input.revision < 1
    || !Array.isArray(input.targets) || !input.targets.length || input.targets.some(value => typeof value !== 'string' || !value)
    || new Set(input.targets).size !== input.targets.length) throw new PersistenceValidationError('Invalid persistence intent');
  const payload = stableJson(input.payload);
  const targets = stableJson([...input.targets].sort());
  return persistence.transaction(() => {
    const prior = persistence.sql.prepare('SELECT * FROM persistence_intents WHERE id = ? OR (owner = ? AND revision = ?)').get(input.id, input.owner, input.revision) as Parameters<typeof intent>[0] | undefined;
    if (prior) {
      if (prior.id !== input.id || prior.owner !== input.owner || prior.revision !== input.revision || prior.payload !== payload || prior.targets !== targets) throw new PersistenceConflictError('Persistence intent identity already has different content');
      return intent(prior);
    }
    const row = { ...input, payload, targets, acknowledged: '[]', createdAt: new Date().toISOString() };
    persistence.sql.prepare('INSERT INTO persistence_intents VALUES (@id,@owner,@revision,@payload,@targets,@acknowledged,@createdAt)').run(row);
    return intent(row);
  });
}

export function pendingPersistenceIntents(persistence: Persistence): readonly PersistenceIntent[] {
  return (persistence.sql.prepare('SELECT * FROM persistence_intents ORDER BY owner, revision').all() as Parameters<typeof intent>[0][])
    .map(intent).filter(value => value.acknowledged.length !== value.targets.length);
}

export function acknowledgePersistenceIntent(persistence: Persistence, id: string, target: string): void {
  persistence.transaction(() => {
    const row = persistence.sql.prepare('SELECT * FROM persistence_intents WHERE id = ?').get(id) as Parameters<typeof intent>[0] | undefined;
    if (!row) throw new PersistenceConflictError('Persistence intent is missing');
    const value = intent(row);
    if (!value.targets.includes(target)) throw new PersistenceValidationError('Unknown persistence intent target');
    persistence.sql.prepare('UPDATE persistence_intents SET acknowledged = ? WHERE id = ?').run(stableJson([...new Set([...value.acknowledged, target])].sort()), id);
  });
}
