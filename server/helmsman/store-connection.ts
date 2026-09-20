import type Database from 'better-sqlite3';
import { openPersistence } from './persistence';
import { migrateLegacyStore, type LegacySchema } from './legacy-store-migrations';

export type StoreDatabase = string | Database.Database;

export function storeConnection(source: StoreDatabase): { sql: Database.Database; close(): void; migrate(schema: LegacySchema): void } {
  const owned = typeof source === 'string' ? openPersistence(source) : null;
  const sql = owned?.sql ?? (source as Database.Database);
  if (!sql?.open) throw new Error('Store requires an open database connection');
  const close = () => owned?.close();
  return { sql, close, migrate(schema) {
    try { migrateLegacyStore(sql, schema); }
    catch (error) { close(); throw error; }
  } };
}
