import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelOpaqueStateV1, PluginPanelContext, PluginPanelInstance, PluginPanelState, SuggestedContactAdminContactV1, SuggestedContactAdminPendingV1, SuggestedContactAdminReceiptV1, SuggestedContactAdminServiceV1 } from '@helmsman/plugin-sdk';
import panel from './panel';
const uuid = '00000000-0000-4000-8000-000000000001'; const id = '00000000-0000-4000-8000-000000000002'; const now = '2026-09-20T00:00:00Z';
const contact: SuggestedContactAdminContactV1 = { id: 'legacy', revision: 3, name: 'Owner', address: 'Slack room', enabled: true, createdAt: now };
const lifetimes: AbortController[] = [];
afterEach(() => { lifetimes.splice(0).forEach(value => value.abort()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const button = (container: HTMLElement, text: string) => { const value = [...container.querySelectorAll('button')].find(value => value.textContent === text); if (!value) throw new Error(`Missing ${text}`); return value; };
const input = (container: HTMLElement, name: string, value: string, selector = '[data-contact-draft="create"]') => { const field = container.querySelector<HTMLInputElement>(`${selector} [name="${name}"]`)!; field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); };
async function fixture(initial: PanelOpaqueStateV1 | null = null) {
  const container = document.createElement('div'); document.body.append(container); const lifetime = new AbortController(); lifetimes.push(lifetime); let activity = new AbortController();
  let state: PluginPanelState = { repo: 'org/a', themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'contacts', savedState: initial, activity: { repo: 'org/a', epoch: 1, active: true, signal: activity.signal } };
  const data = { pending: [] as SuggestedContactAdminPendingV1[], items: [contact], saved: initial, quota: false, loss: false };
  const service: SuggestedContactAdminServiceV1 = { version: 1, list: vi.fn<SuggestedContactAdminServiceV1['list']>(async query => ({ status: 'available', value: { version: 1, scope: 'global', items: data.items, nextCursor: query.cursor ? null : 'next', observedAt: now } })), load: vi.fn(), pending: vi.fn(async () => data.pending),
    submit: vi.fn<SuggestedContactAdminServiceV1['submit']>(async input => {
      const command = data.pending[0]?.command ?? { ...input, id: input.kind === 'create' ? id : input.id, requestId: uuid };
      const receipt: SuggestedContactAdminReceiptV1 = { version: 1, scope: 'global', requestId: uuid, input: { ...input, id: command.id }, status: 'succeeded', reason: null,
        result: { id: command.id, revision: input.kind === 'create' ? 1 : input.expectedRevision + 1, name: input.name, address: input.address, enabled: input.enabled, createdAt: now } };
      data.pending = [{ command, receipt: data.loss ? null : receipt }]; return data.loss ? { status: 'unavailable', reason: 'connection-failed' } : { status: 'available', value: receipt };
    }), retry: vi.fn<NonNullable<SuggestedContactAdminServiceV1['retry']>>(async query => {
      const entry = data.pending.find(item => item.command.requestId === query.requestId);
      return entry?.receipt ? { status: 'available', value: entry.receipt } : { status: 'unavailable', reason: entry ? 'connection-failed' : 'not-found' };
    }), receipt: vi.fn<SuggestedContactAdminServiceV1['receipt']>(async () => ({ status: 'available', value: data.pending[0]?.receipt ?? null })), acknowledge: vi.fn(async query => { expect(JSON.stringify(data.saved)).toContain(query.requestId); data.pending = []; }) };
  let instance: PluginPanelInstance;
  const compare = vi.fn<NonNullable<PluginPanelContext['compareAndSetState']>>(async (expected, next) => { if (data.quota) throw new Error('Quota'); if (JSON.stringify(expected) !== JSON.stringify(data.saved)) throw new Error('Conflict'); data.saved = structuredClone(next); state = { ...state, savedState: data.saved }; await instance.update(state); });
  const context: PluginPanelContext = { state, signal: lifetime.signal, activity: state.activity, services: { version: 1, suggestedContacts: service }, compareAndSetState: compare, saveState: vi.fn(), onDispose: vi.fn(), navigate: vi.fn() };
  instance = await panel.mount(container, context); await instance.refresh?.();
  return { container, instance, data, context, service, compare, async update(patch: Partial<PluginPanelState>) { activity.abort(); activity = new AbortController(); state = { ...state, ...patch, activity: { repo: patch.repo ?? state.repo, active: patch.visible ?? state.visible, epoch: state.activity.epoch + 1, signal: activity.signal } }; await instance.update(state); } };
}
describe('independent global suggested contacts', () => {
  it('labels global metadata, uses bounded global pages and preserves page across header scope change', async () => {
    const f = await fixture(); expect(f.container.textContent).toContain('shared across every repository'); expect(f.context.services.clarifications).toBeUndefined();
    button(f.container, 'Next page').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Page 2')); await f.update({ repo: 'org/b' }); await f.instance.refresh?.();
    expect(f.service.list).toHaveBeenLastCalledWith({ version: 1, scope: 'global', limit: 25, cursor: 'next' }, expect.any(AbortSignal)); expect(f.service.submit).not.toHaveBeenCalled();
  });
  it('creates metadata with arbitrary address, explicit enabled, and saves terminal result before ack', async () => {
    const f = await fixture(); input(f.container, 'name', ' Owner '); input(f.container, 'address', ' Slack room ');
    const enabled = f.container.querySelector<HTMLInputElement>('[data-contact-draft="create"] [name="enabled"]')!; enabled.checked = false; enabled.dispatchEvent(new Event('input', { bubbles: true }));
    button(f.container, 'Create global contact').click(); await vi.waitFor(() => expect(f.service.submit).toHaveBeenCalledOnce());
    expect(f.service.submit).toHaveBeenCalledWith({ version: 1, scope: 'global', kind: 'create', name: 'Owner', address: 'Slack room', enabled: false }, expect.any(AbortSignal));
    await vi.waitFor(() => expect(f.container.querySelector('[data-request-id]')).not.toBeNull()); expect(f.service.acknowledge).not.toHaveBeenCalled();
    button(f.container, 'Save result and dismiss request').click(); await vi.waitFor(() => expect(f.service.acknowledge).toHaveBeenCalledOnce()); expect(f.container.textContent).toContain('No message was sent');
  });
  it('retains original update revision during refresh and emits exact global update', async () => {
    const f = await fixture(); button(f.container, 'Edit contact').click(); input(f.container, 'name', 'Changed', '[data-contact-draft="legacy"]');
    f.data.items = [{ ...contact, revision: 9, name: 'Other editor' }]; await f.instance.refresh?.();
    expect(f.container.textContent).toContain('Original revision 3'); button(f.container, 'Save global contact').click(); await vi.waitFor(() => expect(f.service.submit).toHaveBeenCalledOnce());
    expect(f.service.submit).toHaveBeenCalledWith({ version: 1, scope: 'global', kind: 'update', id: 'legacy', expectedRevision: 3, name: 'Changed', address: 'Slack room', enabled: true }, expect.any(AbortSignal));
  });
  it('checks without sending and retries original create metadata without choosing new contact IDs', async () => {
    const f = await fixture(); f.data.loss = true; input(f.container, 'name', 'Original'); input(f.container, 'address', 'room'); button(f.container, 'Create global contact').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Outcome unknown'));
    input(f.container, 'name', 'New draft'); button(f.container, 'Check receipt').click(); await vi.waitFor(() => expect(f.service.receipt).toHaveBeenCalledOnce()); expect(f.service.submit).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(button(f.container, 'Retry original').disabled).toBe(false)); button(f.container, 'Retry original').click(); await vi.waitFor(() => expect(f.service.retry).toHaveBeenCalledOnce());
    expect(f.service.retry).toHaveBeenCalledWith({ scope: 'global', requestId: uuid }, expect.any(AbortSignal)); expect(f.service.submit).toHaveBeenCalledOnce(); expect(f.data.pending[0]?.command.name).toBe('Original'); expect(f.data.pending[0]?.command.id).toBe(id);
  });
  it('protects pending drafts/results and retains a newer edit on failed result storage', async () => {
    const f = await fixture(); input(f.container, 'name', 'Original'); input(f.container, 'address', 'room'); button(f.container, 'Create global contact').click(); await vi.waitFor(() => expect(f.container.querySelector('[data-request-id]')).not.toBeNull());
    expect(button(f.container, 'Discard global create draft').disabled).toBe(true); f.data.quota = true; input(f.container, 'name', 'New unsent'); button(f.container, 'Save result and dismiss request').click();
    await vi.waitFor(() => expect(f.container.textContent).toContain('could not be written')); expect(f.service.acknowledge).not.toHaveBeenCalled(); expect(f.container.querySelector<HTMLInputElement>('[name="name"]')?.value).toBe('New unsent');
    f.data.quota = false; await vi.waitFor(() => expect(button(f.container, 'Save result and dismiss request').disabled).toBe(false)); button(f.container, 'Save result and dismiss request').click(); await vi.waitFor(() => expect(f.service.acknowledge).toHaveBeenCalledOnce());
  });
  it('stops service work while hidden and preserves unsupported state', async () => {
    const f = await fixture({ version: 8, value: { future: true } }); expect(button(f.container, 'Create global contact').disabled).toBe(true); expect(f.compare).not.toHaveBeenCalled();
    await f.update({ visible: false }); const count = vi.mocked(f.service.list).mock.calls.length; await f.instance.refresh?.(); expect(f.service.list).toHaveBeenCalledTimes(count); expect(f.context.saveState).not.toHaveBeenCalled();
  });
});

it('rechecks a clean contact draft before sending against a stale saved-state namespace', async () => {
  const f = await fixture({ version: 1, value: { create: { name: 'Owner', address: 'room', enabled: true }, edits: [], results: [] } });
  f.data.saved = { version: 1, value: { create: { name: 'Other tab', address: 'room', enabled: true }, edits: [], results: [] } };
  button(f.container, 'Create global contact').click(); await vi.waitFor(() => expect(f.compare).toHaveBeenCalledOnce()); expect(f.service.submit).not.toHaveBeenCalled();
  expect(f.container.querySelector<HTMLInputElement>('[name="name"]')?.value).toBe('Owner');
});

it.each(['next', 'previous'] as const)('retains the displayed global-contact page after rejected %s navigation', async direction => {
  const f = await fixture(); const list = vi.mocked(f.service.list);
  list.mockImplementation(async query => ({ status: 'available', value: { version: 1, scope: 'global', items: [{ ...contact, id: query.cursor ? 'second' : 'first', name: query.cursor ? 'Second page contact' : 'First page contact' }], nextCursor: query.cursor ? null : 'next', observedAt: now } }));
  await f.instance.refresh?.(); if (direction === 'previous') { button(f.container, 'Next page').click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Page 2')); }
  const label = direction === 'next' ? 'Next page' : 'Previous page'; const displayed = direction === 'next' ? 1 : 2;
  list.mockRejectedValueOnce(new Error('Connection lost')); button(f.container, label).click(); await vi.waitFor(() => expect(f.container.textContent).toContain('Contacts unavailable'));
  expect(f.container.textContent).toContain(`Page ${displayed}`); expect(f.container.textContent).toContain(direction === 'next' ? 'First page contact' : 'Second page contact');
  await f.instance.refresh?.(); expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: direction === 'next' ? null : 'next' }), expect.any(AbortSignal));
  button(f.container, label).click(); await vi.waitFor(() => expect(f.container.textContent).toContain(`Page ${direction === 'next' ? 2 : 1}`));
  expect(f.container.textContent).toContain(direction === 'next' ? 'Second page contact' : 'First page contact');
});

