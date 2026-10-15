import {
  PULL_REQUEST_INSPECT_EVIDENCE_LIMITS, type PullRequestInspectEvidenceV1, type PullRequestInspectEvidenceListV1, type PullRequestInspectDiscussionEvidenceV1, type PullRequestInspectCheckEvidenceV1, type PullRequestInspectReviewerEvidenceV1,
  PULL_REQUEST_INSPECT_LIMITS, parsePullRequestInspectDetailQueryV1, parsePullRequestInspectDetailV1, parsePullRequestInspectDiffQueryV1, parsePullRequestInspectDiffV1,
  parsePullRequestInspectTargetV1, parsePullRequestReadItemV1, parsePullRequestReadQueryV1, type PullRequestInspectDetailV1, type PullRequestInspectFileV1,
  type PullRequestInspectQualityV1, type PullRequestInspectReviewV1, type PullRequestInspectTargetV1, type PullRequestProviderContextV1, type PullRequestProviderV1,
  formatPullRequestReviewBody,
  PULL_REQUEST_FEEDBACK_LIMITS, parsePullRequestFeedbackSnapshotV1, fingerprintPullRequestFeedbackSnapshotV1,
  type PullRequestInspectDetailQueryV1, type PullRequestFeedbackSnapshotV1,
} from '@helmsman/plugin-sdk';

const api = 'https://api.github.com';
const sha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value);
const text = (value: unknown, maximum = 2048): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const array = (value: unknown, maximum: number): readonly unknown[] | null => Array.isArray(value) && value.length <= maximum ? value : null;
const unavailable = (reason: string) => ({ status: 'unknown' as const, reason, evidence: { code: 'github-unconfirmed' } });
const unknownChecks = (quality: PullRequestInspectQualityV1): PullRequestInspectDetailV1['checks'] => ({ quality, passed: null, failed: null, pending: null });
const unknownReviews = (quality: PullRequestInspectQualityV1): PullRequestInspectDetailV1['reviews'] => ({ quality, approved: null, changesRequested: null, commented: null, requested: null, viewerReview: null, viewerReviewedAt: null, viewerReviewedCommitId: null });
const listReviewConcurrency = 4;
const authoredRepositoryLimit = 8;
const listFeedbackLimit = 50;
const listEnrichmentTimeoutMs = 15_000;
const directListPageSize = 25;
const teamMembershipTimeoutMs = 3_000;

function inspectionFailure(reason: 'head-changed'): Error & { reason: 'head-changed' } {
  return Object.assign(new Error(reason), { reason });
}

function same(first: PullRequestInspectTargetV1, second: PullRequestInspectTargetV1): boolean {
  return first.repo === second.repo && first.number === second.number && first.headSha === second.headSha && first.baseSha === second.baseSha;
}

function configuredAuthor(context: PullRequestProviderContextV1): string {
  if (!text(context.configuredAuthor, 128)) throw new Error('Configured GitHub author is unavailable');
  return context.configuredAuthor;
}

