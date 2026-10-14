import { parseTaskRepo } from './tasks';

export interface PullRequestInspectDetailQueryV1 { readonly version: 1; readonly repo: string; readonly number: number; }
export interface PullRequestInspectTargetV1 { readonly repo: string; readonly number: number; readonly headSha: string; readonly baseSha: string; }
export interface PullRequestInspectDiffQueryV1 { readonly version: 1; readonly target: PullRequestInspectTargetV1; }
export type PullRequestInspectQualityV1 = 'complete' | 'partial' | 'unavailable';
export type PullRequestInspectReviewV1 = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
export interface PullRequestInspectEvidenceListV1<T> { readonly quality: PullRequestInspectQualityV1; readonly truncated: boolean; readonly items: readonly T[]; }
export interface PullRequestInspectDiscussionEvidenceV1 {
  readonly id: string; readonly author: string | null; readonly body: string; readonly bodyTruncated: boolean; readonly url: string | null; readonly createdAt: string | null;
}
export interface PullRequestInspectReviewerEvidenceV1 { readonly id: string; readonly label: string; readonly url: string | null; }
export interface PullRequestInspectCheckEvidenceV1 { readonly id: string; readonly name: string; readonly url: string | null; }
export interface PullRequestInspectEvidenceV1 {
  readonly comments: PullRequestInspectEvidenceListV1<PullRequestInspectDiscussionEvidenceV1>;
  readonly changesRequested: PullRequestInspectEvidenceListV1<PullRequestInspectDiscussionEvidenceV1>;
  readonly approved: PullRequestInspectEvidenceListV1<PullRequestInspectReviewerEvidenceV1>;
  readonly requested: PullRequestInspectEvidenceListV1<PullRequestInspectReviewerEvidenceV1>;
  readonly checksPassed: PullRequestInspectEvidenceListV1<PullRequestInspectCheckEvidenceV1>;
  readonly checksFailed: PullRequestInspectEvidenceListV1<PullRequestInspectCheckEvidenceV1>;
  readonly checksPending: PullRequestInspectEvidenceListV1<PullRequestInspectCheckEvidenceV1>;
}
export const PULL_REQUEST_INSPECT_EVIDENCE_LIMITS: Readonly<{ items: number; bodyBytes: number; responseBytes: number }> = Object.freeze({ items: 100, bodyBytes: 4096, responseBytes: 512 * 1024 });
/** Ownership and viewer reviews refer to the configured author, not authenticated publication authority. */
export interface PullRequestInspectDetailV1 {
  readonly version: 1; readonly target: PullRequestInspectTargetV1; readonly observedAt: string;
  readonly title: string; readonly url: string; readonly status: 'open' | 'closed' | 'merged'; readonly draft: boolean;
  readonly authorLogin: string | null; readonly isOwnPr: boolean | null; readonly headRefName: string;
  readonly updatedAt: string; readonly comments: number | null; readonly evidence?: PullRequestInspectEvidenceV1;
  readonly checks: { readonly quality: PullRequestInspectQualityV1; readonly passed: number | null; readonly failed: number | null; readonly pending: number | null };
  readonly reviews: { readonly quality: PullRequestInspectQualityV1; readonly approved: number | null; readonly changesRequested: number | null;
    readonly commented: number | null; readonly requested: number | null; readonly viewerReview: PullRequestInspectReviewV1 | null;
    readonly viewerReviewedAt: string | null; readonly viewerReviewedCommitId: string | null };
}
export interface PullRequestInspectFileV1 {
  readonly filename: string; readonly previousFilename: string | null; readonly status: string; readonly additions: number; readonly deletions: number;
  readonly patch: string | null; readonly patchStatus: 'preview' | 'truncated' | 'unavailable';
}
export interface PullRequestInspectDiffV1 {
  readonly version: 1; readonly target: PullRequestInspectTargetV1; readonly observedAt: string; readonly coverage: 'immutable-comparison-preview';
  readonly quality: 'complete' | 'partial'; readonly truncated: boolean; readonly files: readonly PullRequestInspectFileV1[];
}
export type PullRequestInspectUnavailableReasonV1 = 'forbidden' | 'not-found' | 'selection-changed' | 'head-changed' | 'service-unavailable' | 'invalid-response' | 'connection-failed' | 'timeout';
export type PullRequestInspectResultV1<T> = { readonly status: 'available'; readonly value: T }
  | { readonly status: 'unavailable'; readonly reason: PullRequestInspectUnavailableReasonV1 };
