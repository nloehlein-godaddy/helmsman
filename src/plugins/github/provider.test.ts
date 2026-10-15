import { describe, expect, it, vi } from 'vitest';
import { inspectQuery as query, inspectTarget as target } from '../pull-request-inspect.test-fixture';
import { githubPullRequestProvider } from './provider';
import { formatPullRequestReviewBody } from '@helmsman/plugin-sdk';
import { createPullRequestProviderHttp } from '../../../server/helmsman/pull-request-provider-http';

const review = (id: number, state: string, submittedAt = '2025-01-02T03:04:05.000Z', login = 'reviewer') => ({ id, state, user: { login }, submitted_at: submittedAt, commit_id: target.headSha });
const metadata = (overrides: Record<string, unknown> = {}) => ({ number: target.number, base: { sha: target.baseSha, repo: { full_name: target.repo } }, head: { sha: target.headSha, ref: 'work' }, state: 'open', draft: false, merged: false,
  user: { login: 'author' }, html_url: `https://github.com/${target.repo}/pull/${target.number}`, title: 'Pull request', updated_at: '2025-01-02T03:04:05.000Z', comments: 3,
  requested_reviewers: [{ login: 'reviewer' }], requested_teams: [], ...overrides });
const check = (id = 1) => ({ id, head_sha: target.headSha, status: 'completed', conclusion: 'success' });
const file = (name = 'a.ts') => ({ filename: name, status: 'modified', additions: 1, deletions: 1, patch: '+change' });
const comparison = (overrides: Record<string, unknown> = {}) => ({ url: `https://api.github.com/repos/${target.repo}/compare/${target.baseSha}...${target.headSha}`,
  base_commit: { sha: target.baseSha }, merge_base_commit: { sha: target.baseSha }, total_commits: 1, files: [file()], ...overrides });
const listed = (number: number, overrides: Record<string, unknown> = {}) => ({ repository_url: `https://api.github.com/repos/${target.repo}`, number, title: `Pull request ${number}`,
  state: 'open', pull_request: {}, created_at: '2025-01-02T03:04:05.000Z', draft: false, comments: 3, requested_reviewers: [], requested_teams: [], ...overrides });

function context(request: (input: { method: 'GET' | 'POST'; path: string; query: Readonly<Record<string, string>>; body: unknown | null }) => Promise<{ status: number; body: unknown; link?: string; sso?: 'partial' | 'required' }>) {
  return { signal: new AbortController().signal, configuredAuthor: 'reviewer', http: { request: vi.fn(request) } };
}

