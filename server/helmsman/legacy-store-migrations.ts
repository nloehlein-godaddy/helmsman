import Database from 'better-sqlite3';
import { migrateOwned } from './migrations';
import { persistenceHash, PersistenceValidationError } from './persistence';

interface Column { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }
export interface LegacySchema {
  owner: string;
  ddl: string;
  optionalLegacyColumns?: Readonly<Record<string, readonly string[]>>;
  optionalLegacyTables?: readonly string[];
  upgrade?: (sql: Database.Database) => void;
}

export function migrateLegacyStore(sql: Database.Database, schema: LegacySchema): void {
  const reference = new Database(':memory:');
  try {
    reference.exec(schema.ddl);
    schema.upgrade?.(reference);
    const tables = (reference.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const columns = (connection: Database.Database, table: string) => connection.pragma(`table_info(${table})`) as Column[];
    const constraints = (connection: Database.Database, table: string): string => {
      const definition = connection.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
      const checks = (definition?.sql.match(/CHECK\s*\((?:[^()]|\([^()]*\))*\)/gi) ?? []).map(value => value.replace(/\s+/g, ' ').trim()).sort();
      const indexes = connection.pragma(`index_list(${table})`) as { name: string; unique: number }[];
      const unique = indexes.filter(index => index.unique).map(index => {
        const escaped = index.name.replaceAll("'", "''");
        return (connection.pragma(`index_info('${escaped}')`) as { name: string | null }[]).map(column => column.name);
      }).map(value => JSON.stringify(value)).sort();
      return JSON.stringify({ checks, unique });
    };
    const validate = (connection: Database.Database, legacy: boolean): void => {
      for (const table of tables) {
        const expected = columns(reference, table);
        const actual = columns(connection, table);
        if (!actual.length && legacy && schema.optionalLegacyTables?.includes(table)) continue;
        const optional = legacy ? schema.optionalLegacyColumns?.[table] ?? [] : [];
        if (!actual.length || expected.some(column => !optional.includes(column.name) && !actual.some(item => item.name === column.name))
          || actual.some(column => {
            const match = expected.find(item => item.name === column.name);
            return !match || ['type', 'notnull', 'dflt_value', 'pk'].some(key => column[key as keyof Column] !== match[key as keyof Column]);
          })) throw new PersistenceValidationError(`Unrecognized legacy schema: ${schema.owner}/${table}`);
        if (constraints(reference, table) !== constraints(connection, table)) throw new PersistenceValidationError(`Unrecognized table constraints: ${schema.owner}/${table}`);
      }
    };
    migrateOwned(sql, {
      owner: schema.owner, version: 1,
      checksum: persistenceHash({ ddl: schema.ddl, optionalLegacyColumns: schema.optionalLegacyColumns ?? {}, optionalLegacyTables: schema.optionalLegacyTables ?? [] }),
      tables,
      validateLegacy(connection) {
        const present = tables.filter(table => columns(connection, table).length > 0);
        if (!present.length) return null;
        validate(connection, true);
        return 0;
      },
      apply(connection) { connection.exec(schema.ddl); schema.upgrade?.(connection); },
      validateCurrent(connection) { validate(connection, false); },
    });
  } finally { reference.close(); }
}
