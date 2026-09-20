import { randomUUID } from 'node:crypto';
import { migrateOwned, validateTableColumns } from './migrations';
import { type Persistence, PersistenceConflictError, PersistenceValidationError, persistedJson, persistenceHash, stableJson } from './persistence';
import type { SourceHttpConnection } from './task-source-http';

export interface SourceConnectionRecord extends SourceHttpConnection {
  readonly version: 1;
  readonly provisioningKey: string;
  readonly kind: 'jira';
  readonly email: string;
  readonly verifiedAt: string;
}
export interface SourceConnectionStore {
  get(id: string): SourceConnectionRecord | null;
  byProvisioningKey(key: string): SourceConnectionRecord | null;
  pin(input: Omit<SourceConnectionRecord, 'version' | 'id'>): SourceConnectionRecord;
}
const schema = `CREATE TABLE source_connections (id TEXT PRIMARY KEY, provisioningKey TEXT NOT NULL UNIQUE, json TEXT NOT NULL);`;
function validText(value: unknown, maximum = 512): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value); }
export function sourceConnectionOrigin(value: unknown): string {
  if (!validText(value, 2048)) throw new PersistenceValidationError('Invalid source connection origin');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new PersistenceValidationError('Source connection requires an HTTPS origin');
  return url.origin;
}
function parse(input: unknown): SourceConnectionRecord {
  const value = persistedJson(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PersistenceValidationError('Invalid source connection');
  const record = value as Record<string, unknown>;
  const fields = ['version', 'id', 'provisioningKey', 'kind', 'credentialHandle', 'origin', 'email', 'subject', 'authorityId', 'verifiedAt'];
  if (Object.keys(record).length !== fields.length || Object.keys(record).some(key => !fields.includes(key)) || record.version !== 1 || record.kind !== 'jira'
    || !validText(record.id, 128) || !validText(record.provisioningKey, 240) || !validText(record.credentialHandle, 240)
    || !validText(record.email, 320) || !record.email.includes('@') || record.email.includes(':') || !validText(record.subject, 320)
    || record.authorityId !== null && (!validText(record.authorityId, 128) || !/^[a-z\d-]+$/i.test(record.authorityId))
    || !validText(record.verifiedAt, 40) || !Number.isFinite(Date.parse(record.verifiedAt)) || record.origin !== sourceConnectionOrigin(record.origin)) throw new PersistenceValidationError('Invalid source connection record');
  return value as unknown as SourceConnectionRecord;
}
function identity(record: SourceConnectionRecord) {
  return { kind: record.kind, provisioningKey: record.provisioningKey, credentialHandle: record.credentialHandle, origin: record.origin,
    email: record.email, subject: record.subject, authorityId: record.authorityId };
}
export function openSourceConnectionStore(persistence: Persistence): SourceConnectionStore {
  const { sql } = persistence;
  migrateOwned(sql, { owner: 'core.source-connections', version: 1, checksum: persistenceHash(schema), tables: ['source_connections'],
    validateLegacy: () => null, apply: database => database.exec(schema),
    validateCurrent: database => validateTableColumns(database, 'source_connections', ['id', 'provisioningKey', 'json']),
  });
  const read = (row: unknown): SourceConnectionRecord | null => {
    if (!row || typeof row !== 'object' || !('json' in row) || typeof row.json !== 'string') return null;
    return parse(JSON.parse(row.json));
  };
  const store: SourceConnectionStore = {
    get(id) { if (!validText(id, 128)) throw new PersistenceValidationError('Invalid source connection ID'); return read(sql.prepare('SELECT json FROM source_connections WHERE id=?').get(id)); },
    byProvisioningKey(key) { if (!validText(key, 240)) throw new PersistenceValidationError('Invalid source connection provisioning key'); return read(sql.prepare('SELECT json FROM source_connections WHERE provisioningKey=?').get(key)); },
    pin(input) { return persistence.transaction(() => {
      const record = parse({ ...input, version: 1, id: randomUUID() });
      const prior = store.byProvisioningKey(record.provisioningKey);
      if (prior) {
        if (stableJson(identity(prior)) !== stableJson(identity(record))) throw new PersistenceConflictError('Pinned source connection identity changed');
        return prior;
      }
      sql.prepare('INSERT INTO source_connections VALUES (?,?,?)').run(record.id, record.provisioningKey, stableJson(record));
      return record;
    }); },
  };
  return store;
}
