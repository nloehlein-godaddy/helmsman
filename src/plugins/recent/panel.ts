import { createLoadingWheelV1 } from '@helmsman/plugin-sdk';
import type { PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, RunCommandPendingV1,
  RunCommandReceiptV1, RunReadResultV1, RunReadPageV1, RunReadSummaryV1 } from '@helmsman/plugin-sdk';

const presentation: { kind: 'running' | 'terminal'; action: 'stop' | 'retry'; limit: number; name: string } = { kind: 'terminal', action: 'retry', limit: 10, name: 'recent' };
interface CommandState { repo: string; runId: string; attempt: number; requestId: string | null; receipt: RunCommandReceiptV1 | null; busy: boolean; uncertain: boolean; message: string; }
const key = (run: { repo: string; id: string; attempt: number }) => JSON.stringify([run.repo, run.id, run.attempt]);
const feedbackLabel = (run: RunReadSummaryV1 | null | undefined): string | null => {
  const state = run?.feedbackOutcome?.state;
  if (state === 'completed') return run?.status === 'succeeded' ? 'Feedback completed' : run?.status === 'running' ? null : 'Feedback remaining';
  if (state === 'awaiting_decision') return run?.status === 'running' ? 'Awaiting decision' : 'Feedback remaining';
  return state === 'changes_remaining' ? 'Feedback remaining' : null;
};
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
const styles = `.plugin-run-list{display:grid;gap:10px;color:var(--text);font:14px var(--sans,sans-serif);min-width:0}.plugin-run-list h2{margin:0;font-size:15px}.plugin-run-list ul{list-style:none;margin:0;padding:0}.plugin-run-list li{display:grid;gap:7px;padding:10px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.plugin-run-list .run-main,.plugin-run-list .run-actions,.plugin-run-list header{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.plugin-run-list header{justify-content:space-between}.plugin-run-list small{color:var(--text-dim)}.plugin-run-list :is(a,button){font:inherit;color:var(--accent)}.plugin-run-list button{padding:5px 8px;background:var(--face-hi);border:1px solid var(--line-strong);border-radius:var(--radius,4px);cursor:pointer}.plugin-run-list button:disabled{opacity:.5;cursor:default}.plugin-run-list [role=alert]{color:var(--bad)}.plugin-run-list .run-status{font-weight:600}.plugin-run-list :is(a,button):focus-visible{outline:2px solid var(--accent);outline-offset:2px}`;

