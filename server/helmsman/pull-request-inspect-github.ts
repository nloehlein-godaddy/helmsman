import type { GithubConfig } from '../config';
import { parsePullRequestInspectDetailQueryV1, parsePullRequestInspectDetailV1, parsePullRequestInspectDiffQueryV1, parsePullRequestInspectDiffV1, parsePullRequestInspectTargetV1, PULL_REQUEST_INSPECT_LIMITS } from '../../src/plugins/pull-request-inspect';
import type { PullRequestInspectDetailQueryV1, PullRequestInspectDetailV1, PullRequestInspectFileV1, PullRequestInspectQualityV1, PullRequestInspectReviewV1, PullRequestInspectTargetV1 } from '../../src/plugins/pull-request-inspect';
import { PullRequestInspectError } from './pull-request-inspect-service';
import type { PullRequestInspectProvider } from './pull-request-inspect-service';

const api = 'https://api.github.com';
function invalid(): never { throw new PullRequestInspectError(502, 'invalid-response'); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function text(value: unknown, maximum = 1024): string { if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) invalid(); return value; }
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(); return value; }
function date(value: unknown): string { const result = text(value, 64); if (!Number.isFinite(Date.parse(result))) invalid(); return result; }
function sha(value: unknown): string { const result = text(value, 64); if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(result)) invalid(); return result; }
function same(first: PullRequestInspectTargetV1, second: PullRequestInspectTargetV1): boolean { return first.repo === second.repo && first.number === second.number && first.headSha === second.headSha && first.baseSha === second.baseSha; }
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason); if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
function nextPage(header: string | null, endpoint: string, page: number): boolean {
  if (!header) return false;
  let found = false;
  for (const entry of header.split(',')) {
    if (!/\brel\s*=\s*"?next\b/.test(entry)) continue;
    const match = entry.match(/^\s*<([^>]+)>;\s*rel="next"\s*$/); if (!match || found) invalid();
    let url: URL; try { url = new URL(match[1]!); } catch { return invalid(); }
    if (`${url.origin}${url.pathname}` !== endpoint || url.username || url.password || url.hash || url.searchParams.get('page') !== String(page + 1)
      || url.searchParams.get('per_page') !== String(PULL_REQUEST_INSPECT_LIMITS.page) || [...url.searchParams.keys()].some(key => !['page', 'per_page'].includes(key))) invalid();
    found = true;
  }
  return found;
}
const unknownChecks = (quality: PullRequestInspectQualityV1): PullRequestInspectDetailV1['checks'] => ({ quality, passed: null, failed: null, pending: null });
const unknownReviews = (quality: PullRequestInspectQualityV1): PullRequestInspectDetailV1['reviews'] => ({ quality, approved: null, changesRequested: null, commented: null, requested: null, viewerReview: null, viewerReviewedAt: null, viewerReviewedCommitId: null });

export function createGithubPullRequestInspectProvider(options: { github(): GithubConfig | null | undefined; fetch?: typeof fetch; now?(): string }): PullRequestInspectProvider {
  const fetcher = options.fetch ?? fetch; const now = options.now ?? (() => new Date().toISOString());
  function operation(signal: AbortSignal) {
    const configured = options.github(); if (!configured?.token || !configured.author?.trim()) throw new PullRequestInspectError(503, 'service-unavailable');
    const github = { token: configured.token, author: configured.author, repo: configured.repo }; let received = 0;
    function check() {
      signal.throwIfAborted(); const latest = options.github();
      if (latest?.token !== github.token || latest?.author !== github.author || latest?.repo !== github.repo) throw new PullRequestInspectError(409, 'selection-changed');
    }
    async function request(path: string): Promise<{ value: unknown; link: string | null }> {
      check(); let response: Response | undefined;
      try {
        response = await abortable<Response>(fetcher(`${api}${path}`, { method: 'GET', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${github.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }).then(value => {
          try { check(); return value; } catch (error) { if (value.body && !value.body.locked) void value.body.cancel().catch(() => {}); throw error; }
        }), signal);
        check();
        if (response.status === 404) throw new PullRequestInspectError(404, 'not-found');
        if (response.status === 401 || response.status === 403) throw new PullRequestInspectError(403, 'forbidden');
        if (!response.ok) throw new PullRequestInspectError(503, 'service-unavailable');
        if (!response.body || Number(response.headers.get('content-length')) > PULL_REQUEST_INSPECT_LIMITS.responseBytes) invalid();
        const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0; let result = ''; let complete = false;
        try {
          while (true) {
            const next = await abortable(reader.read(), signal); check();
            if (next.done) { complete = true; return { value: JSON.parse(result + decoder.decode()) as unknown, link: response.headers.get('link') }; }
            bytes += next.value.byteLength; received += next.value.byteLength;
            if (bytes > PULL_REQUEST_INSPECT_LIMITS.responseBytes || received > PULL_REQUEST_INSPECT_LIMITS.transportBytes) invalid();
            result += decoder.decode(next.value, { stream: true });
          }
        } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch (error) {
        check(); if (error instanceof PullRequestInspectError) throw error;
        throw new PullRequestInspectError(503, 'service-unavailable');
      } finally { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
    }
    async function metadata(query: Omit<PullRequestInspectDetailQueryV1, 'version'>) {
      const raw = object((await request(`/repos/${query.repo}/pulls/${query.number}`)).value);
      const base = object(raw.base); const head = object(raw.head);
      if (raw.number !== query.number || object(base.repo).full_name !== query.repo || !['open', 'closed'].includes(raw.state as string)
        || typeof raw.draft !== 'boolean' || typeof raw.merged !== 'boolean' || raw.merged && raw.state !== 'closed') invalid();
      const target = parsePullRequestInspectTargetV1({ repo: query.repo, number: query.number, headSha: sha(head.sha), baseSha: sha(base.sha) });
      const authorLogin = raw.user === null ? null : text(object(raw.user).login, 128);
      const url = text(raw.html_url, 2048); if (url !== `https://github.com/${query.repo}/pull/${query.number}`) invalid();
      return { raw, target, title: text(raw.title, 2048), url, status: raw.merged ? 'merged' as const : raw.state as 'open' | 'closed', draft: raw.draft,
        authorLogin, isOwnPr: authorLogin === null ? null : authorLogin.toLowerCase() === github.author.trim().toLowerCase(), headRefName: text(head.ref),
        updatedAt: date(raw.updated_at), comments: raw.comments === undefined || raw.comments === null ? null : integer(raw.comments) };
    }
    async function collection(path: string, key?: string, expectedSha?: string): Promise<{ quality: 'complete' | 'partial'; items: unknown[] }> {
      const items: unknown[] = []; let total: number | null = null;
      for (let page = 1; page <= PULL_REQUEST_INSPECT_LIMITS.pages; page++) {
        const response = await request(`${path}?per_page=${PULL_REQUEST_INSPECT_LIMITS.page}&page=${page}`);
        const data = key ? object(response.value) : null; const values = key ? data?.[key] : response.value;
        if (expectedSha && data?.sha !== expectedSha) invalid();
        if (!Array.isArray(values) || values.length > PULL_REQUEST_INSPECT_LIMITS.page) invalid();
        if (key) { const count = integer(data?.total_count); if (total !== null && count !== total) return { quality: 'partial', items: [] }; total = count; }
        items.push(...values); const next = nextPage(response.link, `${api}${path}`, page);
        if (!next) return { quality: total !== null && total !== items.length ? 'partial' : 'complete', items };
        if (!values.length) invalid();
      }
      return { quality: 'partial', items: [] };
    }
    async function checks(target: PullRequestInspectTargetV1): Promise<PullRequestInspectDetailV1['checks']> {
      try {
        const [result, statuses] = await Promise.all([collection(`/repos/${target.repo}/commits/${target.headSha}/check-runs`, 'check_runs'),
          collection(`/repos/${target.repo}/commits/${target.headSha}/status`, 'statuses', target.headSha)]);
        if (result.quality !== 'complete' || statuses.quality !== 'complete') return unknownChecks('partial');
        let passed = 0; let failed = 0; let pending = 0; const ids = new Set<number>();
        for (const value of result.items) {
          const run = object(value); const id = integer(run.id);
          if (ids.has(id) || run.head_sha !== target.headSha || !['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(run.status as string)) invalid(); ids.add(id);
          if (run.status !== 'completed' || run.conclusion === null) pending++;
          else if (['success', 'neutral', 'skipped'].includes(run.conclusion as string)) passed++;
          else if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(run.conclusion as string)) failed++;
          else invalid();
        }
        const contexts = new Map<string, { id: number; state: string; updatedAt: string }>();
        for (const item of statuses.items) {
          const status = object(item); const id = integer(status.id); const context = text(status.context); const state = text(status.state, 32); const updatedAt = date(status.updated_at);
          if (!['success', 'failure', 'error', 'pending'].includes(state)) invalid();
          const prior = contexts.get(context);
          if (!prior || Date.parse(updatedAt) > Date.parse(prior.updatedAt) || updatedAt === prior.updatedAt && id > prior.id) contexts.set(context, { id, state, updatedAt });
        }
        if (contexts.size !== statuses.items.length) return unknownChecks('partial');
        for (const status of contexts.values()) {
          if (status.state === 'success') passed++;
          else if (status.state === 'pending') pending++;
          else failed++;
        }
        return { quality: 'complete', passed, failed, pending };
      } catch { check(); return unknownChecks('unavailable'); }
    }
    async function reviews(target: PullRequestInspectTargetV1, raw: Record<string, unknown>): Promise<PullRequestInspectDetailV1['reviews']> {
      try {
        const result = await collection(`/repos/${target.repo}/pulls/${target.number}/reviews`);
        if (result.quality !== 'complete') return unknownReviews(result.quality);
        const users = raw.requested_reviewers; const teams = raw.requested_teams;
        if (!Array.isArray(users) || !Array.isArray(teams)) invalid();
        const requested = new Set(users.map(value => text(object(value).login, 128).toLowerCase())).size + new Set(teams.map(value => text(object(value).slug, 128).toLowerCase())).size;
        type Review = { id: number; login: string; state: PullRequestInspectReviewV1; at: string; commit: string };
        const submitted: Review[] = []; const ids = new Set<number>();
        for (const item of result.items) {
          const value = object(item); const id = integer(value.id); if (ids.has(id)) invalid(); ids.add(id);
          if (value.state === 'PENDING') continue;
          if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(value.state as string)) invalid();
          submitted.push({ id, login: text(object(value.user).login, 128).toLowerCase(), state: value.state as PullRequestInspectReviewV1, at: date(value.submitted_at), commit: sha(value.commit_id) });
        }
        submitted.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);
        const effective = new Map<string, Review>(); let latest: Review | undefined;
        for (const review of submitted) {
          const prior = effective.get(review.login); if (!prior || review.state !== 'COMMENTED' || prior.state === 'COMMENTED') effective.set(review.login, review);
          if (review.login === github.author.trim().toLowerCase()) latest = review;
        }
        const values = [...effective.values()];
        return { quality: 'complete', approved: values.filter(value => value.state === 'APPROVED').length, changesRequested: values.filter(value => value.state === 'CHANGES_REQUESTED').length,
          commented: values.filter(value => value.state === 'COMMENTED').length, requested, viewerReview: effective.get(github.author.trim().toLowerCase())?.state ?? null,
          viewerReviewedAt: latest?.at ?? null, viewerReviewedCommitId: latest?.commit ?? null };
      } catch { check(); return unknownReviews('unavailable'); }
    }
    return { request, metadata, checks, reviews, check };
  }
  return Object.freeze<PullRequestInspectProvider>({
    async detail(input, signal) {
      const query = parsePullRequestInspectDetailQueryV1(input); const call = operation(signal); const first = await call.metadata(query);
      const [checks, reviews] = await Promise.all([call.checks(first.target), call.reviews(first.target, first.raw)]);
      const last = await call.metadata(query); if (!same(first.target, last.target)) throw new PullRequestInspectError(409, 'head-changed'); call.check();
      const { raw: _raw, ...detail } = last;
      return parsePullRequestInspectDetailV1({ ...detail, version: 1, observedAt: now(), checks,
        reviews: first.updatedAt === last.updatedAt ? reviews : unknownReviews('partial') }, query);
    },
    async diff(input, signal) {
      const query = parsePullRequestInspectDiffQueryV1(input); const call = operation(signal); const first = await call.metadata(query.target);
      if (!same(first.target, query.target)) throw new PullRequestInspectError(409, 'head-changed');
      const path = `/repos/${query.target.repo}/compare/${query.target.baseSha}...${query.target.headSha}`;
      const comparison = object((await call.request(`${path}?per_page=1&page=1`)).value);
      if (comparison.url !== `${api}${path}` || object(comparison.base_commit).sha !== query.target.baseSha
        || !Array.isArray(comparison.files) || comparison.files.length > PULL_REQUEST_INSPECT_LIMITS.providerFiles) invalid();
      sha(object(comparison.merge_base_commit).sha); integer(comparison.total_commits);
      let remaining = PULL_REQUEST_INSPECT_LIMITS.patches; const names = new Set<string>();
      const files: PullRequestInspectFileV1[] = comparison.files.slice(0, PULL_REQUEST_INSPECT_LIMITS.files).map(value => {
        const item = object(value); const filename = text(item.filename); if (names.has(filename)) invalid(); names.add(filename);
        const original = item.patch === undefined || item.patch === null ? null : item.patch; if (original !== null && (typeof original !== 'string' || original.includes('\0'))) invalid();
        const limit = Math.min(remaining, PULL_REQUEST_INSPECT_LIMITS.patch);
        const patch = original === null ? null : original.slice(0, limit).replace(/[\uD800-\uDBFF]$/, ''); remaining -= patch?.length ?? 0;
        return { filename, previousFilename: item.previous_filename === undefined ? null : text(item.previous_filename), status: text(item.status, 64),
          additions: integer(item.additions), deletions: integer(item.deletions), patch,
          patchStatus: patch === null ? 'unavailable' : patch.length < (original?.length ?? 0) ? 'truncated' : 'preview' };
      });
      const last = await call.metadata(query.target); if (!same(last.target, query.target)) throw new PullRequestInspectError(409, 'head-changed'); call.check();
      const truncated = comparison.files.length >= PULL_REQUEST_INSPECT_LIMITS.providerFiles || comparison.files.length > files.length;
      return parsePullRequestInspectDiffV1({ version: 1, target: query.target, observedAt: now(), coverage: 'immutable-comparison-preview', quality: truncated ? 'partial' : 'complete', truncated, files }, query);
    },
  });
}
