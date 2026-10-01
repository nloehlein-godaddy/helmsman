import { parsePullRequestInspectDetailQueryV1, type PullRequestInspectDetailQueryV1 } from './pull-request-inspect';
import { parseTaskRepo } from './tasks';

export interface PullRequestFeedbackSourceV1 {
  readonly id: string;
  readonly url: string;
  readonly body: string;
  readonly kind: 'description' | 'review' | 'comment' | 'inline';
  readonly updatedAt: string;
  readonly replyTo?: string;
  readonly state?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  readonly submittedAt?: string | null;
}

export interface PullRequestFeedbackSnapshotV1 {
  readonly version: 1;
  readonly quality: 'complete';
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly sources: readonly PullRequestFeedbackSourceV1[];
  readonly fingerprint: string;
}

export const PULL_REQUEST_FEEDBACK_LIMITS: Readonly<{ pages: number; page: number; sources: number; body: number; responseBytes: number }> = Object.freeze({ pages: 100, page: 100, sources: 30_001,
  body: 1024 * 1024, responseBytes: 8 * 1024 * 1024 });

export class PullRequestFeedbackValidationError extends Error {}
function invalid(): never { throw new PullRequestFeedbackValidationError('Invalid or incomplete pull request feedback snapshot'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(result) || !Number.isFinite(Date.parse(result))) invalid();
  return result;
}
function sha(value: unknown): string {
  const result = text(value, 64); if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(result)) invalid(); return result.toLowerCase();
}
function url(value: unknown): string {
  const result = text(value, 2048);
  let parsed: URL; try { parsed = new URL(result); } catch { return invalid(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) invalid();
  return result;
}
function sourceId(value: unknown, kind: string): string {
  const result = text(value, 128); const parts = result.split(':');
  if (parts.length !== 2 || parts[0] !== kind || !/^[1-9]\d*$/.test(parts[1] ?? '') || !Number.isSafeInteger(Number(parts[1]))) invalid();
  return result;
}

export function parsePullRequestFeedbackSnapshotV1(input: unknown, expected: PullRequestInspectDetailQueryV1): PullRequestFeedbackSnapshotV1 {
  const query = parsePullRequestInspectDetailQueryV1(expected); const value = record(input);
  if (value.version !== 1 || value.quality !== 'complete' || value.truncated !== undefined && value.truncated !== false
    || parseTaskRepo(value.repo) !== query.repo || value.prNumber !== query.number
    || typeof value.state !== 'string' || !['OPEN', 'CLOSED', 'MERGED'].includes(value.state) || !Array.isArray(value.sources)
    || !value.sources.length || value.sources.length > PULL_REQUEST_FEEDBACK_LIMITS.sources) invalid();
  const seen = new Set<string>(); let descriptions = 0; let bodyBytes = 0;
  const sources = Array.from({ length: value.sources.length }, (_, index): PullRequestFeedbackSourceV1 => {
    const descriptor = Object.getOwnPropertyDescriptor(value.sources, index); if (!descriptor || !('value' in descriptor)) invalid();
    const item = record(descriptor.value); const kind = item.kind;
    if (kind !== 'description' && kind !== 'review' && kind !== 'comment' && kind !== 'inline') invalid();
    const id = sourceId(item.id, kind); if (seen.has(id)) invalid(); seen.add(id);
    if (kind === 'description' && (++descriptions !== 1 || id !== `description:${query.number}`)) invalid();
    if (typeof item.body !== 'string' || item.body.length > PULL_REQUEST_FEEDBACK_LIMITS.body) invalid();
    const size = new TextEncoder().encode(item.body).byteLength;
    if (size > PULL_REQUEST_FEEDBACK_LIMITS.body) invalid();
    bodyBytes += size;
    if (bodyBytes > PULL_REQUEST_FEEDBACK_LIMITS.responseBytes) invalid();
    const base: PullRequestFeedbackSourceV1 = { id, kind, url: url(item.url), body: item.body, updatedAt: timestamp(item.updatedAt) };
    if (kind === 'review') {
      if (item.replyTo !== undefined || typeof item.state !== 'string' || !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(item.state)) invalid();
      const submittedAt = item.state === 'PENDING' && item.submittedAt === null ? null : timestamp(item.submittedAt);
      return Object.freeze({ ...base, state: item.state as PullRequestFeedbackSourceV1['state'], submittedAt });
    }
    if (item.state !== undefined || item.submittedAt !== undefined || item.replyTo !== undefined && kind !== 'inline') invalid();
    const replyTo = item.replyTo === undefined ? undefined : sourceId(item.replyTo, 'inline');
    if (replyTo === id) invalid();
    return Object.freeze({ ...base, ...(replyTo === undefined ? {} : { replyTo }) });
  });
  if (descriptions !== 1) invalid();
  sources.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const fingerprint = text(value.fingerprint, 64); if (!/^[a-f\d]{64}$/.test(fingerprint)) invalid();
  const snapshot: PullRequestFeedbackSnapshotV1 = { version: 1, quality: 'complete', repo: query.repo, prNumber: query.number,
    headSha: sha(value.headSha), baseSha: sha(value.baseSha), headBranch: text(value.headBranch, 1024), baseBranch: text(value.baseBranch, 1024),
    state: value.state as PullRequestFeedbackSnapshotV1['state'], sources: Object.freeze(sources), fingerprint };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > PULL_REQUEST_FEEDBACK_LIMITS.responseBytes) invalid();
  return Object.freeze(snapshot);
}

export async function fingerprintPullRequestFeedbackSnapshotV1(input: PullRequestFeedbackSnapshotV1): Promise<string> {
  const { fingerprint: _fingerprint, ...content } = parsePullRequestFeedbackSnapshotV1(input, { version: 1, repo: input.repo, number: input.prNumber });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(content)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
