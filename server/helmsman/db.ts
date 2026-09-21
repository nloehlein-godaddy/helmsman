import type Database from 'better-sqlite3';
import { storeConnection } from './store-connection';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'stopped';

export interface RunRow {
  id: string;
  ticketId: string;
  repo: string;
  adapter: string;
  status: RunStatus;
  attempt: number;
  prNumber: number | null;
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  worktreePath: string | null;
  hostKind?: string | null;
  hostRef?: string | null;
  logPath?: string | null;
  exitPath?: string | null;
  specPath?: string | null;
  logOffset?: number | null;
  taskJson?: string | null;
  launchJson?: string | null;
}

export interface RunEventRow {
  id: number;
  runId: string;
  ts: string;
  kind: string;
  text: string;
}

export interface RunPage {
  runs: RunRow[];
  total: number;
}

export interface RunReadRowQuery {
  repos: readonly string[];
  kind: 'running' | 'terminal' | 'all';
  limit: number;
  ceiling: number | null;
  after: { startedAt: string; id: string } | null;
}

export interface RunInspectLogRowQuery {
  runId: string; expectedAttempt: number; direction: 'backward' | 'forward'; limit: number;
  through: number | null; position: number | null; textLimit: number;
}
export interface RunInspectEventMetadata { id: number; tsBytes: number; kindBytes: number; textBytes: number; }

export interface Db {
  insertRun(r: RunRow): void;
  updateRun(id: string, patch: Partial<RunRow>): void;
  getRun(id: string): RunRow | null;
  listRuns(limit: number): RunRow[];
  runsInWindow(from: string, to: string, repo?: string | null): RunRow[];
  runPage(limit: number, offset: number, repo?: string | null): RunPage;
  runReadPage(input: RunReadRowQuery): { runs: RunRow[]; ceiling: number };
  runInspectHistory(input: RunReadRowQuery): { runs: RunRow[]; ceiling: number; total: number };
  runInspectLog(input: RunInspectLogRowQuery): { run: RunRow | null; events: RunEventRow[]; through: number; hasEarlier: boolean; hasLater: boolean };
  runInspectWatermark(runId: string): { run: RunRow | null; through: number };
  runInspectEventMetadata(runId: string, after: number, through: number): RunInspectEventMetadata | null;
  runInspectEventBytes(runId: string, eventId: number, field: 'ts' | 'kind' | 'text', offset: number, limit: number): Uint8Array | null;
  activeRuns(): RunRow[];
  reattachableRuns(): RunRow[];
  appendEvent(runId: string, kind: string, text: string, ts: string): RunEventRow;
  listEvents(runId: string): RunEventRow[];
  latestReviewVerdict(runId: string): string | null;
  recentEvents(runId: string, limit: number, textLimit: number): RunEventRow[];
  eventPage(runId: string, afterId: number, throughId: number, limit: number, textLimit?: number): RunEventRow[];
  getConfigOverrides(): Record<string, string>;
  setConfigOverride(key: string, value: string, ts: string): void;
  close(): void;
}

const COLS: string[] = ['id', 'ticketId', 'repo', 'adapter', 'status', 'attempt', 'prNumber', 'startedAt', 'endedAt', 'costUsd', 'worktreePath', 'hostKind', 'hostRef', 'logPath', 'exitPath', 'specPath', 'logOffset', 'taskJson', 'launchJson'];

