import {describe,expect,it} from 'vitest';
import {parsePullRequestReadItemV1} from './pull-request-read';
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
