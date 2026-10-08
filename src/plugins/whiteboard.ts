import { parseTaskRepo } from './tasks';

export type WhiteboardTargetV1 = { readonly kind: 'run'; readonly repo: string; readonly runId: string; readonly expectedAttempt: number }
  | { readonly kind: 'pull-request'; readonly repo: string; readonly number: number; readonly baseSha: string; readonly headSha: string };
export interface WhiteboardSnapshotV1 {
  readonly version: 1; readonly target: WhiteboardTargetV1;
  readonly status: 'absent' | 'creating' | 'ready' | 'failed' | 'recovery-required';
  readonly sessionId: string | null; readonly baseSha: string | null; readonly headSha: string | null; readonly message: string | null;
}
export type WhiteboardResultV1 = { readonly status: 'available'; readonly value: WhiteboardSnapshotV1 }
  | { readonly status: 'unavailable'; readonly code: number; readonly message: string };
export interface WhiteboardServiceV1 {
  readonly version: 1;
  read(target: WhiteboardTargetV1, signal?: AbortSignal): Promise<WhiteboardResultV1>;
  explain(target: WhiteboardTargetV1, signal?: AbortSignal): Promise<WhiteboardResultV1>;
  open(target: WhiteboardTargetV1, signal?: AbortSignal): Promise<WhiteboardResultV1>;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Whiteboard data');
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError('Invalid Whiteboard number');
  return value as number;
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) throw new TypeError('Invalid Whiteboard commit');
  return value;
}
export function parseWhiteboardTargetV1(value: unknown): WhiteboardTargetV1 {
  const row = object(value); const repo = parseTaskRepo(row.repo);
  if (row.kind === 'run') {
    if (Object.keys(row).some(key => !['kind', 'repo', 'runId', 'expectedAttempt'].includes(key)) || typeof row.runId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.runId)) throw new TypeError('Invalid Whiteboard run');
    return Object.freeze({ kind: 'run', repo, runId: row.runId, expectedAttempt: positive(row.expectedAttempt) });
  }
  if (row.kind !== 'pull-request' || Object.keys(row).some(key => !['kind', 'repo', 'number', 'baseSha', 'headSha'].includes(key))) throw new TypeError('Invalid Whiteboard target');
  return Object.freeze({ kind: 'pull-request', repo, number: positive(row.number), baseSha: sha(row.baseSha), headSha: sha(row.headSha) });
}
export function parseWhiteboardSnapshotV1(value: unknown): WhiteboardSnapshotV1 {
  const row = object(value);
  if (row.version !== 1 || !['absent', 'creating', 'ready', 'failed', 'recovery-required'].includes(String(row.status)) || Object.keys(row).some(key => !['version', 'target', 'status', 'sessionId', 'baseSha', 'headSha', 'message'].includes(key))) throw new TypeError('Invalid Whiteboard snapshot');
  if (row.sessionId !== null && (typeof row.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.sessionId))) throw new TypeError('Invalid Whiteboard session');
  if (row.message !== null && (typeof row.message !== 'string' || row.message.length > 2048)) throw new TypeError('Invalid Whiteboard message');
  const baseSha = row.baseSha === null ? null : sha(row.baseSha); const headSha = row.headSha === null ? null : sha(row.headSha);
  if (row.status === 'ready' && (!row.sessionId || !baseSha || !headSha)) throw new TypeError('Incomplete Whiteboard session');
  return Object.freeze({ version: 1, target: parseWhiteboardTargetV1(row.target), status: row.status as WhiteboardSnapshotV1['status'], sessionId: row.sessionId as string | null, baseSha, headSha, message: row.message as string | null });
}
