import { randomUUID } from 'node:crypto';
import { migrateOwned, validateTableColumns } from '../migrations';
import { persistenceHash, type Persistence } from '../persistence';

export type PostmortemProvider = 'codex' | 'claude-code';
export type PostmortemStatus = 'starting' | 'busy' | 'ready' | 'idle' | 'capped' | 'error';
export type PostmortemRole = 'user' | 'agent' | 'system';
export type PostmortemKind = 'text' | 'tool' | 'command' | 'phase' | 'error' | 'patch';
export interface PostmortemSession {
  id: string; runId: string; provider: PostmortemProvider; model: string | null; effort: string | null; providerSessionId: string | null;
  status: PostmortemStatus; error: string | null; turns: number; costUsd: number | null; createdAt: string; updatedAt: string;
}
export interface PostmortemMessage { id: number; sessionId: string; clientId: string | null; role: PostmortemRole; kind: PostmortemKind; text: string; ts: string }
export class PostmortemError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const POSTMORTEM_MESSAGE_LIMIT = 65_536;
export const TRUNCATION_MARKER = '\n[truncated]';
const TRANSITIONS: Record<PostmortemStatus, readonly PostmortemStatus[]> = {
  starting: ['busy', 'idle', 'error'], busy: ['ready', 'idle', 'error', 'capped'], ready: ['busy', 'idle', 'error', 'capped'],
  idle: ['busy', 'error'], error: ['busy', 'error'], capped: [],
};
const DDL = `CREATE TABLE postmortem_sessions (
  id TEXT PRIMARY KEY, runId TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, effort TEXT, providerSessionId TEXT,
  status TEXT NOT NULL, error TEXT, turns INTEGER NOT NULL DEFAULT 0, costUsd REAL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX postmortem_one_open_per_run ON postmortem_sessions(runId) WHERE status NOT IN ('capped', 'error');
CREATE TABLE postmortem_messages (
  id INTEGER PRIMARY KEY, sessionId TEXT NOT NULL, clientId TEXT, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, ts TEXT NOT NULL,
  UNIQUE(sessionId, clientId)
)`;

export function truncateMessage(text: string): string {
  if (Buffer.byteLength(text) <= POSTMORTEM_MESSAGE_LIMIT) return text;
  const kept = Buffer.from(text).subarray(0, POSTMORTEM_MESSAGE_LIMIT - Buffer.byteLength(TRUNCATION_MARKER)).toString('utf8').replace(/�+$/, '');
  return `${kept}${TRUNCATION_MARKER}`;
}

export function capReached(session: PostmortemSession, limits: { maxTurns: number; maxCostUsd: number }): boolean {
  return session.turns >= limits.maxTurns || session.costUsd !== null && session.costUsd >= limits.maxCostUsd;
}

const uniqueViolation = (error: unknown) => (error as { code?: unknown })?.code === 'SQLITE_CONSTRAINT_UNIQUE';

