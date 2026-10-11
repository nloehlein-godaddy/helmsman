import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClarificationCommandPendingV1, ClarificationCommandReceiptV1, ClarificationCommandServiceV1, ClarificationReadItemV1,
  ClarificationReadServiceV1, PanelOpaqueStateV1, PluginPanelContext, PluginPanelInstance, PluginPanelState } from '@helmsman/plugin-sdk';
import panel from './panel';
const requestId = '00000000-0000-4000-8000-000000000001'; const channel = '00000000-0000-4000-8000-000000000002';
const now = '2026-09-20T00:00:00Z';
const question = (patch: Partial<ClarificationReadItemV1> = {}): ClarificationReadItemV1 => ({ version: 1, id: 'q', repo: 'org/a', runId: 'run', revision: 1, prompt: 'Preserve the existing API?', required: true, owner: 'local', contactId: null,
  state: 'pending', answer: null, createdAt: now, timeoutAt: null, answeredAt: null, provenance: { kind: 'attempt-channel', attempt: 2, channelId: channel }, currentAttempt: 2, blocksPublication: true, answerability: { available: true, reason: null }, ...patch });
const lifetimes: AbortController[] = [];
afterEach(() => { lifetimes.splice(0).forEach(value => value.abort()); document.body.replaceChildren(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });
const button = (container: HTMLElement, label: string) => { const value = [...container.querySelectorAll('button')].find(value => value.textContent === label); if (!value) throw new Error(`Missing ${label}`); return value; };
const edit = (container: HTMLElement, text: string) => { const input = container.querySelector('textarea')!; input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
async function fixture(initial: PanelOpaqueStateV1 | null = null) {
  const container = document.createElement('div'); document.body.append(container); const lifetime = new AbortController(); lifetimes.push(lifetime); let activity = new AbortController();
  let state: PluginPanelState = { repo: 'org/a', themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'questions', savedState: initial, activity: { repo: 'org/a', epoch: 1, active: true, signal: activity.signal } };
  const data = { pending: [] as ClarificationCommandPendingV1[], questions: [question()], saved: initial, quota: false, loss: false };
  const list = vi.fn<ClarificationReadServiceV1['list']>(async query => ({ status: 'available', value: { version: 1, repo: query.repo, items: data.questions, nextCursor: query.cursor ? null : 'next', total: 26, observedAt: now } }));
  const commands: ClarificationCommandServiceV1 = { version: 1, pending: vi.fn(async () => data.pending),
    submit: vi.fn<ClarificationCommandServiceV1['submit']>(async input => {
      const command = data.pending.find(value => value.command.questionId === input.questionId)?.command ?? { ...input, requestId };
      const receipt: ClarificationCommandReceiptV1 = { version: 1, requestId, input, status: 'succeeded', reason: null, result: { questionId: input.questionId, revision: input.expectedQuestionRevision + 1, answer: input.answer, answeredAt: now } };
      data.pending = [{ command, receipt: data.loss ? null : receipt }];
      return data.loss ? { status: 'unavailable', reason: 'connection-failed' } : { status: 'available', value: receipt };
    }), retry: vi.fn<NonNullable<ClarificationCommandServiceV1['retry']>>(async query => {
      const entry = data.pending.find(item => item.command.repo === query.repo && item.command.requestId === query.requestId);
      return entry?.receipt ? { status: 'available', value: entry.receipt } : { status: 'unavailable', reason: entry ? 'connection-failed' : 'not-found' };
    }), receipt: vi.fn<ClarificationCommandServiceV1['receipt']>(async () => ({ status: 'available', value: data.pending[0]?.receipt ?? null })), acknowledge: vi.fn(async query => { expect(JSON.stringify(data.saved)).toContain(query.requestId); data.pending = data.pending.filter(value => value.command.requestId !== query.requestId); }) };
  let instance: PluginPanelInstance;
  const compare = vi.fn<NonNullable<PluginPanelContext['compareAndSetState']>>(async (expected, next) => { if (data.quota) throw new Error('Quota'); if (JSON.stringify(expected) !== JSON.stringify(data.saved)) throw new Error('Conflict'); data.saved = structuredClone(next); state = { ...state, savedState: data.saved }; await instance.update(state); });
  const context: PluginPanelContext = { state, signal: lifetime.signal, activity: state.activity, services: { version: 1, clarifications: { version: 1, list, load: vi.fn() }, clarificationCommands: commands }, compareAndSetState: compare, saveState: vi.fn(), onDispose: vi.fn(), navigate: vi.fn(), selectPresentation: vi.fn() };
  instance = await panel.mount(container, context); await instance.refresh?.();
  return { container, instance, context, data, commands, list, compare, async update(patch: Partial<PluginPanelState>) { if (patch.visible === false || patch.repo !== undefined) { activity.abort(); activity = new AbortController(); } state = { ...state, ...patch, activity: { repo: patch.repo ?? state.repo, active: patch.visible ?? state.visible, epoch: state.activity.epoch + 1, signal: activity.signal } }; await instance.update(state); }, async external(saved: PanelOpaqueStateV1) { data.saved = saved; state = { ...state, savedState: saved }; await instance.update(state); } };
}
describe('independent authored questions', () => {
  it('uses only question services, preserves scoped pagination on refresh and emits typed run selection', async () => {
    const f = await fixture(); expect(f.context.services.suggestedContacts).toBeUndefined();
    button(f.container, 'Next page').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Page 2'));
    await f.instance.refresh?.(); expect(f.list).toHaveBeenLastCalledWith(expect.objectContaining({ repo: 'org/a', limit: 25, cursor: 'next' }), expect.any(AbortSignal));
    button(f.container, 'Open run').click(); expect(f.context.selectPresentation).toHaveBeenCalledWith({ version: 1, kind: 'run', repo: 'org/a', runId: 'run' });
    window.history.replaceState(null, '', '/plugins/example.questions/page?repo=org/header'); await f.instance.refresh?.(); f.container.querySelector('a')!.click(); expect(f.context.navigate).toHaveBeenCalledWith(expect.stringContaining('repo=org%2Fheader'));
  });
  it('keeps unknown provenance read-only and required blocking', async () => {
    const f = await fixture(); f.data.questions = [question({ provenance: { kind: 'legacy-unproven', attempt: null, channelId: null }, answerability: { available: false, reason: 'provenance-unknown' } })]; await f.instance.refresh?.();
    expect(f.container.textContent).toContain('Blocks publication'); expect(f.container.textContent).toContain('Read-only: provenance-unknown'); expect(button(f.container, 'Accept answer').disabled).toBe(true);
  });
  it('saves drafts and terminal results before explicit acknowledgment and retains editable text', async () => {
    const f = await fixture(); edit(f.container, ' Yes '); await vi.waitFor(() => expect(f.compare).toHaveBeenCalled()); button(f.container, 'Accept answer').click();
    await vi.waitFor(() => expect(f.container.querySelector('[data-request-id]')).not.toBeNull()); expect(f.commands.submit).toHaveBeenCalledWith(expect.objectContaining({ answer: 'Yes', expectedAttempt: 2, expectedChannelId: channel, expectedQuestionRevision: 1 }), expect.any(AbortSignal));
    expect(f.commands.acknowledge).not.toHaveBeenCalled(); await f.instance.refresh?.(); expect(f.commands.acknowledge).not.toHaveBeenCalled();
    button(f.container, 'Save result and dismiss request').click(); await vi.waitFor(() => expect(f.commands.acknowledge).toHaveBeenCalledOnce()); expect(f.container.querySelector('textarea')?.value).toBe(' Yes '); expect(JSON.stringify(f.data.saved)).toContain(requestId);
  });
  it('retains immutable original delivery through response loss and changed drafts; check does not resend', async () => {
    const f = await fixture(); f.data.loss = true; edit(f.container, 'Original'); button(f.container, 'Accept answer').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Outcome unknown'));
    edit(f.container, 'New unsent text'); button(f.container, 'Check receipt').click(); await vi.waitFor(() => expect(f.commands.receipt).toHaveBeenCalledOnce()); expect(f.commands.submit).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(button(f.container, 'Retry original').disabled).toBe(false)); button(f.container, 'Retry original').click(); await vi.waitFor(() => expect(f.commands.retry).toHaveBeenCalledOnce()); expect(f.commands.retry).toHaveBeenCalledWith({ repo: 'org/a', requestId }, expect.any(AbortSignal)); expect(f.commands.submit).toHaveBeenCalledOnce(); expect(f.data.pending[0]?.command.answer).toBe('Original'); expect(f.container.querySelector('textarea')?.value).toBe('New unsent text');
  });
  it('blocks acknowledgment when newer draft/result state cannot save, then retries without resubmission', async () => {
    const f = await fixture(); edit(f.container, 'Original'); button(f.container, 'Accept answer').click(); await vi.waitFor(() => expect(f.container.querySelector('[data-request-id]')).not.toBeNull());
    f.data.quota = true; edit(f.container, 'Newer'); button(f.container, 'Save result and dismiss request').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('could not be written')); expect(f.commands.acknowledge).not.toHaveBeenCalled(); expect(f.container.querySelector('textarea')?.value).toBe('Newer');
    f.data.quota = false; await vi.waitFor(() => expect(button(f.container, 'Save result and dismiss request').disabled).toBe(false)); button(f.container, 'Save result and dismiss request').click(); await vi.waitFor(() => expect(f.commands.acknowledge).toHaveBeenCalledOnce()); expect(f.commands.submit).toHaveBeenCalledOnce();
  });
  it('retains local drafts on external CAS conflict and never sends until explicitly reconciled', async () => {
    const f = await fixture(); f.data.quota = true; edit(f.container, 'Unsaved local'); await vi.waitFor(() => expect(f.container.textContent).toContain('could not be written'));
    await f.external({ version: 1, value: { drafts: [{ repo: 'org/a', runId: 'run', questionId: 'q', text: 'Other tab' }], results: [] } });
    expect(f.container.querySelector('textarea')?.value).toBe('Unsaved local'); expect(button(f.container, 'Accept answer').disabled).toBe(true); expect(f.commands.submit).not.toHaveBeenCalled();
    button(f.container, 'Discard local edits and reload saved state').click(); expect(f.container.querySelector('textarea')?.value).toBe('Other tab');
  });
  it('does not acknowledge or repaint an answer that completes after the panel hides', async () => {
    const f = await fixture(); const waiting = deferred<Awaited<ReturnType<ClarificationCommandServiceV1['submit']>>>(); vi.mocked(f.commands.submit).mockReturnValueOnce(waiting.promise);
    edit(f.container, 'Yes'); button(f.container, 'Accept answer').click(); await vi.waitFor(() => expect(f.commands.submit).toHaveBeenCalledOnce()); await f.update({ visible: false });
    waiting.resolve({ status: 'unavailable', reason: 'connection-failed' }); await Promise.resolve(); expect(f.commands.acknowledge).not.toHaveBeenCalled(); expect(button(f.container, 'Accept answer').disabled).toBe(true);
    const calls = f.list.mock.calls.length; await f.instance.refresh?.(); expect(f.list).toHaveBeenCalledTimes(calls);
  });
  it('keeps future saved state read-only and never calls legacy storage/save APIs', async () => {
    const f = await fixture({ version: 8, value: { future: true } }); expect(f.container.textContent).toContain('Saved state is unsupported'); expect(button(f.container, 'Accept answer').disabled).toBe(true); expect(f.context.saveState).not.toHaveBeenCalled(); expect(f.compare).not.toHaveBeenCalled();
  });
});

