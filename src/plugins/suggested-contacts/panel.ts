import type { PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, SuggestedContactAdminContactV1,
  SuggestedContactAdminInputV1, SuggestedContactAdminPendingV1, SuggestedContactAdminReceiptV1 } from '@helmsman/plugin-sdk';
import { empty, emptyDraft, readState, resultState, type ContactDraft, type ContactState } from './state.js';
import { canonical, SavedState } from './saved-state.js';
import { styles } from './styles.js';
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
const failure = (error: unknown) => error instanceof Error ? error.message : 'Service unavailable.';
class Contacts implements PluginPanelInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private state: PluginPanelState;
  private readonly saved: SavedState<ContactState>;
  private disposed = false;
  private generation = 0;
  private sequence = 0;
  private controller = new AbortController();
  private items: readonly SuggestedContactAdminContactV1[] = [];
  private pending: readonly SuggestedContactAdminPendingV1[] = [];
  private ready = false;
  private busy = false;
  private loading = false;
  private error = '';
  private recoveryError = '';
  private notice = '';
  private cursors: (string | null)[] = [null];
  private page = 0;
  private next: string | null = null;
  private savedOpen = false;
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state;
    this.saved = new SavedState(context, readState, empty, () => this.draw());
    context.onDispose(this.dispose); context.signal.addEventListener('abort', this.dispose, { once: true });
    this.state.activity.signal.addEventListener('abort', this.cancel, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(token = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && token === this.generation; }
  private cancel = () => { ++this.generation; ++this.sequence; this.controller.abort(); this.controller = new AbortController(); this.busy = false; this.loading = false; this.ready = false; };
  dispose = () => { if (this.disposed) return; this.disposed = true; this.cancel(); this.state.activity.signal.removeEventListener('abort', this.cancel); this.context.signal.removeEventListener('abort', this.dispose); this.container.replaceChildren(); };
  update(next: PluginPanelState) {
    if (this.disposed) return; const previous = this.state; previous.activity.signal.removeEventListener('abort', this.cancel); this.state = next;
    next.activity.signal.addEventListener('abort', this.cancel, { once: true }); this.saved.receive(next.savedState);
    if (previous.activity.epoch !== next.activity.epoch || previous.activity.signal !== next.activity.signal || previous.visible !== next.visible) { this.cancel(); if (this.active()) void this.refresh(); }
    this.draw();
  }
  private async pendingRead(token: number): Promise<boolean> {
    try {
      const values = await this.context.services.suggestedContacts!.pending();
      if (!this.active(token)) return false;
      if (!Array.isArray(values) || values.some(item => !item?.command || item.command.scope !== 'global')) throw new Error('Invalid global requests.');
      this.pending = values; this.ready = true; this.recoveryError = ''; return true;
    } catch (error) { if (this.active(token)) { this.ready = false; this.recoveryError = `Contact recovery unavailable: ${failure(error)}`; } return false; }
  }
  async refresh() { await this.loadPage(this.page, this.cursors); }
  private async loadPage(page: number, cursors: (string | null)[]) {
    if (!this.active()) return; const token = this.generation; const request = ++this.sequence; this.loading = true; this.draw();
    await Promise.allSettled([
      (async () => {
        try {
          const result = await this.context.services.suggestedContacts!.list({ version: 1, scope: 'global', limit: 25, cursor: cursors[page] ?? null }, this.controller.signal);
          if (!this.active(token) || request !== this.sequence) return;
          if (result?.status !== 'available' || !Array.isArray(result.value?.items) || result.value.items.length > 25 || result.value.items.some(item => !item?.id)) throw new Error(result?.status === 'unavailable' ? result.reason : 'Invalid contact page.');
          this.page = page; this.cursors = cursors; this.items = result.value.items; this.next = result.value.nextCursor; this.error = '';
        } catch (error) { if (this.active(token) && request === this.sequence) this.error = `Contacts unavailable: ${failure(error)}`; }
        finally { if (this.active(token) && request === this.sequence) { this.loading = false; this.draw(); } }
      })(), this.pendingRead(token).then(() => { if (this.active(token)) this.draw(); }),
    ]);
  }
  private blocked(id: string | null) { return this.pending.some(entry => id === null ? entry.command.kind === 'create' : entry.command.kind === 'update' && entry.command.id === id); }
  private async action(work: (token: number) => Promise<void>) {
    if (!this.active() || this.busy) return; const token = this.generation; this.busy = true; this.notice = ''; this.draw();
    try { await work(token); } catch (error) { if (this.active(token)) this.notice = failure(error); }
    finally { if (this.active(token)) { await this.pendingRead(token); if (this.active(token)) { this.busy = false; this.draw(); } } }
  }
  private submit(id: string | null) {
    const draft = id === null ? this.saved.value.create : this.saved.value.edits.find(item => item.id === id);
    if (!draft?.name.trim() || !draft.address.trim() || !this.saved.writable || !this.ready || this.blocked(id)) return;
    const base = { version: 1 as const, scope: 'global' as const, name: draft.name.trim(), address: draft.address.trim(), enabled: draft.enabled };
    const input: SuggestedContactAdminInputV1 = id !== null && 'expectedRevision' in draft && typeof draft.expectedRevision === 'number' ? { ...base, kind: 'update', id, expectedRevision: draft.expectedRevision } : { ...base, kind: 'create' };
    void this.action(async token => {
      if (!await this.saved.save() || !this.active(token)) return;
      const result = await this.context.services.suggestedContacts!.submit(input, this.controller.signal);
      if (!this.active(token)) return;
      this.notice = result?.status === 'available' ? result.value.status === 'succeeded' ? 'Global contact saved. No message was sent. Save the result to dismiss its request.' : `Contact rejected: ${result.value.reason}. Your draft is retained.`
        : 'Contact outcome is unknown. Check the original request before retrying.';
    });
  }
  private async saveResult(receipt: SuggestedContactAdminReceiptV1, token: number) {
    if (!this.saved.writable) return;
    const result = resultState(receipt); const existing = this.saved.value.results.find(item => item.requestId === receipt.requestId);
    if (existing && canonical(existing) !== canonical(result)) throw new Error('Saved result differs from the original receipt. The request is retained.');
    if (!existing) { if (this.saved.value.results.length >= 32) throw new Error('Remove a saved result before recording another. The original request is retained.'); this.saved.edit(value => { value.results.push(result); }); }
    if (!await this.saved.save() || !this.active(token)) return;
    await this.context.services.suggestedContacts!.acknowledge({ scope: 'global', requestId: receipt.requestId }, this.controller.signal);
    if (this.active(token)) { this.notice = 'Global contact result saved. No message was sent. Your draft is retained.'; void this.refresh(); }
  }
  private reconcile(entry: SuggestedContactAdminPendingV1, action: 'check' | 'retry' | 'save') {
    void this.action(async token => {
      if (action === 'save') { if (entry.receipt) await this.saveResult(entry.receipt, token); return; }
      if (action === 'retry' && (!this.ready || !this.saved.writable || !await this.saved.save() || !this.active(token))) return;
      const { requestId: _request, ...intent } = entry.command; const { id: _id, ...create } = intent;
      const input: SuggestedContactAdminInputV1 = intent.kind === 'create' ? { ...create, kind: 'create' } : intent;
      const result = action === 'retry' ? await this.context.services.suggestedContacts!.submit(input, this.controller.signal)
        : await this.context.services.suggestedContacts!.receipt({ scope: 'global', requestId: entry.command.requestId }, this.controller.signal);
      if (!this.active(token)) return;
      this.notice = result?.status === 'available' ? result.value ? 'Original receipt found. Save its result before dismissing the request.' : 'No receipt is recorded. Retry original retains the request and contact identity.' : 'Original outcome is unavailable. The request and draft are retained.';
    });
  }
  private cleanup(kind: 'create' | 'edit' | 'result', id: string | null = null) {
    const selected = () => kind === 'create' ? this.saved.value.create : kind === 'edit' ? this.saved.value.edits.find(item => item.id === id) : this.saved.value.results.find(item => item.requestId === id);
    const snapshot = canonical(selected());
    void this.action(async token => {
      if (!await this.pendingRead(token) || !this.active(token)) throw new Error('Read original requests before removing saved state.');
      if (canonical(selected()) !== snapshot) throw new Error('Saved state changed. Review it before discarding.');
      if (kind === 'result' ? this.pending.some(item => item.command.requestId === id) : this.blocked(kind === 'create' ? null : id)) throw new Error('Resolve the original request before discarding its evidence.');
      this.saved.edit(value => { if (kind === 'create') value.create = emptyDraft(); else if (kind === 'edit') value.edits = value.edits.filter(item => item.id !== id); else value.results = value.results.filter(item => item.requestId !== id); });
      if (await this.saved.save() && this.active(token)) this.notice = 'Selected global saved state removed. Command journals are unchanged.';
    });
  }
  private edit(item: SuggestedContactAdminContactV1) {
    if (!this.saved.writable || this.saved.value.edits.some(value => value.id === item.id)) return;
    if (this.saved.value.edits.length >= 64) { this.notice = 'Discard an unused edit before opening another contact.'; this.draw(); return; }
    this.saved.edit(value => { value.edits.push({ id: item.id, expectedRevision: item.revision, name: item.name, address: item.address, enabled: item.enabled }); }); void this.saved.save(); this.draw();
  }
  private button(text: string, action: () => void, disabled = false) { const button = node('button', text); button.type = 'button'; button.disabled = !this.active() || this.busy || disabled; button.addEventListener('click', action); return button; }
  private form(draft: ContactDraft, id: string | null) {
    const form = node('form'); form.setAttribute('aria-label', id === null ? 'Create global contact' : 'Edit global contact'); form.dataset.contactDraft = id ?? 'create';
    for (const name of ['name', 'address', 'enabled'] as const) {
      const label = node('label', name === 'name' ? 'Name' : name === 'address' ? 'Address' : 'Enabled'); const input = node('input'); input.name = name; input.dataset.focus = `${id ?? 'create'}:${name}`;
      if (name === 'enabled') { label.className = 'contact-enabled'; input.type = 'checkbox'; input.checked = draft.enabled; } else { input.maxLength = name === 'name' ? 160 : 320; input.value = draft[name]; }
      input.disabled = !this.active() || !this.saved.writable;
      input.addEventListener('input', () => { this.saved.edit(value => { const target = id === null ? value.create : value.edits.find(item => item.id === id); if (!target) return; if (name === 'enabled') target.enabled = input.checked; else target[name] = input.value; }); void this.saved.save(); }); label.append(input); form.append(label);
    }
    form.append(this.button(id === null ? 'Create global contact' : 'Save global contact', () => this.submit(id), !this.saved.writable || !this.ready || this.blocked(id)));
    form.addEventListener('submit', event => { event.preventDefault(); this.submit(id); }); return form;
  }
  private draw() {
    if (this.disposed) return;
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null; const focusKey = focused?.dataset.focus;
    const selection = focused instanceof HTMLInputElement && focused.type !== 'checkbox' ? [focused.selectionStart, focused.selectionEnd] : null;
    const root = node('section'); root.className = 'plugin-suggested-contacts'; root.append(node('style', styles), node('h2', 'Suggested contacts — global'), node('p', 'These contacts apply to every galleon. Saving contact metadata sends no messages.'));
    root.append(this.button('Refresh contacts', () => { void this.refresh(); }, this.loading));
    const legacy = node('a', 'Previous contact drafts and requests'); const recovery = new URL('/plugins/helmsman.compat-clarifications/page', window.location.href); const headerRepo = new URL(window.location.href).searchParams.get('repo'); if (headerRepo) recovery.searchParams.set('repo', headerRepo); legacy.href = recovery.href; legacy.addEventListener('click', event => { event.preventDefault(); this.context.navigate(legacy.href); }); root.append(legacy);
    for (const text of [this.error, this.recoveryError, this.saved.error]) if (text) { const alert = node('p', text); alert.setAttribute('role', 'alert'); root.append(alert); }
    if (this.saved.conflict) root.append(this.button('Discard local edits and reload saved state', () => this.saved.reload()));
    if (this.saved.error && this.saved.writable) root.append(this.button('Retry saving drafts', () => { void this.saved.save(); }));
    if (this.notice) { const status = node('p', this.notice); status.setAttribute('role', 'status'); root.append(status); }
    root.append(node('h3', 'Create global contact'), this.form(this.saved.value.create, null));
    if (!this.items.length) root.append(node('p', this.loading ? 'Loading contacts…' : 'No contacts on this page.'));
    for (const item of this.items) { const row = node('article'); row.dataset.contactId = item.id; row.append(node('h3', item.name), node('p', `${item.address} · ${item.enabled ? 'Enabled' : 'Disabled'} · Revision ${item.revision}`), this.button('Edit contact', () => this.edit(item), !this.saved.writable || this.saved.value.edits.some(value => value.id === item.id))); root.append(row); }
    const pages = node('div'); pages.className = 'question-tools'; pages.append(this.button('First page', () => { void this.loadPage(0, [null]); }, this.loading || this.page === 0), this.button('Previous page', () => { void this.loadPage(this.page - 1, this.cursors); }, this.loading || this.page === 0), node('span', `Page ${this.page + 1} · ${this.items.length} global contacts shown.`), this.button('Next page', () => { if (this.next) void this.loadPage(this.page + 1, [...this.cursors.slice(0, this.page + 1), this.next]); }, this.loading || !this.next || this.page >= 127)); root.append(pages);
    for (const draft of this.saved.value.edits) { const row = node('article'); row.dataset.contactId = draft.id; row.append(node('h3', `Edit ${draft.id}`), node('small', `Original revision ${draft.expectedRevision}. Refresh does not change this edit's expected revision.`), this.form(draft, draft.id), this.button('Discard contact edit', () => this.cleanup('edit', draft.id), !this.saved.writable || !this.ready || this.blocked(draft.id))); root.append(row); }
    if (this.pending.length) {
      const requests = node('section'); requests.append(node('h3', 'Original global contact requests'));
      for (const entry of this.pending) {
        const row = node('article'); row.dataset.requestId = entry.command.requestId; row.append(node('p', `${entry.command.kind} · ${entry.command.id}${entry.command.kind === 'update' ? ` · Original revision ${entry.command.expectedRevision}` : ''}`), node('small', entry.command.requestId), node('p', `${entry.command.name} · ${entry.command.address} · ${entry.command.enabled ? 'Enabled' : 'Disabled'}`), node('p', entry.receipt ? `${entry.receipt.status}${entry.receipt.reason ? `: ${entry.receipt.reason}` : ''}` : 'Outcome unknown'));
        if (entry.receipt) row.append(this.button('Save result and dismiss request', () => this.reconcile(entry, 'save'), !this.saved.writable));
        else row.append(this.button('Check receipt', () => this.reconcile(entry, 'check')), this.button('Retry original', () => this.reconcile(entry, 'retry'), !this.ready || !this.saved.writable)); requests.append(row);
      } root.append(requests);
    }
    const saved = node('details'); saved.open = this.savedOpen; saved.append(node('summary', 'Saved global drafts and results')); saved.addEventListener('toggle', () => { if (saved.isConnected) this.savedOpen = saved.open; });
    saved.append(node('p', `${this.saved.value.create.name} · ${this.saved.value.create.address}`), this.button('Discard global create draft', () => this.cleanup('create'), !this.saved.writable || !this.ready || this.blocked(null)));
    for (const result of this.saved.value.results) { const row = node('article'); row.dataset.savedId = result.requestId; row.append(node('p', `${result.requestId} · ${result.kind} · ${result.status}${result.reason ? `: ${result.reason}` : ' · No message was sent.'}`), node('p', `${result.name} · ${result.address}`), this.button('Dismiss saved result', () => this.cleanup('result', result.requestId), !this.saved.writable || !this.ready || this.pending.some(item => item.command.requestId === result.requestId))); saved.append(row); }
    root.append(saved);
    for (const button of root.querySelectorAll<HTMLElement>('button')) button.dataset.focus = JSON.stringify([button.closest<HTMLElement>('[data-contact-id]')?.dataset.contactId, button.closest<HTMLElement>('[data-request-id]')?.dataset.requestId, button.closest<HTMLElement>('[data-saved-id]')?.dataset.savedId, button.textContent]);
    this.container.replaceChildren(root);
    if (focusKey) { const target = [...root.querySelectorAll<HTMLElement>('[data-focus]')].find(item => item.dataset.focus === focusKey); target?.focus({ preventScroll: true }); if (target instanceof HTMLInputElement && selection) target.setSelectionRange(selection[0] ?? null, selection[1] ?? null); }
  }
}
const panel: PluginPanelModule = { mount(container, context) { if (context.services.suggestedContacts?.version !== 1) throw new Error('Global contacts require the public suggested-contact service.'); return new Contacts(container, context); } };
export default panel;
