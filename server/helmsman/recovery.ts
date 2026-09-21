import type { Db, RunRow } from './db';

export type AttachmentHandshake =
  | { status: 'attached'; completion: Promise<void> }
  | { status: 'blocked' | 'failed'; reason: string };

export interface RecoverDeps {
  reattach: (row: RunRow) => Promise<AttachmentHandshake | void>;
  rows?: () => readonly RunRow[];
  recordAttachment?: (row: RunRow, state: 'pending' | 'attached' | 'blocked' | 'failed', reason?: string) => void;
  completionFailed?: (row: RunRow, error: unknown) => void;
  handshakeTimeoutMs?: number;
}
export interface RecoveryResult { reattached: string[]; failed: string[]; blocked: string[]; }

const recoveries = new WeakMap<Db, Map<string, Promise<AttachmentHandshake>>>();
const recoveryKey = (row: RunRow): string => `${row.id}:${row.attempt}`;

export async function recoverRuns(db: Db, deps: RecoverDeps): Promise<RecoveryResult> {
  const rows = deps.rows?.() ?? db.reattachableRuns();
  const timeoutMs = deps.handshakeTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid recovery handshake timeout');
  const active = recoveries.get(db) ?? new Map<string, Promise<AttachmentHandshake>>();
  recoveries.set(db, active);
  const result: RecoveryResult = { reattached: [], failed: [], blocked: [] };
  await Promise.all(rows.map(async row => {
    const key = recoveryKey(row);
    let handshake = active.get(key);
    if (!handshake) {
      handshake = Promise.resolve().then(async (): Promise<AttachmentHandshake> => {
        try {
          deps.recordAttachment?.(row, 'pending');
          const outcome = await deps.reattach(row);
          if (!outcome || !['attached', 'blocked', 'failed'].includes(outcome.status)) {
            return { status: 'blocked', reason: 'Legacy attachment did not provide an ownership handshake' };
          }
          if (outcome.status === 'attached') {
            if (!outcome.completion || typeof outcome.completion.then !== 'function') return { status: 'failed', reason: 'Attachment did not supply a completion observer' };
            void outcome.completion.catch(error => { deps.completionFailed?.(row, error); }).catch(() => {});
          }
          return outcome;
        } catch (error) { return { status: 'failed', reason: error instanceof Error ? error.message : 'Attachment failed' }; }
      });
      active.set(key, handshake);
      void handshake.then(outcome => {
        const release = () => { if (active.get(key) === handshake) active.delete(key); };
        if (outcome.status !== 'attached') { release(); return; }
        void outcome.completion.finally(release).catch(() => {});
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: AttachmentHandshake;
    try {
      outcome = await Promise.race([handshake, new Promise<AttachmentHandshake>(resolve => {
        timer = setTimeout(() => resolve({ status: 'blocked', reason: 'Attachment handshake timed out; process ownership remains unresolved' }), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
    deps.recordAttachment?.(row, outcome.status, outcome.status === 'attached' ? undefined : outcome.reason);
    if (outcome.status === 'attached') result.reattached.push(row.id);
    else result[outcome.status].push(row.id);
  }));
  return result;
}

export function startRunRecovery(db: Db, deps: RecoverDeps & {
  retryIntervalMs?: number; retryWindowMs?: number;
  onResult?: (result: RecoveryResult) => void; onError?: (error: unknown) => void;
}): { initial: Promise<RecoveryResult>; dispose(): void } {
  const interval = deps.retryIntervalMs ?? 5000;
  const window = deps.retryWindowMs ?? 90_000;
  if (!Number.isSafeInteger(interval) || interval < 250 || interval > 60_000
    || !Number.isSafeInteger(window) || window < interval || window > 300_000) throw new Error('Invalid startup recovery retry bounds');
  const rows = () => deps.rows?.() ?? db.reattachableRuns();
  const pending = new Set(rows().map(recoveryKey));
  const deadline = Date.now() + window;
  let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
  async function pass(): Promise<RecoveryResult> {
    try {
      const candidates = rows().filter(row => row.status === 'running' && pending.has(recoveryKey(row)));
      const current = new Set(candidates.map(recoveryKey));
      for (const key of pending) if (!current.has(key)) pending.delete(key);
      const result = await recoverRuns(db, { ...deps, rows: () => candidates });
      for (const row of candidates) if (result.reattached.includes(row.id)) pending.delete(recoveryKey(row));
      if (!disposed) deps.onResult?.(result);
      return result;
    } catch (error) { if (!disposed) deps.onError?.(error); throw error; }
    finally {
      if (!disposed && pending.size && Date.now() + interval <= deadline) {
        timer = setTimeout(() => { timer = undefined; if (!disposed) void pass().catch(() => {}); }, interval);
        timer.unref?.();
      }
    }
  }
  return { initial: pass(), dispose() { disposed = true; clearTimeout(timer); } };
}