function nextPage(link: string | undefined, path: string, query: Readonly<Record<string, string>>, page: number, canonicalPath?: string): boolean {
  if (!link) return false;
  let found = false;
  for (const entry of link.split(',')) {
    if (!/\brel\s*=\s*"?next\b/.test(entry)) continue;
    const match = entry.match(/^\s*<([^>]+)>;\s*rel="next"\s*$/);
    if (!match || found) throw new Error('Invalid GitHub pagination link');
    let value: URL;
    try { value = new URL(match[1]!); } catch { throw new Error('Invalid GitHub pagination link'); }
    if (value.origin !== api || value.pathname !== path && value.pathname !== canonicalPath || value.username || value.password || value.hash || value.searchParams.get('page') !== String(page + 1)
      || [...value.searchParams.keys()].some(key => key !== 'page' && !(key in query))
      || Object.entries(query).some(([key, expected]) => value.searchParams.get(key) !== expected)) throw new Error('Invalid GitHub pagination link');
    found = true;
  }
  return found;
}

function validateFeedbackPagination(link: string | undefined, path: string): void {
  if (link === undefined) return;
  if (typeof link !== 'string' || !link) throw new Error('Invalid GitHub feedback pagination');
  const relations = new Set<string>();
  for (const entry of link.split(',')) {
    const match = entry.match(/^\s*<([^>]+)>;\s*rel="(first|prev|next|last)"\s*$/);
    if (!match || relations.has(match[2]!)) throw new Error('Invalid GitHub feedback pagination');
    relations.add(match[2]!);
    const url = new URL(match[1]!);
    if (url.origin !== api || url.pathname !== path || url.username || url.password || url.hash
      || url.searchParams.size !== 2 || url.searchParams.getAll('page').length !== 1
      || url.searchParams.getAll('per_page').length !== 1 || url.searchParams.get('per_page') !== '100'
      || !/^[1-9]\d*$/.test(url.searchParams.get('page') ?? '')) throw new Error('Invalid GitHub feedback pagination');
  }
}

async function request(context: PullRequestProviderContextV1, method: 'GET' | 'POST', path: string, query: Record<string, string> = {}, body: unknown | null = null) {
  context.signal.throwIfAborted();
  const response = await context.http.request({ method, path, query, body });
  context.signal.throwIfAborted();
  if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new Error('Malformed GitHub response');
  return response;
}

async function collection(context: PullRequestProviderContextV1, path: string, query: Readonly<Record<string, string>>, options: { key?: string; expectedSha?: string; pages?: number; completeEvidence?: boolean } = {}): Promise<{ quality: 'complete' | 'partial'; items: unknown[] }> {
  const { key, expectedSha, pages = PULL_REQUEST_INSPECT_LIMITS.pages } = options;
  const items: unknown[] = []; let total: number | null = null;
  for (let page = 1; page <= pages; page++) {
    const response = await request(context, 'GET', path, { ...query, per_page: String(PULL_REQUEST_INSPECT_LIMITS.page), page: String(page) });
    if (response.status !== 200) throw new Error('GitHub collection is unavailable');
    const data = key ? object(response.body) : null;
    const values = key ? data?.[key] : response.body;
    if (expectedSha && data?.sha !== expectedSha) throw new Error('GitHub collection has a different revision');
    if (!Array.isArray(values) || values.length > PULL_REQUEST_INSPECT_LIMITS.page) throw new Error('Invalid GitHub collection');
    if (key) {
      const count = data?.total_count;
      if (!integer(count) || total !== null && count !== total) return { quality: 'partial', items: [] };
      total = count;
      if (data?.incomplete_results === true) return { quality: 'partial', items: [] };
      if (data?.incomplete_results !== undefined && data?.incomplete_results !== false) throw new Error('Invalid GitHub collection completeness');
    }
    items.push(...values);
    if (options.completeEvidence) validateFeedbackPagination(response.link, path);
    const next = nextPage(response.link, path, { ...query, per_page: String(PULL_REQUEST_INSPECT_LIMITS.page) }, page);
    if (!next) {
      if (total !== null && total !== items.length) return { quality: 'partial', items: [] };
      if (values.length < PULL_REQUEST_INSPECT_LIMITS.page || total !== null) return { quality: 'complete', items };
      if (page === pages) return { quality: 'partial', items: [] };
      continue;
    }
    if (!values.length) throw new Error('Invalid GitHub pagination');
  }
  return { quality: 'partial', items: [] };
}

type RecentCollection = { quality: 'complete' | 'partial' | 'degraded'; items: unknown[]; failed?: boolean; sso?: 'partial' | 'required' };

async function recentCollection(context: PullRequestProviderContextV1, path: string, query: Readonly<Record<string, string>>, limit: number,
  options: { key?: string; pageSize?: number; pages?: number; accept?(value: unknown): boolean } = {}): Promise<RecentCollection> {
  const items: unknown[] = [];
  let sso: RecentCollection['sso'];
  const result = (value: RecentCollection): RecentCollection => ({ ...value,
    ...(sso ? { sso, quality: value.quality === 'complete' ? 'partial' : value.quality } : {}) });
  const pageSize = options.pageSize ?? PULL_REQUEST_INSPECT_LIMITS.page;
  const pages = options.pages ?? PULL_REQUEST_INSPECT_LIMITS.pages;
  let total: number | null = null;
  let after: string | null = null; let canonicalPath: string | undefined; const cursors = new Set<string>();
  for (let page = 1; page <= pages; page++) {
    try {
      const pagination = { ...query, per_page: String(pageSize), page: String(page), ...(after ? { after } : {}) };
      const response = await request(context, 'GET', path, pagination);
      if (response.sso && sso !== 'required') sso = response.sso;
      if (response.status !== 200) throw new Error('Recent GitHub collection is unavailable');
      const data = options.key ? object(response.body) : null;
      const values = options.key ? data?.[options.key] : response.body;
      if (!Array.isArray(values) || values.length > pageSize) throw new Error('Invalid recent GitHub collection');
      items.push(...(options.accept ? values.filter(options.accept) : values));
      if (options.key) {
        const count = data?.total_count;
        if (!integer(count) || total !== null && count !== total || data?.incomplete_results === true) return result({ quality: 'partial', items });
        if (data?.incomplete_results !== undefined && data.incomplete_results !== false) throw new Error('Invalid GitHub collection completeness');
        total = count;
      }
      const requestedRepo = /^\/repos\/([^/]+\/[^/]+)\/(pulls|issues)$/.exec(path)?.[1];
      const baseRepo = (value: unknown) => object(object(object(value)?.base)?.repo);
      const repositoryId = baseRepo(values[0])?.id;
      if (requestedRepo && path.endsWith('/pulls') && positive(repositoryId) && values.every(value => baseRepo(value)?.id === repositoryId && baseRepo(value)?.full_name === requestedRepo)) canonicalPath = `/repositories/${repositoryId}/pulls`;
      if (requestedRepo && path.endsWith('/issues') && !canonicalPath && response.link?.includes('/repositories/')) {
        const repository = await request(context, 'GET', `/repos/${requestedRepo}`); const identity = object(repository.body);
        if (repository.status !== 200 || !positive(identity?.id) || identity?.full_name !== requestedRepo) throw new Error('Unconfirmed GitHub repository identity');
        canonicalPath = `/repositories/${identity.id}/issues`;
      }
      const next = recentNextPage(response.link, path, { ...query, per_page: String(pageSize) }, page, canonicalPath);
      if (next?.after && cursors.has(next.after)) throw new Error('Repeated GitHub pagination cursor');
      if (next?.after) cursors.add(next.after);
      after = next?.after ?? null;
      const more = next || (total !== null ? total > page * pageSize : values.length === pageSize);
      if (items.length >= limit) return result({ quality: more || items.length > limit ? 'partial' : 'complete', items });
      if (!next && (values.length < pageSize || total !== null)) {
        return result({ quality: total !== null && total > page * pageSize ? 'partial' : 'complete', items });
      }
    } catch {
      context.signal.throwIfAborted();
      return result({ quality: items.length ? 'partial' : 'degraded', items, failed: true });
    }
  }
  return result({ quality: 'partial', items });
}

function recentNextPage(link: string | undefined, path: string, query: Readonly<Record<string,string>>, page: number, canonicalPath?: string): { after: string | null } | null {
  if (!link) return null;
  const entries = link.split(',').filter(entry => /\brel\s*=\s*"?next\b/.test(entry));
  if (!entries.length) return null;
  if (entries.length !== 1) throw new Error('Invalid GitHub pagination link');
  const match = entries[0]?.match(/^\s*<([^>]+)>;\s*rel="next"\s*$/);
  if (!match) throw new Error('Invalid GitHub pagination link');
  const value = new URL(match[1]!);const after = value.searchParams.get('after');
  if (value.origin !== api || value.pathname !== path && value.pathname !== canonicalPath || value.username || value.password || value.hash || value.searchParams.get('page') !== String(page + 1)
    || [...value.searchParams.keys()].some(key => value.searchParams.getAll(key).length !== 1 || key !== 'page' && key !== 'after' && !(key in query))
    || Object.entries(query).some(([key,expected]) => value.searchParams.get(key) !== expected)
    || after !== null && (!path.endsWith('/issues') || !after || after.length > 2048 || !/^[A-Za-z\d+/_=:-]+$/.test(after))) throw new Error('Invalid GitHub pagination link');
  return { after };
}

async function metadata(query: { repo: string; number: number }, context: PullRequestProviderContextV1) {
  const response = await request(context, 'GET', `/repos/${query.repo}/pulls/${query.number}`);
  const raw = object(response.body); const base = object(raw?.base); const head = object(raw?.head); const baseRepo = object(base?.repo);
  if (response.status !== 200 || !raw || raw.number !== query.number || baseRepo?.full_name !== query.repo || !['open', 'closed'].includes(String(raw.state))
    || typeof raw.draft !== 'boolean' || typeof raw.merged !== 'boolean' || raw.merged === true && raw.state !== 'closed' || !sha(base?.sha) || !sha(head?.sha)
    || !text(head?.ref, 1024) || !text(raw.title) || !text(raw.html_url) || raw.html_url !== `https://github.com/${query.repo}/pull/${query.number}`
    || !text(raw.updated_at, 64) || !Number.isFinite(Date.parse(raw.updated_at))) throw new Error('Invalid GitHub pull request response');
  const author = raw.user === null ? null : object(raw.user)?.login;
  if (author !== null && !text(author, 128)) throw new Error('Invalid GitHub pull request author');
  return { raw, target: parsePullRequestInspectTargetV1({ repo: query.repo, number: query.number, headSha: head.sha, baseSha: base.sha }), title: raw.title,
    url: raw.html_url, status: raw.merged ? 'merged' as const : raw.state as 'open' | 'closed', draft: raw.draft, authorLogin: author,
    isOwnPr: author === null ? null : author.toLowerCase() === configuredAuthor(context).trim().toLowerCase(), headRefName: head.ref, updatedAt: raw.updated_at,
    comments: raw.comments === undefined || raw.comments === null ? null : integer(raw.comments) ? raw.comments : (() => { throw new Error('Invalid GitHub comment count'); })() };
}

function feedbackUrl(value: unknown, query: { repo: string; number: number }): string {
  if (!text(value)) throw new Error('Invalid GitHub feedback URL');
  const url = new URL(value); const expected = `/${query.repo}/pull/${query.number}`.toLowerCase();
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search
    || ![expected, `${expected}/files`].includes(url.pathname.toLowerCase())) throw new Error('GitHub feedback URL does not match this PR');
  return value;
}

async function feedbackMetadata(query: PullRequestInspectDetailQueryV1, context: PullRequestProviderContextV1): Promise<PullRequestFeedbackSnapshotV1> {
  const response = await request(context, 'GET', `/repos/${query.repo}/pulls/${query.number}`);
  const raw = object(response.body); const base = object(raw?.base); const head = object(raw?.head);
  const fullName = object(base?.repo)?.full_name;
  if (response.status !== 200 || !raw || raw.number !== query.number || typeof fullName !== 'string'
    || fullName.toLowerCase() !== query.repo.toLowerCase() || typeof raw.state !== 'string' || !['open', 'closed'].includes(raw.state)
    || typeof raw.merged !== 'boolean' || raw.merged && raw.state !== 'closed') throw new Error('Invalid GitHub feedback PR metadata');
  return parsePullRequestFeedbackSnapshotV1({ version: 1, quality: 'complete', repo: query.repo, prNumber: query.number,
    headSha: head?.sha, baseSha: base?.sha, headBranch: head?.ref, baseBranch: base?.ref,
    state: raw.merged ? 'MERGED' : raw.state === 'open' ? 'OPEN' : 'CLOSED',
    sources: [{ id: `description:${query.number}`, kind: 'description', url: feedbackUrl(raw.html_url, query),
      body: raw.body === null ? '' : raw.body, updatedAt: raw.updated_at }], fingerprint: '0'.repeat(64) }, query);
}

function feedbackSources(items: readonly unknown[], kind: 'review' | 'comment' | 'inline', query: PullRequestInspectDetailQueryV1, updatedAt: string) {
  return items.map(value => {
    const item = object(value);
    if (!item || !positive(item.id)) throw new Error('Invalid GitHub feedback source');
    const source = { id: `${kind}:${item.id}`, kind, url: feedbackUrl(item.html_url, query), body: item.body };
    if (kind === 'review') {
      // REST reviews have no edit timestamp; their complete body and state are fingerprinted.
      return { ...source, state: item.state, submittedAt: item.submitted_at,
        updatedAt: item.updated_at === undefined ? item.submitted_at ?? updatedAt : item.updated_at };
    }
    if (kind === 'inline' && item.in_reply_to_id !== undefined && item.in_reply_to_id !== null) {
      if (!positive(item.in_reply_to_id)) throw new Error('Invalid GitHub inline reply ID');
      return { ...source, updatedAt: item.updated_at, replyTo: `inline:${item.in_reply_to_id}` };
    }
    return { ...source, updatedAt: item.updated_at };
  });
}

function evidenceList<T extends { id: string }>(values: readonly unknown[], listQuality: PullRequestInspectQualityV1, parse: (value: unknown) => T): PullRequestInspectEvidenceListV1<T> {
  if (listQuality === 'unavailable') return { quality: 'unavailable', truncated: false, items: [] };
  const items: T[] = []; const ids = new Set<string>(); let malformed = false;
  for (const value of values.slice(0, PULL_REQUEST_INSPECT_EVIDENCE_LIMITS.items)) {
    try { const item = parse(value); if (ids.has(item.id)) throw new Error('Duplicate evidence'); ids.add(item.id); items.push(item); }
    catch { malformed = true; }
  }
  const truncated = values.length > PULL_REQUEST_INSPECT_EVIDENCE_LIMITS.items || listQuality === 'partial';
  return { quality: malformed || truncated ? 'partial' : 'complete', truncated, items };
}
function evidenceUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!text(value)) throw new Error('Invalid evidence URL');
  const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid evidence URL');
  return value;
}
function discussionEvidence(value: unknown, kind: 'comment' | 'review', target: PullRequestInspectTargetV1): PullRequestInspectDiscussionEvidenceV1 {
  const item = object(value); const login = item?.user === null ? null : object(item?.user)?.login;
  const createdAt = kind === 'review' ? item?.submitted_at : item?.created_at;
  if (!positive(item?.id) || login !== null && !text(login, 128) || !text(createdAt, 64) || !Number.isFinite(Date.parse(createdAt))
    || typeof item?.body !== 'string' && item?.body !== null) throw new Error('Invalid discussion evidence');
  const sourceBody = item.body ?? ''; let body = ''; let bytes = 0;
  for (const char of sourceBody) { const point = char.codePointAt(0) ?? 0; const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; if (bytes + size > PULL_REQUEST_INSPECT_EVIDENCE_LIMITS.bodyBytes) break; body += char; bytes += size; }
  if (body.includes('\0')) throw new Error('Invalid discussion body');
  return { id: `${kind}:${item.id}`, author: login, body, bodyTruncated: body.length !== sourceBody.length,
    url: item.html_url === undefined || item.html_url === null ? null : feedbackUrl(item.html_url, target), createdAt };
}
function checkEvidence(value: unknown, kind: 'check' | 'status'): PullRequestInspectCheckEvidenceV1 {
  const item = object(value); const name = kind === 'check' ? item?.name : item?.context;
  if (!positive(item?.id) || !text(name)) throw new Error('Invalid check evidence');
  return { id: `${kind}:${item.id}`, name, url: evidenceUrl(kind === 'check' ? item.html_url : item.target_url) };
}
function reviewerEvidence(review: Review): PullRequestInspectReviewerEvidenceV1 { return { id: `user:${review.login}`, label: review.login, url: `https://github.com/${encodeURIComponent(review.login)}` }; }
function requestedEvidence(raw: Record<string, unknown>): PullRequestInspectEvidenceListV1<PullRequestInspectReviewerEvidenceV1> {
  if (requestedReviewCount(raw) === null) return evidenceList([], 'unavailable', () => { throw new Error('Invalid reviewer'); });
  const users = (raw.requested_reviewers as unknown[]).map(value => ({ kind: 'user', value }));
  const teams = (raw.requested_teams as unknown[]).map(value => ({ kind: 'team', value }));
  const seen = new Set<string>();
  const items = [...users, ...teams].flatMap(({ kind, value }) => {
    const item = object(value); const label = String(kind === 'user' ? item?.login : item?.slug).toLowerCase(); const id = `${kind}:${label}`;
    if (seen.has(id)) return []; seen.add(id);
    return [{ id, label: kind === 'user' ? label : `team:${label}`, url: kind === 'user' ? `https://github.com/${encodeURIComponent(label)}` : null }];
  });
  return evidenceList(items, 'complete', value => value as PullRequestInspectReviewerEvidenceV1);
}
function boundEvidence(evidence: PullRequestInspectEvidenceV1): PullRequestInspectEvidenceV1 {
  let bytes = 4096;
  return Object.fromEntries(Object.entries(evidence).map(([key, list]) => {
    const items = [];
    for (const item of list.items) { const size = new TextEncoder().encode(JSON.stringify(item)).byteLength + 1; if (bytes + size > PULL_REQUEST_INSPECT_EVIDENCE_LIMITS.responseBytes) break; bytes += size; items.push(item); }
    return [key, items.length === list.items.length ? list : { ...list, quality: 'partial', truncated: true, items }];
  })) as unknown as PullRequestInspectEvidenceV1;
}
async function discussionComments(target: PullRequestInspectTargetV1, expectedCount: number | null, context: PullRequestProviderContextV1): Promise<PullRequestInspectEvidenceV1['comments']> {
  const result = await recentCollection(context, `/repos/${target.repo}/issues/${target.number}/comments`, {}, PULL_REQUEST_INSPECT_EVIDENCE_LIMITS.items, { pages: 1 });
  const list = evidenceList(result.items, result.quality === 'degraded' ? 'unavailable' : result.quality, value => discussionEvidence(value, 'comment', target));
  return list.quality === 'complete' && expectedCount !== null && list.items.length !== expectedCount ? { ...list, quality: 'partial' } : list;
}

