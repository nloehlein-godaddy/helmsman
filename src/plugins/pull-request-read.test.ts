import {describe,expect,it} from 'vitest';
import {parsePullRequestReadItemV1,parsePullRequestReadQueryV1,parsePullRequestReadPageV1} from './pull-request-read';
const item={repo:'owner/project',number:1,title:'Work',url:null,status:'open',createdAt:'2026-10-14T00:00:00Z',mergedAt:null,draft:false,ticketId:null,reviewDecision:null,comments:null,reviews:null};
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
