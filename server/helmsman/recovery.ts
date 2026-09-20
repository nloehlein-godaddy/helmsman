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

const recoveries = new WeakMap<Db, Map<string, Promise<AttachmentHandshake>>>();

export async function recoverRuns(db: Db, deps: RecoverDeps): Promise<{ reattached: string[]; failed: string[]; blocked: string[] }> {
  const rows = deps.rows?.() ?? db.reattachableRuns();
  const timeoutMs = deps.handshakeTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid recovery handshake timeout');
  const active = recoveries.get(db) ?? new Map<string, Promise<AttachmentHandshake>>();
  recoveries.set(db, active);
  const result = { reattached: [] as string[], failed: [] as string[], blocked: [] as string[] };
  await Promise.all(rows.map(async row => {
    const key = `${row.id}:${row.attempt}`;
    let handshake = active.get(key);
    if (!handshake) {
      handshake = (async (): Promise<AttachmentHandshake> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          deps.recordAttachment?.(row, 'pending');
          const attaching = Promise.resolve().then(() => deps.reattach(row)).then(outcome => {
            if (outcome?.status === 'attached' && typeof outcome.completion?.catch === 'function') {
              void outcome.completion.catch(error => { deps.completionFailed?.(row, error); }).catch(() => {});
            }
            return outcome;
          });
          const outcome = await Promise.race([
            attaching,
            new Promise<AttachmentHandshake>(resolve => { timer = setTimeout(() => resolve({ status: 'blocked', reason: 'Attachment handshake timed out; process ownership remains unresolved' }), timeoutMs); }),
          ]);
          if (!outcome || !['attached', 'blocked', 'failed'].includes(outcome.status)) {
            return { status: 'blocked', reason: 'Legacy attachment did not provide an ownership handshake' };
          }
          if (outcome.status === 'attached' && (!outcome.completion || typeof outcome.completion.then !== 'function')) {
            return { status: 'failed', reason: 'Attachment did not supply a completion observer' };
          }
          return outcome;
        } catch (error) { return { status: 'failed', reason: error instanceof Error ? error.message : 'Attachment failed' }; }
        finally { clearTimeout(timer); }
      })();
      active.set(key, handshake);
      void handshake.then(outcome => {
        const release = () => { if (active.get(key) === handshake) active.delete(key); };
        if (outcome.status !== 'attached') { release(); return; }
        void outcome.completion.finally(release).catch(() => {});
      });
    }
    const outcome = await handshake;
    deps.recordAttachment?.(row, outcome.status, outcome.status === 'attached' ? undefined : outcome.reason);
    if (outcome.status === 'attached') result.reattached.push(row.id);
    else result[outcome.status].push(row.id);
  }));
  return result;
}
