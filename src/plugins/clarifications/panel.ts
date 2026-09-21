import type { ClarificationCommandInputV1, ClarificationCommandPendingV1, ClarificationCommandReceiptV1, ClarificationReadItemV1,
  PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState } from '@helmsman/plugin-sdk';
import { empty, key, readState, resultState, type QuestionState } from './state.js';
import { canonical, SavedState } from './saved-state.js';
import { styles } from './styles.js';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
const identity = (item: ClarificationReadItemV1) => ({ repo: item.repo, runId: item.runId, questionId: item.id });
const failure = (error: unknown) => error instanceof Error ? error.message : 'Service unavailable.';
class Questions implements PluginPanelInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private state: PluginPanelState;
  private readonly saved: SavedState<QuestionState>;
  private disposed = false;
  private generation = 0;
  private sequence = 0;
  private controller = new AbortController();
  private items: readonly ClarificationReadItemV1[] = [];
  private pending: readonly ClarificationCommandPendingV1[] = [];
  private ready = false;
  private busy = false;
  private loading = false;
  private error = '';
  private recoveryError = '';
  private notice = '';
  private cursors: (string | null)[] = [null];
  private page = 0;
  private next: string | null = null;
  private total: number | null = null;
  private observedAt = '';
  private readonly details = new Set<string>();
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state;
    this.saved = new SavedState(context, readState, empty, () => this.draw());
    context.onDispose(this.dispose); context.signal.addEventListener('abort', this.dispose, { once: true });
    this.state.activity.signal.addEventListener('abort', this.cancel, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(token = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && token === this.generation; }
  private scoped(repo: string) { return this.state.activity.repo === null || this.state.activity.repo === repo; }
  private cancel = () => { ++this.generation; ++this.sequence; this.controller.abort(); this.controller = new AbortController(); this.busy = false; this.loading = false; this.ready = false; };
  dispose = () => { if (this.disposed) return; this.disposed = true; this.cancel(); this.state.activity.signal.removeEventListener('abort', this.cancel); this.context.signal.removeEventListener('abort', this.dispose); this.container.replaceChildren(); };
  update(next: PluginPanelState) {
    if (this.disposed) return;
    const previous = this.state; previous.activity.signal.removeEventListener('abort', this.cancel); this.state = next;
    next.activity.signal.addEventListener('abort', this.cancel, { once: true }); this.saved.receive(next.savedState);
    if (previous.activity.epoch !== next.activity.epoch || previous.activity.signal !== next.activity.signal || previous.visible !== next.visible || previous.repo !== next.repo) {
      this.cancel(); this.pending = [];
      if (previous.repo !== next.repo) { this.items = []; this.cursors = [null]; this.page = 0; this.next = null; this.total = null; this.error = ''; this.notice = ''; }
      if (this.active()) void this.refresh();
    }
    this.draw();
  }
  private async pendingRead(token: number): Promise<boolean> {
    try {
      const values = await this.context.services.clarificationCommands!.pending();
      if (!this.active(token)) return false;
      if (!Array.isArray(values) || values.some(item => !item?.command || typeof item.command.questionId !== 'string')) throw new Error('Invalid saved requests.');
      this.pending = values.filter(item => this.scoped(item.command.repo)); this.ready = true; this.recoveryError = ''; return true;
    } catch (error) { if (this.active(token)) { this.ready = false; this.recoveryError = `Answer recovery unavailable: ${failure(error)}`; } return false; }
  }
  async refresh() { await this.loadPage(this.page, this.cursors); }
  private async loadPage(page: number, cursors: (string | null)[]) {
    if (!this.active()) return;
    const token = this.generation; const request = ++this.sequence; this.loading = true; this.draw();
    await Promise.allSettled([
      (async () => {
        try {
          const result = await this.context.services.clarifications!.list({ version: 1, repo: this.state.activity.repo, runId: null, states: [], limit: 25, cursor: cursors[page] ?? null }, this.controller.signal);
          if (!this.active(token) || request !== this.sequence) return;
          if (result?.status !== 'available' || !Array.isArray(result.value?.items) || result.value.items.length > 25 || result.value.items.some(item => !item || !this.scoped(item.repo))) throw new Error(result?.status === 'unavailable' ? result.reason : 'Invalid question page.');
          this.page = page; this.cursors = cursors; this.items = result.value.items; this.next = result.value.nextCursor; this.total = result.value.total; this.observedAt = result.value.observedAt; this.error = '';
        } catch (error) { if (this.active(token) && request === this.sequence) this.error = `Questions unavailable: ${failure(error)}`; }
        finally { if (this.active(token) && request === this.sequence) { this.loading = false; this.draw(); } }
      })(),
      this.pendingRead(token).then(() => { if (this.active(token)) this.draw(); }),
    ]);
  }
  private blocked(item: { repo: string; runId: string; questionId: string }) { return this.pending.some(entry => key(entry.command) === key(item)); }
  private async action(work: (token: number) => Promise<void>) {
    if (!this.active() || this.busy) return;
    const token = this.generation; this.busy = true; this.notice = ''; this.draw();
    try { await work(token); } catch (error) { if (this.active(token)) this.notice = failure(error); }
    finally { if (this.active(token)) { await this.pendingRead(token); if (this.active(token)) { this.busy = false; this.draw(); } } }
  }
  private answer(item: ClarificationReadItemV1) {
    const draft = this.saved.value.drafts.find(value => key(value) === key(identity(item)));
    if (!item.answerability?.available || item.provenance?.kind !== 'attempt-channel' || !draft?.text.trim() || !this.saved.writable || !this.ready || this.blocked(identity(item))) return;
    const input: ClarificationCommandInputV1 = { version: 1, ...identity(item), expectedAttempt: item.provenance.attempt, expectedChannelId: item.provenance.channelId, expectedQuestionRevision: item.revision, answer: draft.text.trim() };
    void this.action(async token => {
      if (!await this.saved.save() || !this.active(token)) return;
      const result = await this.context.services.clarificationCommands!.submit(input, this.controller.signal);
      if (!this.active(token)) return;
      this.notice = result?.status === 'available' ? result.value.status === 'succeeded' ? 'Answer accepted. Worker consumption is not confirmed. Save the result to dismiss its request.' : `Answer rejected: ${result.value.reason}. Your draft is retained.`
        : 'Answer outcome is unknown. Check the original saved request before retrying.';
    });
  }
  private async saveResult(receipt: ClarificationCommandReceiptV1, token: number) {
    if (!this.saved.writable || !this.scoped(receipt.input.repo)) return;
    const result = resultState(receipt); const existing = this.saved.value.results.find(item => item.requestId === receipt.requestId);
    if (existing && canonical(existing) !== canonical(result)) throw new Error('Saved result differs from the original receipt. The request is retained.');
    if (!existing) {
      if (this.saved.value.results.length >= 32) throw new Error('Remove a saved result before recording another. The original request is retained.');
      this.saved.edit(value => { value.results.push(result); });
    }
    if (!await this.saved.save() || !this.active(token)) return;
    await this.context.services.clarificationCommands!.acknowledge({ repo: receipt.input.repo, requestId: receipt.requestId }, this.controller.signal);
    if (this.active(token)) { this.notice = 'Result saved. The original draft is retained.'; void this.refresh(); }
  }
  private reconcile(entry: ClarificationCommandPendingV1, action: 'check' | 'retry' | 'save') {
    void this.action(async token => {
      if (action === 'save') { if (entry.receipt) await this.saveResult(entry.receipt, token); return; }
      if (action === 'retry' && (!this.ready || !this.saved.writable || !await this.saved.save() || !this.active(token))) return;
      const service = this.context.services.clarificationCommands!;
      if (action === 'retry' && !service.retry) throw new Error('Original request retry is unavailable. Check its receipt instead.');
      const query = { repo: entry.command.repo, requestId: entry.command.requestId };
      const result = action === 'retry' ? await service.retry!(query, this.controller.signal)
        : await service.receipt(query, this.controller.signal);
      if (!this.active(token)) return;
      this.notice = result?.status === 'available' ? result.value ? 'Original receipt found. Save its result before dismissing the request.' : 'No receipt is recorded. Retry original retains the same request identity.' : 'Original outcome is unavailable. The request and draft are retained.';
    });
  }
  private cleanup(kind: 'draft' | 'result', id: string) {
    const selected = kind === 'draft' ? this.saved.value.drafts.find(item => key(item) === id) : this.saved.value.results.find(item => item.requestId === id);
    const snapshot = canonical(selected);
    void this.action(async token => {
      if (!await this.pendingRead(token) || !this.active(token)) throw new Error('Read original requests before removing saved state.');
      const current = kind === 'draft' ? this.saved.value.drafts.find(item => key(item) === id) : this.saved.value.results.find(item => item.requestId === id);
      if (canonical(current) !== snapshot) throw new Error('Saved state changed. Review it before discarding.');
      if (kind === 'draft' && this.pending.some(item => key(item.command) === id) || kind === 'result' && this.pending.some(item => item.command.requestId === id)) throw new Error('Resolve the original request before discarding its evidence.');
      this.saved.edit(value => { if (kind === 'draft') value.drafts = value.drafts.filter(item => key(item) !== id); else value.results = value.results.filter(item => item.requestId !== id); });
      if (await this.saved.save() && this.active(token)) this.notice = 'Selected saved state removed. Command journals are unchanged.';
    });
  }
  private button(text: string, action: () => void, disabled = false) { const button = node('button', text); button.type = 'button'; button.disabled = !this.active() || this.busy || disabled; button.addEventListener('click', action); return button; }
  private detail(title: string, id: string) { const details = node('details'); details.open = this.details.has(id); details.append(node('summary', title)); details.addEventListener('toggle', () => { if (details.isConnected) { if (details.open) this.details.add(id); else this.details.delete(id); } }); return details; }
  private draw() {
    if (this.disposed) return;
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset.focus; const selection = focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd] : null;
    const root = node('section'); root.className = 'plugin-clarifications plugin-clarifications-panel'; root.append(node('style', styles), node('h2', 'Agent questions'));
    const controls = node('div'); controls.className = 'question-tools'; controls.append(this.button('Refresh questions', () => { void this.refresh(); }, this.loading), this.button('First page', () => { void this.loadPage(0, [null]); }, this.loading || this.page === 0)); root.append(controls);
    root.append(node('small', `${this.state.activity.repo ?? 'All galleons'} · ${this.total === null ? 'Total unknown' : `${this.total} matching questions observed`}${this.observedAt ? ` · ${this.observedAt}` : ''}`));
    const legacy = node('a', 'Previous drafts and requests'); const recovery = new URL('/plugins/helmsman.compat-clarifications/page', window.location.href); const headerRepo = new URL(window.location.href).searchParams.get('repo'); if (headerRepo) recovery.searchParams.set('repo', headerRepo); legacy.href = recovery.href; legacy.addEventListener('click', event => { event.preventDefault(); this.context.navigate(legacy.href); }); root.append(legacy);
    for (const text of [this.error, this.recoveryError, this.saved.error]) if (text) { const alert = node('p', text); alert.setAttribute('role', 'alert'); root.append(alert); }
    if (this.saved.conflict) root.append(this.button('Discard local edits and reload saved state', () => this.saved.reload()));
    if (this.saved.error && this.saved.writable) root.append(this.button('Retry saving drafts', () => { void this.saved.save(); }));
    if (this.notice) { const notice = node('p', this.notice); notice.setAttribute('role', 'status'); root.append(notice); }
    if (!this.items.length) root.append(node('p', this.loading ? 'Loading questions…' : 'No questions on this page.'));
    for (const item of this.items) {
      const row = node('article'); row.dataset.questionId = item.id; row.append(node('h3', item.prompt), node('small', `${item.repo} · ${item.runId} · ${item.state} · ${item.blocksPublication ? 'Blocks publication' : 'Does not block publication'}`));
      row.append(this.button('Open run', () => { try { this.context.selectPresentation?.({ version: 1, kind: 'run', repo: item.repo, runId: item.runId }); } catch (error) { this.notice = failure(error); this.draw(); } }, !this.context.selectPresentation));
      if (item.answer !== null) row.append(node('p', `Accepted answer: ${item.answer}`));
      const draft = this.saved.value.drafts.find(value => key(value) === key(identity(item)));
      if (!item.answerability?.available) row.append(node('p', `Read-only: ${item.answerability?.reason ?? 'unavailable'}.`));
      const form = node('form'); const label = node('label', 'Answer'); const input = node('textarea'); input.maxLength = 4000; input.value = draft?.text ?? ''; input.name = 'answer'; input.dataset.focus = `answer:${key(identity(item))}`;
      input.disabled = !this.active() || !this.saved.writable || !draft && this.saved.value.drafts.length >= 64;
      input.addEventListener('input', () => { this.saved.edit(value => { const current = value.drafts.find(value => key(value) === key(identity(item))); if (current) current.text = input.value; else value.drafts.push({ ...identity(item), text: input.value }); }); void this.saved.save(); });
      label.append(input); form.append(label); const submit = this.button('Accept answer', () => this.answer(item), !this.ready || !this.saved.writable || !item.answerability?.available || this.blocked(identity(item))); form.append(submit);
      form.addEventListener('submit', event => { event.preventDefault(); this.answer(item); }); row.append(form); root.append(row);
    }
    const pages = node('div'); pages.className = 'question-tools'; pages.append(this.button('Previous page', () => { void this.loadPage(this.page - 1, this.cursors); }, this.loading || this.page === 0), node('span', `Page ${this.page + 1} · ${this.items.length} questions shown.`),
      this.button('Next page', () => { if (this.next) void this.loadPage(this.page + 1, [...this.cursors.slice(0, this.page + 1), this.next]); }, this.loading || !this.next || this.page >= 127)); root.append(pages);
    if (this.pending.length) {
      const requests = node('section'); requests.append(node('h3', 'Original answer requests'));
      for (const entry of this.pending) {
        const row = node('article'); row.dataset.requestId = entry.command.requestId;
        row.append(node('p', `${entry.command.repo} · ${entry.command.runId} · ${entry.command.questionId} · Original attempt ${entry.command.expectedAttempt}, revision ${entry.command.expectedQuestionRevision}`), node('small', entry.command.requestId), node('pre', entry.command.answer), node('p', entry.receipt ? `${entry.receipt.status}${entry.receipt.reason ? `: ${entry.receipt.reason}` : ''}` : 'Outcome unknown'));
        if (entry.receipt) row.append(this.button('Save result and dismiss request', () => this.reconcile(entry, 'save'), !this.saved.writable));
        else row.append(this.button('Check receipt', () => this.reconcile(entry, 'check')), this.button('Retry original', () => this.reconcile(entry, 'retry'), !this.ready || !this.saved.writable || !this.context.services.clarificationCommands?.retry));
        requests.append(row);
      } root.append(requests);
    }
    const saved = this.detail('Saved drafts and results', 'saved');
    for (const draft of this.saved.value.drafts.filter(value => this.scoped(value.repo))) { const row = node('article'); row.dataset.savedId = key(draft); row.append(node('small', `${draft.repo} · ${draft.runId} · ${draft.questionId}`), node('pre', draft.text), this.button('Discard saved draft', () => this.cleanup('draft', key(draft)), !this.saved.writable || !this.ready || this.blocked(draft))); saved.append(row); }
    for (const result of this.saved.value.results.filter(value => this.scoped(value.repo))) { const row = node('article'); row.dataset.savedId = result.requestId; row.append(node('p', `${result.requestId} · ${result.status}${result.reason ? `: ${result.reason}` : '. Answer accepted; worker consumption is not confirmed.'}`), node('pre', result.answer), this.button('Dismiss saved result', () => this.cleanup('result', result.requestId), !this.saved.writable || !this.ready || this.pending.some(value => value.command.requestId === result.requestId))); saved.append(row); }
    root.append(saved);
    for (const button of root.querySelectorAll<HTMLElement>('button')) button.dataset.focus = JSON.stringify([button.closest<HTMLElement>('[data-question-id]')?.dataset.questionId, button.closest<HTMLElement>('[data-request-id]')?.dataset.requestId, button.closest<HTMLElement>('[data-saved-id]')?.dataset.savedId, button.textContent]);
    this.container.replaceChildren(root);
    if (focusKey) { const target = [...root.querySelectorAll<HTMLElement>('[data-focus]')].find(value => value.dataset.focus === focusKey); target?.focus({ preventScroll: true }); if (target instanceof HTMLTextAreaElement && selection) target.setSelectionRange(selection[0] ?? null, selection[1] ?? null); }
  }
}
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.clarifications?.version !== 1 || context.services.clarificationCommands?.version !== 1) throw new Error('Agent questions require public question and answer services.');
  return new Questions(container, context);
} };
export default panel;