async function checks(target: PullRequestInspectTargetV1, context: PullRequestProviderContextV1): Promise<{ counts: PullRequestInspectDetailV1['checks']; evidence: Pick<PullRequestInspectEvidenceV1, 'checksPassed' | 'checksFailed' | 'checksPending'> }> {
  const unknown = (quality: PullRequestInspectQualityV1) => ({ counts: unknownChecks(quality), evidence: { checksPassed: evidenceList([], quality, value => value as PullRequestInspectCheckEvidenceV1), checksFailed: evidenceList([], quality, value => value as PullRequestInspectCheckEvidenceV1), checksPending: evidenceList([], quality, value => value as PullRequestInspectCheckEvidenceV1) } });
  try {
    const [runs, statuses] = await Promise.all([
      collection(context, `/repos/${target.repo}/commits/${target.headSha}/check-runs`, {}, { key: 'check_runs' }),
      collection(context, `/repos/${target.repo}/commits/${target.headSha}/status`, {}, { key: 'statuses', expectedSha: target.headSha }),
    ]);
    if (runs.quality !== 'complete' || statuses.quality !== 'complete') return unknown('partial');
    const evidence: { passed: unknown[]; failed: unknown[]; pending: unknown[] } = { passed: [], failed: [], pending: [] };
    let passed = 0; let failed = 0; let pending = 0; const ids = new Set<number>();
    for (const item of runs.items) {
      const run = object(item); const id = run?.id;
      if (!run || !positive(id) || ids.has(id) || run.head_sha !== target.headSha || !['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(String(run.status))) throw new Error('Invalid GitHub check run');
      ids.add(id);
      if (run.status !== 'completed' || run.conclusion === null) { pending++; evidence.pending.push({ value: run, kind: 'check' }); }
      else if (['success', 'neutral', 'skipped'].includes(String(run.conclusion))) { passed++; evidence.passed.push({ value: run, kind: 'check' }); }
      else if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(String(run.conclusion))) { failed++; evidence.failed.push({ value: run, kind: 'check' }); }
      else throw new Error('Invalid GitHub check conclusion');
    }
    const contexts = new Map<string, { id: number; state: string; updatedAt: string }>();
    for (const item of statuses.items) {
      const status = object(item); const id = status?.id; const name = status?.context; const state = status?.state; const updatedAt = status?.updated_at;
      if (!positive(id) || !text(name) || !text(state, 32) || !text(updatedAt, 64) || !Number.isFinite(Date.parse(updatedAt)) || !['success', 'failure', 'error', 'pending'].includes(state)) throw new Error('Invalid GitHub status');
      const prior = contexts.get(name);
      if (!prior || Date.parse(updatedAt) > Date.parse(prior.updatedAt) || updatedAt === prior.updatedAt && id > prior.id) contexts.set(name, { id, state, updatedAt });
    }
    if (contexts.size !== statuses.items.length) return unknown('partial');
    for (const status of contexts.values()) {
      const value = statuses.items.find(item => object(item)?.id === status.id);
      if (status.state === 'success') { passed++; evidence.passed.push({ value, kind: 'status' }); }
      else if (status.state === 'pending') { pending++; evidence.pending.push({ value, kind: 'status' }); }
      else { failed++; evidence.failed.push({ value, kind: 'status' }); }
    }
    const parse = (value: unknown) => { const item = object(value); return checkEvidence(item?.value, item?.kind === 'check' ? 'check' : 'status'); };
    return { counts: { quality: 'complete', passed, failed, pending }, evidence: { checksPassed: evidenceList(evidence.passed, 'complete', parse), checksFailed: evidenceList(evidence.failed, 'complete', parse), checksPending: evidenceList(evidence.pending, 'complete', parse) } };
  } catch { context.signal.throwIfAborted(); return unknown('unavailable'); }
}

type Review = { id: number; login: string; state: PullRequestInspectReviewV1; at: string; commit: string };

function submittedReviews(items: readonly unknown[]): Review[] {
  const submitted: Review[] = []; const ids = new Set<number>();
  for (const item of items) {
    const review = object(item); const id = review?.id;
    if (!review || !positive(id) || ids.has(id)) throw new Error('Invalid GitHub review'); ids.add(id);
    if (review.state === 'PENDING') continue;
    const login = object(review.user)?.login; const at = review.submitted_at; const commit = review.commit_id;
    if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(String(review.state)) || !text(login, 128) || !text(at, 64) || !Number.isFinite(Date.parse(at)) || !sha(commit)) throw new Error('Invalid GitHub review');
    submitted.push({ id, login: login.toLowerCase(), state: review.state as PullRequestInspectReviewV1, at, commit });
  }
  return submitted.sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id - right.id);
}