export interface PullRequestInspectServiceV1 {
  readonly version: 1;
  detail(query: PullRequestInspectDetailQueryV1, signal?: AbortSignal): Promise<PullRequestInspectResultV1<PullRequestInspectDetailV1>>;
  diff(query: PullRequestInspectDiffQueryV1, signal?: AbortSignal): Promise<PullRequestInspectResultV1<PullRequestInspectDiffV1>>;
}
export const PULL_REQUEST_INSPECT_LIMITS: Readonly<{ files: number; providerFiles: number; page: number; pages: number; patch: number; patches: number; responseBytes: number; transportBytes: number; repos: number }> = Object.freeze({ files: 100, providerFiles: 300, page: 100, pages: 3,
  patch: 32 * 1024, patches: 256 * 1024, responseBytes: 2 * 1024 * 1024, transportBytes: 12 * 1024 * 1024, repos: 1000 });
export class PullRequestInspectValidationError extends Error {}
function invalid(): never { throw new PullRequestInspectValidationError('Invalid pull request inspection data'); }
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  for (const key of Reflect.ownKeys(input)) if (typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(input, key) ?? {}))) invalid();
  return input as Record<string, unknown>;
}
function text(input: unknown, maximum: number, multiline = false): string {
  if (typeof input !== 'string' || input.length > maximum || (!multiline && (!input.trim() || /[\x00-\x1f\x7f]/.test(input))) || input.includes('\0')) invalid(); return input;
}
function count(input: unknown, minimum = 0): number { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum) invalid(); return input; }
function date(input: unknown): string { const value = text(input, 64); if (!Number.isFinite(Date.parse(value))) invalid(); return value; }
function sha(input: unknown): string { const value = text(input, 64); if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(value)) invalid(); return value; }
function quality(input: unknown): PullRequestInspectQualityV1 { if (input !== 'complete' && input !== 'partial' && input !== 'unavailable') invalid(); return input; }
function knownCount(input: unknown, known: boolean): number | null { if (!known) { if (input !== null) invalid(); return null; } return count(input); }
function target(input: unknown, expected: PullRequestInspectDetailQueryV1 | PullRequestInspectTargetV1): PullRequestInspectTargetV1 {
  const value = parsePullRequestInspectTargetV1(input);
  if (value.repo !== expected.repo || value.number !== expected.number || 'headSha' in expected && (value.headSha !== expected.headSha || value.baseSha !== expected.baseSha)) invalid(); return value;
}
function bounded<T>(value: T): T { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PULL_REQUEST_INSPECT_LIMITS.responseBytes) invalid(); return Object.freeze(value); }
export function parsePullRequestInspectDetailQueryV1(input: unknown): PullRequestInspectDetailQueryV1 {
  const value = record(input); if (value.version !== 1) invalid(); return Object.freeze({ version: 1, repo: parseTaskRepo(value.repo), number: count(value.number, 1) });
}
export function parsePullRequestInspectTargetV1(input: unknown): PullRequestInspectTargetV1 {
  const value = record(input); return Object.freeze({ repo: parseTaskRepo(value.repo), number: count(value.number, 1), headSha: sha(value.headSha), baseSha: sha(value.baseSha) });
}
export function parsePullRequestInspectDiffQueryV1(input: unknown): PullRequestInspectDiffQueryV1 {
  const value = record(input); if (value.version !== 1) invalid(); return Object.freeze({ version: 1, target: parsePullRequestInspectTargetV1(value.target) });
}
function evidenceUrl(input: unknown): string | null {
  if (input === null) return null;
  const value = text(input, 2048); let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password) invalid();
  return value;
}
function evidenceList<T extends { readonly id: string }>(input: unknown, parse: (value: Record<string, unknown>) => T): PullRequestInspectEvidenceListV1<T> {
  const value = record(input); const listQuality = quality(value.quality);
  if (typeof value.truncated !== 'boolean' || !Array.isArray(value.items) || value.items.length > PULL_REQUEST_INSPECT_EVIDENCE_LIMITS.items
    || listQuality === 'complete' && value.truncated || listQuality === 'unavailable' && (value.truncated || value.items.length)) invalid();
  const ids = new Set<string>();
  const items = Array.from({ length: value.items.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value.items, index); if (!descriptor || !('value' in descriptor)) invalid();
    const item = Object.freeze(parse(record(descriptor.value))); if (ids.has(item.id)) invalid(); ids.add(item.id); return item;
  });
  return Object.freeze({ quality: listQuality, truncated: value.truncated, items: Object.freeze(items) });
}
function discussionEvidence(value: Record<string, unknown>): PullRequestInspectDiscussionEvidenceV1 {
  const body = text(value.body, PULL_REQUEST_INSPECT_EVIDENCE_LIMITS.bodyBytes, true);
  if (new TextEncoder().encode(body).byteLength > PULL_REQUEST_INSPECT_EVIDENCE_LIMITS.bodyBytes || typeof value.bodyTruncated !== 'boolean') invalid();
  return { id: text(value.id, 256), author: value.author === null ? null : text(value.author, 128), body, bodyTruncated: value.bodyTruncated, url: evidenceUrl(value.url), createdAt: value.createdAt === null ? null : date(value.createdAt) };
}
function reviewerEvidence(value: Record<string, unknown>): PullRequestInspectReviewerEvidenceV1 { return { id: text(value.id, 256), label: text(value.label, 256), url: evidenceUrl(value.url) }; }
function checkEvidence(value: Record<string, unknown>): PullRequestInspectCheckEvidenceV1 { return { id: text(value.id, 256), name: text(value.name, 2048), url: evidenceUrl(value.url) }; }
function inspectEvidence(input: unknown): PullRequestInspectEvidenceV1 {
  const value = record(input);
  const evidence = { comments: evidenceList(value.comments, discussionEvidence), changesRequested: evidenceList(value.changesRequested, discussionEvidence),
    approved: evidenceList(value.approved, reviewerEvidence), requested: evidenceList(value.requested, reviewerEvidence), checksPassed: evidenceList(value.checksPassed, checkEvidence),
    checksFailed: evidenceList(value.checksFailed, checkEvidence), checksPending: evidenceList(value.checksPending, checkEvidence) };
  if (new TextEncoder().encode(JSON.stringify(evidence)).byteLength > PULL_REQUEST_INSPECT_EVIDENCE_LIMITS.responseBytes) invalid();
  return Object.freeze(evidence);
}
export function parsePullRequestInspectDetailV1(input: unknown, query: PullRequestInspectDetailQueryV1): PullRequestInspectDetailV1 {
  const value = record(input); const selected = target(value.target, query); const checks = record(value.checks); const reviews = record(value.reviews);
  const checkQuality = quality(checks.quality); const reviewQuality = quality(reviews.quality);
  if (value.version !== 1 || !['open', 'closed', 'merged'].includes(value.status as string) || typeof value.draft !== 'boolean'
    || value.isOwnPr !== null && typeof value.isOwnPr !== 'boolean') invalid();
  const url = text(value.url, 2048); let parsed: URL; try { parsed = new URL(url); } catch { return invalid(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) invalid();
  const authorLogin = value.authorLogin === null ? null : text(value.authorLogin, 128);
  if (authorLogin === null && value.isOwnPr !== null) invalid();
  if (reviews.viewerReview !== null && !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(reviews.viewerReview as string)) invalid();
  const viewerReviewedAt = reviews.viewerReviewedAt === null ? null : date(reviews.viewerReviewedAt);
  const viewerReviewedCommitId = reviews.viewerReviewedCommitId === null ? null : sha(reviews.viewerReviewedCommitId);
  if (reviewQuality !== 'complete' && (reviews.viewerReview !== null || viewerReviewedAt !== null || viewerReviewedCommitId !== null)) invalid();
  return bounded({ version: 1, target: selected, observedAt: date(value.observedAt), title: text(value.title, 2048), url,
    status: value.status as PullRequestInspectDetailV1['status'], draft: value.draft, authorLogin, isOwnPr: value.isOwnPr as boolean | null,
    headRefName: text(value.headRefName, 1024), updatedAt: date(value.updatedAt), comments: value.comments === null ? null : count(value.comments),
    checks: Object.freeze({ quality: checkQuality, passed: knownCount(checks.passed, checkQuality === 'complete'), failed: knownCount(checks.failed, checkQuality === 'complete'), pending: knownCount(checks.pending, checkQuality === 'complete') }),
    ...(Object.hasOwn(value, 'evidence') ? { evidence: inspectEvidence(value.evidence) } : {}),
    reviews: Object.freeze({ quality: reviewQuality, approved: knownCount(reviews.approved, reviewQuality === 'complete'), changesRequested: knownCount(reviews.changesRequested, reviewQuality === 'complete'),
      commented: knownCount(reviews.commented, reviewQuality === 'complete'), requested: knownCount(reviews.requested, reviewQuality === 'complete'), viewerReview: reviews.viewerReview as PullRequestInspectReviewV1 | null,
      viewerReviewedAt, viewerReviewedCommitId }) });
}
export function parsePullRequestInspectDiffV1(input: unknown, query: PullRequestInspectDiffQueryV1): PullRequestInspectDiffV1 {
  const value = record(input);
  if (value.version !== 1 || value.coverage !== 'immutable-comparison-preview' || !['complete', 'partial'].includes(value.quality as string)
    || typeof value.truncated !== 'boolean' || (value.quality === 'partial') !== value.truncated || !Array.isArray(value.files) || value.files.length > PULL_REQUEST_INSPECT_LIMITS.files) invalid();
  let patchLength = 0; const names = new Set<string>();
  const files = Array.from({ length: value.files.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value.files, index); if (!descriptor || !('value' in descriptor)) invalid();
    const item = record(descriptor.value); const filename = text(item.filename, 1024); if (names.has(filename)) invalid(); names.add(filename);
    if (!['preview', 'truncated', 'unavailable'].includes(item.patchStatus as string) || (item.patchStatus === 'unavailable') !== (item.patch === null)) invalid();
    const patch = item.patch === null ? null : text(item.patch, PULL_REQUEST_INSPECT_LIMITS.patch, true); patchLength += patch?.length ?? 0;
    if (patchLength > PULL_REQUEST_INSPECT_LIMITS.patches) invalid();
    return Object.freeze({ filename, previousFilename: item.previousFilename === null ? null : text(item.previousFilename, 1024), status: text(item.status, 64),
      additions: count(item.additions), deletions: count(item.deletions), patch, patchStatus: item.patchStatus as PullRequestInspectFileV1['patchStatus'] });
  });
  return bounded({ version: 1, target: target(value.target, query.target), observedAt: date(value.observedAt), coverage: 'immutable-comparison-preview',
    quality: value.quality as PullRequestInspectDiffV1['quality'], truncated: value.truncated, files: Object.freeze(files) });
}
