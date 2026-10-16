import {describe,expect,it} from 'vitest';
import {parsePullRequestReadItemV1,parsePullRequestReadQueryV1,parsePullRequestReadPageV1} from './pull-request-read';
const item={repo:'owner/project',number:1,title:'Work',url:null,status:'open',createdAt:'2026-10-14T00:00:00Z',mergedAt:null,draft:false,ticketId:null,reviewDecision:null,comments:null,reviews:null};
describe('optional pull request author and personal review history', () => {
  it('preserves older providers and nullable personal review evidence', () => {
    const legacy = parsePullRequestReadItemV1(item);
    expect(legacy).not.toHaveProperty('authorLogin');
    expect(legacy).not.toHaveProperty('viewerHasReviewed');
    for (const viewerHasReviewed of [true, false, null]) {
      expect(parsePullRequestReadItemV1({ ...item, authorLogin: 'contributor', viewerHasReviewed })).toMatchObject({ authorLogin: 'contributor', viewerHasReviewed });
    }
    expect(parsePullRequestReadItemV1({ ...item, authorLogin: null }).authorLogin).toBeNull();
  });
  it.each(['', '  ', 'a'.repeat(129), 'author\nname', 42, {}])('rejects an invalid author %j', authorLogin => {
    expect(() => parsePullRequestReadItemV1({ ...item, authorLogin })).toThrow('Invalid pull request read data');
  });
  it.each(['false', 0, {}, []])('rejects invalid personal review evidence %j', viewerHasReviewed => {
    expect(() => parsePullRequestReadItemV1({ ...item, viewerHasReviewed })).toThrow('Invalid pull request read data');
  });
});
describe('optional pull request feedback',()=>{
  it('preserves backward compatible rows and freezes nullable evidence flags',()=>{
    expect(parsePullRequestReadItemV1(item)).not.toHaveProperty('feedback');
    const feedback={changesRequested:true,newComments:null,latestCommitAt:'2026-10-13T00:00:00Z'};
    expect(parsePullRequestReadItemV1({...item,feedback}).feedback).toEqual(feedback);expect(Object.isFrozen(parsePullRequestReadItemV1({...item,feedback}).feedback)).toBe(true);
  });
  it.each([null,{}, {changesRequested:'true',newComments:false,latestCommitAt:null},{changesRequested:false,newComments:0,latestCommitAt:null},{changesRequested:null,newComments:null,latestCommitAt:'bad'}])('rejects malformed feedback %j',feedback=>{
    expect(()=>parsePullRequestReadItemV1({...item,feedback})).toThrow('Invalid pull request read data');
  });
  it('rejects row and nested feedback accessors without invoking them',()=>{
    const getter=()=>{throw new Error('Accessor was executed');};
    const feedback={changesRequested:false,newComments:false,latestCommitAt:null};Object.defineProperty(feedback,'newComments',{get:getter});
    expect(()=>parsePullRequestReadItemV1({...item,feedback})).toThrow('Invalid pull request read data');
    const row={...item};Object.defineProperty(row,'feedback',{get:getter});expect(()=>parsePullRequestReadItemV1(row)).toThrow('Invalid pull request read data');
  });
});

describe('authored status selection',()=>{
  const query={version:1,repo:'owner/project',kind:'authored-recent',limit:25} as const;
  it('keeps absent state compatible and accepts explicit open and all',()=>{
    expect(parsePullRequestReadQueryV1(query)).not.toHaveProperty('state');
    for(const state of ['open','all'] as const) expect(parsePullRequestReadQueryV1({...query,state}).state).toBe(state);
  });
  it.each([undefined,null,'closed','merged',''])('rejects invalid explicit state %j',state=>{
    expect(()=>parsePullRequestReadQueryV1({...query,state})).toThrow();
  });
  it.each(['repo-open','review-requested'])('rejects state on %s',kind=>{
    expect(()=>parsePullRequestReadQueryV1({...query,kind,state:'open'})).toThrow();
  });
  it('rejects terminal rows in an open window while preserving all history',()=>{
    const page={version:1,repo:query.repo,kind:query.kind,quality:'complete',truncated:false,browseUrl:null,items:[{...item,status:'closed'}]};
    expect(()=>parsePullRequestReadPageV1(page,{...query,state:'open'},[query.repo])).toThrow();
    expect(parsePullRequestReadPageV1(page,{...query,state:'all'},[query.repo]).items[0]?.status).toBe('closed');
    expect(parsePullRequestReadPageV1(page,query,[query.repo]).items).toHaveLength(1);
  });
});

it('preserves only supported SSO notices on incomplete PR lists', () => {
  const query = { version: 1, repo: item.repo, kind: 'review-requested', limit: 25 } as const;
  const page = { version: 1, repo: item.repo, kind: query.kind, items: [], quality: 'partial', truncated: false, browseUrl: null, notice: 'github-sso-required' };
  expect(parsePullRequestReadPageV1(page, query, [item.repo]).notice).toBe('github-sso-required');
  expect(() => parsePullRequestReadPageV1({ ...page, quality: 'complete' }, query, [item.repo])).toThrow();
  expect(() => parsePullRequestReadPageV1({ ...page, notice: 'https://example.com/private-token' }, query, [item.repo])).toThrow();
});


describe('review request origins', () => {
  it('preserves absent origins and freezes both direct and team evidence', () => {
    expect(parsePullRequestReadItemV1(item)).not.toHaveProperty('reviewRequest');
    const reviewRequest = { direct: true, teams: [{ name: 'Builder developers', slug: 'builder-devs' }] };
    const parsed = parsePullRequestReadItemV1({ ...item, reviewRequest });
    expect(parsed.reviewRequest).toEqual(reviewRequest);
    expect(Object.isFrozen(parsed.reviewRequest)).toBe(true);
    expect(Object.isFrozen(parsed.reviewRequest?.teams)).toBe(true);
    expect(Object.isFrozen(parsed.reviewRequest?.teams[0])).toBe(true);
  });
  it.each([null, {}, { direct: 'true', teams: [] }, { direct: false, teams: [] },
    { direct: true, teams: [null] }, { direct: false, teams: [{ name: '', slug: 'devs' }] },
    { direct: false, teams: [{ name: 'Devs', slug: '../devs' }] },
    { direct: true, teams: [{ name: 'Devs', slug: 'devs' }, { name: 'Other', slug: 'DEVS' }] },
    { direct: true, teams: Array.from({ length: 101 }, (_, index) => ({ name: 'Devs', slug: `devs-${index}` })) },
  ])('rejects malformed or unbounded origin %j', reviewRequest => {
    expect(() => parsePullRequestReadItemV1({ ...item, reviewRequest })).toThrow('Invalid pull request read data');
  });
  it('rejects nested origin and array accessors without executing them', () => {
    const getter = () => { throw new Error('Accessor was executed'); };
    const team = { name: 'Devs', slug: 'devs' }; Object.defineProperty(team, 'name', { get: getter });
    expect(() => parsePullRequestReadItemV1({ ...item, reviewRequest: { direct: false, teams: [team] } })).toThrow('Invalid pull request read data');
    const teams: unknown[] = []; Object.defineProperty(teams, '0', { get: getter });
    expect(() => parsePullRequestReadItemV1({ ...item, reviewRequest: { direct: true, teams } })).toThrow('Invalid pull request read data');
  });
});