function effectiveReviews(submitted: readonly Review[]): readonly Review[] {
  const effective = new Map<string, Review>();
  for (const review of submitted) {
    const prior = effective.get(review.login);
    if (!prior || review.state !== 'COMMENTED' || prior.state === 'COMMENTED') effective.set(review.login, review);
  }
  return [...effective.values()];
}

function requestedReviewCount(raw: Record<string, unknown> | null): number | null {
  const users = raw?.requested_reviewers; const teams = raw?.requested_teams;
  if (!Array.isArray(users) || !Array.isArray(teams)) return null;
  const reviewers = new Set<string>(); const requestedTeams = new Set<string>();
  for (const user of users) {
    const login = object(user)?.login;
    if (!text(login, 128)) return null;
    reviewers.add(login.toLowerCase());
  }
  for (const team of teams) {
    const slug = object(team)?.slug;
    if (!text(slug, 128)) return null;
    requestedTeams.add(slug.toLowerCase());
  }
  return reviewers.size + requestedTeams.size;
}

type RequestedTeamMemberships = { ids: ReadonlySet<number>; quality: 'complete' | 'partial' | 'degraded'; sso?: 'partial' | 'required' };

async function requestedTeamMemberships(author: string, context: PullRequestProviderContextV1): Promise<RequestedTeamMemberships> {
  let sso: RequestedTeamMemberships['sso'];
  const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), teamMembershipTimeoutMs);
  const signal = AbortSignal.any([context.signal, deadline.signal]);
  const boundedContext = { ...context, http: { request: async (input: Parameters<typeof context.http.request>[0]) => {
    signal.throwIfAborted();
    return new Promise<Awaited<ReturnType<typeof context.http.request>>>((resolve, reject) => {
      const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      void context.http.request(input).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  } } };
  try {
    const identity = await request(boundedContext, 'GET', '/user');
    sso = identity.sso;
    const login = object(identity.body)?.login;
    if (identity.status !== 200 || !text(login, 128) || login.toLowerCase() !== author.trim().toLowerCase()) throw new Error('Authenticated review identity is unavailable');
    const teams = await recentCollection(boundedContext, '/user/teams', {}, 301);
    sso = teams.sso ?? sso;
    const ids = new Set<number>(); let malformed = false;
    for (const value of teams.items) {
      const id = object(value)?.id;
      if (!positive(id)) { malformed = true; continue; }
      if (ids.has(id)) malformed = true;
      ids.add(id);
    }
    return { ids, quality: (malformed || sso) && teams.quality === 'complete' ? 'partial' : teams.quality, ...(sso ? { sso } : {}) };
  } catch {
    context.signal.throwIfAborted();
    return { ids: new Set(), quality: 'degraded', ...(sso ? { sso } : {}) };
  } finally { clearTimeout(timer); }
}

function requestedBy(value: unknown, author: string, memberships: RequestedTeamMemberships): boolean | null {
  const raw = object(value); const requested = raw?.requested_reviewers; const teams = raw?.requested_teams;
  let malformed = !Array.isArray(requested) || !Array.isArray(teams);
  for (const reviewer of Array.isArray(requested) ? requested : []) {
    const login = object(reviewer)?.login;
    if (!text(login, 128)) { malformed = true; continue; }
    if (login.toLowerCase() === author.toLowerCase()) return true;
  }
  for (const team of Array.isArray(teams) ? teams : []) {
    const id = object(team)?.id;
    if (!positive(id)) { malformed = true; continue; }
    if (memberships.ids.has(id)) return true;
  }
  return malformed || Array.isArray(teams) && teams.length > 0 && memberships.quality !== 'complete' ? null : false;
}

async function reviews(target: PullRequestInspectTargetV1, raw: Record<string, unknown>, context: PullRequestProviderContextV1): Promise<{ counts: PullRequestInspectDetailV1['reviews']; evidence: Pick<PullRequestInspectEvidenceV1, 'approved' | 'changesRequested' | 'requested'> }> {
  const requestedList = requestedEvidence(raw);
  const unknown = (quality: PullRequestInspectQualityV1) => ({ counts: unknownReviews(quality), evidence: { approved: evidenceList([], quality, value => value as PullRequestInspectReviewerEvidenceV1), changesRequested: evidenceList([], quality, value => value as PullRequestInspectDiscussionEvidenceV1), requested: requestedList } });
  try {
    const result = await collection(context, `/repos/${target.repo}/pulls/${target.number}/reviews`, {});
    if (result.quality !== 'complete') return unknown(result.quality);
    const requested = requestedReviewCount(raw);
    const submitted = submittedReviews(result.items); const values = effectiveReviews(submitted); let latest: Review | undefined; const author = configuredAuthor(context).trim().toLowerCase();
    for (const review of submitted) {
      if (review.login === author) latest = review;
    }
    const approved = values.filter(value => value.state === 'APPROVED');
    const changesRequested = values.filter(value => value.state === 'CHANGES_REQUESTED');
    const evidence = { approved: evidenceList(approved, 'complete', value => reviewerEvidence(value as Review)), requested: requestedList,
      changesRequested: evidenceList(changesRequested.map(review => result.items.find(value => object(value)?.id === review.id)), 'complete', value => discussionEvidence(value, 'review', target)) };
    if (requested === null) return { evidence, counts: unknownReviews('unavailable') };
    return { evidence, counts: { quality: 'complete', approved: values.filter(value => value.state === 'APPROVED').length, changesRequested: values.filter(value => value.state === 'CHANGES_REQUESTED').length,
      commented: values.filter(value => value.state === 'COMMENTED').length, requested, viewerReview: values.find(value => value.login === author)?.state ?? null,
      viewerReviewedAt: latest?.at ?? null, viewerReviewedCommitId: latest?.commit ?? null } };
  } catch { context.signal.throwIfAborted(); return unknown('unavailable'); }
}

function readItem(value: unknown, fallbackRepo: string, reviewDecision: 'REVIEW_REQUIRED' | null = null) {
  const raw = object(value); const repo = typeof raw?.repository_url === 'string' && raw.repository_url.startsWith(`${api}/repos/`) ? raw.repository_url.slice(`${api}/repos/`.length) : fallbackRepo;
  const mergedAt = (raw?.pull_request ? object(raw.pull_request)?.merged_at : undefined) ?? raw?.merged_at;
  const state = mergedAt ? 'merged' : raw?.state === 'closed' ? 'closed' : 'open';
  return parsePullRequestReadItemV1({ repo, number: raw?.number, title: raw?.title, url: `https://github.com/${repo}/pull/${String(raw?.number)}`,
    status: state, createdAt: raw?.created_at, mergedAt: mergedAt ?? null, draft: typeof raw?.draft === 'boolean' ? raw.draft : null,
    ticketId: null, reviewDecision, comments: integer(raw?.comments) ? raw.comments : null, reviews: null });
}

type ListCandidate = { item: ReturnType<typeof readItem>; requested: number | null };
type ListReviewEvidence = { counts: ReturnType<typeof readItem>['reviews']; items: readonly unknown[] | null };

async function listReviews(item: ReturnType<typeof readItem>, requested: number | null, context: PullRequestProviderContextV1): Promise<ListReviewEvidence> {
  try {
    const result = await collection(context, `/repos/${item.repo}/pulls/${item.number}/reviews`, {});
    if (result.quality !== 'complete') return { counts: null, items: null };
    const values = effectiveReviews(submittedReviews(result.items));
    return { counts: { approved: values.filter(value => value.state === 'APPROVED').length, changesRequested: values.filter(value => value.state === 'CHANGES_REQUESTED').length,
      commented: values.filter(value => value.state === 'COMMENTED').length, requested }, items: result.items };
  } catch {
    context.signal.throwIfAborted();
    return { counts: null, items: null };
  }
}

function newCommentEvidence(items: readonly unknown[], author: string, latestCommitAt: string, kind: 'comment' | 'review'): boolean | null {
  let invalid = false;
  for (const value of items) {
    const item = object(value); const login = object(item?.user)?.login;
    if (kind === 'review' && item?.state === 'PENDING') continue;
    const at = kind === 'review' ? item?.submitted_at : item?.created_at;
    if (!positive(item?.id) || !text(login, 128) || !text(at, 64) || !Number.isFinite(Date.parse(at)) || kind === 'review' && typeof item?.body !== 'string') { invalid = true; continue; }
    if (login.toLowerCase() !== author.toLowerCase() && Date.parse(at) > Date.parse(latestCommitAt) && (kind !== 'review' || (item?.body as string).trim())) return true;
  }
  return invalid ? null : false;
}

async function listFeedback(item: ReturnType<typeof readItem>, evidence: Promise<ListReviewEvidence>, context: PullRequestProviderContextV1): Promise<NonNullable<ReturnType<typeof readItem>['feedback']>> {
  const unknown = { changesRequested: null, newComments: null, latestCommitAt: null };
  try {
    const first = await metadata(item, context);
    if (first.status !== 'open' || !first.authorLogin) return unknown;
    const commit = await request(context, 'GET', `/repos/${item.repo}/commits/${first.target.headSha}`, { per_page: '1' });
    const raw = object(commit.body); const latestCommitAt = object(object(raw?.commit)?.committer)?.date;
    if (commit.status !== 200 || raw?.sha !== first.target.headSha || !text(latestCommitAt, 64) || !Number.isFinite(Date.parse(latestCommitAt))) return unknown;
    const comments = await Promise.all([
      recentCollection(context, `/repos/${item.repo}/issues/${item.number}/comments`, { since: latestCommitAt }, 25, { pageSize: 25, pages: 1 }),
      recentCollection(context, `/repos/${item.repo}/pulls/${item.number}/comments`, { since: latestCommitAt, sort: 'created', direction: 'desc' }, 25, { pageSize: 25, pages: 1 }),
    ]);
    const reviewEvidence = await evidence;
    const last = await metadata(item, context);
    if (!same(first.target, last.target) || first.updatedAt !== last.updatedAt || last.status !== 'open' || first.authorLogin !== last.authorLogin) return unknown;
    const flags = comments.map(result => { const flag = newCommentEvidence(result.items, first.authorLogin!, latestCommitAt, 'comment'); return flag === true ? true : result.quality === 'complete' ? flag : null; });
    flags.push(reviewEvidence.items ? newCommentEvidence(reviewEvidence.items, first.authorLogin, latestCommitAt, 'review') : null);
    return { changesRequested: reviewEvidence.counts?.changesRequested === null || reviewEvidence.counts?.changesRequested === undefined ? null : reviewEvidence.counts.changesRequested > 0,
      newComments: flags.includes(true) ? true : flags.every(flag => flag === false) ? false : null, latestCommitAt };
  } catch { context.signal.throwIfAborted(); return unknown; }
}

async function withListReviews(candidates: readonly ListCandidate[], context: PullRequestProviderContextV1): Promise<ReturnType<typeof readItem>[]> {
  const enriched = candidates.map(candidate => candidate.item); const open = candidates.flatMap((candidate, index) => candidate.item.status === 'open' ? [index] : []); let next = 0;
  const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), listEnrichmentTimeoutMs);
  const signal = AbortSignal.any([context.signal, deadline.signal]);
  const boundedContext = { ...context, http: { request: async (input: Parameters<typeof context.http.request>[0]) => {
    signal.throwIfAborted();
    return new Promise<Awaited<ReturnType<typeof context.http.request>>>((resolve,reject) => {
      const abort = () => reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
      void context.http.request(input).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
  } } };
  try { await Promise.all(Array.from({ length: Math.min(listReviewConcurrency, open.length) }, async () => {
    while (true) {
      context.signal.throwIfAborted();
      const order = next++;const index = open[order]; if (index === undefined) return;
      const candidate = candidates[index]!;
      const evidence = listReviews(candidate.item, candidate.requested, boundedContext);
      const [reviews, feedback] = await Promise.all([evidence, order < listFeedbackLimit ? listFeedback(candidate.item, evidence, boundedContext) : Promise.resolve(null)]);
      enriched[index] = { ...candidate.item, reviews: reviews.counts, feedback: feedback ?? { changesRequested: reviews.counts?.changesRequested == null ? null : reviews.counts.changesRequested > 0, newComments: null, latestCommitAt: null } };
    }
  })); } finally { clearTimeout(timer); }
  return enriched;
}

async function prepared(repo: string, number: number, expectedHeadSha: string | null, context: PullRequestProviderContextV1) {
  const [actorResponse, detailResponse] = await Promise.all([request(context, 'GET', '/user'), request(context, 'GET', `/repos/${repo}/pulls/${number}`)]);
  const actor = object(actorResponse.body); const detail = object(detailResponse.body); const head = object(detail?.head);
  if (actorResponse.status !== 200 || detailResponse.status !== 200 || !text(actor?.login, 128) || !sha(head?.sha) || detail?.state !== 'open' || detail?.merged === true
    || expectedHeadSha !== null && head.sha !== expectedHeadSha) throw new Error('Authenticated review actor or open PR revision is unavailable');
  return Object.freeze({ repo, number, headSha: head.sha, actor: actor.login });
}

export const githubPullRequestProvider: PullRequestProviderV1 = Object.freeze<PullRequestProviderV1>({
  async feedbackSnapshot(input, context) {
    const query = parsePullRequestInspectDetailQueryV1(input);
    const first = await feedbackMetadata(query, context);
    const description = first.sources[0];
    if (!description) throw new Error('Missing GitHub PR description');
    const endpoints = [
      ['review', `/repos/${query.repo}/pulls/${query.number}/reviews`],
      ['comment', `/repos/${query.repo}/issues/${query.number}/comments`],
      ['inline', `/repos/${query.repo}/pulls/${query.number}/comments`],
    ] as const;
    const sources = await Promise.all(endpoints.map(async ([kind, path]) => {
      const result = await collection(context, path, {}, { pages: PULL_REQUEST_FEEDBACK_LIMITS.pages, completeEvidence: true });
      if (result.quality !== 'complete') throw new Error('GitHub feedback pagination is incomplete');
      return feedbackSources(result.items, kind, query, description.updatedAt);
    }));
    const last = await feedbackMetadata(query, context);
    if (JSON.stringify(first) !== JSON.stringify(last)) throw inspectionFailure('head-changed');
    const snapshot = parsePullRequestFeedbackSnapshotV1({ ...first, sources: [description, ...sources.flat()] }, query);
    const fingerprint = await fingerprintPullRequestFeedbackSnapshotV1(snapshot);
    context.signal.throwIfAborted();
    return Object.freeze({ ...snapshot, fingerprint });
  },
  async profile(context) {
    const bounded = (value: unknown, maximum: number): string | null => text(value, maximum) ? value.trim() || null : null;
    try {
      context.signal.throwIfAborted();
      const response = await request(context, 'GET', '/user');
      context.signal.throwIfAborted();
      if (response.status !== 200) return { displayName: null, login: null };
      const data = object(response.body); const login = bounded(data?.login, 128);
      if (!login) return { displayName: null, login: null };
      return { displayName: bounded(data?.name, 256) ?? login, login };
    } catch {
      context.signal.throwIfAborted();
      return { displayName: null, login: null };
    }
  },
  async list(input, context) {
    const query = parsePullRequestReadQueryV1(input.query); const repos = [...new Set(input.repos)]; const author = configuredAuthor(context);
    let memberships: RequestedTeamMemberships = { ids: new Set(), quality: 'complete' };
    const repoPaths = (query.repo === null ? repos : [query.repo]).map(repo => ({ repo, path: `/repos/${repo}/pulls` }));
    const direct = async (repo: string) => recentCollection(context, `/repos/${repo}/pulls`, { state: 'open', sort: 'created', direction: 'desc' }, query.limit,
      { pageSize: directListPageSize, pages: Math.ceil(PULL_REQUEST_INSPECT_LIMITS.page * PULL_REQUEST_INSPECT_LIMITS.pages / directListPageSize),
        ...(query.kind === 'review-requested' ? { accept: (value: unknown) => requestedBy(value, author, memberships) !== false } : {}) });
    let sources: Array<{ repo: string; result: RecentCollection; reviewRequested: boolean }> = [];
    let omittedAuthoredScopes = false;
    try {
      if (query.kind === 'repo-open') sources = await Promise.all(repoPaths.map(async ({ repo }) => ({ repo, result: await direct(repo), reviewRequested: false })));
      else if (query.kind === 'authored-recent') {
        const scopes = repoPaths.slice(0, authoredRepositoryLimit);
        omittedAuthoredScopes = scopes.length !== repoPaths.length;
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(2, scopes.length) }, async () => {
          while (true) {
            context.signal.throwIfAborted();
            const scope = scopes[next++]; if (!scope) return;
            const result = await recentCollection(context, '/search/issues', { q: `is:pr${query.state === 'open' ? ' is:open' : ''} author:${author} repo:${scope.repo}`, sort: 'created', order: 'desc' }, query.limit, { key: 'items' });
            if (result.items.length || result.quality === 'complete') {
              sources.push({ repo: '', result, reviewRequested: false });
              continue;
            }
            const recent = await recentCollection(context, `/repos/${scope.repo}/issues`, { creator: author, state: query.state === 'open' ? 'open' : 'all', sort: 'created', direction: 'desc' }, query.limit,
              { accept: value => {
                const raw = object(value); const login = object(raw?.user)?.login;
                return object(raw?.pull_request) !== null && typeof login === 'string' && login.toLowerCase() === author.toLowerCase();
              } });
            sources.push({ repo: scope.repo, result: recent, reviewRequested: false });
          }
        }));
      } else {
        const memberTeams = requestedTeamMemberships(author, context);
        const search = recentCollection(context,'/search/issues', { q: `is:pr is:open review-requested:${author}${query.repo ? ` repo:${query.repo}` : ''}`, sort: 'created', order: 'desc' },query.limit,{key:'items'});
        const local = memberTeams.then(value => {
          memberships = value;
          return Promise.all(repoPaths.map(async ({ repo }) => ({ repo, result: await direct(repo), reviewRequested: true })));
        });
        const [searchResult, localResults] = await Promise.all([search, local]);
        const recoveredSearch = searchResult.failed && localResults.length && localResults.every(source => !source.result.failed)
          ? { ...searchResult, quality: 'complete' as const, failed: false } : searchResult;
        sources = [{ repo: '', result: recoveredSearch, reviewRequested: true }, ...localResults];
      }
    } catch { context.signal.throwIfAborted(); return Object.freeze({ items: Object.freeze([]), quality: 'degraded' as const, truncated: false, browseUrl: null }); }
    const ssoRequired = query.kind === 'review-requested' && Boolean(memberships.sso || sources.some(source => source.result.sso));
    const items: ListCandidate[] = []; let partial = omittedAuthoredScopes || ssoRequired; let degraded = false;
    for (const source of sources) {
      partial ||= source.result.quality !== 'complete';
      degraded ||= source.result.quality === 'degraded' || query.kind !== 'authored-recent' && source.result.failed === true;
      for (const candidate of source.result.items) {
        try {
          if (source.reviewRequested && source.repo) {
            const teams = object(candidate)?.requested_teams;
            if (Array.isArray(teams) && teams.length > 0) {
              partial ||= memberships.quality !== 'complete';
              degraded ||= memberships.quality === 'degraded';
            }
            const requested = requestedBy(candidate, author, memberships);
            if (requested === null) { degraded = true; continue; }
            if (!requested) continue;
          }
          const parsed = readItem(candidate, source.repo, source.reviewRequested ? 'REVIEW_REQUIRED' : null);
          if (repos.includes(parsed.repo) && (query.repo === null || parsed.repo === query.repo) && (query.kind === 'authored-recent' && query.state !== 'open' || parsed.status === 'open')) items.push({ item: parsed, requested: requestedReviewCount(object(candidate)) });
        } catch { degraded = true; }
      }
    }
    const unique = [...new Map(items.map(value => [`${value.item.repo.toLowerCase()}#${value.item.number}`, value])).values()].sort((left, right) => Date.parse(right.item.createdAt) - Date.parse(left.item.createdAt));
    const truncated = partial || unique.length > query.limit || unique.length > 300;
    const visible = unique.slice(0, Math.min(300, query.limit));
    const listed = await withListReviews(visible, context);
    const browseUrl = query.repo && query.kind === 'authored-recent' ? `https://github.com/${query.repo}/pulls?q=${encodeURIComponent(`is:pr${query.state === 'open' ? ' is:open' : ''} author:${author} sort:created-desc`)}`
      : query.kind === 'review-requested' ? `${query.repo ? `https://github.com/${query.repo}/pulls` : 'https://github.com/pulls'}?q=${encodeURIComponent(`is:pr is:open review-requested:${author} sort:created-desc`)}`
        : query.kind === 'repo-open' && query.repo ? `https://github.com/${query.repo}/pulls` : null;
    return Object.freeze({ items: Object.freeze(listed), quality: degraded ? 'degraded' as const : truncated ? 'partial' as const : 'complete' as const, truncated, browseUrl,
      ...(ssoRequired ? { notice: 'github-sso-required' as const } : {}) });
  },
  async detail(input, context) {
    const query = parsePullRequestInspectDetailQueryV1(input); const first = await metadata(query, context);
    const [checkResult, reviewResult, comments] = await Promise.all([checks(first.target, context), reviews(first.target, first.raw, context), discussionComments(first.target, first.comments, context)]);
    const last = await metadata(query, context); if (!same(first.target, last.target)) throw inspectionFailure('head-changed');
    const { raw: _raw, ...detail } = last;
    return parsePullRequestInspectDetailV1({ ...detail, version: 1, observedAt: new Date().toISOString(), checks: checkResult.counts,
      evidence: boundEvidence(first.updatedAt === last.updatedAt ? { ...checkResult.evidence, ...reviewResult.evidence, comments } : { ...checkResult.evidence, approved: { quality: 'partial', truncated: false, items: [] }, changesRequested: { quality: 'partial', truncated: false, items: [] }, requested: { quality: 'partial', truncated: false, items: [] }, comments: { quality: 'partial', truncated: false, items: [] } }),
      reviews: first.updatedAt === last.updatedAt ? reviewResult.counts : unknownReviews('partial') }, query);
  },
  async diff(input, context) {
    const query = parsePullRequestInspectDiffQueryV1(input); const target = parsePullRequestInspectTargetV1(query.target); const first = await metadata(target, context);
    if (!same(first.target, target)) throw inspectionFailure('head-changed');
    const path = `/repos/${target.repo}/compare/${target.baseSha}...${target.headSha}`;
    const response = await request(context, 'GET', path, { per_page: '1', page: '1' }); const comparison = object(response.body); const files = array(comparison?.files, PULL_REQUEST_INSPECT_LIMITS.providerFiles);
    if (response.status !== 200 || !comparison || comparison.url !== `${api}${path}` || object(comparison.base_commit)?.sha !== target.baseSha || !sha(object(comparison.merge_base_commit)?.sha)
      || !integer(comparison.total_commits) || !files) throw new Error('Invalid GitHub comparison response');
    let remaining = PULL_REQUEST_INSPECT_LIMITS.patches; const names = new Set<string>();
    const mapped: PullRequestInspectFileV1[] = files.slice(0, PULL_REQUEST_INSPECT_LIMITS.files).map(value => {
      const file = object(value); const filename = file?.filename;
      if (!text(filename, 1024) || names.has(filename) || !text(file?.status, 64) || !integer(file?.additions) || !integer(file?.deletions)) throw new Error('Invalid GitHub comparison file');
      names.add(filename); const original = file?.patch === undefined || file.patch === null ? null : file.patch;
      if (original !== null && (typeof original !== 'string' || original.includes('\0'))) throw new Error('Invalid GitHub comparison patch');
      const sourcePatch = typeof original === 'string' ? original : null;
      const patch = sourcePatch === null ? null : sourcePatch.slice(0, Math.min(remaining, PULL_REQUEST_INSPECT_LIMITS.patch)).replace(/[\uD800-\uDBFF]$/, ''); remaining -= patch?.length ?? 0;
      return { filename, previousFilename: file?.previous_filename === undefined ? null : text(file.previous_filename, 1024) ? file.previous_filename : (() => { throw new Error('Invalid GitHub comparison file'); })(), status: file.status,
        additions: file.additions, deletions: file.deletions, patch, patchStatus: patch === null ? 'unavailable' : patch.length < (sourcePatch?.length ?? 0) ? 'truncated' : 'preview' };
    });
    const last = await metadata(target, context); if (!same(last.target, target)) throw inspectionFailure('head-changed');
    const truncated = files.length >= PULL_REQUEST_INSPECT_LIMITS.providerFiles || files.length > mapped.length;
    return parsePullRequestInspectDiffV1({ version: 1, target, observedAt: new Date().toISOString(), coverage: 'immutable-comparison-preview', quality: truncated ? 'partial' : 'complete', truncated, files: mapped }, query);
  },
  async prepareReview(input, context) { return prepared(input.repo, input.number, input.expectedHeadSha, context); },
  async invokeReview(input, context) {
    try {
      const pinned = await prepared(input.repo, input.number, input.headSha, context);
      if (pinned.actor.toLowerCase() !== input.actor.toLowerCase()) throw new Error('Authenticated actor changed');
      const response = await request(context, 'POST', `/repos/${input.repo}/pulls/${input.number}/reviews`, {}, { event: input.event, body: formatPullRequestReviewBody(input), commit_id: input.headSha });
      const posted = object(response.body); if (response.status < 200 || response.status >= 300 || !positive(posted?.id)) return response.status >= 400 && response.status < 500
        ? { status: 'definitely-not-applied' as const, retryable: response.status === 429, reason: `GitHub rejected the review (${response.status}).`, evidence: { httpStatus: response.status } }
        : unavailable(`GitHub rejected the review (${response.status}).`);
      return { status: 'acknowledged' as const, receipt: { repo: input.repo, prNumber: input.number, headSha: input.headSha, actor: input.actor, reviewId: posted.id } };
    } catch { return unavailable('Pinned GitHub review delivery could not be confirmed.'); }
  },
  async reconcileReview(input, context) {
    try {
      const history = await collection(context, `/repos/${input.repo}/pulls/${input.number}/reviews`, {}, { pages: 20 });
      if (history.quality !== 'complete') return unavailable('Pinned GitHub review history is incomplete.');
      const expectedBody = formatPullRequestReviewBody(input);
      const ids = new Set<number>();
      const found = history.items.map(value => {
        const review = object(value);
        if (!positive(review?.id) || ids.has(review.id)) throw new Error('Invalid GitHub review history');
        ids.add(review.id); return review;
      }).filter(value => {
        const actor = object(value.user)?.login;
        return value.commit_id === input.headSha && value.body === expectedBody && typeof actor === 'string' && actor.toLowerCase() === input.actor.toLowerCase();
      });
      if (found.length !== 1) return unavailable(found.length > 1 ? 'Multiple review receipts match this operation; operator reconciliation is required.' : 'No authenticated review receipt proves delivery; an earlier request may still be in flight.');
      return { status: 'acknowledged' as const, receipt: { repo: input.repo, prNumber: input.number, headSha: input.headSha, actor: input.actor, reviewId: found[0]!.id } };
    } catch { return unavailable('Pinned GitHub review history is unavailable.'); }
  },
});
