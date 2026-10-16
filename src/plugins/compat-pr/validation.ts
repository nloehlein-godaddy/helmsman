import type { PullRequestInspectDetailV1, PullRequestInspectDiffV1, PullRequestReadPageV1, RunReadSummaryV1 } from '@helmsman/plugin-sdk';
import { target, sameTarget, type Identity } from './render.js';
const record = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && 'value' in (Object.getOwnPropertyDescriptor(value, key) ?? {})) ? value as Record<string, unknown> : null;
};
const count = (value: unknown) => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const sha = (value: unknown) => typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value);
const evidenceObject = (value: unknown, fields: readonly string[]): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !fields.includes(key) || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}))) return null;
  return value as Record<string, unknown>;
};
const evidenceText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const evidenceUrl = (value: unknown) => {
  if (value === null) return true; if (!evidenceText(value, 2048)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
};
function validEvidence(input: unknown): boolean {
  const fields = ['comments', 'changesRequested', 'approved', 'requested', 'checksPassed', 'checksFailed', 'checksPending'];
  const evidence = evidenceObject(input, fields); if (!evidence) return false;
  for (const field of fields) {
    const list = evidenceObject(evidence[field], ['quality', 'truncated', 'items']);
    if (!list || !['complete', 'partial', 'unavailable'].includes(String(list.quality)) || typeof list.truncated !== 'boolean'
      || !Array.isArray(list.items) || list.items.length > 100 || Reflect.ownKeys(list.items).length !== list.items.length + 1
      || list.quality === 'complete' && list.truncated || list.quality === 'unavailable' && (list.truncated || list.items.length)) return false;
    const discussion = field === 'comments' || field === 'changesRequested'; const reviewer = field === 'approved' || field === 'requested'; const ids = new Set<string>();
    for (let index = 0; index < list.items.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(list.items, index); if (!descriptor || !('value' in descriptor)) return false;
      const item = evidenceObject(descriptor.value, discussion ? ['id', 'author', 'body', 'bodyTruncated', 'url', 'createdAt'] : reviewer ? ['id', 'label', 'url'] : ['id', 'name', 'url']);
      if (!item || !evidenceText(item.id, 256) || ids.has(item.id) || !evidenceUrl(item.url)) return false; ids.add(item.id);
      if (discussion) {
        if (item.author !== null && !evidenceText(item.author, 128) || typeof item.body !== 'string' || item.body.includes('\0') || new TextEncoder().encode(item.body).byteLength > 4096
          || typeof item.bodyTruncated !== 'boolean' || item.createdAt !== null && (!evidenceText(item.createdAt, 64) || !Number.isFinite(Date.parse(item.createdAt)))) return false;
      } else if (!evidenceText(item[reviewer ? 'label' : 'name'], reviewer ? 256 : 2048)) return false;
    }
  }
  return new TextEncoder().encode(JSON.stringify(evidence)).byteLength <= 512 * 1024;
}
export function validDetail(input: unknown, expected: Identity): input is PullRequestInspectDetailV1 {
  const value = record(input); const selected = record(value?.target); const checks = record(value?.checks); const reviews = record(value?.reviews);
  return value?.version === 1 && sameTarget(target(selected), expected) && sha(selected?.headSha) && sha(selected?.baseSha)
    && typeof value.title === 'string' && typeof value.url === 'string' && typeof value.updatedAt === 'string' && typeof value.headRefName === 'string'
    && ['open', 'closed', 'merged'].includes(String(value.status)) && typeof value.draft === 'boolean' && (value.isOwnPr === null || typeof value.isOwnPr === 'boolean')
    && (!Object.hasOwn(value, 'evidence') || validEvidence(value.evidence))
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
    const row = record(item); return row && target(row) && (repo === null || row.repo === repo) && typeof row.title === 'string' && ['open', 'closed', 'merged'].includes(String(row.status)) && count(row.comments)
      && (row.authorLogin === undefined || row.authorLogin === null || evidenceText(row.authorLogin, 128))
      && (row.viewerHasReviewed === undefined || row.viewerHasReviewed === null || typeof row.viewerHasReviewed === 'boolean');
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
