import type { ClarificationReadResultV1 } from './clarification-read';

export interface LocalBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  upstreamStatus?: 'present' | 'gone' | 'none' | 'unknown';
  deletionBlockedReason?: string | null;
  commit: string;
}

export interface LocalWorktree {
  path: string;
  branch: string | null;
  commit: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  deletionBlockedReason?: string | null;
}

export type LocalGitAction =
  | { action: 'delete-branch'; branch: string; expectedCommit: string; force?: boolean }
  | { action: 'delete-worktree'; path: string; expectedCommit: string }
  | { action: 'preview-delete-untracked-branches'; force?: boolean }
  | { action: 'delete-untracked-branches'; expectedHead: string; branches: { branch: string; expectedCommit: string }[]; force?: boolean }
  | { action: 'refresh-remotes' };

export interface LocalGitCleanup {
  expectedHead: string;
  force: boolean;
  candidates: { branch: string; expectedCommit: string; upstreamStatus: 'none' | 'gone' }[];
  skipped: { branch: string; reason: string }[];
}

export interface LocalGitResponse {
  repo: string;
  path: string | null;
  branches: LocalBranch[];
  worktrees: LocalWorktree[];
  error: string | null;
  cleanup?: LocalGitCleanup;
}


export interface LocalGitTargetV1 { readonly repo: string; readonly revision: string; }
export interface LocalGitSnapshotV1 extends Omit<LocalGitResponse, 'cleanup'> { readonly version: 1; readonly revision: string; }
export interface LocalGitPreviewV1 { readonly version: 1; readonly target: LocalGitTargetV1; readonly cleanup: LocalGitCleanup; }
export interface LocalGitControlInputV1 { readonly version: 1; readonly target: LocalGitTargetV1; readonly operation: Exclude<LocalGitAction, { action: 'preview-delete-untracked-branches' }>; }
export interface LocalGitControlCommandV1 extends LocalGitControlInputV1 { readonly requestId: string; }
export interface LocalGitReceiptQueryV1 { readonly repo: string; readonly requestId: string; }
export interface LocalGitControlReceiptV1 {
  readonly version: 1; readonly requestId: string; readonly input: LocalGitControlInputV1;
  readonly status: 'succeeded' | 'rejected' | 'pending' | 'recovery-required'; readonly reason: string | null; readonly result: LocalGitSnapshotV1 | null;
}
export interface LocalGitPendingV1 { readonly command: LocalGitControlCommandV1; readonly receipt: LocalGitControlReceiptV1 | null; }
export interface LocalGitServiceV1 {
  readonly version: 1;
  snapshot(input: { readonly version: 1; readonly repo: string }, signal?: AbortSignal): Promise<ClarificationReadResultV1<LocalGitSnapshotV1>>;
  preview(input: { readonly target: LocalGitTargetV1; readonly force: boolean }, signal?: AbortSignal): Promise<ClarificationReadResultV1<LocalGitPreviewV1>>;
  control(input: LocalGitControlInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<LocalGitControlReceiptV1>>;
  receipt(input: LocalGitReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<LocalGitControlReceiptV1 | null>>;
  inspect(input: LocalGitReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<LocalGitControlReceiptV1>>;
  pending(signal?: AbortSignal): Promise<readonly LocalGitPendingV1[]>;
  acknowledge(input: LocalGitReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}

import { clarificationArray, clarificationBoolean, clarificationFields, clarificationJson, clarificationObject, clarificationUuid, clarificationVersion, invalidClarification } from './clarification-validation';
import { sourceText } from './source-contract-validation';
import { parseTaskRepo } from './tasks';
export const LOCAL_GIT_LIMITS: Readonly<{ branches: number; worktrees: number; responseBytes: number }> = Object.freeze({ branches: 1000, worktrees: 1000, responseBytes: 3 * 1024 * 1024 });
function nullable(value: unknown, maximum: number): string | null { return value === null ? null : sourceText(value, maximum); }
function hash(value: unknown, revision = false): string { const text = sourceText(value, 64); if (!(revision ? /^[a-f\d]{64}$/ : /^(?:[a-f\d]{40}|[a-f\d]{64})$/i).test(text)) invalidClarification(); return text; }
function branch(value: unknown): string { const text = sourceText(value, 1024); if (text.startsWith('-') || /[\s~^:?*\[\\]/.test(text) || text.includes('..') || text.includes('@{') || text.endsWith('.') || text.endsWith('/') || text.includes('//')) invalidClarification(); return text; }
function path(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) invalidClarification(); const text = value; if (!text.startsWith('/') && !/^[a-z]:[\\/]/i.test(text) && !text.startsWith('\\\\')) invalidClarification(); return text; }
export function parseLocalGitTargetV1(input: unknown): LocalGitTargetV1 {
  const value = clarificationObject(input); clarificationFields(value, ['repo', 'revision']); return Object.freeze({ repo: parseTaskRepo(value.repo), revision: hash(value.revision, true) });
}
export function parseLocalGitSnapshotV1(input: unknown): LocalGitSnapshotV1 {
  const value = clarificationVersion(clarificationJson(input, LOCAL_GIT_LIMITS.responseBytes)); clarificationFields(value, ['version', 'repo', 'revision', 'path', 'branches', 'worktrees', 'error']);
  const branches = [...clarificationArray(value.branches, entry => {
    const item = clarificationObject(entry); clarificationFields(item, ['name', 'current', 'upstream', 'commit'], ['upstreamStatus', 'deletionBlockedReason']);
    if (item.upstreamStatus !== undefined && !['present', 'gone', 'none', 'unknown'].includes(String(item.upstreamStatus))) invalidClarification();
    return { name: branch(item.name), current: clarificationBoolean(item.current), upstream: nullable(item.upstream, 1024), commit: hash(item.commit),
      ...(item.upstreamStatus === undefined ? {} : { upstreamStatus: item.upstreamStatus as LocalBranch['upstreamStatus'] }),
      ...(item.deletionBlockedReason === undefined ? {} : { deletionBlockedReason: nullable(item.deletionBlockedReason, 2000) }) };
  }, LOCAL_GIT_LIMITS.branches)];
  const worktrees = [...clarificationArray(value.worktrees, entry => {
    const item = clarificationObject(entry); clarificationFields(item, ['path', 'branch', 'commit', 'bare', 'detached', 'locked', 'prunable'], ['deletionBlockedReason']);
    return { path: path(item.path), branch: item.branch === null ? null : branch(item.branch), commit: item.commit === '' && item.bare === true ? '' : hash(item.commit), bare: clarificationBoolean(item.bare), detached: clarificationBoolean(item.detached), locked: clarificationBoolean(item.locked), prunable: clarificationBoolean(item.prunable),
      ...(item.deletionBlockedReason === undefined ? {} : { deletionBlockedReason: nullable(item.deletionBlockedReason, 2000) }) };
  }, LOCAL_GIT_LIMITS.worktrees)];
  if (new Set(branches.map(item => item.name)).size !== branches.length || new Set(worktrees.map(item => item.path)).size !== worktrees.length) invalidClarification();
  return { version: 1, repo: parseTaskRepo(value.repo), revision: hash(value.revision, true), path: value.path === null ? null : path(value.path), branches, worktrees, error: nullable(value.error, 2000) };
}
export function parseLocalGitCleanupV1(input: unknown): LocalGitCleanup {
  const value = clarificationObject(input); clarificationFields(value, ['expectedHead', 'force', 'candidates', 'skipped']);
  const candidates = [...clarificationArray(value.candidates, entry => {
    const item = clarificationObject(entry); clarificationFields(item, ['branch', 'expectedCommit', 'upstreamStatus']); if (item.upstreamStatus !== 'none' && item.upstreamStatus !== 'gone') invalidClarification();
    return { branch: branch(item.branch), expectedCommit: hash(item.expectedCommit), upstreamStatus: item.upstreamStatus as 'none' | 'gone' };
  }, LOCAL_GIT_LIMITS.branches)];
  const skipped = [...clarificationArray(value.skipped, entry => { const item = clarificationObject(entry); clarificationFields(item, ['branch', 'reason']); return { branch: branch(item.branch), reason: sourceText(item.reason, 2000) }; }, LOCAL_GIT_LIMITS.branches)];
  if (new Set([...candidates, ...skipped].map(item => item.branch)).size !== candidates.length + skipped.length) invalidClarification();
  return { expectedHead: hash(value.expectedHead), force: clarificationBoolean(value.force), candidates, skipped };
}
export function parseLocalGitPreviewV1(input: unknown, expected?: LocalGitTargetV1): LocalGitPreviewV1 {
  const value = clarificationVersion(clarificationJson(input, LOCAL_GIT_LIMITS.responseBytes)); clarificationFields(value, ['version', 'target', 'cleanup']); const target = parseLocalGitTargetV1(value.target);
  if (expected && JSON.stringify(target) !== JSON.stringify(parseLocalGitTargetV1(expected))) invalidClarification();
  return { version: 1, target, cleanup: parseLocalGitCleanupV1(value.cleanup) };
}
export function parseLocalGitControlInputV1(input: unknown): LocalGitControlInputV1 {
  const value = clarificationVersion(clarificationJson(input, LOCAL_GIT_LIMITS.responseBytes)); clarificationFields(value, ['version', 'target', 'operation']);
  const data = clarificationObject(value.operation); let operation: LocalGitControlInputV1['operation'];
  const force = () => data.force === undefined ? {} : { force: clarificationBoolean(data.force) };
  if (data.action === 'refresh-remotes') { clarificationFields(data, ['action']); operation = { action: 'refresh-remotes' }; }
  else if (data.action === 'delete-branch') { clarificationFields(data, ['action', 'branch', 'expectedCommit'], ['force']); operation = { action: 'delete-branch', branch: branch(data.branch), expectedCommit: hash(data.expectedCommit), ...force() }; }
  else if (data.action === 'delete-worktree') { clarificationFields(data, ['action', 'path', 'expectedCommit']); operation = { action: 'delete-worktree', path: path(data.path), expectedCommit: hash(data.expectedCommit) }; }
  else if (data.action === 'delete-untracked-branches') {
    clarificationFields(data, ['action', 'expectedHead', 'branches'], ['force']);
    const branches = [...clarificationArray(data.branches, entry => { const item = clarificationObject(entry); clarificationFields(item, ['branch', 'expectedCommit']); return { branch: branch(item.branch), expectedCommit: hash(item.expectedCommit) }; }, LOCAL_GIT_LIMITS.branches)];
    if (!branches.length || new Set(branches.map(item => item.branch)).size !== branches.length) invalidClarification();
    operation = { action: 'delete-untracked-branches', expectedHead: hash(data.expectedHead), branches, ...force() };
  } else return invalidClarification();
  return Object.freeze({ version: 1, target: parseLocalGitTargetV1(value.target), operation: Object.freeze(operation) });
}
export function parseLocalGitControlCommandV1(input: unknown): LocalGitControlCommandV1 {
  const { requestId, ...value } = clarificationObject(input); return Object.freeze({ ...parseLocalGitControlInputV1(value), requestId: clarificationUuid(requestId) });
}
export function parseLocalGitReceiptQueryV1(input: unknown): LocalGitReceiptQueryV1 {
  const value = clarificationObject(input); clarificationFields(value, ['repo', 'requestId']); return Object.freeze({ repo: parseTaskRepo(value.repo), requestId: clarificationUuid(value.requestId) });
}
export function parseLocalGitControlReceiptV1(input: unknown, expected?: LocalGitControlCommandV1 | LocalGitReceiptQueryV1): LocalGitControlReceiptV1 {
  const value = clarificationVersion(clarificationJson(input, LOCAL_GIT_LIMITS.responseBytes)); clarificationFields(value, ['version', 'requestId', 'input', 'status', 'reason', 'result']);
  const command = parseLocalGitControlInputV1(value.input); const requestId = clarificationUuid(value.requestId);
  if (expected && (expected.requestId !== requestId || ('target' in expected ? expected.target.repo : expected.repo) !== command.target.repo)) invalidClarification();
  if (expected && 'target' in expected) { const { requestId: _id, ...original } = parseLocalGitControlCommandV1(expected); if (JSON.stringify(original) !== JSON.stringify(command)) invalidClarification(); }
  if (!['succeeded', 'rejected', 'pending', 'recovery-required'].includes(String(value.status))) invalidClarification();
  const result = value.result === null ? null : parseLocalGitSnapshotV1(value.result); const reason = nullable(value.reason, 2000);
  if (value.status === 'succeeded' ? result === null || result.repo !== command.target.repo || result.error !== null || reason !== null : result !== null || value.status !== 'pending' && reason === null) invalidClarification();
  return { version: 1, requestId, input: command, status: value.status as LocalGitControlReceiptV1['status'], result, reason };
}
