import type { PullRequestInspectDetailV1, PullRequestInspectDiffV1, PullRequestReadPageV1, RunReadSummaryV1 } from '@helmsman/plugin-sdk';
import { target, sameTarget, type Identity } from './render.js';
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown) => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const sha = (value: unknown) => typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value);
export function validDetail(input: unknown, expected: Identity): input is PullRequestInspectDetailV1 {
  const value = record(input); const selected = record(value?.target); const checks = record(value?.checks); const reviews = record(value?.reviews);
  return value?.version === 1 && sameTarget(target(selected), expected) && sha(selected?.headSha) && sha(selected?.baseSha)
    && typeof value.title === 'string' && typeof value.url === 'string' && typeof value.updatedAt === 'string' && typeof value.headRefName === 'string'
    && ['open', 'closed', 'merged'].includes(String(value.status)) && typeof value.draft === 'boolean' && (value.isOwnPr === null || typeof value.isOwnPr === 'boolean')
    && Boolean(checks && reviews) && ['passed', 'failed', 'pending'].every(key => count(checks?.[key])) && ['approved', 'changesRequested', 'commented', 'requested'].every(key => count(reviews?.[key]));
}
export function validDiff(input: unknown, expected: PullRequestInspectDetailV1['target']): input is PullRequestInspectDiffV1 {
  const value = record(input); const selected = record(value?.target);
  return value?.version === 1 && sameTarget(target(selected), expected) && selected?.headSha === expected.headSha && selected?.baseSha === expected.baseSha
    && Array.isArray(value.files) && value.files.length <= 100 && value.files.every(file => { const item = record(file); return item && typeof item.filename === 'string' && (item.patch === null || typeof item.patch === 'string') && ['preview', 'truncated', 'unavailable'].includes(String(item.patchStatus)) && count(item.additions) && count(item.deletions); });
}
export function validList(input: unknown, repo: string | null): input is PullRequestReadPageV1 {
  const value = record(input);
  return value?.version === 1 && value.repo === repo && Array.isArray(value.items) && value.items.length <= 50 && value.items.every(item => {
    const row = record(item); return row && target(row) && (repo === null || row.repo === repo) && typeof row.title === 'string' && ['open', 'closed', 'merged'].includes(String(row.status)) && count(row.comments);
  });
}
export function validRun(input: unknown, repo: string | null): input is RunReadSummaryV1 {
  const value = record(input);
  return value?.version === 1 && typeof value.id === 'string' && /^[a-z\d_-]{1,128}$/i.test(value.id) && typeof value.repo === 'string' && (repo === null || value.repo === repo)
    && typeof value.displayKey === 'string' && typeof value.startedAt === 'string' && count(value.prNumber) && ['running', 'succeeded', 'failed', 'stopped'].includes(String(value.status));
}
export function validPending(input: unknown, kind: 'review' | 'run'): boolean {
  const row = record(input); const command = record(row?.command);
  if (!command || command.version !== 1 || typeof command.repo !== 'string' || typeof command.requestId !== 'string') return false;
  if (kind === 'review') return Boolean(target(command) && sha(command.expectedHeadSha) && typeof command.body === 'string' && ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(String(command.event)));
  if (command.action === 'launch') { const launch = record(command.launch); return launch && (launch.mode === 'review' || launch.mode === 'rerun') ? Boolean(target({ repo: command.repo, number: launch.prNumber })) : Boolean(launch && ['source', 'freeform'].includes(String(launch.mode))); }
  return command.action === 'retry' || command.action === 'stop';
}