describe('exact review receipt reconciliation', () => {
  const input = { id: 'operation-1', contentHash: 'a'.repeat(64), repo: target.repo, number: target.number, headSha: target.headSha, actor: 'reviewer', event: 'COMMENT' as const, body: 'Reviewed' };
  const receipt = (id: number, body = formatPullRequestReviewBody(input)) => ({ ...review(id, 'COMMENTED'), body });
  const unrelated = () => Array.from({ length: 100 }, (_, i) => receipt(i + 1, 'Unrelated'));
  const path = `/repos/${target.repo}/pulls/${target.number}/reviews`;
  const link = (page: number) => `<https://api.github.com${path}?per_page=100&page=${page}>; rel="next"`;
  function fixture(history: (page: number) => { status: number; body: unknown; link?: string }, actor = () => 'reviewer', head = () => target.headSha) {
    return context(async request => {
      expect(request.method).toBe('GET');
      if (request.path === '/user') return { status: 200, body: { login: actor() } };
      if (request.path === path) return history(Number(request.query.page));
      return { status: 200, body: metadata({ head: { sha: head(), ref: 'work' } }) };
    });
  }

  it.each([true, false])('finds an exact receipt beyond the first 100 reviews with next link=%s', async hasLink => {
    const ctx = fixture(page => page === 1 ? { status: 200, body: unrelated(), ...(hasLink ? { link: link(2) } : {}) } : { status: 200, body: [receipt(101)] });
    expect(await githubPullRequestProvider.reconcileReview!(input, ctx)).toMatchObject({ status: 'acknowledged', receipt: { reviewId: 101, headSha: target.headSha } });
    expect(ctx.http.request.mock.calls.filter(([request]) => request.path === path).map(([request]) => request.query.page)).toEqual(['1', '2']);
  });

  it.each(['duplicate-marker', 'duplicate-id', 'malformed-page', 'failed-page', 'foreign-next-link', 'repeated-page'] as const)('preserves uncertainty for %s', async failure => {
    const first = [receipt(1), ...unrelated().slice(1)];
    const ctx = fixture(page => page === 1 ? { status: 200, body: first, link: failure === 'foreign-next-link' ? '<https://attacker.example/reviews?page=2>; rel="next"' : failure === 'repeated-page' ? link(1) : link(2) }
      : failure === 'failed-page' ? { status: 503, body: null } : { status: 200, body: failure === 'malformed-page' ? null : [receipt(failure === 'duplicate-id' ? 1 : 101)] });
    expect(await githubPullRequestProvider.reconcileReview!(input, ctx)).toMatchObject({ status: 'unknown' });
  });

  it('never acknowledges a partial bounded history even when it contains a matching marker', async () => {
    const ctx = fixture(page => ({ status: 200, body: [receipt(page * 100), ...Array.from({ length: 99 }, (_, index) => receipt(page * 100 + index + 1, 'Unrelated'))], link: link(page + 1) }));
    expect(await githubPullRequestProvider.reconcileReview!(input, ctx)).toMatchObject({ status: 'unknown' });
    expect(ctx.http.request.mock.calls.filter(([request]) => request.path === path)).toHaveLength(20);
  });

  it.each(['head-moved', 'merged', 'closed', 'actor-changed'] as const)('reconciles the original receipt after %s', async changed => {
    const ctx = context(async request => {
      expect(request.method).toBe('GET');
      if (request.path === path) return { status: 200, body: [receipt(1)] };
      if (request.path === '/user') return { status: 200, body: { login: changed === 'actor-changed' ? 'replacement' : 'reviewer' } };
      return { status: 200, body: metadata(changed === 'head-moved' ? { head: { sha: 'b'.repeat(40), ref: 'work' } }
        : changed === 'merged' ? { state: 'closed', merged: true } : changed === 'closed' ? { state: 'closed' } : {}) };
    });
    expect(await githubPullRequestProvider.reconcileReview!(input, ctx)).toMatchObject({ status: 'acknowledged', receipt: { reviewId: 1, headSha: input.headSha, actor: input.actor } });
    expect(ctx.http.request.mock.calls.map(([request]) => request.path)).toEqual([path]);
  });

  it.each(['actor', 'head', 'body'] as const)('rejects a historical receipt with a mismatched %s', async changed => {
    const mismatched = { ...receipt(1), ...(changed === 'actor' ? { user: { login: 'replacement' } }
      : changed === 'head' ? { commit_id: 'b'.repeat(40) } : { body: 'Unrelated' }) };
    expect(await githubPullRequestProvider.reconcileReview!(input, fixture(() => ({ status: 200, body: [mismatched] })))).toMatchObject({ status: 'unknown' });
  });

  it.each(['head-moved', 'merged', 'actor-changed'] as const)('still refuses a new review after %s', async changed => {
    const ctx = context(async request => {
      expect(request.method).toBe('GET');
      if (request.path === '/user') return { status: 200, body: { login: changed === 'actor-changed' ? 'replacement' : 'reviewer' } };
      return { status: 200, body: metadata(changed === 'head-moved' ? { head: { sha: 'b'.repeat(40), ref: 'work' } }
        : changed === 'merged' ? { state: 'closed', merged: true } : {}) };
    });
    expect(await githubPullRequestProvider.invokeReview!(input, ctx)).toMatchObject({ status: 'unknown' });
    expect(ctx.http.request.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });

  it('stops pagination when cancellation arrives without acknowledging or sending a review', async () => {
    const controller = new AbortController();
    const ctx = fixture(() => { controller.abort(); return { status: 200, body: [receipt(1)], link: link(2) }; });
    expect(await githubPullRequestProvider.reconcileReview!(input, { ...ctx, signal: controller.signal })).toMatchObject({ status: 'unknown' });
    expect(ctx.http.request.mock.calls.filter(([request]) => request.path === path)).toHaveLength(1);
  });
});

describe('current list feedback',()=>{
  const commitAt='2025-01-02T00:00:00.000Z';const newer='2025-01-03T00:00:00.000Z';
  const comment=(id:number,login='other',created_at=newer)=>({id,user:{login},created_at,updated_at:newer,body:'Feedback'});
  function feedbackFixture(options:{reviews?:unknown[];issues?:unknown[];inline?:unknown[];failed?:string;changed?:boolean;partial?:boolean}={}){
    let reads=0;
    return context(async input=>{
      if(input.path===`/repos/${target.repo}/pulls`)return {status:200,body:[listed(42)]};
      if(input.path.endsWith('/42/reviews'))return {status:200,body:options.reviews??[]};
      if(input.path===`/repos/${target.repo}/pulls/42`){reads++;return {status:200,body:metadata(options.changed&&reads===2?{head:{sha:'f'.repeat(40),ref:'work'}}:{})};}
      if(input.path.includes('/commits/'))return {status:200,body:{sha:target.headSha,commit:{committer:{date:commitAt},author:{date:'2024-01-01T00:00:00.000Z'}}}};
      if(input.path.endsWith('/comments')){
        expect(input.query.since).toBe(commitAt);expect(input.query.per_page).toBe('25');
        if(input.path.includes(options.failed??'never-match'))return {status:503,body:null};
        const body=input.path.includes('/issues/')?options.issues??[]:options.inline??[];
        return {status:200,body,...(options.partial?{link:`<https://api.github.com${input.path}?${new URLSearchParams({...input.query,page:'2'})}>; rel="next"`}:{})};
      }
      throw new Error(`Unexpected ${input.path}`);
    });
  }
  const list=async(ctx:ReturnType<typeof context>)=>githubPullRequestProvider.list({query:{version:1,repo:target.repo,kind:'repo-open',limit:100},repos:[target.repo]},ctx);
  it.each(['issues','inline','review'] as const)('finds external %s feedback created after the immutable head committer time',async kind=>{
    const ctx=feedbackFixture(kind==='issues'?{issues:[comment(1)]}:kind==='inline'?{inline:[comment(1)]}:{reviews:[{...review(1,'COMMENTED',newer),body:'New feedback'}]});
    expect((await list(ctx)).items[0]?.feedback).toEqual({changesRequested:false,newComments:true,latestCommitAt:commitAt});
  });
  it('excludes author replies, edited older comments, equal-time comments and empty reviews',async()=>{
    const ctx=feedbackFixture({issues:[comment(1,'author'),comment(2,'other','2025-01-01T00:00:00.000Z'),comment(3,'other',commitAt)],reviews:[{...review(1,'COMMENTED',newer),body:'  '}]});
    expect((await list(ctx)).items[0]?.feedback).toMatchObject({changesRequested:false,newComments:false});
  });
  it('uses latest decisive review state, keeping COMMENTED from clearing requested changes and allowing approval or dismissal',async()=>{
    const entries=[{...review(1,'CHANGES_REQUESTED',commitAt,'alice'),body:''},{...review(2,'COMMENTED',newer,'alice'),body:''},
      {...review(3,'CHANGES_REQUESTED',commitAt,'bob'),body:''},{...review(4,'APPROVED',newer,'bob'),body:''},
      {...review(5,'CHANGES_REQUESTED',commitAt,'carol'),body:''},{...review(6,'DISMISSED',newer,'carol'),body:''}];
    const result=await list(feedbackFixture({reviews:entries}));expect(result.items[0]).toMatchObject({reviews:{changesRequested:1},feedback:{changesRequested:true,newComments:false}});
  });
  it.each([true,false])('retains only known positive comments from partial histories, found=%s',async found=>{
    const result=await list(feedbackFixture({issues:found?[comment(1)]:[],partial:true}));expect(result.items[0]?.feedback?.newComments).toBe(found?true:null);
  });
  it('preserves a known inline positive when issue comments fail, but does not report a false negative',async()=>{
    expect((await list(feedbackFixture({failed:'/issues/',inline:[comment(1)]}))).items[0]?.feedback?.newComments).toBe(true);
    expect((await list(feedbackFixture({failed:'/issues/'}))).items[0]?.feedback?.newComments).toBeNull();
  });
  it('clears feedback certainty when the observed PR head changes while collecting evidence',async()=>{
    expect((await list(feedbackFixture({issues:[comment(1)],changed:true}))).items[0]?.feedback).toEqual({changesRequested:null,newComments:null,latestCommitAt:null});
  });
  it('bounds freshness work to the first50 open rows and preserves counts with unknown comments outside that budget',async()=>{
    const ctx=context(async input=>{
      if(input.path===`/repos/${target.repo}/pulls`) {
        const size=Number(input.query.per_page);const start=(Number(input.query.page)-1)*size;
        return {status:200,body:Array.from({length:Math.min(size,60-start)},(_,index)=>listed(start+index+1))};
      }
      if(input.path.endsWith('/reviews'))return {status:200,body:[]};
      return {status:503,body:null};
    });
    const result=await list(ctx);expect(result.items).toHaveLength(60);expect(ctx.http.request.mock.calls.filter(([input])=>/\/pulls\/\d+$/.test(input.path))).toHaveLength(50);
    expect(result.items[59]?.feedback).toEqual({changesRequested:false,newComments:null,latestCommitAt:null});
  });
  it('returns positive list rows with unknown feedback after the attention deadline even when requests ignore cancellation',async()=>{
    vi.useFakeTimers();
    try {
      const ctx=context(async input=>input.path===`/repos/${target.repo}/pulls`?{status:200,body:[listed(42)]}:new Promise(()=>{}));
      const result=list(ctx);await vi.advanceTimersByTimeAsync(15001);expect((await result).items).toMatchObject([{number:42,reviews:null,feedback:{changesRequested:null,newComments:null}}]);
    }finally{vi.useRealTimers();}
  });
});

describe('GitHub pull request provider', () => {
  function teamListFixture(options: {
    pulls: unknown[];
    identity?: string | null;
    teams?: (page: number) => { status: number; body: unknown; link?: string; sso?: 'partial' | 'required' };
  }) {
    return context(async input => {
      if (input.path === '/user') return { status: 200, body: { login: options.identity === undefined ? 'reviewer' : options.identity } };
      if (input.path === '/user/teams') return options.teams?.(Number(input.query.page)) ?? { status: 200, body: [] };
      if (input.path === '/search/issues') return { status: 200, body: { items: [], total_count: 0, incomplete_results: false } };
      if (input.path === `/repos/${target.repo}/pulls`) return { status: 200, body: options.pulls };
      return { status: 503, body: null };
    });
  }
  const teamRequested = (number: number, id: number, slug = 'developers') => listed(number, { requested_teams: [{ id, slug }] });
  const requestedList = (ctx: ReturnType<typeof context>) => githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'review-requested', limit: 100 }, repos: [target.repo] }, ctx);

  it('includes authenticated team requests by stable ID alongside direct requests without matching unrelated same-slug teams', async () => {
    const ctx = teamListFixture({ pulls: [teamRequested(41, 1), teamRequested(42, 2), listed(43, { requested_reviewers: [{ login: 'reviewer' }] })],
      teams: () => ({ status: 200, body: [{ id: 1, slug: 'developers', organization: { login: 'first-org' } }] }) });
    expect(await requestedList(ctx)).toMatchObject({ quality: 'complete', truncated: false, items: [{ number: 41, reviewRequest: { direct: false, teams: [{ name: 'developers', slug: 'developers' }] } }, { number: 43, reviewRequest: { direct: true, teams: [] } }] });
    expect(ctx.http.request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });

  it('labels direct requests and every verified requested team without exposing unrelated teams', async () => {
    const ctx = teamListFixture({ pulls: [listed(42, { requested_reviewers: [{ login: 'REVIEWER' }], requested_teams: [
      { id: 1, slug: 'builder-devs', name: 'Builder developers' }, { id: 2, slug: 'final-approval', name: 'Final approval' },
      { id: 3, slug: 'unrelated', name: 'Unrelated team' }, { id: 1, slug: 'builder-devs', name: 'Builder developers' },
    ] })], teams: () => ({ status: 200, body: [{ id: 1 }, { id: 2 }] }) });
    expect((await requestedList(ctx)).items[0]?.reviewRequest).toEqual({ direct: true, teams: [
      { name: 'Builder developers', slug: 'builder-devs' }, { name: 'Final approval', slug: 'final-approval' },
    ] });
  });

  it('uses verified membership labels when a requested team has only an ID', async () => {
    const ctx = teamListFixture({ pulls: [listed(42, { requested_teams: [{ id: 1 }] })],
      teams: () => ({ status: 200, body: [{ id: 1, slug: 'builder-devs', name: 'Builder developers' }] }) });
    expect((await requestedList(ctx)).items[0]?.reviewRequest).toEqual({ direct: false, teams: [{ name: 'Builder developers', slug: 'builder-devs' }] });
  });

  it('enriches search-only request origins from PR metadata without trusting unrelated team names', async () => {
    const ctx = teamListFixture({ pulls: [], teams: () => ({ status: 200, body: [{ id: 1 }] }) });
    const original = ctx.http.request.getMockImplementation()!;
    ctx.http.request.mockImplementation(input => input.path === '/search/issues'
      ? Promise.resolve({ status: 200, body: { items: [listed(42)], total_count: 1, incomplete_results: false } })
      : input.path === `/repos/${target.repo}/pulls/42` ? Promise.resolve({ status: 200, body: metadata({ requested_reviewers: [], requested_teams: [{ id: 1, name: 'Builder developers', slug: 'builder-devs' }, { id: 2, slug: 'unrelated' }] }) })
        : original(input));
    expect((await requestedList(ctx)).items[0]?.reviewRequest).toEqual({ direct: false, teams: [{ name: 'Builder developers', slug: 'builder-devs' }] });
  });

  it('keeps search positives without inventing origins when request details are unavailable', async () => {
    const ctx = teamListFixture({ pulls: [] }); const original = ctx.http.request.getMockImplementation()!;
    ctx.http.request.mockImplementation(input => input.path === '/search/issues'
      ? Promise.resolve({ status: 200, body: { items: [listed(42)], total_count: 1, incomplete_results: false } }) : original(input));
    const result = await requestedList(ctx);
    expect(result.items).toHaveLength(1); expect(result.items[0]).not.toHaveProperty('reviewRequest');
  });

  it('validates team membership pagination and includes a requested team on the next page', async () => {
    const ctx = teamListFixture({ pulls: [teamRequested(42, 2)], teams: page => page === 1
      ? { status: 200, body: [{ id: 1 }], link: '<https://api.github.com/user/teams?per_page=100&page=2>; rel="next"' }
      : { status: 200, body: [{ id: 2 }] } });
    expect(await requestedList(ctx)).toMatchObject({ quality: 'complete', items: [{ number: 42 }] });
    expect(ctx.http.request.mock.calls.filter(([input]) => input.path === '/user/teams').map(([input]) => input.query.page)).toEqual(['1', '2']);
  });

  it.each(['partial', 'required'] as const)('reports GitHub SSO %s membership access without discarding proven direct or team requests', async sso => {
    const ctx = teamListFixture({ pulls: [teamRequested(41, 1), listed(42, { requested_reviewers: [{ login: 'reviewer' }] })],
      teams: () => ({ status: sso === 'required' ? 403 : 200, body: sso === 'required' ? null : [{ id: 1 }], sso }) });
    const result = await requestedList(ctx);
    expect(result).toMatchObject({ quality: sso === 'required' ? 'degraded' : 'partial', truncated: true, notice: 'github-sso-required' });
    expect(result.items.map(item => item.number)).toEqual(sso === 'required' ? [42] : [41, 42]);
  });

  it('keeps an empty SSO-filtered team response incomplete even when every visible pull has no team request', async () => {
    const ctx = teamListFixture({ pulls: [], teams: () => ({ status: 200, body: [], sso: 'partial' }) });
    expect(await requestedList(ctx)).toMatchObject({ quality: 'partial', truncated: true, notice: 'github-sso-required', items: [] });
  });

  it('retains the SSO notice when a later membership page succeeds after a filtered first page', async () => {
    const ctx = teamListFixture({ pulls: [teamRequested(41, 2)], teams: page => page === 1
      ? { status: 200, body: [{ id: 1 }], sso: 'partial', link: '<https://api.github.com/user/teams?per_page=100&page=2>; rel="next"' }
      : { status: 200, body: [{ id: 2 }] } });
    expect(await requestedList(ctx)).toMatchObject({ quality: 'partial', truncated: true, notice: 'github-sso-required', items: [{ number: 41 }] });
  });

  it('retains requested-review search positives while reporting SSO-filtered search coverage', async () => {
    const ctx = teamListFixture({ pulls: [] }); const original = ctx.http.request.getMockImplementation()!;
    ctx.http.request.mockImplementation(input => input.path === '/search/issues'
      ? Promise.resolve({ status: 200, body: { items: [listed(42)], total_count: 1, incomplete_results: false }, sso: 'partial' }) : original(input));
    expect(await requestedList(ctx)).toMatchObject({ quality: 'partial', truncated: true, notice: 'github-sso-required', items: [{ number: 42 }] });
  });

  it.each(['denied', 'malformed', 'identity-mismatch', 'foreign-next', 'repeated-next'] as const)('preserves direct requests without trusting unknown team membership: %s', async failure => {
    const ctx = teamListFixture({ identity: failure === 'identity-mismatch' ? 'another-user' : 'reviewer',
      pulls: [teamRequested(41, 1), listed(42, { requested_reviewers: [{ login: 'reviewer' }] })],
      teams: () => failure === 'denied' ? { status: 403, body: { message: 'Forbidden' } }
        : failure === 'malformed' ? { status: 200, body: [{ slug: 'developers' }] }
          : { status: 200, body: [{ id: 2 }], link: failure === 'foreign-next'
            ? '<https://attacker.example/user/teams?per_page=100&page=2>; rel="next"'
            : '<https://api.github.com/user/teams?per_page=100&page=1>; rel="next"' } });
    expect(await requestedList(ctx)).toMatchObject({ quality: 'degraded', items: [{ number: 42 }] });
    if (failure === 'identity-mismatch') expect(ctx.http.request.mock.calls.some(([input]) => input.path === '/user/teams')).toBe(false);
    expect(ctx.http.request.mock.calls.some(([input]) => input.path.includes('attacker'))).toBe(false);
  });

  it.each(['failed-page', 'bounded', 'malformed-row'] as const)('retains proven team membership matches while reporting incomplete coverage: %s', async failure => {
    const ctx = teamListFixture({ pulls: [teamRequested(41, 1), listed(42, { requested_reviewers: [{ login: 'reviewer' }] })],
      teams: page => failure === 'failed-page' && page === 2 ? { status: 403, body: null }
        : { status: 200, body: failure === 'bounded' ? Array.from({ length: 100 }, (_, index) => ({ id: (page - 1) * 100 + index + 1 }))
          : failure === 'malformed-row' ? [{ id: 1 }, null] : [{ id: 1 }],
        ...(failure !== 'malformed-row' ? { link: `<https://api.github.com/user/teams?per_page=100&page=${page + 1}>; rel="next"` } : {}) } });
    expect(await requestedList(ctx)).toMatchObject({ quality: 'partial', truncated: true, items: [{ number: 41 }, { number: 42 }] });
    expect(ctx.http.request.mock.calls.filter(([input]) => input.path === '/user/teams')).toHaveLength(failure === 'bounded' ? 3 : failure === 'failed-page' ? 2 : 1);
  });

  it('preserves direct requests after the membership deadline even when the transport ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const ctx = teamListFixture({ pulls: [teamRequested(41, 1), listed(42, { requested_reviewers: [{ login: 'reviewer' }] })] });
      const originalRequest = ctx.http.request.getMockImplementation()!;
      ctx.http.request.mockImplementation(input => input.path === '/user/teams' ? new Promise(() => {}) : originalRequest(input));
      const result = requestedList(ctx);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(result).resolves.toMatchObject({ quality: 'degraded', items: [{ number: 42 }] });
    } finally { vi.useRealTimers(); }
  });

  it.each(['repo-open','review-requested'] as const)('preserves positive %s rows when an independent source fails',async kind=>{
    const ctx=context(async input=>{
      if(input.path==='/search/issues')return {status:200,body:{total_count:1,incomplete_results:false,items:[listed(42)]}};
      if(input.path===`/repos/${target.repo}/pulls`)return {status:200,body:[listed(43,{requested_reviewers:[{login:'reviewer'}]})]};
      if(input.path==='/repos/org/unreadable/pulls')return {status:403,body:null};
      return {status:503,body:null};
    });
    const result=await githubPullRequestProvider.list({query:{version:1,repo:null,kind,limit:100},repos:[target.repo,'org/unreadable']},ctx);
    expect(result.quality).toBe('degraded');expect(result.items.map(item=>item.number)).toEqual(kind==='repo-open'?[43]:[42,43]);
  });
  it('preserves local requested rows when search fails and keeps rows received before a later page failure',async()=>{
    const ctx=context(async input=>{
      if(input.path==='/search/issues')return {status:422,body:null};
      if(input.path===`/repos/${target.repo}/pulls`)return input.query.page==='1'?{status:200,body:[listed(42,{requested_reviewers:[{login:'reviewer'}]})],link:`<https://api.github.com${input.path}?${new URLSearchParams({...input.query,page:'2'})}>; rel="next"`}:{status:503,body:null};
      return {status:503,body:null};
    });
    const result=await githubPullRequestProvider.list({query:{version:1,repo:target.repo,kind:'review-requested',limit:100},repos:[target.repo]},ctx);
    expect(result).toMatchObject({quality:'degraded',items:[{number:42}],truncated:true});
  });
  it('counts requested matches rather than raw rows when scanning bounded local review-requested pages',async()=>{
    const ctx=context(async input=>{
      if(input.path==='/search/issues')return {status:422,body:null};
      if(input.path===`/repos/${target.repo}/pulls`)return {status:200,body:input.query.page==='1'?Array.from({length:Number(input.query.per_page)},(_,index)=>listed(index+1,{requested_reviewers:[{login:'someone-else'}]})):[listed(101,{requested_reviewers:[{login:'ReViewer'}]})]};
      return {status:503,body:null};
    });
    const result=await githubPullRequestProvider.list({query:{version:1,repo:target.repo,kind:'review-requested',limit:1},repos:[target.repo]},ctx);
    expect(result).toMatchObject({quality:'complete',items:[{number:101}]});
    expect(ctx.http.request.mock.calls.filter(([input])=>input.path===`/repos/${target.repo}/pulls`).map(([input])=>input.query.page)).toEqual(['1','2']);
  });
  it.each(['repo-open', 'review-requested'] as const)('keeps large %s pull responses within the real transport limit', async kind => {
    const records = Array.from({ length: 126 }, (_, index) => listed(index + 1, { body: 'x'.repeat(30_000), base: { repo: { id: 123, full_name: target.repo } },
      requested_reviewers: index === 125 ? [{ login: 'reviewer' }] : [] }));
    expect(Buffer.byteLength(JSON.stringify(records.slice(0, 100)))).toBeGreaterThan(2 * 1024 * 1024);
    const signal = new AbortController().signal;
    const connection = { id: 'github', credentialHandle: 'github-test', origin: 'https://api.github.com', subject: 'reviewer' };
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/search/issues') return Response.json({ message: 'Validation failed' }, { status: 422 });
      if (url.pathname === `/repos/${target.repo}/pulls`) {
        const size = Number(url.searchParams.get('per_page')); const page = Number(url.searchParams.get('page'));
        const start = (page - 1) * size;
        return Response.json(records.slice(start, start + size), { headers: start + size < records.length
          ? { link: `<https://api.github.com/repositories/123/pulls?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), page: String(page + 1) })}>; rel="next"` } : {} });
      }
      return Response.json(null, { status: 503 });
    });
    const http = createPullRequestProviderHttp({ connection, signal, mutation: false, authorize: () => {}, fetcher,
      resolve: async () => ({ ...connection, headers: {} }) });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind, limit: 100 }, repos: [target.repo] }, { signal, configuredAuthor: 'reviewer', http });
    if (kind === 'review-requested') expect(result).toMatchObject({ quality: 'complete', truncated: false, items: [{ number: 126 }] });
    else { expect(result).toMatchObject({ quality: 'partial', truncated: true }); expect(result.items).toHaveLength(100); }
    const reads = fetcher.mock.calls.map(([url]) => new URL(String(url))).filter(url => url.pathname === `/repos/${target.repo}/pulls`);
    expect(reads).toHaveLength(kind === 'review-requested' ? 6 : 4);
    expect(reads.every(url => url.searchParams.get('per_page') === '25')).toBe(true);
  });
  it.each([false, true])('uses successful direct requested-review scanning when search rejects the query, bounded=%s', async bounded => {
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 422, body: null };
      if (input.path === `/repos/${target.repo}/pulls`) return { status: 200, body: bounded ? Array.from({ length: Number(input.query.per_page) }, (_, index) => listed(index + 1, { requested_reviewers: [] })) : [] };
      return { status: 503, body: null };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'review-requested', limit: 100 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ quality: bounded ? 'partial' : 'complete', items: [], truncated: bounded });
    expect(ctx.http.request.mock.calls.filter(([input]) => input.path === `/repos/${target.repo}/pulls`)).toHaveLength(bounded ? 12 : 1);
    expect(new URL(result.browseUrl ?? '').searchParams.get('q')).toBe('is:pr is:open review-requested:reviewer sort:created-desc');
    expect(ctx.http.request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
  it('retains positive search rows before a later search failure when the direct fallback succeeds', async () => {
    const ctx = context(async input => {
      if (input.path === '/search/issues') return input.query.page === '1'
        ? { status: 200, body: { total_count: 101, incomplete_results: false, items: [listed(42)] }, link: `<https://api.github.com/search/issues?${new URLSearchParams({ ...input.query, page: '2' })}>; rel="next"` }
        : { status: 503, body: null };
      if (input.path === `/repos/${target.repo}/pulls`) return { status: 200, body: [listed(43, { requested_reviewers: [{ login: 'reviewer' }] })] };
      return { status: 503, body: null };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'review-requested', limit: 100 }, repos: [target.repo] }, ctx);
    expect(result.quality).toBe('complete'); expect(result.items.map(item => item.number)).toEqual([42, 43]);
  });
  it('surfaces malformed requested-reviewer arrays as degraded without removing other local matches',async()=>{
    const ctx=context(async input=>{
      if(input.path==='/search/issues')return {status:200,body:{total_count:0,items:[],incomplete_results:false}};
      if(input.path===`/repos/${target.repo}/pulls`)return {status:200,body:[listed(41,{requested_reviewers:null}),listed(42,{requested_reviewers:[null]}),listed(43,{requested_reviewers:[{login:'reviewer'}]})]};
      return {status:503,body:null};
    });
    expect(await githubPullRequestProvider.list({query:{version:1,repo:target.repo,kind:'review-requested',limit:100},repos:[target.repo]},ctx)).toMatchObject({quality:'degraded',items:[{number:43}]});
  });
  it('accepts verified numeric pull pagination without widening strict inspection paths',async()=>{
    const ctx=context(async input=>{
      if(input.path===`/repos/${target.repo}/pulls`)return input.query.page==='1'?{status:200,body:[listed(42,{base:{repo:{id:123,full_name:target.repo}}})],link:`<https://api.github.com/repositories/123/pulls?${new URLSearchParams({...input.query,page:'2'})}>; rel="next"`}:{status:200,body:[listed(43)]};
      return {status:503,body:null};
    });
    expect((await githubPullRequestProvider.list({query:{version:1,repo:target.repo,kind:'repo-open',limit:100},repos:[target.repo]},ctx)).items.map(item=>item.number)).toEqual([42,43]);
    expect(ctx.http.request.mock.calls.filter(([input])=>input.path===`/repos/${target.repo}/pulls`).map(([input])=>input.query.page)).toEqual(['1','2']);
  });
  it.each(['valid','repeated','foreign','duplicate'] as const)('validates creator-filtered numeric issue cursor pagination: %s',async variant=>{
    const ctx=context(async input=>{
      if(input.path==='/search/issues')return {status:422,body:null};
      if(input.path===`/repos/${target.repo}`)return {status:200,body:{id:123,full_name:target.repo}};
      const parameters=new URLSearchParams({...input.query,page:String(Number(input.query.page)+1),after:'cursor_token='});
      if(variant==='duplicate')parameters.append('creator','different');
      if(input.path===`/repos/${target.repo}/issues`)return {status:200,body:[listed(Number(input.query.page)+40,{state:'closed',user:{login:'reviewer'}})],...(input.query.page==='1'||variant==='repeated'?{link:`<https://api.github.com/repositories/${variant==='foreign'?999:123}/issues?${parameters}>; rel="next"`}:{})};
      return {status:503,body:null};
    });
    const result=await githubPullRequestProvider.list({query:{version:1,repo:target.repo,kind:'authored-recent',limit:100},repos:[target.repo]},ctx);
    const requests=ctx.http.request.mock.calls.filter(([input])=>input.path===`/repos/${target.repo}/issues`);
    expect(requests).toHaveLength(variant==='valid'||variant==='repeated'?2:1);expect(result.items.length).toBe(variant==='valid'||variant==='repeated'?2:1);
    if(requests.length===2)expect(requests[1]?.[0].query.after).toBe('cursor_token=');
    expect(result.quality).toBe(variant==='valid'?'complete':'partial');
  });
  it('projects bounded profile names using the public authenticated HTTP service', async () => {
    const ctx = context(async () => ({ status: 200, body: { name: ' Person ', login: ' person ', token: 'private' } }));
    expect(await githubPullRequestProvider.profile!(ctx)).toEqual({ displayName: 'Person', login: 'person' });
    expect(ctx.http.request).toHaveBeenCalledWith({ method: 'GET', path: '/user', query: {}, body: null });
    for (const body of [null, {}, [], { name: null, login: 123 }, { name: '\nbad', login: 'x'.repeat(129) }]) expect(await githubPullRequestProvider.profile!(context(async () => ({ status: 200, body })))).toEqual({ displayName: null, login: null });
    for (const name of [null, '', '   ', 42]) expect(await githubPullRequestProvider.profile!({ ...context(async () => ({ status: 200, body: { name, login: 'person' } })), configuredAuthor: undefined })).toEqual({ displayName: 'person', login: 'person' });
    expect(await githubPullRequestProvider.profile!(context(async () => ({ status: 403, body: null })))).toEqual({ displayName: null, login: null });
    expect(await githubPullRequestProvider.profile!(context(async () => { throw new Error('private'); }))).toEqual({ displayName: null, login: null });
  });
  it('does not replace profile cancellation with a fallback identity', async () => {
    const controller = new AbortController(); const ctx = context(async () => { controller.abort(); return { status: 200, body: { name: 'Person', login: 'person' } }; });
    await expect(githubPullRequestProvider.profile!({ ...ctx, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('uses the configured author for lists without authenticating as that author', async () => {
    const call = vi.fn(async (input: { path: string; query: Readonly<Record<string, string>> }) => {
      expect(input.path).toBe('/search/issues');
      expect(input.query.q).toBe(`is:pr author:reviewer repo:${target.repo}`);
      return { status: 200, body: { total_count: 0, incomplete_results: false, items: [] } };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'authored-recent', limit: 100 }, repos: [target.repo] }, context(call));
    expect(result).toMatchObject({ quality: 'complete', items: [] });
    expect(call).toHaveBeenCalledOnce();
  });

  it('retains the recent authored window when search has more than three pages of history', async () => {
    const records = Array.from({ length: 100 }, (_, index) => listed(index + 1, { state: 'closed' }));
    const ctx = context(async input => {
      expect(input.path).toBe('/search/issues');
      expect(input.query.page).toBe('1');
      return { status: 200, body: { total_count: 395, incomplete_results: false, items: records },
        link: `<https://api.github.com/search/issues?${new URLSearchParams({ ...input.query, page: '2' })}>; rel="next"` };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ quality: 'partial', truncated: true });
    expect(result.items).toHaveLength(50);
    expect(ctx.http.request).toHaveBeenCalledOnce();
  });

  it('falls back to scoped recent PRs when search rejects a readable private repository', async () => {
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 422, body: { message: 'Validation failed' } };
      expect(input.path).toBe(`/repos/${target.repo}/issues`);
      expect(input.query).toMatchObject({ creator: 'reviewer', state: 'all', sort: 'created', direction: 'desc' });
      return { status: 200, body: [listed(42, { user: { login: 'ReViewer' }, state: 'closed', merged_at: '2025-01-03T00:00:00.000Z' }),
        listed(43, { user: { login: 'someone-else' } }), listed(44, { user: null, state: 'closed' }), listed(45,{user:{login:'reviewer'},pull_request:null})] };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ quality: 'complete', truncated: false, items: [{ number: 42, status: 'merged' }] });
    expect(result.items).toHaveLength(1);
    expect(result.browseUrl).toContain(`https://github.com/${target.repo}/pulls?q=`);
    expect(ctx.http.request).toHaveBeenCalledTimes(2);
  });

  it('preserves received authored matches when later fallback pages fail', async () => {
    const records = Array.from({ length: 25 }, (_, index) => listed(index + 1, { state: 'closed', user: { login: index < 3 ? 'reviewer' : 'other' } }));
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 422, body: {} };
      if (input.query.page === '1') return { status: 200, body: records,
        link: `<https://api.github.com${input.path}?${new URLSearchParams({ ...input.query, page: '2' })}>; rel="next"` };
      return { status: 503, body: {} };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ quality: 'partial', truncated: true });
    expect(result.items).toHaveLength(3);
    expect(ctx.http.request).toHaveBeenCalledTimes(3);
  });

  it('bounds creator-filtered fallback payloads to100 rows and keeps matches after its three-page window', async () => {
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 422, body: {} };
      expect(input.query.per_page).toBe('100');
      const page = Number(input.query.page);
      expect(page).toBeLessThanOrEqual(3);
      return { status: 200, body: Array.from({ length: 100 }, (_, index) => listed(page * 100 + index, { state: 'closed', user: { login: index === 0 ? 'reviewer' : 'other' } })),
        link: `<https://api.github.com${input.path}?${new URLSearchParams({ ...input.query, page: String(page + 1) })}>; rel="next"` };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ quality: 'partial', truncated: true });
    expect(result.items).toHaveLength(3);
    expect(ctx.http.request).toHaveBeenCalledTimes(4);
  });

  it.each([true, false])('validates canonical repository pagination before continuing when identity matches=%s', matching => {
    const records = Array.from({ length: 25 }, (_, index) => listed(index + 1, { state: 'closed', user: { login: 'other' }, base: { repo: { id: 123, full_name: target.repo } } }));
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 422, body: {} };
      if (input.path === `/repos/${target.repo}`) return {status:200,body:{id:123,full_name:target.repo}};
      expect(input.path).toBe(`/repos/${target.repo}/issues`);
      if (input.query.page === '1') return { status: 200, body: records,
        link: `<https://api.github.com/repositories/${matching ? 123 : 999}/issues?${new URLSearchParams({ ...input.query, page: '2' })}>; rel="next"` };
      return { status: 200, body: [listed(42, { state: 'closed', user: { login: 'reviewer' } })] };
    });
    return githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50 }, repos: [target.repo] }, ctx).then(result => {
      expect(result.items).toHaveLength(matching ? 1 : 0);
      expect(ctx.http.request).toHaveBeenCalledTimes(matching ? 4 : 3);
    });
  });

  it('retains matches from an incomplete search without requesting unsafe pagination', async () => {
    const ctx = context(async input => {
      expect(input.path).toBe('/search/issues');
      return { status: 200, body: { total_count: 395, incomplete_results: true, items: [listed(42, { state: 'closed' })] } };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ quality: 'partial', truncated: true, items: [{ number: 42 }] });
    expect(ctx.http.request).toHaveBeenCalledOnce();
  });

  it('bounds global fallback scans and keeps accessible galleons when another one fails', async () => {
    const repos = Array.from({ length: 10 }, (_, index) => `org/repo-${index}`);
    const ctx = context(async input => {
      if (input.path === '/search/issues') {
        expect(input.query.q).not.toContain('repo:org/repo-8');
        return { status: 422, body: {} };
      }
      if (input.path === '/repos/org/repo-1/issues') return { status: 404, body: {} };
      const repo = input.path.slice('/repos/'.length, -'/issues'.length);
      return { status: 200, body: [listed(42, { repository_url: `https://api.github.com/repos/${repo}`, state: 'closed', user: { login: 'reviewer' } })] };
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'authored-recent', limit: 50 }, repos }, ctx);
    expect(result.quality).not.toBe('complete');
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(7);
    expect(ctx.http.request).toHaveBeenCalledTimes(16);
  });

  it('projects effective counts only for final visible authored open pull requests', async () => {
    const first = listed(42, { requested_reviewers: [{ login: 'alice' }, { login: 'ALICE' }], requested_teams: [{ slug: 'alice' }] }); const skipped = listed(43);
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 200, body: { total_count: 2, incomplete_results: false, items: [first, skipped] } };
      if (input.path === `/repos/${target.repo}/pulls/42/reviews`) return { status: 200, body: [
        review(1, 'APPROVED', '2025-01-01T00:00:00.000Z', 'alice'), review(2, 'COMMENTED', '2025-01-02T00:00:00.000Z', 'alice'),
        review(3, 'CHANGES_REQUESTED', '2025-01-03T00:00:00.000Z', 'bob'), review(4, 'COMMENTED', '2025-01-04T00:00:00.000Z', 'carol'),
        review(5, 'DISMISSED', '2025-01-05T00:00:00.000Z', 'dan'), review(6, 'APPROVED', '2025-01-06T00:00:00.000Z', 'dan'),
      ] };
      throw new Error(`Unexpected request: ${input.path}`);
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'authored-recent', limit: 1 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ items: [{ number: 42, comments: 3, reviews: { approved: 2, changesRequested: 1, commented: 1, requested: 2 } }], quality: 'partial', truncated: true });
    expect(ctx.http.request.mock.calls.filter(([request]) => request.path.endsWith('/reviews')).map(([request]) => request.path)).toEqual([`/repos/${target.repo}/pulls/42/reviews`]);
  });

  it('reports zeros only for a complete empty authored open review history', async () => {
    const open = listed(42); const closed = listed(43, { state: 'closed' });
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 200, body: { total_count: 2, incomplete_results: false, items: [open, closed] } };
      if (input.path === `/repos/${target.repo}/pulls/42/reviews`) return { status: 200, body: [] };
      throw new Error(`Unexpected request: ${input.path}`);
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'authored-recent', limit: 2 }, repos: [target.repo] }, ctx);
    expect(result.items).toMatchObject([{ number: 42, reviews: { approved: 0, changesRequested: 0, commented: 0, requested: 0 } }, { number: 43, reviews: null }]);
    expect(ctx.http.request.mock.calls.filter(([request]) => request.path.endsWith('/reviews')).map(([request]) => request.path)).toEqual([`/repos/${target.repo}/pulls/42/reviews`]);
  });

  it('keeps authored pull requests when review histories are unavailable, malformed, or unsafe', async () => {
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 200, body: { total_count: 3, incomplete_results: false, items: [listed(42), listed(43), listed(44)] } };
      if (input.path.endsWith('/42/reviews')) return { status: 503, body: null };
      if (input.path.endsWith('/43/reviews')) return { status: 200, body: [review(1, 'APPROVED'), review(1, 'CHANGES_REQUESTED')] };
      if (input.path.endsWith('/44/reviews')) return { status: 200, body: [review(2, 'APPROVED')], link: '<https://other.test/reviews?page=2>; rel="next"' };
      throw new Error(`Unexpected request: ${input.path}`);
    });
    const result = await githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'authored-recent', limit: 3 }, repos: [target.repo] }, ctx);
    expect(result).toMatchObject({ quality: 'complete', items: [{ number: 42, comments: 3, reviews: null }, { number: 43, comments: 3, reviews: null }, { number: 44, comments: 3, reviews: null }] });
  });

  it('stops before scheduling queued authored review histories after cancellation', async () => {
    const controller = new AbortController(); let reviewCalls = 0;
    const ctx = context(async input => {
      if (input.path === '/search/issues') return { status: 200, body: { total_count: 5, incomplete_results: false, items: [42, 43, 44, 45, 46].map(number => listed(number)) } };
      if (input.path.endsWith('/reviews')) { reviewCalls++; if (reviewCalls === 4) controller.abort(); return { status: 200, body: [] }; }
      throw new Error(`Unexpected request: ${input.path}`);
    });
    await expect(githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'authored-recent', limit: 5 }, repos: [target.repo] }, { ...ctx, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(reviewCalls).toBe(4);
  });

  it.each(['search', 'local'] as const)('handles concurrent review reads when %s fails first', async first => {
    let rejectSearch!: (reason: Error) => void;
    let rejectLocal!: (reason: Error) => void;
    const search = new Promise<{ status: number; body: unknown }>((_, reject) => { rejectSearch = reject; });
    const local = new Promise<{ status: number; body: unknown }>((_, reject) => { rejectLocal = reject; });
    const ctx = context(input => input.path === '/search/issues' ? search : local);
    const result = githubPullRequestProvider.list({ query: { version: 1, repo: null, kind: 'review-requested', limit: 100 }, repos: [target.repo] }, ctx);
    const failures = first === 'search' ? [rejectSearch, rejectLocal] : [rejectLocal, rejectSearch];
    failures[0]!(new TypeError('fetch failed'));
    await new Promise(resolve => setTimeout(resolve, 0));
    failures[1]!(new TypeError('fetch failed'));
    await expect(result).resolves.toMatchObject({ quality: 'degraded', items: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ctx.http.request.mock.calls.map(([input]) => input.path).sort()).toEqual(['/user', '/search/issues', `/repos/${target.repo}/pulls`].sort());
  });

  it('projects checks and effective viewer approval from the immutable PR observation', async () => {
    const result = await githubPullRequestProvider.detail(query, context(async input => {
      if (input.path.endsWith('/check-runs')) return { status: 200, body: { total_count: 1, check_runs: [check()] } };
      if (input.path.endsWith('/status')) return { status: 200, body: { sha: target.headSha, total_count: 0, statuses: [] } };
      if (input.path.endsWith('/reviews')) return { status: 200, body: [review(1, 'APPROVED'), review(2, 'COMMENTED', '2025-01-03T03:04:05.000Z')] };
      return { status: 200, body: metadata() };
    }));
    expect(result).toMatchObject({ target, isOwnPr: false, checks: { quality: 'complete', passed: 1, failed: 0, pending: 0 },
      reviews: { quality: 'complete', approved: 1, commented: 0, requested: 1, viewerReview: 'APPROVED', viewerReviewedAt: '2025-01-03T03:04:05.000Z' } });
  });

  it('rejects detail and diff when the observed revision or comparison identity changes', async () => {
    let metadataReads = 0;
    await expect(githubPullRequestProvider.detail(query, context(async input => {
      if (input.path.endsWith('/check-runs')) return { status: 200, body: { total_count: 0, check_runs: [] } };
      if (input.path.endsWith('/status')) return { status: 200, body: { sha: target.headSha, total_count: 0, statuses: [] } };
      if (input.path.endsWith('/reviews')) return { status: 200, body: [] };
      if (input.path.endsWith('/comments')) return { status: 200, body: [] };
      metadataReads++;
      return { status: 200, body: metadata(metadataReads === 2 ? { head: { sha: 'e'.repeat(40), ref: 'work' } } : {}) };
    }))).rejects.toMatchObject({ reason: 'head-changed' });
    await expect(githubPullRequestProvider.diff({ version: 1, target }, context(async input => input.path.includes('/compare/')
      ? { status: 200, body: comparison({ url: 'https://api.github.com/repos/other/repo/compare/a...b' }) }
      : { status: 200, body: metadata() }))).rejects.toThrow('Invalid GitHub comparison response');
  });

  it('does not claim complete quality for incomplete totals or unsafe pagination links', async () => {
    const partial = await githubPullRequestProvider.detail(query, context(async input => {
      if (input.path.endsWith('/check-runs')) return { status: 200, body: { total_count: 2, check_runs: [check()] } };
      if (input.path.endsWith('/status')) return { status: 200, body: { sha: target.headSha, total_count: 0, statuses: [] } };
      if (input.path.endsWith('/reviews')) return { status: 200, body: [], link: '<https://other.test/token?page=2>; rel="next"' };
      return { status: 200, body: metadata() };
    }));
    expect(partial.checks).toMatchObject({ quality: 'partial', passed: null });
    expect(partial.reviews).toMatchObject({ quality: 'unavailable', approved: null });
  });

  it('reports provider file caps independently from patch preview clipping', async () => {
    const files = Array.from({ length: 300 }, (_, index) => file(String(index)));
    files[1]!.patch = 'x'.repeat(40 * 1024);
    const result = await githubPullRequestProvider.diff({ version: 1, target }, context(async input => input.path.includes('/compare/')
      ? { status: 200, body: comparison({ files }) }
      : { status: 200, body: metadata() }));
    expect(result).toMatchObject({ quality: 'partial', truncated: true });
    expect(result.files).toHaveLength(100);
    expect(result.files[1]).toMatchObject({ patchStatus: 'truncated' });
  });
});

