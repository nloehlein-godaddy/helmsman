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
const shortRunId = (id: string): string => {
  const digest = /^(?:slack|created)-([a-f0-9]+)$/i.exec(id)?.[1] ?? id;
  return /^[a-f0-9]{12,}$/i.test(digest) ? digest.slice(0, 12) : digest;
};
const reviewSummary = (verdict: string | null | undefined, outcome: string): string => {
  const text = typeof verdict === 'string' ? verdict.trim() : '';
  const recommendation = outcome === 'Comment' ? 'Comment(?: only)?' : outcome;
  const prefix = new RegExp(`^(?:Verdict:\\s*)?${recommendation}(?:\\s*[—–:.-]\\s*|$)`, 'i');
  return text.replace(prefix, '').trim();
};
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
const iconPaths = {
  succeeded: 'M20 6 9 17l-5-5',
  failed: 'M18 6 6 18M6 6l12 12',
  stopped: 'M6 6h12v12H6z',
  running: 'm9 5 11 7-11 7z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2',
  attempt: 'M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6',
  refresh: 'M20 6v5h-5M4 18v-5h5M20 11a8 8 0 0 0-14-5l-2 2M4 13a8 8 0 0 0 14 5l2-2',
  attention: 'M12 3 2 21h20L12 3M12 9v4M12 17h.01',
  settlement: 'M9 12l2 2 4-4M12 3l8 4v5c0 5-8 9-8 9s-8-4-8-9V7z',
} as const;
const iconMarkup = (icon: keyof typeof iconPaths): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[icon]}"/></svg>`;
const runInfo = (kind: string, icon: keyof typeof iconPaths | null, label: string, tooltipText: string, tooltipId: string, text?: string): HTMLSpanElement => {
  const info = node('span'); info.className = 'run-info';
  const trigger = node('button'); trigger.type = 'button'; trigger.dataset.runInfo = kind;
  trigger.setAttribute('aria-label', label); trigger.setAttribute('aria-describedby', tooltipId);
  if (icon) trigger.innerHTML = iconMarkup(icon);
  if (text) trigger.append(node('span', text));
  const tooltip = node('span', tooltipText); tooltip.className = 'run-tooltip'; tooltip.id = tooltipId; tooltip.setAttribute('role', 'tooltip');
  trigger.addEventListener('blur', () => { delete info.dataset.tapped; });
  const reveal = () => { delete info.dataset.dismissed; };
  info.addEventListener('pointerenter', reveal); trigger.addEventListener('focus', reveal);
  trigger.addEventListener('click', () => { const tapped = info.dataset.tapped !== 'true'; info.dataset.tapped = String(tapped); info.dataset.dismissed = String(!tapped); });
  trigger.addEventListener('keydown', event => { if (event.key === 'Escape') { delete info.dataset.tapped; info.dataset.dismissed = 'true'; event.stopPropagation(); } });
  info.append(trigger, tooltip); return info;
};
const styles = `.plugin-run-list{display:grid;gap:12px;color:var(--text);font:16px var(--sans,sans-serif);min-width:0}.plugin-run-list h2{margin:0;font-size:17px}.plugin-run-list ul{list-style:none;margin:0;padding:0}.plugin-run-list li{display:grid;gap:8px;padding:12px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.plugin-run-list .run-main,.plugin-run-list .run-actions,.plugin-run-list header{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.plugin-run-list header{justify-content:space-between}.plugin-run-list small{color:var(--text-dim)}.plugin-run-list :is(a,button){font:inherit;color:var(--accent)}.plugin-run-list button{padding:5px 8px;background:var(--face-hi);border:1px solid var(--line-strong);border-radius:6px;cursor:pointer}.plugin-run-list button:disabled{opacity:.5;cursor:default}.plugin-run-list [role=alert]{color:var(--bad)}.plugin-run-list .run-status{font-weight:600}.plugin-run-list :is(a,button):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-run-list{line-height:1.5;overflow-wrap:anywhere}
.plugin-run-list :is(h2,h3,p){margin:0}
.plugin-run-list h2{font-size:17px;font-weight:650}
.plugin-run-list h3{font-size:15px;font-weight:600;color:var(--text-dim)}
.plugin-run-list :is(button,select,input:not([type=checkbox]):not([type=radio])){min-height:34px}
.plugin-run-list :is(button,select,input,textarea){font-family:var(--sans,sans-serif);min-width:0}
.plugin-run-list button{transition:background-color 160ms ease,color 160ms ease}
.plugin-run-list button:not(:disabled):hover{background:var(--panel-hover,var(--panel));border-color:var(--accent)}
.plugin-run-list button:disabled{cursor:not-allowed}
.plugin-run-list :is(a,button){text-underline-offset:3px}
.plugin-run-list small{font-size:14px;line-height:1.5}
.plugin-run-list li:last-child{border-bottom:0}
.plugin-run-list .work-identity{font-family:var(--mono,monospace);font-size:14px;overflow-wrap:anywhere}
@media(prefers-reduced-motion:reduce){.plugin-run-list button{transition:none}}
.plugin-run-list .run-main{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:start}
.plugin-run-list .run-main>a{font-size:17px;font-weight:600;line-height:1.45;color:var(--text);text-decoration:none}
.plugin-run-list .run-main>a:hover{color:var(--accent);text-decoration:underline}
.plugin-run-list .run-main>small{grid-column:1;grid-row:2}
.plugin-run-list .run-status{grid-column:2;grid-row:1/3;align-self:start;padding:2px 8px;border:1px solid var(--line);border-radius:6px;font-size:14px;background:var(--panel)}
.plugin-run-list .run-status[data-status=running]{color:var(--accent)}
.plugin-run-list .run-status[data-status=failed]{color:var(--bad)}
.plugin-run-list .run-evidence{display:flex;flex-wrap:wrap;gap:4px 12px;color:var(--text-dim);font-size:14px}
.plugin-run-list .run-actions{gap:8px}
@media(max-width:480px){.plugin-run-list .run-main{grid-template-columns:minmax(0,1fr)}.plugin-run-list .run-status{grid-column:1;grid-row:3;justify-self:start}}
[role=tabpanel][aria-labelledby][data-panel-instance] .plugin-run-list>header>h2{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
[role=tabpanel][aria-labelledby][data-panel-instance] .plugin-run-list>header{display:contents}
.plugin-run-list.plugin-recent{container-type:inline-size}
.plugin-run-list.plugin-recent li{gap:12px;padding:20px 0}
.plugin-run-list.plugin-recent li:first-child{padding-top:4px}
.plugin-run-list.plugin-recent>ul{border-bottom:1px solid var(--line)}
.plugin-run-list.plugin-recent .run-icon-action{display:inline-flex;align-items:center;justify-content:center;width:34px;min-height:34px;padding:8px}
.plugin-run-list.plugin-recent .run-icon-action svg{width:16px;height:16px;flex-shrink:0}
.plugin-run-list.plugin-recent .run-main{gap:4px 16px;grid-template-columns:minmax(0,1fr) auto}
.plugin-run-list.plugin-recent .run-main>a{font-size:18px;font-weight:650;align-self:center}
.plugin-run-list.plugin-recent .run-status{padding:0;border:0;background:transparent;color:var(--text-dim);grid-column:2;grid-row:1}
.plugin-run-list.plugin-recent .run-status[data-status=succeeded]{color:var(--good)}
.plugin-run-list.plugin-recent .run-status[data-status=failed]{color:var(--bad)}
.plugin-run-list.plugin-recent .run-review{display:grid;gap:4px}
.plugin-run-list.plugin-recent .run-recommendation{font-size:14px;font-weight:600;color:var(--review,var(--accent))}
.plugin-run-list.plugin-recent .run-recommendation[data-outcome=REQUEST_CHANGES]{color:var(--queued,var(--accent))}
.plugin-run-list.plugin-recent .run-recommendation[data-outcome=APPROVE]{color:var(--good)}
.plugin-run-list.plugin-recent .run-review-summary{font-size:16px;line-height:1.5;max-width:70ch}
.plugin-run-list.plugin-recent .run-evidence{gap:4px 16px;font-size:13px;align-items:center}
.plugin-run-list.plugin-recent .run-evidence .work-identity{font-family:var(--mono,monospace);font-size:13px;text-decoration:underline}
.plugin-run-list.plugin-recent .run-evidence{position:relative}
.plugin-run-list.plugin-recent .run-evidence .run-info{position:static}
.plugin-run-list.plugin-recent .run-info{position:relative;display:inline-flex;align-items:center}
.plugin-run-list.plugin-recent .run-info>button{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:24px;min-height:24px;padding:0;border:0;background:transparent;color:inherit;font-size:13px;font-variant-numeric:tabular-nums;cursor:pointer}
.plugin-run-list.plugin-recent .run-info>button:hover{color:var(--text);background:transparent}
.plugin-run-list.plugin-recent .run-info svg{width:16px;height:16px;flex-shrink:0}
.plugin-run-list.plugin-recent .run-tooltip{position:absolute;top:100%;left:0;z-index:5;width:max-content;max-width:min(280px,80vw);padding:8px 12px;border:1px solid var(--line-strong);border-radius:6px;background:var(--panel);color:var(--text);font-size:13px;font-weight:400;line-height:1.5;visibility:hidden}
.plugin-run-list.plugin-recent .run-status .run-tooltip{right:0;left:auto}
.plugin-run-list.plugin-recent .run-info:not([data-dismissed=true]):focus-within>.run-tooltip{visibility:visible}
@media(hover:hover){.plugin-run-list.plugin-recent .run-info:not([data-dismissed=true]):hover>.run-tooltip{visibility:visible}}
.plugin-run-list.plugin-recent .run-supporting{font-size:14px;color:var(--text-dim)}
@media(pointer:coarse){.plugin-run-list.plugin-recent .work-identity{display:inline-flex;align-items:center;min-height:44px}.plugin-run-list.plugin-recent button{min-height:44px}.plugin-run-list.plugin-recent .run-info>button{min-height:44px;min-width:44px}.plugin-run-list.plugin-recent .run-icon-action{width:44px;min-height:44px}}
`;

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
    document.addEventListener('keydown', this.dismissTooltips);
    context.onDispose(() => this.dispose()); context.signal.addEventListener('abort', this.dispose, { once: true });
    this.state.activity.signal.addEventListener('abort', this.cancel, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation): boolean { return !this.disposed && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private cancel = () => { for (const command of this.commands.values()) command.busy = false; ++this.generation; this.controller?.abort(); this.controller = null; this.unsubscribe?.(); this.unsubscribe = null; this.pendingRead = null; this.evidenceReady = false; };
  private dismissTooltips = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') for (const info of this.container.querySelectorAll<HTMLElement>('.run-info')) { delete info.dataset.tapped; info.dataset.dismissed = 'true'; }
  };
  dispose = () => {
    if (this.disposed) return; this.disposed = true; this.cancel();
    document.removeEventListener('keydown', this.dismissTooltips);
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
  private iconButton(label: string, icon: keyof typeof iconPaths, callback: () => void, disabled = false): HTMLButtonElement {
    const button = this.button('', callback, disabled); button.className = 'run-icon-action'; button.title = label; button.setAttribute('aria-label', label); button.innerHTML = iconMarkup(icon); return button;
  }
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
    const inspections = new Map<string, { dismissed: string | undefined; tapped: string | undefined }>();
    for (const trigger of this.container.querySelectorAll<HTMLElement>('[data-run-info]')) {
      const identity = trigger.dataset.runFocus; const info = trigger.parentElement;
      if (identity && info) inspections.set(identity, { dismissed: info.dataset.dismissed, tapped: info.dataset.tapped });
    }
    const root = node('section'); root.className = `plugin-run-list plugin-${presentation.name}`;
    root.setAttribute('aria-busy', String(this.loading)); root.append(node('style', styles));
    const header = node('header'); header.append(node('h2', presentation.kind === 'running' ? this.state.pirateMode ? 'Deckhand tasks' : 'Agent tasks' : this.state.pirateMode ? 'Recent voyages' : 'Recent runs')); root.append(header);
    for (const message of [this.error, this.commandError]) if (message) { const error = node('p', message); error.setAttribute('role', 'alert'); root.append(error); }
    const list = node('ul'); const visible = new Set<string>();
    for (const run of this.rows) {
      const id = key(run); visible.add(id); const command = this.commands.get(id);
      const row = node('li'); row.dataset.runId = run.id; row.dataset.runKey = id;
      const main = node('div'); main.className = 'run-main';
      const title = run.prNumber ? `${this.state.pirateMode ? 'Bounty' : 'PR'} #${run.prNumber} · ${run.displayKey}` : run.displayKey;
      const info = (kind: string, icon: keyof typeof iconPaths | null, label: string, description = label, text?: string) =>
        runInfo(kind, icon, label, description, `run-info-${encodeURIComponent(JSON.stringify([this.state.instanceId, id, kind]))}`, text);
      main.append(this.link(title, this.detail(run.id, run.repo)));
      if (this.state.repo === null) main.append(node('small', run.repo));
      const status = info('worker', run.status, `Worker: ${run.status}`); status.classList.add('run-status'); status.dataset.status = run.status;
      main.append(status); row.append(main);
      const timestamp = Number.isFinite(Date.parse(run.startedAt)) ? new Date(run.startedAt).toLocaleString() : 'Unknown start time';
      const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(run.startedAt)) / 60_000));
      if (run.status === 'running' && Number.isFinite(elapsed)) row.append(node('small', `${elapsed < 60 ? `${elapsed}m` : `${Math.floor(elapsed / 60)}h ${elapsed % 60}m`} elapsed`));
      const feedback = feedbackLabel(run);
      if (feedback) { const outcome = node('p', feedback); outcome.className = 'run-feedback-outcome'; outcome.title = run.feedbackOutcome?.summary ?? ''; row.append(outcome); }
      if (run.review) {
        const label = { APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes', COMMENT: 'Comment' }[run.review.outcome];
        const review = node('div'); review.className = 'run-review';
        const recommendation = node('p', label); recommendation.className = 'run-recommendation'; recommendation.dataset.outcome = run.review.outcome;
        recommendation.title = `Review recommendation: ${label}`; review.append(recommendation);
        const summary = reviewSummary(run.review.verdict, label);
        if (summary) { const verdict = node('p', summary); verdict.className = 'run-review-summary'; review.append(verdict); }
        row.append(review);
      }
      const evidence = node('div'); evidence.className = 'run-evidence';
      evidence.append(info('started', 'clock', 'Start time', `Started ${timestamp}`), info('attempt', 'attempt', `Attempt ${run.attempt}`, `Attempt ${run.attempt}`, String(run.attempt)));
      if (run.costUsd !== null) evidence.append(info('spend', null, 'Observed spend', `$${run.costUsd.toFixed(2)} observed spend`, `$${run.costUsd.toFixed(2)}`));
      if (run.sourceSettlement) {
        const label = { pending: 'pending', settled: 'settled', 'operator-required': 'operator action required' }[run.sourceSettlement.state];
        evidence.append(info('settlement', run.sourceSettlement.state === 'settled' ? 'settlement' : run.sourceSettlement.state === 'pending' ? 'clock' : 'attention', `Source settlement: ${label}`, `Source settlement: ${label}. Worker outcome is unchanged.`, run.sourceSettlement.state === 'operator-required' ? 'Needs action' : undefined));
      }
      const identity = this.link(shortRunId(run.id), this.detail(run.id, run.repo)); identity.className = 'work-identity';
      identity.title = `Open run ${run.id}`; identity.setAttribute('aria-label', `Open run ${shortRunId(run.id)}`);
      evidence.append(identity); row.append(evidence);
      const actions = node('div'); actions.className = 'run-actions';
      const eligible = presentation.action === 'stop' ? run.status === 'running' : run.status === 'failed';
      if (eligible) {
        const button = this.iconButton(presentation.action === 'stop' ? 'Stop' : 'Retry', presentation.action === 'stop' ? 'stopped' : 'attempt', () => { void this.submit(run); }, !this.active() || !this.evidenceReady || !!command?.busy || !!command?.uncertain || !!command?.receipt && ['accepted', 'rejected'].includes(command.receipt.status));
        button.setAttribute('aria-label', `${presentation.action === 'stop' ? 'Stop' : 'Retry'} ${this.state.pirateMode ? 'voyage' : 'run'} ${run.displayKey}, attempt ${run.attempt}`); actions.append(button);
      }
      if (actions.childElementCount) row.append(actions); if (command) this.commandFeedback(row, command); list.append(row);
    }
    if (this.loading) { const loading = node('li'); loading.append(createLoadingWheelV1('Loading runs…')); list.append(loading); }
    if (!this.rows.length && !this.loading && !this.error) list.append(node('li', presentation.kind === 'running' ? this.state.pirateMode ? 'No deckhand tasks underway.' : 'No agent tasks running.' : this.state.pirateMode ? 'No past voyages.' : 'No past runs.'));
    root.append(list);
    const pending = [...this.commands].filter(([id]) => !visible.has(id));
    if (pending.length) { const saved = node('section'); saved.append(node('h3', `Saved requests (${pending.length})`)); for (const [, command] of pending) { const row = node('div', `${command.runId} · ${command.repo} · Attempt ${command.attempt}`); row.dataset.runKey = key({ repo: command.repo, id: command.runId, attempt: command.attempt }); this.commandFeedback(row, command); saved.append(row); } root.append(saved); }
    if (this.truncated) root.append(node('small', `Showing the first ${presentation.limit} ${presentation.kind === 'running' ? 'active' : 'recent'} runs.`));
    const history = new URLSearchParams({ pane: 'recent' }); if (this.state.repo) history.set('repo', this.state.repo);
    const footer = node('footer'); footer.className = 'run-actions'; footer.append(this.link(this.state.pirateMode ? 'All voyages' : 'All runs', `/runs?${history}`), this.iconButton('Refresh', 'refresh', () => { void this.refresh(); }, !this.active())); root.append(footer);
    const controls = Array.from(root.querySelectorAll<HTMLElement>('a,button'));
    for (const control of controls) control.dataset.runFocus = JSON.stringify([control.closest<HTMLElement>('[data-run-key]')?.dataset.runKey ?? '', control.tagName, control.dataset.runInfo ?? control.getAttribute('aria-label') ?? control.textContent, control.getAttribute('href')]);
    this.container.replaceChildren(root);
    if (focus) controls.find(control => control.dataset.runFocus === focus)?.focus({ preventScroll: true });
    for (const control of controls) {
      const inspection = inspections.get(control.dataset.runFocus ?? ''); const info = control.parentElement;
      if (inspection && info) {
        if (inspection.dismissed !== undefined) info.dataset.dismissed = inspection.dismissed;
        if (inspection.tapped !== undefined) info.dataset.tapped = inspection.tapped;
      }
    }
  }
}
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.runs?.version !== 1 || context.services.runCommands?.version !== 1) throw new Error('Run panels require version 1 run reads and commands.');
  return new RunListPanel(container, context);
} };
export default panel;