it('rechecks a clean draft before dispatch and an already-saved result before acknowledgment', async () => {
  const input = { version: 1 as const, repo: 'org/a', runId: 'run', questionId: 'q', expectedAttempt: 2, expectedChannelId: channel, expectedQuestionRevision: 1, answer: 'Yes' };
  const receipt: ClarificationCommandReceiptV1 = { version: 1, requestId, input, status: 'succeeded', reason: null, result: { questionId: 'q', revision: 2, answer: 'Yes', answeredAt: now } };
  const saved = { version: 1, value: { drafts: [{ repo: 'org/a', runId: 'run', questionId: 'q', text: 'Yes' }], results: [{ requestId, repo: 'org/a', runId: 'run', questionId: 'q', answer: 'Yes', status: 'succeeded', reason: null }] } };
  const f = await fixture(saved); f.data.saved = { version: 1, value: { drafts: [], results: [] } };
  button(f.container, 'Accept answer').click(); await vi.waitFor(() => expect(f.compare).toHaveBeenCalledOnce()); expect(f.commands.submit).not.toHaveBeenCalled();
  f.data.pending = [{ command: { ...input, requestId }, receipt }]; await f.instance.refresh?.();
  await vi.waitFor(() => expect(button(f.container, 'Save result and dismiss request').disabled).toBe(false)); button(f.container, 'Save result and dismiss request').click();
  await vi.waitFor(() => expect(f.compare).toHaveBeenCalledTimes(2)); expect(f.commands.acknowledge).not.toHaveBeenCalled(); expect(f.data.pending).toHaveLength(1);
});