export function openPostmortemStore(persistence: Persistence, now: () => string = () => new Date().toISOString()) {
  const { sql } = persistence;
  migrateOwned(sql, { owner: 'core.postmortem', version: 1, checksum: persistenceHash(DDL), tables: ['postmortem_sessions', 'postmortem_messages'],
    validateLegacy: () => null, apply: () => sql.exec(DDL),
    validateCurrent: () => {
      validateTableColumns(sql, 'postmortem_sessions', ['id', 'runId', 'provider', 'model', 'effort', 'providerSessionId', 'status', 'error', 'turns', 'costUsd', 'createdAt', 'updatedAt']);
      validateTableColumns(sql, 'postmortem_messages', ['id', 'sessionId', 'clientId', 'role', 'kind', 'text', 'ts']);
    } });
  const get = (id: string) => (sql.prepare('SELECT * FROM postmortem_sessions WHERE id=?').get(id) as PostmortemSession | undefined) ?? null;
  const required = (id: string) => { const session = get(id); if (!session) throw new PostmortemError(404, 'Post-mortem not found'); return session; };
  function write(id: string, values: Partial<PostmortemSession>): PostmortemSession {
    const next = { ...required(id), ...values, updatedAt: now() };
    try {
      sql.prepare('UPDATE postmortem_sessions SET providerSessionId=@providerSessionId,status=@status,error=@error,turns=@turns,costUsd=@costUsd,updatedAt=@updatedAt WHERE id=@id').run(next);
    } catch (error) {
      if (uniqueViolation(error)) throw new PostmortemError(409, 'This run already has an open post-mortem');
      throw error;
    }
    return next;
  }
  return {
    get,
    create(input: { runId: string; provider: PostmortemProvider; model: string | null; effort: string | null; providerSessionId: string | null }): PostmortemSession {
      const at = now();
      const session: PostmortemSession = { id: randomUUID(), ...input, status: 'starting', error: null, turns: 0, costUsd: null, createdAt: at, updatedAt: at };
      try { sql.prepare('INSERT INTO postmortem_sessions VALUES (@id,@runId,@provider,@model,@effort,@providerSessionId,@status,@error,@turns,@costUsd,@createdAt,@updatedAt)').run(session); }
      catch (error) {
        if (uniqueViolation(error)) throw new PostmortemError(409, 'This run already has an open post-mortem');
        throw error;
      }
      return session;
    },
    open: (runId: string) => (sql.prepare("SELECT * FROM postmortem_sessions WHERE runId=? AND status NOT IN ('capped','error')").get(runId) as PostmortemSession | undefined) ?? null,
    latest: (runId: string) => (sql.prepare('SELECT * FROM postmortem_sessions WHERE runId=? ORDER BY createdAt DESC, rowid DESC LIMIT 1').get(runId) as PostmortemSession | undefined) ?? null,
    update: (id: string, patch: { providerSessionId?: string | null; costUsd?: number | null; turns?: number }) => write(id, patch),
    transition(id: string, status: PostmortemStatus, patch: { error?: string; providerSessionId?: string | null; costUsd?: number | null; turns?: number } = {}): PostmortemSession {
      const current = required(id);
      if (!TRANSITIONS[current.status].includes(status)) throw new PostmortemError(409, `Cannot move post-mortem from ${current.status} to ${status}`);
      const { error, ...rest } = patch;
      return write(id, { ...rest, status, error: status === 'error' ? error ?? 'Post-mortem failed' : null });
    },
    append(sessionId: string, input: { role: PostmortemRole; kind: PostmortemKind; text: string; clientId?: string | null }): { message: PostmortemMessage; duplicate: boolean } {
      const text = truncateMessage(input.text); const clientId = input.clientId ?? null;
      if (clientId) {
        const previous = sql.prepare('SELECT * FROM postmortem_messages WHERE sessionId=? AND clientId=?').get(sessionId, clientId) as PostmortemMessage | undefined;
        if (previous && previous.text !== text) throw new PostmortemError(409, 'Message ID already belongs to a different message');
        if (previous) return { message: previous, duplicate: true };
      }
      const ts = now();
      const result = sql.prepare('INSERT INTO postmortem_messages (sessionId,clientId,role,kind,text,ts) VALUES (?,?,?,?,?,?)').run(sessionId, clientId, input.role, input.kind, text, ts);
      return { message: { id: Number(result.lastInsertRowid), sessionId, clientId, role: input.role, kind: input.kind, text, ts }, duplicate: false };
    },
    messages: (sessionId: string) => sql.prepare('SELECT * FROM postmortem_messages WHERE sessionId=? ORDER BY id').all(sessionId) as PostmortemMessage[],
    sweep: () => sql.prepare("UPDATE postmortem_sessions SET status='idle', updatedAt=? WHERE status IN ('starting','busy','ready')").run(now()).changes,
  };
}
export type PostmortemStore = ReturnType<typeof openPostmortemStore>;