export function openDb(path: string | Database.Database): Db {
  const connection = storeConnection(path);
  const { sql } = connection;
  connection.migrate({ owner: 'core.runs', ddl: `
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, ticketId TEXT, repo TEXT, adapter TEXT, status TEXT,
      attempt INTEGER, prNumber INTEGER, startedAt TEXT, endedAt TEXT, costUsd REAL, worktreePath TEXT
    );
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT, ts TEXT, kind TEXT, text TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(runId, id);
    CREATE INDEX IF NOT EXISTS idx_events_review_verdict ON run_events(runId, id) WHERE kind = 'review-verdict';
    CREATE INDEX IF NOT EXISTS idx_runs_history ON runs(startedAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_repo_history ON runs(repo COLLATE NOCASE, startedAt DESC, id DESC);
    CREATE TABLE IF NOT EXISTS config_overrides (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt TEXT NOT NULL);
  `, optionalLegacyTables: ['config_overrides'], optionalLegacyColumns: { runs: ['hostKind', 'hostRef', 'logPath', 'exitPath', 'specPath', 'logOffset', 'taskJson', 'launchJson'] },
    upgrade(sql) {
      const existing = new Set((sql.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map((c) => c.name));
      const addCols: [string, string][] = [
        ['hostKind', 'TEXT'], ['hostRef', 'TEXT'], ['logPath', 'TEXT'], ['exitPath', 'TEXT'],
        ['specPath', 'TEXT'], ['logOffset', 'INTEGER'], ['taskJson', 'TEXT'], ['launchJson', 'TEXT'],
      ];
      for (const [name, type] of addCols) {
        if (!existing.has(name)) sql.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
      }
    },
  });
  const latestReviewVerdict = sql.prepare("SELECT substr(text, 1, 512) AS text FROM run_events WHERE runId = ? AND kind = 'review-verdict' ORDER BY id DESC LIMIT 1");

  return {
    insertRun(r: RunRow): void {
      const full = { hostKind: null, hostRef: null, logPath: null, exitPath: null, specPath: null, logOffset: null, taskJson: null, launchJson: null, ...r };
      sql.prepare(`INSERT INTO runs (${COLS.join(',')}) VALUES (${COLS.map((c) => '@' + c).join(',')})`).run(full);
    },
    updateRun(id: string, patch: Partial<RunRow>): void {
      const keys: string[] = Object.keys(patch).filter((k) => COLS.includes(k));
      if (keys.length === 0) return;
      const set: string = keys.map((k) => `${k} = @${k}`).join(', ');
      sql.prepare(`UPDATE runs SET ${set} WHERE id = @id`).run({ ...patch, id });
    },
    getRun(id: string): RunRow | null {
      return (sql.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined) ?? null;
    },
    listRuns(limit: number): RunRow[] {
      return sql.prepare('SELECT * FROM runs ORDER BY startedAt DESC, rowid ASC LIMIT ?').all(limit) as RunRow[];
    },
    runsInWindow(from, to, repo = null) {
      if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from)
        || Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw new RangeError('Invalid history window');
      return sql.prepare(`SELECT * FROM runs WHERE julianday(startedAt) >= julianday(@from) AND julianday(startedAt) < julianday(@to)
        ${repo === null ? '' : 'AND repo = @repo COLLATE NOCASE'} ORDER BY startedAt DESC, id DESC`)
        .all({ from, to, ...(repo === null ? {} : { repo }) }) as RunRow[];
    },
    runPage: sql.transaction((limit: number, offset: number, repo: string | null = null): RunPage => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
        throw new RangeError('Run history requires a limit from 1 to 100 and a nonnegative offset');
      }
      const where = repo === null ? '' : ' WHERE repo = @repo COLLATE NOCASE';
      const params = repo === null ? {} : { repo };
      const total = (sql.prepare(`SELECT COUNT(*) AS total FROM runs${where}`).get(params) as { total: number }).total;
      const runs = sql.prepare(`SELECT * FROM runs${where} ORDER BY startedAt DESC, id DESC LIMIT @limit OFFSET @offset`)
        .all({ ...params, limit, offset }) as RunRow[];
      return { runs, total };
    }),
    runReadPage: sql.transaction((input: RunReadRowQuery) => {
      if (!input || !Array.isArray(input.repos) || input.repos.length > 1000 || input.repos.some(repo => typeof repo !== 'string' || !repo || repo.length > 512)
        || !['running', 'terminal', 'all'].includes(input.kind) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 101
        || input.ceiling !== null && (!Number.isSafeInteger(input.ceiling) || input.ceiling < 0)
        || input.after !== null && (typeof input.after?.startedAt !== 'string' || typeof input.after?.id !== 'string')) throw new RangeError('Invalid run read bounds');
      const ceiling = input.ceiling ?? (sql.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM runs').get() as { value: number }).value;
      if (!input.repos.length) return { runs: [], ceiling };
      const predicates = [`repo IN (${input.repos.map(() => '?').join(',')})`, 'rowid <= ?'];
      const params: (string | number)[] = [...input.repos, ceiling];
      if (input.kind === 'running') predicates.push("status = 'running'");
      if (input.kind === 'terminal') predicates.push("status IN ('succeeded','failed','stopped')");
      if (input.after) { predicates.push('(startedAt < ? OR (startedAt = ? AND id < ?))'); params.push(input.after.startedAt, input.after.startedAt, input.after.id); }
      params.push(input.limit);
      const runs = sql.prepare(`SELECT * FROM runs WHERE ${predicates.join(' AND ')} ORDER BY startedAt DESC,id DESC LIMIT ?`).all(...params) as RunRow[];
      return { runs, ceiling };
    }),
    runInspectHistory: sql.transaction((input: RunReadRowQuery) => {
      if (!input || !Array.isArray(input.repos) || input.repos.length > 1000 || input.repos.some(repo => typeof repo !== 'string' || !repo || repo.length > 512)
        || !['running', 'terminal', 'all'].includes(input.kind) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 101
        || input.ceiling !== null && (!Number.isSafeInteger(input.ceiling) || input.ceiling < 0)
        || input.after !== null && (typeof input.after?.startedAt !== 'string' || typeof input.after?.id !== 'string')) throw new RangeError('Invalid run inspection history bounds');
      const ceiling = input.ceiling ?? (sql.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM runs').get() as { value: number }).value;
      if (!input.repos.length) return { runs: [], ceiling, total: 0 };
      const predicates = [`repo IN (${input.repos.map(() => '?').join(',')})`, 'rowid <= ?'];
      const params: (string | number)[] = [...input.repos, ceiling];
      if (input.kind === 'running') predicates.push("status = 'running'");
      if (input.kind === 'terminal') predicates.push("status IN ('succeeded','failed','stopped')");
      const total = (sql.prepare(`SELECT COUNT(*) AS total FROM runs WHERE ${predicates.join(' AND ')}`).get(...params) as { total: number }).total;
      if (input.after) { predicates.push('(startedAt < ? OR (startedAt = ? AND id < ?))'); params.push(input.after.startedAt, input.after.startedAt, input.after.id); }
      const runs = sql.prepare(`SELECT * FROM runs WHERE ${predicates.join(' AND ')} ORDER BY startedAt DESC,id DESC LIMIT ?`).all(...params, input.limit) as RunRow[];
      return { runs, ceiling, total };
    }),
    runInspectLog: sql.transaction((input: RunInspectLogRowQuery) => {
      if (!input || typeof input.runId !== 'string' || !Number.isSafeInteger(input.expectedAttempt) || input.expectedAttempt < 1
        || !['backward', 'forward'].includes(input.direction) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50
        || !Number.isSafeInteger(input.textLimit) || input.textLimit < 1 || input.textLimit > 4001
        || [input.through, input.position].some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))) throw new RangeError('Invalid run inspection log bounds');
      const run = (sql.prepare('SELECT * FROM runs WHERE id = ?').get(input.runId) as RunRow | undefined) ?? null;
      if (!run || run.attempt !== input.expectedAttempt) return { run, events: [], through: 0, hasEarlier: false, hasLater: false };
      const latest = (sql.prepare('SELECT COALESCE(MAX(id),0) AS value FROM run_events WHERE runId = ?').get(input.runId) as { value: number }).value;
      const through = input.through === null || input.direction === 'forward' && input.position === input.through ? latest : input.through;
      if (through > latest || input.direction === 'forward' && (input.position ?? 0) > through) throw new RangeError('Run inspection log changed');
      const backwards = input.direction === 'backward';
      const position = input.position ?? (backwards ? through + 1 : 0);
      const events = sql.prepare(`SELECT id,runId,ts,kind,CAST(substr(CAST(text AS BLOB),1,?) AS TEXT) AS text FROM run_events WHERE runId = ? AND id <= ? AND id ${backwards ? '<' : '>'} ? ORDER BY id ${backwards ? 'DESC' : 'ASC'} LIMIT ?`)
        .all(input.textLimit * 4, input.runId, through, position, input.limit) as RunEventRow[];
      if (backwards) events.reverse();
      const first = events[0]?.id; const last = events.at(-1)?.id;
      const exists = (operator: '<' | '>' | '<=' | '>=', id: number) => !!sql.prepare(`SELECT 1 FROM run_events WHERE runId = ? AND id <= ? AND id ${operator} ? LIMIT 1`).get(input.runId, through, id);
      return { run, events, through, hasEarlier: exists(first === undefined && !backwards ? '<=' : '<', first ?? position),
        hasLater: exists(last === undefined && backwards ? '>=' : '>', last ?? position) };
    }),
    runInspectWatermark: sql.transaction((runId: string) => ({
      run: (sql.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined) ?? null,
      through: (sql.prepare('SELECT COALESCE(MAX(id),0) AS value FROM run_events WHERE runId = ?').get(runId) as { value: number }).value,
    })),
    runInspectEventMetadata(runId, after, through) {
      if (![after, through].every(value => Number.isSafeInteger(value) && value >= 0) || after > through) throw new RangeError('Invalid run export bounds');
      return (sql.prepare('SELECT id,length(CAST(ts AS BLOB)) AS tsBytes,length(CAST(kind AS BLOB)) AS kindBytes,length(CAST(text AS BLOB)) AS textBytes FROM run_events WHERE runId = ? AND id > ? AND id <= ? ORDER BY id ASC LIMIT 1')
        .get(runId, after, through) as RunInspectEventMetadata | undefined) ?? null;
    },
    runInspectEventBytes(runId, eventId, field, offset, limit) {
      if (!['ts', 'kind', 'text'].includes(field) || !Number.isSafeInteger(eventId) || eventId < 1 || !Number.isSafeInteger(offset) || offset < 0
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 65536) throw new RangeError('Invalid run export chunk');
      const row = sql.prepare(`SELECT substr(CAST(${field} AS BLOB),?,?) AS bytes FROM run_events WHERE runId = ? AND id = ?`).get(offset + 1, limit, runId, eventId) as { bytes: Uint8Array } | undefined;
      return row?.bytes ?? null;
    },
    activeRuns(): RunRow[] {
      return sql.prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY startedAt DESC, rowid ASC`).all() as RunRow[];
    },
    reattachableRuns(): RunRow[] {
      return sql.prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY startedAt DESC, rowid ASC`).all() as RunRow[];
    },
    appendEvent(runId: string, kind: string, text: string, ts: string): RunEventRow {
      const info: Database.RunResult = sql.prepare('INSERT INTO run_events (runId, ts, kind, text) VALUES (?, ?, ?, ?)').run(runId, ts, kind, text);
      return { id: Number(info.lastInsertRowid), runId, ts, kind, text };
    },
    listEvents(runId: string): RunEventRow[] {
      return sql.prepare('SELECT * FROM run_events WHERE runId = ? ORDER BY id ASC').all(runId) as RunEventRow[];
    },
    latestReviewVerdict(runId: string): string | null {
      return (latestReviewVerdict.get(runId) as { text: string | null } | undefined)?.text ?? null;
    },
    recentEvents(runId: string, limit: number, textLimit: number): RunEventRow[] {
      return (sql.prepare('SELECT id, runId, ts, kind, substr(text, 1, ?) AS text FROM run_events WHERE runId = ? ORDER BY id DESC LIMIT ?')
        .all(Math.max(0, Math.floor(textLimit)), runId, Math.max(0, Math.floor(limit))) as RunEventRow[]).reverse();
    },
    eventPage(runId: string, afterId: number, throughId: number, limit: number, textLimit?: number): RunEventRow[] {
      if (textLimit !== undefined && (!Number.isSafeInteger(textLimit) || textLimit < 0 || textLimit > 100_000)) throw new RangeError('Invalid log text bound');
      const columns = textLimit === undefined ? '*' : 'id,runId,ts,kind,substr(text,1,?) AS text';
      return sql.prepare(`SELECT ${columns} FROM run_events WHERE runId = ? AND id > ? AND id <= ? ORDER BY id ASC LIMIT ?`)
        .all(...(textLimit === undefined ? [] : [textLimit]), runId, afterId, throughId, Math.max(0, Math.floor(limit))) as RunEventRow[];
    },
    getConfigOverrides(): Record<string, string> {
      const rows: { key: string; value: string }[] = sql.prepare('SELECT key, value FROM config_overrides').all() as { key: string; value: string }[];
      return rows.reduce((acc: Record<string, string>, row: { key: string; value: string }) => {
        acc[row.key] = row.value;
        return acc;
      }, {});
    },
    setConfigOverride(key: string, value: string, ts: string): void {
      sql
        .prepare(
          'INSERT INTO config_overrides (key, value, updatedAt) VALUES (@key,@value,@ts) ON CONFLICT(key) DO UPDATE SET value=@value, updatedAt=@ts',
        )
        .run({ key, value, ts });
    },
    close(): void {
      connection.close();
    },
  };
}
