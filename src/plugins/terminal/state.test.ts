import { beforeEach, expect, it } from 'vitest';
import { emptyState, parseDraft, TerminalStorage } from './state';
import type { TerminalControlReceiptV1 } from '@helmsman/plugin-sdk';
beforeEach(()=>localStorage.clear());
const prefix='helmsman.terminal.v1:helmsman.terminal/panel:terminal:';
const makeReceipt=():TerminalControlReceiptV1=>({version:1,requestId:'b0ef36b8-e7a2-4b24-a343-2dac4b561824',input:{version:1,target:{repo:'org/b',surfaceRef:'surface:1',revision:'a'.repeat(64)},operation:{kind:'image',mimeType:'image/png',dataBase64:'A'.repeat(2*1024*1024)}},status:'recovery-required',reason:'Unknown delivery'});
it('retains a maximum-sized image receipt and inspection evidence within the public response bound',()=>{const storage=new TerminalStorage('helmsman.terminal/panel','terminal');const value=makeReceipt();storage.result(value);storage.inspected(value);expect(storage.results()).toEqual([value]);});
it('preserves corrupt or future inspection records and refuses to overwrite their original bytes',()=>{const storage=new TerminalStorage('helmsman.terminal/panel','terminal');const value=makeReceipt();const key=prefix+`inspected:${value.requestId}`;localStorage.setItem(key,'{"version":9,"future":true}');expect(()=>storage.results()).toThrow('inspection evidence');expect(()=>storage.inspected(value)).toThrow('Original data is kept');expect(localStorage.getItem(key)).toBe('{"version":9,"future":true}');});
it('requires mounted identity and keeps unknown draft fields unchanged',()=>{expect(()=>new TerminalStorage(undefined,'terminal')).toThrow('identity');expect(()=>parseDraft({...emptyState(),future:true})).toThrow('unsupported format');expect(()=>parseDraft({...emptyState(),collapsed:{tabs:false,screen:false,future:true}})).toThrow('unsupported format');});
