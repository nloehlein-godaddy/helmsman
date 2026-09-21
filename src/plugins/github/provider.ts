import {
  PULL_REQUEST_INSPECT_LIMITS, parsePullRequestInspectDetailQueryV1, parsePullRequestInspectDetailV1, parsePullRequestInspectDiffQueryV1, parsePullRequestInspectDiffV1,
  parsePullRequestInspectTargetV1, parsePullRequestReadItemV1, parsePullRequestReadQueryV1, type PullRequestInspectDetailV1, type PullRequestInspectFileV1,
  type PullRequestInspectQualityV1, type PullRequestInspectReviewV1, type PullRequestInspectTargetV1, type PullRequestProviderContextV1, type PullRequestProviderV1,
  formatPullRequestReviewBody,
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

function nextPage(link: string | undefined, path: string, query: Readonly<Record<string, string>>, page: number): boolean {
  if (!link) return false;
  let found = false;
  for (const entry of link.split(',')) {
    if (!/\brel\s*=\s*"?next\b/.test(entry)) continue;
    const match = entry.match(/^\s*<([^>]+)>;\s*rel="next"\s*$/);
    if (!match || found) throw new Error('Invalid GitHub pagination link');
    let value: URL;
    try { value = new URL(match[1]!); } catch { throw new Error('Invalid GitHub pagination link'); }
    if (value.origin !== api || value.pathname !== path || value.username || value.password || value.hash || value.searchParams.get('page') !== String(page + 1)
      || [...value.searchParams.keys()].some(key => key !== 'page' && !(key in query))
      || Object.entries(query).some(([key, expected]) => value.searchParams.get(key) !== expected)) throw new Error('Invalid GitHub pagination link');
    found = true;
  }
  return found;
}

async function request(context: PullRequestProviderContextV1, method: 'GET' | 'POST', path: string, query: Record<string, string> = {}, body: unknown | null = null) {
  context.signal.throwIfAborted();
  const response = await context.http.request({ method, path, query, body });
  context.signal.throwIfAborted();
  if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new Error('Malformed GitHub response');
  return response;
}

async function collection(context: PullRequestProviderContextV1, path: string, query: Readonly<Record<string, string>>, key?: string, expectedSha?: string): Promise<{ quality: 'complete' | 'partial'; items: unknown[] }> {
  const items: unknown[] = []; let total: number | null = null;
  for (let page = 1; page <= PULL_REQUEST_INSPECT_LIMITS.pages; page++) {
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
    const next = nextPage(response.link, path, { ...query, per_page: String(PULL_REQUEST_INSPECT_LIMITS.page) }, page);
    if (!next) {
      if (total !== null && total !== items.length) return { quality: 'partial', items: [] };
      if (values.length < PULL_REQUEST_INSPECT_LIMITS.page || total !== null) return { quality: 'complete', items };
      if (page === PULL_REQUEST_INSPECT_LIMITS.pages) return { quality: 'partial', items: [] };
      continue;
    }
    if (!values.length) throw new Error('Invalid GitHub pagination');
  }
  return { quality: 'partial', items: [] };
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

async function checks(target: PullRequestInspectTargetV1, context: PullRequestProviderContextV1): Promise<PullRequestInspectDetailV1['checks']> {
  try {
    const [runs, statuses] = await Promise.all([
      collection(context, `/repos/${target.repo}/commits/${target.headSha}/check-runs`, {}, 'check_runs'),
      collection(context, `/repos/${target.repo}/commits/${target.headSha}/status`, {}, 'statuses', target.headSha),
    ]);
    if (runs.quality !== 'complete' || statuses.quality !== 'complete') return unknownChecks('partial');
    let passed = 0; let failed = 0; let pending = 0; const ids = new Set<number>();
    for (const item of runs.items) {
      const run = object(item); const id = run?.id;
      if (!run || !positive(id) || ids.has(id) || run.head_sha !== target.headSha || !['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(String(run.status))) throw new Error('Invalid GitHub check run');
      ids.add(id);
      if (run.status !== 'completed' || run.conclusion === null) pending++;
      else if (['success', 'neutral', 'skipped'].includes(String(run.conclusion))) passed++;
      else if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(String(run.conclusion))) failed++;
      else throw new Error('Invalid GitHub check conclusion');
    }
    const contexts = new Map<string, { id: number; state: string; updatedAt: string }>();
    for (const item of statuses.items) {
      const status = object(item); const id = status?.id; const name = status?.context; const state = status?.state; const updatedAt = status?.updated_at;
      if (!positive(id) || !text(name) || !text(state, 32) || !text(updatedAt, 64) || !Number.isFinite(Date.parse(updatedAt)) || !['success', 'failure', 'error', 'pending'].includes(state)) throw new Error('Invalid GitHub status');
      const prior = contexts.get(name);
      if (!prior || Date.parse(updatedAt) > Date.parse(prior.updatedAt) || updatedAt === prior.updatedAt && id > prior.id) contexts.set(name, { id, state, updatedAt });
    }
    if (contexts.size !== statuses.items.length) return unknownChecks('partial');
    for (const status of contexts.values()) {
      if (status.state === 'success') passed++;
      else if (status.state === 'pending') pending++;
      else failed++;
    }
    return { quality: 'complete', passed, failed, pending };
  } catch { return unknownChecks('unavailable'); }
}

async function reviews(target: PullRequestInspectTargetV1, raw: Record<string, unknown>, context: PullRequestProviderContextV1): Promise<PullRequestInspectDetailV1['reviews']> {
  try {
    const result = await collection(context, `/repos/${target.repo}/pulls/${target.number}/reviews`, {});
    if (result.quality !== 'complete') return unknownReviews(result.quality);
    const users = raw.requested_reviewers; const teams = raw.requested_teams;
    if (!Array.isArray(users) || !Array.isArray(teams)) throw new Error('Invalid requested reviewers');
    const requested = new Set(users.map(value => object(value)?.login).filter(value => text(value, 128)).map(value => value.toLowerCase())).size
      + new Set(teams.map(value => object(value)?.slug).filter(value => text(value, 128)).map(value => value.toLowerCase())).size;
    if (users.some(value => !text(object(value)?.login, 128)) || teams.some(value => !text(object(value)?.slug, 128))) throw new Error('Invalid requested reviewer');
    type Review = { id: number; login: string; state: PullRequestInspectReviewV1; at: string; commit: string };
    const submitted: Review[] = []; const ids = new Set<number>();
    for (const item of result.items) {
      const review = object(item); const id = review?.id;
      if (!review || !positive(id) || ids.has(id)) throw new Error('Invalid GitHub review'); ids.add(id);
      if (review.state === 'PENDING') continue;
      const login = object(review.user)?.login; const at = review.submitted_at; const commit = review.commit_id;
      if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(String(review.state)) || !text(login, 128) || !text(at, 64) || !Number.isFinite(Date.parse(at)) || !sha(commit)) throw new Error('Invalid GitHub review');
      submitted.push({ id, login: login.toLowerCase(), state: review.state as PullRequestInspectReviewV1, at, commit });
    }
    submitted.sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id - right.id);
    const effective = new Map<string, Review>(); let latest: Review | undefined; const author = configuredAuthor(context).trim().toLowerCase();
    for (const review of submitted) {
      const prior = effective.get(review.login); if (!prior || review.state !== 'COMMENTED' || prior.state === 'COMMENTED') effective.set(review.login, review);
      if (review.login === author) latest = review;
    }
    const values = [...effective.values()];
    return { quality: 'complete', approved: values.filter(value => value.state === 'APPROVED').length, changesRequested: values.filter(value => value.state === 'CHANGES_REQUESTED').length,
      commented: values.filter(value => value.state === 'COMMENTED').length, requested, viewerReview: effective.get(author)?.state ?? null,
      viewerReviewedAt: latest?.at ?? null, viewerReviewedCommitId: latest?.commit ?? null };
  } catch { return unknownReviews('unavailable'); }
}

function readItem(value: unknown, fallbackRepo: string, reviewDecision: 'REVIEW_REQUIRED' | null = null) {
  const raw = object(value); const repo = typeof raw?.repository_url === 'string' && raw.repository_url.startsWith(`${api}/repos/`) ? raw.repository_url.slice(`${api}/repos/`.length) : fallbackRepo;
  const mergedAt = (raw?.pull_request ? object(raw.pull_request)?.merged_at : undefined) ?? raw?.merged_at;
  const state = mergedAt ? 'merged' : raw?.state === 'closed' ? 'closed' : 'open';
  return parsePullRequestReadItemV1({ repo, number: raw?.number, title: raw?.title, url: `https://github.com/${repo}/pull/${String(raw?.number)}`,
    status: state, createdAt: raw?.created_at, mergedAt: mergedAt ?? null, draft: typeof raw?.draft === 'boolean' ? raw.draft : null,
    ticketId: null, reviewDecision, comments: integer(raw?.comments) ? raw.comments : null, reviews: null });
}

async function prepared(repo: string, number: number, expectedHeadSha: string | null, context: PullRequestProviderContextV1) {
  const [actorResponse, detailResponse] = await Promise.all([request(context, 'GET', '/user'), request(context, 'GET', `/repos/${repo}/pulls/${number}`)]);
  const actor = object(actorResponse.body); const detail = object(detailResponse.body); const head = object(detail?.head);
  if (actorResponse.status !== 200 || detailResponse.status !== 200 || !text(actor?.login, 128) || !sha(head?.sha) || detail?.state !== 'open' || detail?.merged === true
    || expectedHeadSha !== null && head.sha !== expectedHeadSha) throw new Error('Authenticated review actor or open PR revision is unavailable');
  return Object.freeze({ repo, number, headSha: head.sha, actor: actor.login });
}

export const githubPullRequestProvider: PullRequestProviderV1 = Object.freeze<PullRequestProviderV1>({
  async profile(context) {
    const bounded = (value: unknown, maximum: number): string | null => text(value, maximum) ? value.trim() || null : null;
    const fallback = bounded(context.configuredAuthor, 128);
    try {
      context.signal.throwIfAborted();
      const response = await request(context, 'GET', '/user');
      context.signal.throwIfAborted();
      if (response.status !== 200) return { displayName: fallback, login: fallback };
      const data = object(response.body); const login = bounded(data?.login, 128) ?? fallback;
      return { displayName: bounded(data?.name, 256) ?? login, login };
    } catch {
      context.signal.throwIfAborted();
      return { displayName: fallback, login: fallback };
    }
  },
  async list(input, context) {
    const query = parsePullRequestReadQueryV1(input.query); const repos = [...new Set(input.repos)]; const author = configuredAuthor(context);
    const repoPaths = (query.repo === null ? repos : [query.repo]).map(repo => ({ repo, path: `/repos/${repo}/pulls` }));
    const direct = async (repo: string) => collection(context, `/repos/${repo}/pulls`, { state: 'open', sort: 'created', direction: 'desc' });
    let sources: Array<{ repo: string; result: { quality: 'complete' | 'partial'; items: unknown[] }; reviewRequested: boolean }> = [];
    try {
      if (query.kind === 'repo-open') sources = await Promise.all(repoPaths.map(async ({ repo }) => ({ repo, result: await direct(repo), reviewRequested: false })));
      else if (query.kind === 'authored-recent') {
        const result = await collection(context, '/search/issues', { q: `is:pr author:${author}${query.repo ? ` repo:${query.repo}` : ''}`, sort: 'created', order: 'desc' }, 'items');
        sources = [{ repo: '', result, reviewRequested: false }];
      } else {
        const search = collection(context, '/search/issues', { q: `is:pr is:open review-requested:${author}${query.repo ? ` repo:${query.repo}` : ''}`, sort: 'created', order: 'desc' }, 'items');
        const local = Promise.all(repoPaths.map(async ({ repo }) => ({ repo, result: await direct(repo), reviewRequested: true })));
        sources = [{ repo: '', result: await search, reviewRequested: true }, ...(await local)];
      }
    } catch { return Object.freeze({ items: Object.freeze([]), quality: 'degraded' as const, truncated: false, browseUrl: null }); }
    const items = []; let partial = false; let degraded = false;
    for (const source of sources) {
      partial ||= source.result.quality !== 'complete';
      for (const candidate of source.result.items) {
        try {
          if (source.reviewRequested && source.repo) {
            const requested = object(candidate)?.requested_reviewers;
            if (!Array.isArray(requested)) { degraded = true; continue; }
            if (!requested.some(value => {
              const login = object(value)?.login;
              return typeof login === 'string' && login.toLowerCase() === author.toLowerCase();
            })) continue;
          }
          const parsed = readItem(candidate, source.repo, source.reviewRequested ? 'REVIEW_REQUIRED' : null);
          if (repos.includes(parsed.repo) && (query.repo === null || parsed.repo === query.repo) && (query.kind === 'authored-recent' || parsed.status === 'open')) items.push(parsed);
        } catch { degraded = true; }
      }
    }
    const unique = [...new Map(items.map(value => [`${value.repo.toLowerCase()}#${value.number}`, value])).values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const truncated = partial || unique.length > 300;
    return Object.freeze({ items: Object.freeze(unique.slice(0, 300)), quality: degraded ? 'degraded' as const : truncated ? 'partial' as const : 'complete' as const, truncated, browseUrl: query.kind === 'repo-open' && query.repo ? `https://github.com/${query.repo}/pulls` : null });
  },
  async detail(input, context) {
    const query = parsePullRequestInspectDetailQueryV1(input); const first = await metadata(query, context);
    const [checkResult, reviewResult] = await Promise.all([checks(first.target, context), reviews(first.target, first.raw, context)]);
    const last = await metadata(query, context); if (!same(first.target, last.target)) throw inspectionFailure('head-changed');
    const { raw: _raw, ...detail } = last;
    return parsePullRequestInspectDetailV1({ ...detail, version: 1, observedAt: new Date().toISOString(), checks: checkResult,
      reviews: first.updatedAt === last.updatedAt ? reviewResult : unknownReviews('partial') }, query);
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
      const pinned = await prepared(input.repo, input.number, input.headSha, context); if (pinned.actor.toLowerCase() !== input.actor.toLowerCase()) throw new Error('Authenticated actor changed');
      const response = await request(context, 'GET', `/repos/${input.repo}/pulls/${input.number}/reviews`, { per_page: '100', page: '1' }); const values = array(response.body, 100);
      if (response.status !== 200 || !values) return unavailable('Pinned GitHub review history is unavailable.');
      const expectedBody = formatPullRequestReviewBody(input);
      const found = values.map(object).filter(value => positive(value?.id) && value?.commit_id === input.headSha && value?.body === expectedBody && String(object(value?.user)?.login).toLowerCase() === input.actor.toLowerCase());
      if (found.length !== 1) return unavailable(found.length > 1 ? 'Multiple review receipts match this operation; operator reconciliation is required.' : 'No authenticated review receipt proves delivery; an earlier request may still be in flight.');
      return { status: 'acknowledged' as const, receipt: { repo: input.repo, prNumber: input.number, headSha: input.headSha, actor: input.actor, reviewId: found[0]!.id } };
    } catch { return unavailable('Pinned GitHub review history is unavailable.'); }
  },
});