describe('independent metadata evidence', () => {
  const submittedAt = '2025-01-02T03:04:05.000Z';
  const later = '2025-01-03T03:04:05.000Z';
  const comment = (id: number, body = 'Discussion text', author = 'alice') => ({ id, body, user: { login: author }, created_at: submittedAt, html_url: `https://github.com/${target.repo}/pull/${target.number}#issuecomment-${id}` });
  const detailedReview = (id: number, state: string, login: string, body = 'Review text', at = submittedAt) => ({ ...review(id, state, at, login), body, html_url: `https://github.com/${target.repo}/pull/${target.number}#pullrequestreview-${id}` });
  const detailedCheck = (id: number, name: string, conclusion: string | null = 'success') => ({ ...check(), id, name, conclusion, html_url: `https://github.com/${target.repo}/actions/runs/${id}` });
  function fixture(options: { comments?: unknown[]; commentStatus?: number; reviews?: unknown[]; checks?: unknown[]; statuses?: unknown[]; raw?: Record<string, unknown>; updated?: boolean } = {}) {
    let reads = 0;
    return context(async input => {
      if (input.path.endsWith('/check-runs')) return { status: 200, body: { total_count: options.checks?.length ?? 0, check_runs: options.checks ?? [] } };
      if (input.path.endsWith('/status')) return { status: 200, body: { sha: target.headSha, total_count: options.statuses?.length ?? 0, statuses: options.statuses ?? [] } };
      if (input.path.endsWith('/reviews')) { const page = Number(input.query.page ?? '1'); return { status: 200, body: (options.reviews ?? []).slice((page - 1) * 100, page * 100) }; }
      if (input.path.endsWith('/comments')) return { status: options.commentStatus ?? 200, body: options.comments ?? [] };
      reads++;
      return { status: 200, body: metadata({ comments: options.comments?.length ?? 0, ...options.raw, ...(options.updated && reads === 2 ? { updated_at: later } : {}) }) };
    });
  }
  it('retains decisive changes requested bodies, approved/requested names and check names without changing legacy counts', async () => {
    const ctx = fixture({ comments: [comment(1, '<img src=x>\nLiteral content'), comment(2)],
      reviews: [detailedReview(1, 'CHANGES_REQUESTED', 'alice', 'Must fix'), detailedReview(2, 'COMMENTED', 'alice', 'Later comment', later),
        detailedReview(3, 'CHANGES_REQUESTED', 'bob'), detailedReview(4, 'APPROVED', 'bob', '', later), detailedReview(5, 'CHANGES_REQUESTED', 'carol'), detailedReview(6, 'DISMISSED', 'carol', '', later)],
      raw: { requested_reviewers: [{ login: 'DAVE' }, { login: 'dave' }], requested_teams: [{ slug: 'platform' }] },
      checks: [detailedCheck(1, 'Build'), detailedCheck(2, 'Unit tests', 'failure'), detailedCheck(3, 'Integration', null)],
      statuses: [{ id: 4, context: 'Deploy', state: 'pending', updated_at: submittedAt, target_url: 'https://ci.example.com/job/4' }] });
    const result = await githubPullRequestProvider.detail(query, ctx);
    expect(result.comments).toBe(2); expect(result.checks).toEqual({ quality: 'complete', passed: 1, failed: 1, pending: 2 });
    expect(result.reviews).toMatchObject({ approved: 1, changesRequested: 1, requested: 2 });
    expect(result.evidence?.changesRequested).toMatchObject({ quality: 'complete', items: [{ id: 'review:1', author: 'alice', body: 'Must fix' }] });
    expect(result.evidence?.approved.items.map(item => item.label)).toEqual(['bob']);
    expect(result.evidence?.requested.items.map(item => item.label)).toEqual(['dave', 'team:platform']);
    expect(result.evidence?.checksPassed.items.map(item => item.name)).toEqual(['Build']);
    expect(result.evidence?.checksFailed.items.map(item => item.name)).toEqual(['Unit tests']);
    expect(result.evidence?.checksPending.items.map(item => item.name)).toEqual(['Integration', 'Deploy']);
    expect(result.evidence?.comments.items[0]?.body).toBe('<img src=x>\nLiteral content');
    expect(ctx.http.request.mock.calls.filter(([input]) => input.path.endsWith('/comments')).map(([input]) => input.path)).toEqual([`/repos/${target.repo}/issues/${target.number}/comments`]);
  });
  it('keeps names and counts independently available when discussion bodies or names are malformed', async () => {
    const result = await githubPullRequestProvider.detail(query, fixture({ commentStatus: 403, reviews: [review(1, 'CHANGES_REQUESTED'), detailedReview(2, 'APPROVED', 'bob')], checks: [{ ...check(), id: 1 }] }));
    expect(result.reviews).toMatchObject({ quality: 'complete', changesRequested: 1, approved: 1 }); expect(result.checks).toMatchObject({ quality: 'complete', passed: 1 });
    expect(result.evidence?.comments).toEqual({ quality: 'unavailable', truncated: false, items: [] });
    expect(result.evidence?.changesRequested).toEqual({ quality: 'partial', truncated: false, items: [] });
    expect(result.evidence?.approved).toMatchObject({ quality: 'complete', items: [{ label: 'bob' }] });
    expect(result.evidence?.checksPassed).toEqual({ quality: 'partial', truncated: false, items: [] });
  });
  it('clips UTF-8 body previews explicitly while preserving aggregate counts and independently capped response bytes', async () => {
    const result = await githubPullRequestProvider.detail(query, fixture({ comments: [comment(1, 'é'.repeat(3000))], reviews: [detailedReview(1, 'CHANGES_REQUESTED', 'alice', '\n'.repeat(8000))] }));
    expect(result.evidence?.comments.items[0]).toMatchObject({ body: 'é'.repeat(2048), bodyTruncated: true });
    expect(result.evidence?.changesRequested.items[0]).toMatchObject({ body: '\n'.repeat(4096), bodyTruncated: true });
    const capped = await githubPullRequestProvider.detail(query, fixture({ comments: Array.from({ length: 100 }, (_, index) => comment(index + 1, '\n'.repeat(4096))),
      reviews: Array.from({ length: 100 }, (_, index) => detailedReview(index + 1, 'CHANGES_REQUESTED', `reviewer-${index}`, '\n'.repeat(4096))) }));
    expect(new TextEncoder().encode(JSON.stringify(capped.evidence)).byteLength).toBeLessThanOrEqual(512 * 1024);
    expect(capped.comments).toBe(100); expect(capped.reviews.changesRequested).toBe(100);
    expect(capped.evidence?.comments).toMatchObject({ quality: 'partial', truncated: true });
  });
  it('drops non-pinned review/comment observations if metadata changes during independent reads', async () => {
    const result = await githubPullRequestProvider.detail(query, fixture({ updated: true, comments: [comment(1)], reviews: [detailedReview(1, 'APPROVED', 'alice')], checks: [detailedCheck(1, 'Build')] }));
    expect(result.reviews.quality).toBe('partial'); expect(result.evidence?.approved).toEqual({ quality: 'partial', truncated: false, items: [] });
    expect(result.evidence?.comments).toEqual({ quality: 'partial', truncated: false, items: [] });
    expect(result.evidence?.checksPassed.items).toHaveLength(1);
  });
});