it.each(['next', 'previous'] as const)('retains the displayed question page after failed %s navigation and retries explicitly', async direction => {
  const f = await fixture();
  f.list.mockImplementation(async query => ({ status: 'available', value: { version: 1, repo: query.repo, items: [question({ id: query.cursor ? 'second' : 'first', prompt: query.cursor ? 'Second page question' : 'First page question' })], nextCursor: query.cursor ? null : 'next', total: 2, observedAt: now } }));
  await f.instance.refresh?.();
  if (direction === 'previous') { button(f.container, 'Next page').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Page 2')); }
  const label = direction === 'next' ? 'Next page' : 'Previous page'; const displayed = direction === 'next' ? 1 : 2; const content = direction === 'next' ? 'First page question' : 'Second page question';
  f.list.mockResolvedValueOnce({ status: 'unavailable', reason: 'connection-failed' }); button(f.container, label).click();
  await vi.waitFor(() => expect(f.container.textContent).toContain('Questions unavailable'));
  expect(f.container.textContent).toContain(`Page ${displayed}`); expect(f.container.textContent).toContain(content);
  await f.instance.refresh?.(); expect(f.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: direction === 'next' ? null : 'next' }), expect.any(AbortSignal));
  expect(f.container.textContent).toContain(`Page ${displayed}`); button(f.container, label).click();
  await vi.waitFor(() => expect(f.container.textContent).toContain(`Page ${direction === 'next' ? 2 : 1}`));
  expect(f.container.textContent).toContain(direction === 'next' ? 'Second page question' : 'First page question');
});