it.each(['missing-retry', 'removed-request'] as const)('never allocates another contact after %s', async scenario => {
  const f = await fixture(); f.data.loss = true; input(f.container, 'name', 'Original'); input(f.container, 'address', 'room'); button(f.container, 'Create global contact').click();
  await vi.waitFor(() => expect(button(f.container, 'Retry original').disabled).toBe(false)); input(f.container, 'name', 'Retained draft');
  if (scenario === 'missing-retry') {
    delete f.service.retry; await f.instance.refresh?.(); expect(button(f.container, 'Retry original').disabled).toBe(true);
    button(f.container, 'Retry original').click();
  } else {
    f.data.pending = []; button(f.container, 'Retry original').click();
    await vi.waitFor(() => expect(f.service.retry).toHaveBeenCalledWith({ scope: 'global', requestId: uuid }, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(f.container.textContent).toContain('Original outcome is unavailable'));
    expect(f.data.pending).toHaveLength(0);
  }
  expect(f.service.submit).toHaveBeenCalledOnce(); expect(f.service.acknowledge).not.toHaveBeenCalled();
  expect(f.container.querySelector<HTMLInputElement>('[name="name"]')?.value).toBe('Retained draft');
});

it('keeps global contacts supporting the composed page without duplicate Refresh or recovery links',async()=>{
 const f=await fixture();expect(button(f.container,'Refresh contacts')).toBeTruthy();expect(f.container.querySelector('a')).not.toBeNull();
 const host=document.createElement('div');host.dataset.compositionPage='';document.body.append(host);host.append(f.container);await f.instance.refresh?.();
 expect([...f.container.querySelectorAll('button')].some(value=>value.textContent==='Refresh contacts')).toBe(false);expect(f.container.querySelector('a')).toBeNull();expect(f.container.querySelector('.contact-global')?.textContent).toBe('Global');
 expect(f.container.querySelector('.contact-intro')?.textContent).toContain('sends no messages');expect(f.container.querySelector('.contact-form [name="address"]')?.getAttribute('type')).not.toBe('email');expect(f.service.submit).not.toHaveBeenCalled();
});

it('hides inert global paging while retaining cursor recovery and distinct failed reads',async()=>{
 const f=await fixture();vi.mocked(f.service.list).mockResolvedValue({status:'available',value:{version:1,scope:'global',items:[],nextCursor:null,observedAt:now}});await f.instance.refresh?.();
 expect(f.container.querySelector('.contact-pagination')).toBeNull();expect(f.container.textContent).toContain('No contacts on this page. Add a name and address above.');
 vi.mocked(f.service.list).mockResolvedValue({status:'unavailable',reason:'connection-failed'});await f.instance.refresh?.();expect(f.container.textContent).not.toContain('No contacts on this page.');expect(f.container.textContent).toContain('Contacts unavailable');
});

it('retains global saved disclosure focus and standalone recovery focus through refresh',async()=>{
 const f=await fixture();const saved=f.container.querySelector<HTMLDetailsElement>('.contact-saved')!;saved.open=true;saved.dispatchEvent(new Event('toggle'));saved.querySelector<HTMLElement>('summary')!.focus();await f.instance.refresh?.();
 expect(f.container.querySelector<HTMLDetailsElement>('.contact-saved')?.open).toBe(true);expect(document.activeElement).toBe(f.container.querySelector('.contact-saved summary'));
 f.container.querySelector<HTMLAnchorElement>('a')!.focus();await f.instance.refresh?.();expect(document.activeElement).toBe(f.container.querySelector('a'));
});