it.each(['open', 'all', undefined] as const)('scopes recent authored search and browsing to the selected state %s', async state => {
  const ctx = context(async input => {
    if (input.path === '/search/issues') {
      expect(input.query.q).toBe(`is:pr${state === 'open' ? ' is:open' : ''} author:reviewer repo:${target.repo}`);
      return { status: 200, body: { total_count: 2, incomplete_results: false, items: [listed(41, { state: 'closed', user: { login: 'reviewer' } }), listed(42, { user: { login: 'reviewer' } })] } };
    }
    if (input.path.endsWith('/reviews')) return { status: 200, body: [] };
    return { status: 503, body: null };
  });
  const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50, ...(state === undefined ? {} : { state }) }, repos: [target.repo] }, ctx);
  expect(result.items.map(item => item.status)).toEqual(state === 'open' ? ['open'] : ['closed', 'open']);
  expect(new URL(result.browseUrl!).searchParams.get('q')).toBe(`is:pr${state === 'open' ? ' is:open' : ''} author:reviewer sort:created-desc`);
});
it('uses the open issue fallback and discards closed or merged rows from inconsistent upstream responses', async () => {
  const ctx = context(async input => {
    if (input.path === '/search/issues') return { status: 422, body: null };
    if (input.path === `/repos/${target.repo}/issues`) {
      expect(input.query.state).toBe('open');
      return { status: 200, body: [listed(41, { state: 'closed', user: { login: 'reviewer' } }), listed(42, { user: { login: 'reviewer' } }), listed(43, { state: 'closed', merged_at: '2025-01-03T00:00:00Z', user: { login: 'reviewer' } })] };
    }
    if (input.path.endsWith('/reviews')) return { status: 200, body: [] };
    return { status: 503, body: null };
  });
  const result = await githubPullRequestProvider.list({ query: { version: 1, repo: target.repo, kind: 'authored-recent', limit: 50, state: 'open' }, repos: [target.repo] }, ctx);
  expect(result.items.map(item => item.number)).toEqual([42]);
});
it('caps check names independently from complete aggregate counts after following bounded pagination', async () => {
  const checks = Array.from({ length: 150 }, (_, index) => ({ ...check(index + 1), name: `Check ${index + 1}`, html_url: null }));
  const ctx = context(async input => {
    if (input.path.endsWith('/check-runs')) {
      const page = Number(input.query.page); return { status: 200, body: { total_count: checks.length, check_runs: checks.slice((page - 1) * 100, page * 100) },
        ...(page === 1 ? { link: `<https://api.github.com${input.path}?per_page=100&page=2>; rel="next"` } : {}) };
    }
    if (input.path.endsWith('/status')) return { status: 200, body: { sha: target.headSha, total_count: 0, statuses: [] } };
    if (input.path.endsWith('/reviews') || input.path.endsWith('/comments')) return { status: 200, body: [] };
    return { status: 200, body: metadata({ comments: 0 }) };
  });
  const result = await githubPullRequestProvider.detail(query, ctx);
  expect(result.checks).toEqual({ quality: 'complete', passed: 150, failed: 0, pending: 0 });
  expect(result.evidence?.checksPassed).toMatchObject({ quality: 'partial', truncated: true });
  expect(result.evidence?.checksPassed.items).toHaveLength(100);
});