it.each(['missing-retry', 'removed-request'] as const)('never creates another answer request after %s', async scenario => {
  const f = await fixture(); f.data.loss = true; edit(f.container, 'Original'); button(f.container, 'Accept answer').click();
  await vi.waitFor(() => expect(button(f.container, 'Retry original').disabled).toBe(false)); edit(f.container, 'Retained draft');
  if (scenario === 'missing-retry') {
    delete f.commands.retry; await f.instance.refresh?.(); expect(button(f.container, 'Retry original').disabled).toBe(true);
    button(f.container, 'Retry original').click();
  } else {
    f.data.pending = []; button(f.container, 'Retry original').click();
    await vi.waitFor(() => expect(f.commands.retry).toHaveBeenCalledWith({ repo: 'org/a', requestId }, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(f.container.textContent).toContain('Original outcome is unavailable'));
    expect(f.data.pending).toHaveLength(0);
  }
  expect(f.commands.submit).toHaveBeenCalledOnce(); expect(f.commands.acknowledge).not.toHaveBeenCalled();
  expect(f.container.querySelector('textarea')?.value).toBe('Retained draft');
});

it('delegates composed heading, Refresh and legacy link while retaining standalone controls and observation evidence',async()=>{
 const f=await fixture();expect(f.container.querySelector('h2')?.textContent).toBe('Agent questions');expect(button(f.container,'Refresh questions')).toBeTruthy();expect(f.container.querySelector('a')).not.toBeNull();
 expect(f.container.querySelector('time')?.getAttribute('datetime')).toBe(now);expect(f.container.querySelector('time')?.textContent).toContain('Sep 20, 2026');expect(f.container.querySelector('time')?.textContent).toContain('UTC');
 const host=document.createElement('div');host.dataset.compositionPage='';document.body.append(host);host.append(f.container);await f.instance.refresh?.();
 expect(f.container.querySelector('h2')).toBeNull();expect([...f.container.querySelectorAll('button')].some(value=>value.textContent==='Refresh questions')).toBe(false);expect(f.container.querySelector('a')).toBeNull();expect(f.commands.submit).not.toHaveBeenCalled();
});

it('hides inert paging only on a proven first page and keeps empty scope distinct from unknown totals',async()=>{
 const f=await fixture();f.list.mockResolvedValue({status:'available',value:{version:1,repo:'org/a',items:[],nextCursor:null,total:0,observedAt:now}});await f.instance.refresh?.();
 expect(f.container.querySelector('.question-pagination')).toBeNull();expect([...f.container.querySelectorAll('button')].some(value=>value.textContent==='First page')).toBe(false);expect(f.container.textContent).toContain('No agent questions in this scope.');
 f.list.mockResolvedValue({status:'available',value:{version:1,repo:'org/a',items:[],nextCursor:null,total:null,observedAt:now}});await f.instance.refresh?.();
 expect(f.container.textContent).toContain('No questions on this page.');expect(f.container.textContent).not.toContain('No agent questions in this scope.');
 f.list.mockResolvedValue({status:'unavailable',reason:'connection-failed'});await f.instance.refresh?.();expect(f.container.querySelector('.question-empty')).toBeNull();expect(f.container.textContent).toContain('Questions unavailable');
});

it('restores saved disclosure and standalone recovery link focus through refresh',async()=>{
 const f=await fixture();const details=f.container.querySelector<HTMLDetailsElement>('.question-saved')!;details.open=true;details.dispatchEvent(new Event('toggle'));details.querySelector<HTMLElement>('summary')!.focus();
 await f.instance.refresh?.();expect(f.container.querySelector<HTMLDetailsElement>('.question-saved')?.open).toBe(true);expect(document.activeElement).toBe(f.container.querySelector('.question-saved summary'));
 f.container.querySelector<HTMLAnchorElement>('a')!.focus();await f.instance.refresh?.();expect(document.activeElement).toBe(f.container.querySelector('a'));
});

it('keeps same-id question action focus on its fully qualified run identity',async()=>{
 const f=await fixture();f.data.questions=[question({runId:'first-run'}),question({runId:'second-run'})];await f.instance.refresh?.();
 const rows=()=>[...f.container.querySelectorAll<HTMLElement>('[data-question-id]')];rows()[1]!.querySelector<HTMLButtonElement>('button')!.focus();await f.instance.refresh?.();
 expect(document.activeElement).toBe(rows()[1]!.querySelector('button'));expect(rows()[0]!.querySelector('button')?.dataset.focus).not.toBe(rows()[1]!.querySelector('button')?.dataset.focus);expect(f.commands.submit).not.toHaveBeenCalled();
});

it('collapses read-only answer drafts while preserving qualified disclosure state, draft text and focus',async()=>{
 const f=await fixture();edit(f.container,'Retained draft');await vi.waitFor(()=>expect(f.compare).toHaveBeenCalled());
 const readonly={available:false,reason:'provenance-unknown'} as const;
 f.data.questions=[question({answer:'Accepted',answerability:readonly}),question({runId:'other-run',answerability:readonly})];await f.instance.refresh?.();
 const disclosures=()=>[...f.container.querySelectorAll<HTMLDetailsElement>('.question-answer-draft')];
 expect(disclosures()).toHaveLength(2);expect(disclosures().every(value=>!value.open)).toBe(true);
 expect(f.container.querySelector('.question-accepted')?.closest('details')).toBeNull();expect(f.container.querySelector('.question-read-only')?.closest('details')).toBeNull();
 expect(disclosures()[0]?.querySelector('textarea')?.value).toBe('Retained draft');expect(button(f.container,'Accept answer').disabled).toBe(true);
 const first=disclosures()[0]!;first.open=true;first.dispatchEvent(new Event('toggle'));first.querySelector<HTMLElement>('summary')!.focus();await f.instance.refresh?.();
 expect(disclosures()[0]?.open).toBe(true);expect(disclosures()[1]?.open).toBe(false);expect(document.activeElement).toBe(disclosures()[0]?.querySelector('summary'));
 expect(disclosures()[0]?.querySelector<HTMLElement>('summary')?.dataset.focus).not.toBe(disclosures()[1]?.querySelector<HTMLElement>('summary')?.dataset.focus);
 const input=disclosures()[0]!.querySelector('textarea')!;input.focus();input.setSelectionRange(2,5);await f.instance.refresh?.();
 expect(document.activeElement).toBe(disclosures()[0]?.querySelector('textarea'));expect(disclosures()[0]?.querySelector('textarea')?.selectionStart).toBe(2);expect(disclosures()[0]?.querySelector('textarea')?.selectionEnd).toBe(5);
 f.data.questions=[question({runId:'available-run'})];await f.instance.refresh?.();expect(disclosures()).toHaveLength(0);
 const available=f.container.querySelector('textarea')!;available.focus();f.data.questions=[question({runId:'available-run',answerability:readonly})];await f.instance.refresh?.();
 expect(disclosures()[0]?.open).toBe(false);expect(document.activeElement).toBe(disclosures()[0]?.querySelector('summary'));expect(f.commands.submit).not.toHaveBeenCalled();
});

it('clears and fences effective scope changes even with unchanged header, epoch and activity signal',async()=>{
 const f=await fixture();const pending=deferred<Awaited<ReturnType<ClarificationReadServiceV1['list']>>>();f.list.mockReturnValueOnce(pending.promise);const old=f.instance.refresh?.();
 f.list.mockImplementation(async query=>({status:'available',value:{version:1,repo:query.repo,items:[question({repo:query.repo??'org/b',prompt:'New effective scope'})],nextCursor:null,total:1,observedAt:now}}));
 await f.instance.update({...f.context.state,activity:{...f.context.state.activity,repo:'org/b'}});
 await vi.waitFor(()=>expect(f.container.textContent).toContain('New effective scope'));
 pending.resolve({status:'available',value:{version:1,repo:'org/a',items:[question({prompt:'Late old scope'})],nextCursor:null,total:1,observedAt:now}});await old;
 expect(f.container.textContent).not.toContain('Late old scope');expect(f.list).toHaveBeenLastCalledWith(expect.objectContaining({repo:'org/b',cursor:null}),expect.any(AbortSignal));
});
