import type { RunReadSummaryV1, PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, RunInspectHistoryPageV1 } from '@helmsman/plugin-sdk';
import { readState, saveState, type HistoryState } from './state.js';
import { styles } from './styles.js';

const feedbackLabel = (run: RunReadSummaryV1 | null | undefined): string | null => {
  const state = run?.feedbackOutcome?.state;
  if (state === 'completed') return run?.status === 'succeeded' ? 'Feedback completed' : run?.status === 'running' ? null : 'Feedback remaining';
  if (state === 'awaiting_decision') return run?.status === 'running' ? 'Awaiting decision' : 'Feedback remaining';
  return state === 'changes_remaining' ? 'Feedback remaining' : null;
};
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };

class HistoryPanel implements PluginPanelInstance {
  private state: PluginPanelState;
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private saved: HistoryState;
  private readonly unsupported: boolean;
  private disposed = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private page: RunInspectHistoryPageV1 | null = null;
  private cursors: (string | null)[] = [null];
  private index = 0;
  private loading = false;
  private error = '';
  private saveError = '';
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state;
    const saved = readState(this.state.savedState); this.saved = saved ?? { kind: 'all' }; this.unsupported = saved === null;
    context.onDispose(this.dispose); context.signal.addEventListener('abort', this.dispose, { once: true });
    this.state.activity.signal.addEventListener('abort', this.cancel, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private cancel = () => { ++this.generation; this.controller?.abort(); this.controller = null; this.loading = false; };
  dispose = () => {
    if (this.disposed) return; this.disposed = true; this.cancel();
    this.context.signal.removeEventListener('abort', this.dispose); this.state.activity.signal.removeEventListener('abort', this.cancel);
    this.container.replaceChildren();
  };
  update(next: PluginPanelState) {
    if (this.disposed) return;
    const previous = this.state;
    previous.activity.signal.removeEventListener('abort', this.cancel); this.state = next; next.activity.signal.addEventListener('abort', this.cancel, { once: true });
    const scopeChanged = previous.activity.repo !== next.activity.repo;
    const changed = scopeChanged || previous.activity.signal !== next.activity.signal || previous.activity.epoch !== next.activity.epoch || previous.visible !== next.visible || previous.activity.active !== next.activity.active;
    if (changed) { this.cancel(); if (scopeChanged) { this.page = null; this.cursors = [null]; this.index = 0; this.error = ''; } if (this.active()) void this.read(this.index); }
    this.draw();
  }
  refresh() { this.cursors = [null]; this.index = 0; this.page = null; return this.read(0); }
  private async read(index: number) {
    const service = this.context.services.runInspect;
    if (!service || !this.active()) return;
    this.cancel(); const generation = this.generation; const controller = new AbortController(); this.controller = controller;
    this.loading = true; this.error = ''; this.draw();
    try {
      const result = await service.history({ version: 1, repo: this.state.activity.repo, kind: this.saved.kind, cursor: this.cursors[index] ?? null, limit: 50 }, controller.signal);
      if (!this.active(generation)) return;
      if (result?.status !== 'available' || !Array.isArray(result.value?.items) || result.value.items.length > 50
        || result.value.repo !== this.state.activity.repo || result.value.items.some(run => !run || typeof run.id !== 'string' || typeof run.repo !== 'string' || typeof run.displayKey !== 'string'
          || this.state.activity.repo !== null && run.repo !== this.state.activity.repo)) throw new Error('Run history is unavailable. Refresh to retry.');
      this.page = result.value; this.index = index; this.error = '';
    } catch (error) { if (this.active(generation)) this.error = error instanceof Error ? error.message : 'Run history is unavailable. Refresh to retry.'; }
    finally { if (this.active(generation)) { this.loading = false; this.draw(); } }
  }
  private persist() {
    if (this.unsupported) return;
    const snapshot = saveState(this.saved);
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      if (this.disposed) return;
      try { await this.context.saveState(snapshot); this.saveError = ''; }
      catch { this.saveError = 'History filter could not be saved. Your current selection is kept.'; }
      if (!this.disposed) this.draw();
    });
  }
  private select(repo: string, runId: string) {
    if (!this.active()) return;
    try { if (!this.context.selectPresentation) throw new Error('Run selection is unavailable.'); this.context.selectPresentation({ version: 1, kind: 'run', repo, runId }); }
    catch (error) { this.error = error instanceof Error ? error.message : 'Run selection is unavailable.'; this.draw(); }
  }
  private button(label: string, action: () => void, disabled = false) { const button = node('button', label); button.type = 'button'; button.disabled = disabled || !this.active(); button.addEventListener('click', action); return button; }
  private draw() {
    if (this.disposed) return;
    const focus = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
    const root = node('section'); root.className = 'plugin-run-history'; root.setAttribute('aria-busy', String(this.loading)); root.append(node('style', styles));
    const tools = node('div'); tools.className = 'run-tools'; tools.append(node('h2', this.state.pirateMode ? 'Voyage history' : 'Run history'));
    const filter = node('select'); filter.setAttribute('aria-label', 'Run status filter'); filter.dataset.focus = 'filter'; filter.disabled = !this.active() || this.unsupported;
    for (const [value, label] of [['all', 'All runs'], ['running', 'Running'], ['terminal', 'Completed']]) { const option = node('option', label); option.value = value!; filter.append(option); }
    filter.value = this.saved.kind;
    filter.addEventListener('change', () => { this.saved.kind = filter.value as HistoryState['kind']; this.page = null; this.persist(); void this.refresh(); });
    tools.append(filter, this.button('Refresh', () => { this.persist(); void this.refresh(); }, this.loading)); root.append(tools);
    for (const message of [this.error, this.saveError, this.unsupported ? 'Saved history state uses an unsupported version. It is preserved.' : '']) if (message) { const alert = node('p', message); alert.setAttribute('role', 'alert'); root.append(alert); }
    if (this.page) {
      root.append(node('p', this.page.totalQuality === 'exact' && this.page.total !== null ? `${this.page.total} matching runs observed ${this.page.observedAt}` : `Total unknown · observed ${this.page.observedAt}`),
        node('small', `Page ${this.index + 1} · ${this.page.items.length} runs shown. Statuses may change between pages.`));
      for (const run of this.page.items) {
        const row = node('article'); row.className = 'run-row'; row.dataset.runId = run.id;
        const open = this.button(run.displayKey, () => this.select(run.repo, run.id), !this.context.selectPresentation);
        open.setAttribute('aria-label', `${run.displayKey} · ${run.repo} · ${run.id} · Attempt ${run.attempt}`);
        row.append(open, node('small', `${run.repo} · ${run.id} · Attempt ${run.attempt}`),
          node('p', `Worker: ${run.status} · ${run.costUsd === null ? 'Spend unknown' : `$${run.costUsd.toFixed(2)} observed spend`}`), node('small', `Started ${run.startedAt}${run.endedAt ? ` · Ended ${run.endedAt}` : ''}`));
        const feedback = feedbackLabel(run);
      if (feedback) { const outcome = node('p', feedback); outcome.className = 'run-feedback-outcome'; outcome.title = run.feedbackOutcome?.summary ?? ''; row.append(outcome); }
      if (run.review) row.append(node('p', `Review recommendation: ${run.review.outcome}${run.review.verdict ? ` — ${run.review.verdict}` : ''}`));
        if (run.sourceSettlement) row.append(node('p', `Source settlement: ${run.sourceSettlement.state}`));
        root.append(row);
      }
      if (!this.page.items.length) root.append(node('p', 'No matching runs.'));
      const navigation = node('div'); navigation.className = 'run-tools';
      navigation.append(this.button('Previous page', () => { void this.read(this.index - 1); }, this.loading || this.index === 0), this.button('Next page', () => {
        if (!this.page?.nextCursor || this.cursors.slice(0, this.index + 1).includes(this.page.nextCursor)) { this.error = 'History cursor did not advance. Refresh to retry.'; this.draw(); return; }
        if (this.index >= 199) { this.error = 'This history session has reached 200 pages. Refresh to start a new observation.'; this.draw(); return; }
        this.cursors = this.cursors.slice(0, this.index + 1); this.cursors.push(this.page.nextCursor); void this.read(this.index + 1);
      }, this.loading || !this.page.nextCursor)); root.append(navigation);
    } else root.append(node('p', this.loading ? 'Loading run history…' : 'Run history is unavailable.'));
    const controls = [...root.querySelectorAll<HTMLElement>('button')];
    for (const control of controls) control.dataset.focus = JSON.stringify([control.closest<HTMLElement>('[data-run-id]')?.dataset.runId, control.textContent]);
    this.container.replaceChildren(root);
    if (focus) [...root.querySelectorAll<HTMLElement>('[data-focus]')].find(control => control.dataset.focus === focus)?.focus({ preventScroll: true });
  }
}
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.runInspect?.version !== 1) throw new Error('Run history requires version 1 run inspection.');
  return new HistoryPanel(container, context);
} };
export default panel;
