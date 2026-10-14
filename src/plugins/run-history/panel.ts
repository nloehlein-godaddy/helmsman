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

const glyphs = { refresh: '\ue094', running: '\ue3d2', succeeded: '\ue184', failed: '\ue4e2', stopped: '\ue3de', review: '\ue282', history: '\ue19a', caretRight: '\ue13a' } as const;
const icon = (name: keyof typeof glyphs) => { const value = node('span', glyphs[name]); value.className = 'run-icon'; value.setAttribute('aria-hidden', 'true'); return value; };
const statusLabels = { running: 'Worker running', succeeded: 'Worker completed', failed: 'Worker failed', stopped: 'Worker stopped' } as const;
const recommendationLabels = { APPROVE: 'Approve', REQUEST_CHANGES: 'Changes requested', COMMENT: 'Comment' } as const;
const date = (value: string) => {
  const parsed = new Date(value); const time = node('time', Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(parsed) + ' UTC' : value);
  time.dateTime = value; time.title = value; return time;
};

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
  private readonly expanded = new Set<string>();
  private historyOpen = true;

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
    if (changed) { this.cancel(); if (scopeChanged) { this.page = null; this.cursors = [null]; this.index = 0; this.error = ''; this.expanded.clear(); } if (this.active()) void this.read(this.index); }
    this.draw();
  }
  refresh() { return this.read(0, true); }
  private async read(index: number, reset = false) {
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
      this.page = result.value; this.index = index; if (reset) this.cursors = [null]; this.error = '';
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
    const previousDisclosure = this.container.querySelector<HTMLDetailsElement>('.run-history-panel');
    if (previousDisclosure) this.historyOpen = previousDisclosure.open;
    const focus = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
    const shell = node('section'); shell.className = 'plugin-run-history'; shell.setAttribute('aria-busy', String(this.loading)); shell.append(node('style', styles));
    const composition = this.container.closest('[data-composition-page]'); const composed = composition !== null;
    const disclosure = node('details'); disclosure.className = 'run-history-panel'; disclosure.open = this.historyOpen;
    disclosure.addEventListener('toggle', () => { if (disclosure.isConnected) this.historyOpen = disclosure.open; });
    const summary = node('summary'); summary.dataset.focus = 'history-summary'; const caret = icon('caretRight'); caret.classList.add('run-history-caret'); summary.append(caret);
    const heading = node(composition?.classList.contains('plugin-run-history') ? 'span' : 'h2', this.state.pirateMode ? 'Voyage history' : 'Run history'); heading.className = 'run-history-title'; heading.prepend(icon('history')); summary.append(heading); disclosure.append(summary);
    const root = node('div'); root.className = 'run-history-body'; disclosure.append(root); shell.append(disclosure);
    const tools = node('div'); tools.className = 'run-tools';
    const filter = node('select'); filter.setAttribute('aria-label', 'Run status filter'); filter.dataset.focus = 'filter'; filter.disabled = !this.active() || this.unsupported;
    for (const [value, label] of [['all', this.state.pirateMode ? 'All voyages' : 'All runs'], ['running', 'Running'], ['terminal', 'Finished']]) { const option = node('option', label); option.value = value!; filter.append(option); }
    filter.value = this.saved.kind;
    filter.addEventListener('change', () => { this.saved.kind = filter.value as HistoryState['kind']; this.page = null; this.cursors = [null]; this.index = 0; this.expanded.clear(); this.persist(); void this.refresh(); });
    const refresh = this.button('Refresh', () => { this.persist(); void this.refresh(); }, this.loading); refresh.prepend(icon('refresh')); refresh.dataset.focus = 'refresh';
    if (!composed) tools.append(refresh); if (tools.childElementCount) root.append(tools);
    const filters = node('div'); filters.className = 'run-filters'; const label = node('label', 'Status'); label.append(filter); filters.append(label); root.append(filters);
    for (const message of [this.error, this.saveError, this.unsupported ? 'Saved history state uses an unsupported version. It is preserved.' : '']) if (message) { const alert = node('p', `${message}${message === this.error && this.page ? ' Showing the last observed page.' : ''}`); alert.setAttribute('role', 'alert'); root.append(alert); }
    if (this.page) {
      const observation = node('div'); observation.className = 'run-observation';
      const total = node('p', this.page.totalQuality === 'exact' && this.page.total !== null ? `${this.page.total} matching runs observed ` : 'Total unknown · observed '); total.append(date(this.page.observedAt));
      observation.append(total, node('small', `Page ${this.index + 1} · ${this.page.items.length} runs shown. Statuses may change between pages.`)); root.append(observation);
      const list = node('div'); list.className = 'run-list';
      for (const run of this.page.items) {
        const row = node('article'); row.className = 'run-row'; row.dataset.runId = run.id; const heading = node('div'); heading.className = 'run-heading';
        const review = /^review$/i.test(run.displayKey.trim());
        const number = Number.isSafeInteger(run.prNumber) && (run.prNumber ?? 0) > 0 ? run.prNumber : null;
        const label = review ? `${this.state.pirateMode ? 'Inspection' : 'Review'}${number ? ` #${number}` : ''}` : run.displayKey;
        const subject = typeof run.title === 'string' && run.title.trim() && !/^review(?:\s+#\d+)?$/i.test(run.title.trim()) ? run.title : null;
        const open = this.button(subject ?? label, () => this.select(run.repo, run.id), !this.context.selectPresentation); open.className = subject ? 'run-open run-subject' : 'run-open';
        open.dataset.focus = JSON.stringify([run.repo, run.id, 'open']); open.setAttribute('aria-label', `${subject ? `${subject} · ` : ''}${label} · ${run.repo} · ${run.id} · Attempt ${run.attempt}`); heading.append(open);
        const identity = node('div'); identity.className = 'run-identity';
        if (subject) identity.append(node('small', label));
        if (run.repo !== this.state.activity.repo) identity.append(node('small', run.repo));
        if (number && /^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[a-z\d_.-]+$/i.test(run.repo)) {
          const headerRepo = this.state.headerRepo === undefined ? this.state.repo : this.state.headerRepo;
          const params = new URLSearchParams({ ...(headerRepo ? { repo: headerRepo } : {}), prRepo: run.repo, pr: String(number) });
          const linkLabel = `${this.state.pirateMode ? 'Bounty' : 'PR'} ${run.repo === this.state.activity.repo ? '' : run.repo}#${number}`;
          const link = node('a', linkLabel); link.title = `${run.repo}#${number}`; link.setAttribute('aria-label', `${linkLabel} · ${run.repo}`); link.href = `/prs?${params}`; link.dataset.focus = JSON.stringify([run.repo, run.id, 'pr']);
          link.addEventListener('click', event => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !this.active()) return;
            event.preventDefault(); this.context.navigate(link.getAttribute('href') ?? '/prs');
          }); identity.append(link);
        }
        heading.append(identity); row.append(heading);
        const metadata = node('div'); metadata.className = 'run-metadata';
        const worker = node('span', statusLabels[run.status] ?? `Worker: ${run.status}`); worker.className = 'run-worker'; worker.dataset.status = run.status;
        if (Object.hasOwn(statusLabels, run.status)) worker.prepend(icon(run.status)); metadata.append(worker);
        if (run.review) { const recommendation = node('span', `Recommendation: ${recommendationLabels[run.review.outcome] ?? run.review.outcome}`); recommendation.className = 'run-recommendation'; recommendation.prepend(icon(run.review.outcome === 'APPROVE' ? 'succeeded' : run.review.outcome === 'REQUEST_CHANGES' ? 'failed' : 'review')); metadata.append(recommendation); }
        const feedback = feedbackLabel(run);
        if (feedback) { const outcome = node('span', feedback); outcome.className = 'run-feedback-outcome'; outcome.title = run.feedbackOutcome?.summary ?? ''; metadata.append(outcome); }
        if (run.sourceSettlement?.state === 'operator-required') { const settlement = node('span', 'Needs action'); settlement.className = 'run-settlement'; settlement.title = 'Source settlement requires operator action.'; settlement.prepend(icon('failed')); metadata.append(settlement); }
        const spend = node('small', run.costUsd === null || !Number.isFinite(run.costUsd) ? 'Spend unknown' : `$${run.costUsd.toFixed(2)} observed spend`); metadata.append(spend); row.append(metadata);
        const footer = node('div'); footer.className = 'run-footer';
        const started = node('small', 'Started '); started.className = 'run-started'; started.append(date(run.startedAt)); footer.append(started);
        const detailsKey = JSON.stringify([run.repo, run.id]); const details = node('details'); details.className = 'run-details'; details.open = this.expanded.has(detailsKey);
        details.addEventListener('toggle', () => { if (!details.isConnected) return; if (details.open) { if (this.expanded.size >= 200) this.expanded.delete(this.expanded.values().next().value!); this.expanded.add(detailsKey); } else this.expanded.delete(detailsKey); });
        const summary = node('summary', 'Details'); summary.dataset.focus = JSON.stringify([run.repo, run.id, 'details']); details.append(summary);
        const evidence = node('div'); evidence.className = 'run-evidence'; evidence.append(node('small', `${run.repo} · ${run.id} · Attempt ${run.attempt}`), node('p', `Worker: ${run.status}`), node('small', `Started ${run.startedAt}${run.endedAt ? ` · Ended ${run.endedAt}` : ''}`));
        if (run.review) evidence.append(node('p', `Review recommendation: ${run.review.outcome}${run.review.verdict ? ` — ${run.review.verdict}` : ''}`));
        if (run.feedbackOutcome) evidence.append(node('p', `Feedback state: ${run.feedbackOutcome.state}`), node('small', `Feedback head: ${run.feedbackOutcome.headSha}`), node('p', run.feedbackOutcome.summary ?? ''));
        if (run.sourceSettlement) evidence.append(node('p', `Source settlement: ${run.sourceSettlement.state}`));
        details.append(evidence); footer.append(details); row.append(footer); list.append(row);
      }
      root.append(list);
      if (!this.page.items.length) root.append(node('p', 'No matching runs.'));
      const navigation = node('div'); navigation.className = 'run-tools';
      navigation.append(this.button('Previous page', () => { void this.read(this.index - 1); }, this.loading || this.index === 0), this.button('Next page', () => {
        if (!this.page?.nextCursor || this.cursors.slice(0, this.index + 1).includes(this.page.nextCursor)) { this.error = 'History cursor did not advance. Refresh to retry.'; this.draw(); return; }
        if (this.index >= 199) { this.error = 'This history session has reached 200 pages. Refresh to start a new observation.'; this.draw(); return; }
        this.cursors = this.cursors.slice(0, this.index + 1); this.cursors.push(this.page.nextCursor); void this.read(this.index + 1);
      }, this.loading || !this.page.nextCursor)); root.append(navigation);
    } else root.append(node('p', this.loading ? 'Loading run history…' : 'Run history is unavailable.'));
    const controls = [...root.querySelectorAll<HTMLElement>('button, a')];
    for (const control of controls) if (!control.dataset.focus) control.dataset.focus = JSON.stringify([control.closest<HTMLElement>('[data-run-id]')?.dataset.runId, control.textContent]);
    this.container.replaceChildren(shell);
    if (focus) [...shell.querySelectorAll<HTMLElement>('[data-focus]')].find(control => control.dataset.focus === focus)?.focus({ preventScroll: true });
  }
}
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.runInspect?.version !== 1) throw new Error('Run history requires version 1 run inspection.');
  return new HistoryPanel(container, context);
} };
export default panel;
