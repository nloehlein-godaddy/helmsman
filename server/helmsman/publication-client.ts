import { isContributionId } from '../../src/plugins/manifest';

export interface PrePrPublicationConnection { url: string; token: string; }
export interface PublicationApproval {
  baseSha: string;
  headSha: string;
  branch: string;
  baseBranch: string;
  round: number;
  reviewers: readonly string[];
  metadata: { stage: 'implement' | 'fix'; round: number };
}
export interface PublicationRequest { version: 1; kind: 'pre-pr'; approved: PublicationApproval; }
export interface PublicationResponse { ok: true; prNumber: number; }

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const sha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(value);
const branch = (value: unknown): value is string => typeof value === 'string' && value.length <= 255 && /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(value)
  && !value.includes('..') && !value.endsWith('/') && !value.endsWith('.lock') && !value.includes('//');
const provider = (value: unknown): value is string => typeof value === 'string' && (value === 'codex' || value === 'claude-code'
  || isContributionId(value));

export function parsePublicationRequest(input: unknown): PublicationRequest {
  const value = object(input);
  const approved = object(value?.approved);
  const metadata = object(approved?.metadata);
  if (!value || Object.keys(value).some(key => !['version', 'kind', 'approved'].includes(key)) || value.version !== 1 || value.kind !== 'pre-pr'
    || !approved || Object.keys(approved).some(key => !['baseSha', 'headSha', 'branch', 'baseBranch', 'round', 'reviewers', 'metadata'].includes(key))
    || !sha(approved.baseSha) || !sha(approved.headSha) || approved.baseSha === approved.headSha || !branch(approved.branch) || !branch(approved.baseBranch)
    || !Number.isSafeInteger(approved.round) || Number(approved.round) < 1 || Number(approved.round) > 5
    || !Array.isArray(approved.reviewers) || approved.reviewers.length < 1 || approved.reviewers.length > 8
    || new Set(approved.reviewers).size !== approved.reviewers.length || approved.reviewers.some(id => !provider(id))
    || !metadata || Object.keys(metadata).some(key => !['stage', 'round'].includes(key)) || !['implement', 'fix'].includes(String(metadata.stage))
    || !Number.isSafeInteger(metadata.round) || Number(metadata.round) < 0 || Number(metadata.round) >= Number(approved.round)
    || metadata.stage === 'implement' && metadata.round !== 0 || metadata.stage === 'fix' && metadata.round === 0) throw new Error('Invalid approved publication request');
  return Object.freeze({ version: 1, kind: 'pre-pr', approved: Object.freeze({ baseSha: approved.baseSha, headSha: approved.headSha,
    branch: approved.branch, baseBranch: approved.baseBranch, round: Number(approved.round),
    reviewers: Object.freeze([...approved.reviewers]) as PublicationApproval['reviewers'],
    metadata: Object.freeze({ stage: metadata.stage as 'implement' | 'fix', round: Number(metadata.round) }) }) });
}

export function validatePublicationConnection(value: unknown): PrePrPublicationConnection {
  const connection = object(value);
  if (!connection || typeof connection.url !== 'string' || typeof connection.token !== 'string' || !/^[a-f\d]{64}$/.test(connection.token)) throw new Error('A coordinator publication capability is required');
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/publication/v1' || url.username || url.password || url.search || url.hash) throw new Error('Publication endpoint must be the local core gateway');
  return Object.freeze({ url: url.href, token: connection.token });
}

export async function publishApprovedRevision(connection: PrePrPublicationConnection, input: PublicationRequest, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<number> {
  const destination = validatePublicationConnection(connection);
  const request = parsePublicationRequest(input);
  const response = await fetcher(destination.url, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${destination.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
  const body = object(await response.json().catch(() => null));
  if (!response.ok || body?.ok !== true || typeof body.prNumber !== 'number' || !Number.isSafeInteger(body.prNumber) || body.prNumber < 1) {
    throw new Error('Core publication is incomplete; its durable operation must be reconciled before retrying.');
  }
  return body.prNumber;
}