class RunListPanel implements PluginPanelInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private state: PluginPanelState;
  private disposed = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private pendingRead: Promise<void> | null = null;
  private evidenceReady = false;
  private loading = true;
  private error = '';
  private commandError = '';
  private truncated = false;
  private rows: readonly RunReadSummaryV1[] = [];
  private readonly dismissed = new Set<string>();
  private readonly commands = new Map<string, CommandState>();

  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state;
    context.onDispose(() => this.dispose()); context.signal.addEventListener('abort', this.dispose, { once: true });
    this.state.activity.signal.addEventListener('abort', this.cancel, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation): boolean { return !this.disposed && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private cancel = () => { for (const command of this.commands.values()) command.busy = false; ++this.generation; this.controller?.abort(); this.controller = null; this.unsubscribe?.(); this.unsubscribe = null; this.pendingRead = null; this.evidenceReady = false; };
  dispose = () => {
    if (this.disposed) return; this.disposed = true; this.cancel();
    this.context.signal.removeEventListener('abort', this.dispose); this.state.activity.signal.removeEventListener('abort', this.cancel);
  };
  update(next: PluginPanelState): void {
    if (this.disposed) return;
    const previous = this.state; this.state = next;
    if (previous.activity.signal !== next.activity.signal) { previous.activity.signal.removeEventListener('abort', this.cancel); next.activity.signal.addEventListener('abort', this.cancel, { once: true }); }
    if (previous.repo !== next.repo || previous.activity.epoch !== next.activity.epoch || previous.visible !== next.visible || previous.activity.active !== next.activity.active || previous.activity.signal !== next.activity.signal) {
      this.cancel();
      if (previous.repo !== next.repo) { this.rows = []; this.commands.clear(); this.error = ''; this.commandError = ''; }
      if (this.active()) void this.refresh();
    }
    this.draw();
  }
  refresh(): Promise<void> {
    if (!this.active()) return Promise.resolve();
    this.cancel(); const generation = this.generation; const controller = new AbortController(); this.controller = controller;
    this.loading = true; this.error = ''; this.draw();
    try {
      this.unsubscribe = this.context.services.runs!.watchList({ version: 1, repo: this.state.repo, kind: presentation.kind, limit: presentation.limit, cursor: null },
        result => this.receive(result, generation), controller.signal);
    } catch { this.loading = false; this.error = 'Run data is unavailable. Refresh to retry.'; this.draw(); }
    return this.restorePending(generation);
  }
  private receive(result: RunReadResultV1<RunReadPageV1>, generation: number): void {
    if (!this.active(generation)) return;
    this.loading = false;
    if (result?.status === 'available' && Array.isArray(result.value?.items)) {
      this.rows = result.value.items.filter(run => run && typeof run.id === 'string' && typeof run.repo === 'string' && typeof run.displayKey === 'string'
        && Number.isInteger(run.attempt) && run.attempt > 0 && typeof run.startedAt === 'string'
        && (run.costUsd === null || typeof run.costUsd === 'number' && Number.isFinite(run.costUsd) && run.costUsd >= 0)
        && ['running', 'succeeded', 'failed', 'stopped'].includes(run.status)
        && (this.state.repo === null || run.repo === this.state.repo) && (presentation.kind === 'running' ? run.status === 'running' : run.status !== 'running')).slice(0, presentation.limit);
      this.truncated = typeof result.value.nextCursor === 'string'; this.error = '';
    } else { this.rows = []; this.error = `Run data is unavailable${result?.status === 'unavailable' ? `: ${result.reason}` : ''}. Refresh to retry.`; }
    this.draw(); void this.restorePending(generation);
  }
  private restorePending(generation: number): Promise<void> {
    if (!this.active(generation)) return Promise.resolve();
    if (this.pendingRead) return this.pendingRead;
    const work = Promise.resolve().then(async () => {
      const pending = await this.context.services.runCommands!.pending();
      if (!this.active(generation)) return;
      if (!Array.isArray(pending)) throw new Error('Invalid command evidence');
      this.commandError = '';
      const matches = pending.filter(item => item?.command && item.command.action === presentation.action && 'target' in item.command
        && (this.state.repo === null || item.command.repo === this.state.repo));
      if (matches.length > 100) this.commandError = 'Only the first 100 saved requests are shown. Review remaining requests in Recovery.';
      for (const saved of matches.slice(0, 100)) this.restoreCommand(saved);
      this.evidenceReady = matches.length <= 100;
    }).catch(() => { if (this.active(generation)) { this.evidenceReady = false; this.commandError = 'Saved command evidence is unavailable. Refresh before issuing another command.'; } })
      .finally(() => { if (this.active(generation)) { this.pendingRead = null; this.draw(); } });
    this.pendingRead = work; return work;
  }
  private restoreCommand(saved: RunCommandPendingV1): void {
    const input = saved.command; if (input.action === 'launch' || !input.target || this.dismissed.has(input.requestId)) return;
    const id = key({ repo: input.repo, id: input.target.runId, attempt: input.target.expectedAttempt });
    const current = this.commands.get(id); if (current?.busy || current?.receipt && ['accepted', 'rejected'].includes(current.receipt.status)) return;
    this.commands.set(id, { repo: input.repo, runId: input.target.runId, attempt: input.target.expectedAttempt, requestId: input.requestId,
      receipt: saved.receipt, busy: false, uncertain: saved.receipt === null || ['pending', 'recovery-required'].includes(saved.receipt.status), message: '' });
  }
  private async submit(run: RunReadSummaryV1): Promise<void> {
    const id = key(run); const prior = this.commands.get(id);
    if (!this.active() || !this.evidenceReady || prior?.busy || prior?.uncertain || !!prior?.receipt && ['accepted', 'rejected'].includes(prior.receipt.status)
      || !this.rows.some(current => key(current) === id && current.status === run.status)) return;
    const command: CommandState = { repo: run.repo, runId: run.id, attempt: run.attempt, requestId: null, receipt: null, busy: true, uncertain: true, message: '' };
    this.commands.set(id, command); await this.deliver(command, 'submit');
  }
  private async deliver(command: CommandState, action: 'submit' | 'retry'): Promise<void> {
    if (!this.active() || !this.evidenceReady || command.receipt && ['accepted', 'rejected', 'recovery-required'].includes(command.receipt.status)) return;
    const generation = this.generation; command.busy = true; this.draw();
    try {
      const service = this.context.services.runCommands!;
      if (action === 'retry' && (!command.requestId || !service.retry)) throw new Error('Original request retry is unavailable.');
      const result = action === 'retry' ? await service.retry!({ repo: command.repo, requestId: command.requestId! }, this.controller?.signal)
        : await service.submit({ version: 1, repo: command.repo, action: presentation.action,
          target: { runId: command.runId, expectedAttempt: command.attempt } }, this.controller?.signal);
      if (!this.active(generation)) return;
      if (result?.status === 'available' && result.value) { command.receipt = result.value; command.requestId = result.value.requestId; command.uncertain = ['pending', 'recovery-required'].includes(result.value.status); }
      else command.message = 'Command outcome is not confirmed. Check the saved request before trying again.';
    } catch { if (this.active(generation)) command.message = 'Command outcome is not confirmed. Check the saved request before trying again.'; }
    finally { if (this.active(generation)) { command.busy = false; await this.restorePending(generation); this.draw(); } }
  }
  private async reconcile(command: CommandState): Promise<void> {
    if (!this.active() || command.busy) return;
    if (!command.requestId) {
      const generation = this.generation; await this.restorePending(generation);
      const restored = this.commands.get(key({ repo: command.repo, id: command.runId, attempt: command.attempt }));
      if (this.active(generation) && restored?.requestId) await this.reconcile(restored);
      return;
    }
    const generation = this.generation; command.busy = true; this.draw();
    try {
      const result = await this.context.services.runCommands!.receipt({ repo: command.repo, requestId: command.requestId }, this.controller?.signal);
      if (!this.active(generation)) return;
      if (result?.status === 'available' && result.value) { command.receipt = result.value; command.uncertain = ['pending', 'recovery-required'].includes(result.value.status); command.message = ''; }
      else command.message = result?.status === 'available' ? 'The server has not recorded this request. Retry delivery keeps its saved identity.' : 'No terminal command receipt is available. The request remains protected.';
    } catch { if (this.active(generation)) command.message = 'Unable to read the command receipt. The request remains protected.'; }
    finally { if (this.active(generation)) { command.busy = false; this.draw(); } }
  }
  private async dismiss(command: CommandState): Promise<void> {
    if (!this.active() || command.busy || !command.requestId || !command.receipt || !['accepted', 'rejected'].includes(command.receipt.status)) return;
    const generation = this.generation; command.busy = true; this.draw();
    try {
      await this.context.services.runCommands!.acknowledge({ repo: command.repo, requestId: command.requestId });
      if (this.active(generation)) { this.dismissed.add(command.requestId); this.commands.delete(key({ repo: command.repo, id: command.runId, attempt: command.attempt })); }
    } catch { if (this.active(generation)) command.message = 'Could not dismiss the saved request. Refresh to retry.'; }
    finally { if (this.active(generation)) { command.busy = false; this.draw(); } }
  }
  private link(label: string, path: string): HTMLAnchorElement {
    const link = node('a', label); link.href = path;
    link.addEventListener('click', event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); this.context.navigate(path); } });
    return link;
  }
  private detail(runId: string, repo: string): string {
    const headerRepo = this.state.headerRepo === undefined ? this.state.repo : this.state.headerRepo;
    const query = new URLSearchParams({ ...(headerRepo ? { repo: headerRepo } : {}), runRepo: repo, run: runId });
    return `/runs?${query}`;
  }
  private button(label: string, callback: () => void, disabled = false): HTMLButtonElement { const button = node('button', label); button.type = 'button'; button.disabled = disabled; button.addEventListener('click', callback); return button; }
  private commandFeedback(parent: HTMLElement, command: CommandState): void {
    const receipt = command.receipt;
    const feedback = node('p', command.busy ? 'Updating request…' : receipt?.status === 'accepted'
      ? presentation.action === 'stop' ? 'Stop requested. Worker status is reported separately.' : 'Retry accepted. The original worker outcome is unchanged.'
      : receipt?.status === 'rejected' ? `Request rejected: ${receipt.message ?? 'Refresh and try again.'}`
      : receipt?.status === 'recovery-required' ? 'Request requires Recovery. Its outcome is not confirmed.' : command.message || 'Request pending. Its outcome is not confirmed.');
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); parent.append(feedback);
    if (receipt?.status === 'accepted' && presentation.action === 'retry' && receipt.runId) parent.append(this.link(this.state.pirateMode ? 'Open new voyage' : 'Open new run', this.detail(receipt.runId, command.repo)));
    if (receipt && ['accepted', 'rejected'].includes(receipt.status)) {
      if (command.message) parent.append(node('p', command.message));
      parent.append(this.button('Dismiss request', () => { void this.dismiss(command); }, command.busy || !this.active()));
    }
    if (command.uncertain || receipt?.status === 'recovery-required') {
      parent.append(this.button('Check request', () => { void this.reconcile(command); }, command.busy || !this.active()));
      if (command.requestId && (!receipt || receipt.status === 'pending')) parent.append(this.button('Retry delivery', () => { if (!command.busy) void this.deliver(command, 'retry'); }, command.busy || !this.active() || !this.evidenceReady || !this.context.services.runCommands?.retry));
      parent.append(this.link('Recovery', `/recovery?${new URLSearchParams({ repo: command.repo })}`));
    }
  }
  private draw(): void {
    if (this.disposed) return;
    const focus = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement.dataset.runFocus : undefined;
    const root = node('section'); root.className = `plugin-run-list plugin-${presentation.name}`;
    root.setAttribute('aria-busy', String(this.loading)); root.append(node('style', styles));
    const header = node('header'); header.append(node('h2', presentation.kind === 'running' ? this.state.pirateMode ? 'Deckhand tasks' : 'Agent tasks' : this.state.pirateMode ? 'Recent voyages' : 'Recent runs'),
      this.button('Refresh', () => { void this.refresh(); }, !this.active())); root.append(header);
    for (const message of [this.error, this.commandError]) if (message) { const error = node('p', message); error.setAttribute('role', 'alert'); root.append(error); }
    const list = node('ul'); const visible = new Set<string>();
    for (const run of this.rows) {
      const id = key(run); visible.add(id); const command = this.commands.get(id);
      const row = node('li'); row.dataset.runId = run.id; row.dataset.runKey = id;
      const main = node('div'); main.className = 'run-main';
      const title = run.prNumber ? `${run.displayKey} · ${this.state.pirateMode ? 'Bounty' : 'PR'} #${run.prNumber}` : run.displayKey;
      main.append(this.link(title, this.detail(run.id, run.repo)), node('small', run.repo), node('span', `Worker: ${run.status === 'running' && this.state.pirateMode ? 'Underway' : run.status}`));
      const status = main.lastElementChild; if (status) status.className = 'run-status'; row.append(main);
      const timestamp = Number.isFinite(Date.parse(run.startedAt)) ? new Date(run.startedAt).toLocaleString() : 'Unknown start time';
      const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(run.startedAt)) / 60_000));
      if (run.status === 'running' && Number.isFinite(elapsed)) row.append(node('small', `${elapsed < 60 ? `${elapsed}m` : `${Math.floor(elapsed / 60)}h ${elapsed % 60}m`} elapsed`));
      row.append(node('small', `${run.id} · Attempt ${run.attempt} · Started ${timestamp} · ${run.costUsd === null ? 'Spend unknown' : `$${run.costUsd.toFixed(2)} observed spend`}`));
      const feedback = feedbackLabel(run);
      if (feedback) { const outcome = node('p', feedback); outcome.className = 'run-feedback-outcome'; outcome.title = run.feedbackOutcome?.summary ?? ''; row.append(outcome); }
      if (run.review) row.append(node('p', `Review recommendation: ${{ APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes', COMMENT: 'Comment' }[run.review.outcome]}${run.review.verdict ? ` — ${run.review.verdict}` : ''}`));
      if (run.sourceSettlement) row.append(node('p', `Source settlement: ${{ pending: 'pending', settled: 'settled', 'operator-required': 'operator action required' }[run.sourceSettlement.state]}. Worker outcome is unchanged.`));
      const actions = node('div'); actions.className = 'run-actions';
      const eligible = presentation.action === 'stop' ? run.status === 'running' : run.status === 'failed';
      if (eligible) {
        const button = this.button(presentation.action === 'stop' ? 'Stop' : 'Retry', () => { void this.submit(run); }, !this.active() || !this.evidenceReady || !!command?.busy || !!command?.uncertain || !!command?.receipt && ['accepted', 'rejected'].includes(command.receipt.status));
        button.setAttribute('aria-label', `${presentation.action === 'stop' ? 'Stop' : 'Retry'} ${this.state.pirateMode ? 'voyage' : 'run'} ${run.displayKey}, attempt ${run.attempt}`); actions.append(button);
      }
      const copy = this.button('Copy run ID', () => {
        void Promise.resolve().then(() => navigator.clipboard.writeText(run.id)).then(() => { copy.textContent = 'Copied'; }).catch(() => { copy.textContent = 'Copy unavailable'; });
      });
      actions.append(copy); row.append(actions); if (command) this.commandFeedback(row, command); list.append(row);
    }
    if (this.loading) { const loading = node('li'); loading.append(createLoadingWheelV1('Loading runs…')); list.append(loading); }
    if (!this.rows.length && !this.loading && !this.error) list.append(node('li', presentation.kind === 'running' ? this.state.pirateMode ? 'No deckhand tasks underway.' : 'No agent tasks running.' : this.state.pirateMode ? 'No past voyages.' : 'No past runs.'));
    root.append(list);
    const pending = [...this.commands].filter(([id]) => !visible.has(id));
    if (pending.length) { const saved = node('section'); saved.append(node('h3', `Saved requests (${pending.length})`)); for (const [, command] of pending) { const row = node('div', `${command.runId} · ${command.repo} · Attempt ${command.attempt}`); row.dataset.runKey = key({ repo: command.repo, id: command.runId, attempt: command.attempt }); this.commandFeedback(row, command); saved.append(row); } root.append(saved); }
    if (this.truncated) root.append(node('small', `Showing the first ${presentation.limit} ${presentation.kind === 'running' ? 'active' : 'recent'} runs.`));
    const history = new URLSearchParams({ pane: 'recent' }); if (this.state.repo) history.set('repo', this.state.repo);
    root.append(this.link(this.state.pirateMode ? 'All voyages' : 'All runs', `/runs?${history}`));
    const controls = Array.from(root.querySelectorAll<HTMLElement>('a,button'));
    for (const control of controls) control.dataset.runFocus = JSON.stringify([control.closest<HTMLElement>('[data-run-key]')?.dataset.runKey ?? '', control.tagName, control.getAttribute('aria-label') ?? control.textContent, control.getAttribute('href')]);
    this.container.replaceChildren(root);
    if (focus) controls.find(control => control.dataset.runFocus === focus)?.focus({ preventScroll: true });
  }
}
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.runs?.version !== 1 || context.services.runCommands?.version !== 1) throw new Error('Run panels require version 1 run reads and commands.');
  return new RunListPanel(container, context);
} };
export default panel;
