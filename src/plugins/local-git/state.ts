import type { LocalBranch, LocalWorktree, LocalGitAction, LocalGitCleanup, LocalGitTargetV1, LocalGitSnapshotV1, LocalGitPreviewV1, LocalGitControlInputV1, LocalGitControlReceiptV1, LocalGitPendingV1 } from '@helmsman/plugin-sdk';

export interface LocalGitViewState {
  repo: string | null; headerRepo: string | null; pirateMode: boolean; path: string | null;
  branches: LocalBranch[]; worktrees: LocalWorktree[]; error: string | null; loading: boolean;
  pendingAction?: string; cleanup?: LocalGitCleanup; cleanupForce: boolean; deleteForce: boolean;
  confirmation?: Extract<LocalGitAction, { action: 'delete-branch' | 'delete-worktree' | 'release-worktree' }>;
}
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]!);
export const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const repoValid = (value: unknown): value is string => text(value) && /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(value);
const optionalText = (value: unknown) => value === null || value === undefined || text(value);
export const targetValid = (value: unknown): value is LocalGitTargetV1 => object(value) && repoValid(value.repo) && text(value.revision) && /^[a-f\d]{64}$/.test(value.revision);
export const sameTarget = (a: LocalGitTargetV1 | null | undefined, b: LocalGitTargetV1 | null | undefined) => !!a && !!b && a.repo === b.repo && a.revision === b.revision;
export function snapshotValid(value: unknown): value is LocalGitSnapshotV1 {
  return object(value) && value.version === 1 && targetValid(value) && (value.path === null || text(value.path)) && (value.error === null || text(value.error))
    && Array.isArray(value.branches) && value.branches.length <= 2000 && value.branches.every(row => object(row) && text(row.name) && !!row.name && text(row.commit) && typeof row.current === 'boolean' && (row.upstream === null || text(row.upstream)) && (row.upstreamStatus === undefined || ['present','gone','none','unknown'].includes(String(row.upstreamStatus))) && optionalText(row.deletionBlockedReason))
    && Array.isArray(value.worktrees) && value.worktrees.length <= 2000 && value.worktrees.every(row => object(row) && text(row.path) && !!row.path && text(row.commit) && (row.branch === null || text(row.branch)) && ['bare','detached','locked','prunable'].every(key => typeof row[key] === 'boolean') && (row.active === undefined || typeof row.active === 'boolean') && optionalText(row.releaseBlockedReason) && optionalText(row.deletionBlockedReason));
}
export function previewValid(value: unknown): value is LocalGitPreviewV1 {
  if (!object(value) || value.version !== 1 || !targetValid(value.target) || !object(value.cleanup)) return false;
  const cleanup = value.cleanup;
  return text(cleanup.expectedHead) && !!cleanup.expectedHead && typeof cleanup.force === 'boolean' && Array.isArray(cleanup.candidates) && cleanup.candidates.length <= 2000 && cleanup.candidates.every(row => object(row) && text(row.branch) && !!row.branch && text(row.expectedCommit) && !!row.expectedCommit && ['none','gone'].includes(String(row.upstreamStatus))) && Array.isArray(cleanup.skipped) && cleanup.skipped.length <= 2000 && cleanup.skipped.every(row => object(row) && text(row.branch) && text(row.reason));
}
export function inputValid(value: unknown): value is LocalGitControlInputV1 {
  if (!object(value) || value.version !== 1 || !targetValid(value.target) || !object(value.operation)) return false;
  const op = value.operation;
  if (op.force !== undefined && typeof op.force !== 'boolean') return false;
  switch (op.action) {
    case 'refresh-remotes': return true;
    case 'delete-branch': return text(op.branch) && !!op.branch && text(op.expectedCommit) && !!op.expectedCommit;
    case 'release-worktree': return text(op.path) && !!op.path && text(op.expectedCommit) && !!op.expectedCommit && text(op.expectedBranch) && !!op.expectedBranch && op.force === undefined;
    case 'delete-worktree': return text(op.path) && !!op.path && text(op.expectedCommit) && !!op.expectedCommit;
    case 'delete-untracked-branches': return text(op.expectedHead) && !!op.expectedHead && Array.isArray(op.branches) && op.branches.length > 0 && op.branches.length <= 2000 && op.branches.every(row => object(row) && text(row.branch) && !!row.branch && text(row.expectedCommit) && !!row.expectedCommit);
    default: return false;
  }
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
export const sameInput = (a: LocalGitControlInputV1, b: LocalGitControlInputV1) => JSON.stringify(canonical({version:a.version,target:a.target,operation:a.operation})) === JSON.stringify(canonical({version:b.version,target:b.target,operation:b.operation}));
export function receiptValid(value: unknown): value is LocalGitControlReceiptV1 {
  return object(value) && value.version === 1 && text(value.requestId) && !!value.requestId && inputValid(value.input) && ['succeeded','rejected','pending','recovery-required'].includes(String(value.status)) && (value.reason === null || text(value.reason)) && (value.status === 'succeeded' ? snapshotValid(value.result) && value.result.repo === value.input.target.repo : value.result === null);
}
export function pendingValid(value: unknown): value is readonly LocalGitPendingV1[] {
  return Array.isArray(value) && value.length <= 256 && value.every(row => object(row) && inputValid(row.command) && 'requestId' in row.command && text(row.command.requestId) && !!row.command.requestId && (row.receipt === null || receiptValid(row.receipt) && row.receipt.requestId === row.command.requestId && sameInput(row.receipt.input,row.command)));
}
export class LocalGitStorage {
  private readonly prefix: string;
  constructor(contribution: string | undefined, instance: string) {
    if (!contribution || !/^[a-z\d][a-z\d._-]*\/[a-z\d][a-z\d._-]*$/i.test(contribution) || !instance) throw new Error('Local Git storage requires its mounted contribution and instance identity.');
    this.prefix = `helmsman.local-git.v1:${contribution}:${encodeURIComponent(instance)}:`;
  }
  private read(key: string): unknown { const raw = localStorage.getItem(this.prefix + key); if (raw === null) return null; if (raw.length > 4 * 1024 * 1024) throw new Error('Saved Local Git evidence exceeds the supported limit. Its original data is kept.'); return JSON.parse(raw); }
  private save(key: string, value: unknown) { const previous = this.read(key); const raw = JSON.stringify(value); if (previous !== null && JSON.stringify(canonical(previous)) !== JSON.stringify(canonical(value))) throw new Error('Local Git receipt changed. Original evidence is kept.'); if (raw.length > 4 * 1024 * 1024) throw new Error('Local Git evidence is too large to save.'); localStorage.setItem(this.prefix + key,raw); }
  result(value: LocalGitControlReceiptV1) { this.save(`result:${value.requestId}:${value.status}`,value); }
  inspected(value: LocalGitControlReceiptV1) { this.save(`inspected:${value.requestId}`,{version:1,receipt:value}); }
  results(): LocalGitControlReceiptV1[] {
    const values: LocalGitControlReceiptV1[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index); if (!key?.startsWith(this.prefix)) continue;
      const suffix = key.slice(this.prefix.length); const value = this.read(suffix);
      if (suffix.startsWith('inspected:')) { if (!object(value) || value.version !== 1 || !receiptValid(value.receipt) || value.receipt.status !== 'recovery-required') throw new Error('Saved Local Git inspection evidence uses an unsupported format. Original data is kept.'); }
      else if (suffix.startsWith('result:') && receiptValid(value) && value.status !== 'pending') values.push(value);
      else throw new Error('Saved Local Git evidence uses an unsupported format. Original data is kept.');
    }
    return values;
  }
}
