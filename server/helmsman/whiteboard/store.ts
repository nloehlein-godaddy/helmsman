import type Database from 'better-sqlite3';
import { storeConnection } from '../store-connection';

export interface WhiteboardRecord {
  key: string; target: string; status: 'creating' | 'ready' | 'failed' | 'recovery-required'; sessionId: string | null;
  baseSha: string; headSha: string; evidence: string; document: string | null; message: string | null;
}

export function openWhiteboardStore(sql: Database.Database) {
  storeConnection(sql).migrate({ owner: 'core.whiteboard', ddl: `CREATE TABLE whiteboard_sessions (
    key TEXT PRIMARY KEY, target TEXT NOT NULL, status TEXT NOT NULL, sessionId TEXT,
    baseSha TEXT NOT NULL, headSha TEXT NOT NULL, evidence TEXT NOT NULL, document TEXT, message TEXT
  );` });
  sql.prepare(`UPDATE whiteboard_sessions SET
    status=CASE WHEN sessionId IS NOT NULL OR document IS NULL THEN 'failed' ELSE 'recovery-required' END,
    message=CASE WHEN sessionId IS NOT NULL OR document IS NULL THEN 'Explanation was interrupted. Retry to continue.' ELSE 'Whiteboard creation was interrupted. Reconcile the existing session before retrying.' END
    WHERE status='creating'`).run();
  return {
    read: (key: string) => (sql.prepare('SELECT * FROM whiteboard_sessions WHERE key=?').get(key) as WhiteboardRecord | undefined) ?? null,
    insert(record: WhiteboardRecord) { sql.prepare('INSERT INTO whiteboard_sessions VALUES (@key,@target,@status,@sessionId,@baseSha,@headSha,@evidence,@document,@message)').run(record); },
    save(record: WhiteboardRecord) { sql.prepare('UPDATE whiteboard_sessions SET status=@status, sessionId=@sessionId, baseSha=@baseSha, headSha=@headSha, evidence=@evidence, document=@document, message=@message WHERE key=@key').run(record); },
  };
}
