import { WhiteboardCompanion } from './whiteboard.js';
import { prepareRecommendation } from './recommendation.js';
import { RunInstructions } from './instructions.js';
import { PostmortemChat } from './postmortem-chat.js';
import type { RunReadSummaryV1, PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, PresentationLocatorV1,
  RunCommandInputV1, RunCommandPendingV1, RunCommandReceiptQueryV1, RunCommandReceiptV1, RunInspectLogPageV1, RunInspectTargetV1 } from '@helmsman/plugin-sdk';
import { emptyState, mergeLog, newTab, readState, saveState, tabKey, type RunTab } from './state.js';
import { styles } from './styles.js';
import { icon, type IconName } from './icons.js';
import { LogResize } from './log-resize.js';

const feedbackLabel = (run: RunReadSummaryV1 | null | undefined): string | null => {
  const state = run?.feedbackOutcome?.state;
  if (state === 'completed') return run?.status === 'succeeded' ? 'Feedback completed' : run?.status === 'running' ? null : 'Feedback remaining';
  if (state === 'awaiting_decision') return run?.status === 'running' ? 'Awaiting decision' : 'Feedback remaining';
  return state === 'changes_remaining' ? 'Feedback remaining' : null;
};
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
const locatorKey = (locator: PresentationLocatorV1 | null | undefined) => !locator ? '' : locator.kind === 'run' ? JSON.stringify(['run', locator.repo, locator.runId])
  : locator.kind === 'legacy-run' ? JSON.stringify(['legacy-run', locator.runId]) : JSON.stringify(['pull-request', locator.repo, locator.number]);
const canonical = (tab: { repo: string; runId: string }): PresentationLocatorV1 => ({ version: 1, kind: 'run', repo: tab.repo, runId: tab.runId });
const terminal = (receipt: RunCommandReceiptV1 | null | undefined) => receipt?.status === 'accepted' || receipt?.status === 'rejected';
const logText = (tab: RunTab) => tab.events.map(event => `[${event.at}] ${event.kind}: ${event.text}${event.truncated ? ' [preview clipped]' : ''}`).join('\n');
const renderChildren = (parent: HTMLElement, next: HTMLElement, retained: Map<Node, HTMLElement>) => {
  let cursor = parent.firstChild;
  for (const child of [...next.childNodes]) {
    const element = retained.get(child) ?? child;
    if (element.parentNode === parent) {
      while (cursor && cursor !== element) { const obsolete = cursor; cursor = cursor.nextSibling; obsolete.remove(); }
      cursor = element.nextSibling;
    } else parent.insertBefore(element, cursor);
  }
  while (cursor) { const obsolete = cursor; cursor = cursor.nextSibling; obsolete.remove(); }
};

class ViewerPanel implements PluginPanelInstance {
  private readonly instructions: RunInstructions;
  private readonly whiteboard: WhiteboardCompanion;
  private readonly postmortem: PostmortemChat;
  private readonly resize: LogResize;
  private logHeight: number;
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private state: PluginPanelState;
  private readonly unsupported: boolean;
  private disposed = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private tabs: RunTab[];
  private activeKey: string | null;
  private results: RunCommandReceiptV1[];
  private handled = '\u0000';
  private pending: RunCommandPendingV1[] = [];
  private evidenceReady = false;
  private busy = false;
  private reading = false;
  private queuedOlder: string | null = null;
  private summariesReading = false;
  private summariesReadAt = 0;
  private recentRuns: RunReadSummaryV1[] = [];
  private recentLoading = false;
  private recentLoaded = false;
  private recentError = '';
  private commandBusy = false;
  private error = '';
  private message = '';
  private saveError = '';
  private commandError = '';
  private resultsOpen = false;
  private readonly disclosures = new Set<string>();
  private saveQueue: Promise<boolean> = Promise.resolve(true);
  private readonly log = node('pre');
  private readonly root = node('section');
  private readonly tools = node('div');
  private readonly earlier = node('button', 'Earlier logs');
  private logIdentity: string | null = null;
  private logLoaded = false;
  private readonly downloads = new Set<AbortController>();

  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.instructions = new RunInstructions(context.services.runInstructions);
    this.whiteboard = new WhiteboardCompanion(context.services.whiteboard);
    this.postmortem = new PostmortemChat(context.services.postmortem);
    this.container = container; this.context = context; this.state = context.state;
    const parsed = readState(this.state.savedState); this.unsupported = parsed === null; const saved = parsed ?? emptyState();
    this.tabs = saved.tabs.map(newTab); this.activeKey = saved.activeKey; this.results = saved.results;
    this.logHeight = saved.logHeight;
    this.resize = new LogResize(this.log, this.logHeight, height => { this.logHeight = height; void this.persist(); });
    this.earlier.type = 'button';
    this.earlier.prepend(icon('clock-counter-clockwise'));
    this.earlier.addEventListener('click', () => {
      const tab = this.selected(); if (!tab || this.earlier.disabled || !this.active()) return;
      tab.follow = false; void this.persist(); void this.load('older');
    });
    this.log.className = 'run-log'; this.log.tabIndex = 0; this.log.setAttribute('aria-label', 'Run log preview');
    this.log.addEventListener('scroll', () => {
      const tab = this.selected(); if (!tab || this.logIdentity !== tabKey(tab)) return;
      tab.scrollTop = this.log.scrollTop;
      if (this.log.scrollHeight - this.log.clientHeight - this.log.scrollTop > 20 && tab.follow) { tab.follow = false; this.draw(); }
      if (this.scrollTimer) clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => { this.scrollTimer = null; void this.persist(); }, 250);
    });
    context.onDispose(this.dispose); context.signal.addEventListener('abort', this.dispose, { once: true });
    this.state.activity.signal.addEventListener('abort', this.cancel, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private inScope(repo: string) { return this.state.activity.repo === null || this.state.activity.repo === repo; }
  private selected() { return this.tabs.find(tab => tabKey(tab) === this.activeKey && this.inScope(tab.repo)) ?? null; }
  private cancel = () => {
    ++this.generation; this.controller?.abort(); this.controller = null;
    this.resize.cancelDrag();
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    for (const controller of this.downloads) controller.abort(); this.downloads.clear();
    this.busy = false; this.reading = false; this.summariesReading = false; this.summariesReadAt = 0; this.commandBusy = false; this.evidenceReady = false;
    this.queuedOlder = null;
    this.recentLoading = false;
  };
  dispose = () => {
    if (this.disposed) return; this.disposed = true; this.cancel(); this.instructions.dispose(); this.postmortem.dispose(); this.whiteboard.dispose(); this.resize.dispose();
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.context.signal.removeEventListener('abort', this.dispose); this.state.activity.signal.removeEventListener('abort', this.cancel); this.container.replaceChildren();
  };
  update(next: PluginPanelState) {
    if (this.disposed) return;
    const previous = this.state; previous.activity.signal.removeEventListener('abort', this.cancel); this.state = next;
    next.activity.signal.addEventListener('abort', this.cancel, { once: true });
    const scopeChanged = previous.activity.repo !== next.activity.repo;
    const changed = scopeChanged || previous.activity.epoch !== next.activity.epoch || previous.activity.signal !== next.activity.signal || previous.visible !== next.visible || previous.activity.active !== next.activity.active;
    if (changed) {
      this.cancel(); this.pending = []; this.error = ''; this.commandError = ''; this.message = '';
      if (scopeChanged) { this.handled = ''; this.recentRuns = []; this.recentLoaded = false; this.recentError = ''; if (!this.selected()) this.activeKey = null; for (const tab of this.tabs) { tab.target = null; tab.summary = null; tab.events = []; tab.loaded = false; } }
      if (this.active()) {
        this.controller = new AbortController();
        const locator = next.presentation;
        if (locatorKey(locator) !== this.handled || locator && locator.kind !== 'pull-request' && this.selected()?.runId !== locator.runId) void this.followPresentation(); else void this.load('follow');
      }
    } else if (locatorKey(next.presentation) !== this.handled) void this.followPresentation();
    this.draw();
  }
  async refresh() {
    if (!this.active()) return;
    this.cancel(); this.controller = new AbortController();
    const locator = this.state.presentation;
    if (locatorKey(locator) !== this.handled || locator && locator.kind !== 'pull-request' && this.selected()?.runId !== locator.runId) await this.followPresentation();
    else await this.load('initial');
  }
  private async followPresentation() {
    if (!this.active()) return;
    this.cancel(); const generation = this.generation; this.controller = new AbortController();
    const locator = this.state.presentation; this.handled = locatorKey(locator); this.error = ''; this.message = '';
    if (!locator) {
      const saved = this.selected();
      if (saved && this.context.selectPresentation) {
        try { this.handled = locatorKey(canonical(saved)); this.context.selectPresentation(canonical(saved)); await this.load(saved.loaded ? 'follow' : 'initial'); }
        catch { this.error = 'Saved run selection could not be restored. Choose a run to try again.'; this.draw(); }
        return;
      }
      this.activeKey = null; void this.persist(); this.draw(); await Promise.all([this.restorePending(generation), this.loadRecent(generation)]); return;
    }
    if (locator.kind === 'pull-request') { this.activeKey = null; void this.persist(); this.draw(); await Promise.all([this.restorePending(generation), this.loadRecent(generation)]); return; }
    if (locator.kind === 'run' && !this.inScope(locator.repo)) { this.activeKey = null; this.error = 'Selected run is outside this panel’s scope.'; this.draw(); await Promise.all([this.restorePending(generation), this.loadRecent(generation)]); return; }
    if (this.selected()?.runId !== locator.runId || locator.kind === 'run' && this.selected()?.repo !== locator.repo) this.activeKey = null;
    this.busy = true; this.draw();
    try {
      const result = await this.resolvePresentation(locator, generation, this.controller.signal);
      if (!this.active(generation)) return;
      if (result?.status !== 'available' || !result.value?.target || !this.inScope(result.value.target.repo)
        || result.value.target.runId !== locator.runId || locator.kind === 'run' && result.value.target.repo !== locator.repo) throw new Error('Selected run is unavailable in this scope.');
      const target = result.value.target; let tab = this.tabs.find(item => item.repo === target.repo && item.runId === target.runId);
      if (!tab) {
        if (this.tabs.length >= 12) throw new Error('Twelve run tabs are open. Close a tab before opening another run. Saved requests are kept.');
        tab = newTab({ repo: target.repo, runId: target.runId, scrollTop: 0, follow: true }); this.tabs.push(tab);
      }
      this.activeKey = tabKey(tab);
      if (locator.kind === 'legacy-run') {
        if (!this.context.selectPresentation) throw new Error('Canonical run selection is unavailable.');
        this.handled = locatorKey(canonical(tab)); this.context.selectPresentation(canonical(tab));
      }
      void this.persist(); await this.load(tab.loaded ? 'follow' : 'initial');
    } catch (error) { if (this.active(generation)) { this.activeKey = null; this.error = error instanceof Error ? error.message : 'Selected run is unavailable.'; } }
    finally { if (this.active(generation)) { this.busy = false; await Promise.all([this.restorePending(generation), this.selected() ? Promise.resolve() : this.loadRecent(generation)]); this.draw(); } }
  }
  private async resolvePresentation(locator: Extract<PresentationLocatorV1, { kind: 'run' | 'legacy-run' }>, generation: number, signal: AbortSignal) {
    for (let retry = 0; ; retry++) {
      signal.throwIfAborted();
      const result = await this.context.services.runInspect!.resolve({ version: 1, runId: locator.runId }, signal);
      if (!this.active(generation) || locator.kind !== 'run' || result?.status !== 'unavailable' || result.reason !== 'not-found' || retry >= 12) return result;
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 2500);
        if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
      });
    }
  }
  private async resolve(tab: RunTab, signal: AbortSignal): Promise<RunInspectTargetV1> {
    const result = await this.context.services.runInspect!.resolve({ version: 1, runId: tab.runId }, signal);
    if (result?.status !== 'available' || !result.value?.target || result.value.target.repo !== tab.repo || result.value.target.runId !== tab.runId || !this.inScope(tab.repo)) throw new Error('Run is unavailable in this scope.');
    return result.value.target;
  }
  private async loadRecent(generation: number) {
    if (!this.active(generation) || this.selected() || this.recentLoading) return;
    this.recentLoading = true; this.recentError = ''; this.draw();
    const repo = this.state.activity.repo;
    try {
      const result = await this.context.services.runs?.list({ version: 1, repo, kind: 'all', limit: 10, cursor: null }, this.controller?.signal);
      if (!this.active(generation)) return;
      if (result?.status !== 'available' || result.value?.version !== 1 || result.value?.repo !== repo || !Array.isArray(result.value?.items)) throw new Error('Recent runs could not be loaded. Refresh to try again.');
      this.recentRuns = result.value.items.filter(run => !!run && this.inScope(run.repo) && typeof run.repo === 'string' && /^[a-z\d-]+\/[a-z\d_.-]+$/i.test(run.repo)
        && typeof run.id === 'string' && /^[a-z\d_-]{1,128}$/i.test(run.id) && typeof run.displayKey === 'string'
        && ['running', 'succeeded', 'failed', 'stopped'].includes(run.status)).slice(0, 10);
    } catch { if (this.active(generation)) { this.recentRuns = []; this.recentError = 'Recent runs could not be loaded. Refresh to try again.'; } }
    finally { if (this.active(generation)) { this.recentLoading = false; this.recentLoaded = true; this.draw(); } }
  }
  private selectRecent(run: RunReadSummaryV1) {
    if (!this.active() || !this.inScope(run.repo)) return;
    try {
      if (!this.context.selectPresentation) throw new Error('Run selection is unavailable.');
      this.context.selectPresentation(canonical({ repo: run.repo, runId: run.id }));
    } catch { this.recentError = 'Run selection is unavailable. Refresh to try again.'; this.draw(); }
  }
  private schedule(generation: number) {
    if (this.timer) clearTimeout(this.timer);
    if (!this.active(generation) || !this.selected()) return;
    this.timer = setTimeout(() => { this.timer = null; void this.load('follow'); }, this.selected()?.hasLater && this.selected()?.follow ? 100 : 2000);
  }
  private refreshInactiveSummaries(generation: number, signal: AbortSignal) {
    if (this.summariesReading || Date.now() - this.summariesReadAt < 2000) return;
    const tabs = this.tabs.filter(tab => tab !== this.selected() && this.inScope(tab.repo));
    if (!tabs.length) return;
    this.summariesReading = true; this.summariesReadAt = Date.now();
    void Promise.all(tabs.map(async tab => {
      try {
        const result = await this.context.services.runs!.load({ version: 1, repo: tab.repo, runId: tab.runId }, signal);
        if (!this.active(generation) || signal.aborted || !this.tabs.includes(tab) || tab === this.selected()) return;
        const run = result?.status === 'available' ? result.value?.run : null;
        tab.summary = run?.repo === tab.repo && run?.id === tab.runId ? run : null;
        this.draw();
      } catch { if (this.active(generation) && this.tabs.includes(tab) && tab !== this.selected()) { tab.summary = null; this.draw(); } }
    })).finally(() => { if (this.active(generation)) this.summariesReading = false; });
  }
  private async load(direction: 'initial' | 'older' | 'follow') {
    const tab = this.selected();
    if (this.reading) {
      if (direction === 'older' && tab && this.active()) { this.queuedOlder = tabKey(tab); this.busy = true; this.draw(); }
      return;
    }
    if (!this.active() || !tab) { await Promise.all([this.restorePending(this.generation), this.loadRecent(this.generation)]); this.draw(); return; }
    const generation = this.generation; const controller = this.controller ?? new AbortController(); this.controller = controller;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.reading = true; this.busy = direction !== 'follow' || !tab.loaded; this.refreshInactiveSummaries(generation, controller.signal); this.draw();
    try {
      const target = await this.resolve(tab, controller.signal);
      if (!this.active(generation) || this.selected() !== tab) return;
      const attemptChanged = tab.target !== null && tab.target.expectedAttempt !== target.expectedAttempt;
      if (attemptChanged) { tab.events = []; tab.loaded = false; tab.olderCursor = null; tab.followCursor = null; tab.summary = null; this.message = `Attempt changed to ${target.expectedAttempt}. Saved requests still target their original attempt.`; }
      tab.target = target;
      const summary = await this.context.services.runs!.load({ version: 1, repo: tab.repo, runId: tab.runId }, controller.signal);
      if (!this.active(generation) || this.selected() !== tab) return;
      if (summary?.status !== 'available' || !summary.value?.run || summary.value.run.attempt !== target.expectedAttempt || summary.value.run.repo !== tab.repo || summary.value.run.id !== tab.runId) throw new Error('Run changed while loading. Refresh to resolve its current attempt.');
      tab.summary = summary.value.run;
      let mode: 'initial' | 'older' | 'follow' = !tab.loaded || direction === 'initial' ? 'initial' : direction;
      if (mode === 'older' && tab.olderTrimmed || mode === 'follow' && tab.follow && tab.newerTrimmed) mode = 'initial';
      if (mode !== 'follow' || tab.follow) {
        const cursor = mode === 'older' ? tab.olderCursor : mode === 'follow' ? tab.followCursor : null;
        if (mode === 'initial' || cursor) {
          const result = await this.context.services.runInspect!.log({ version: 1, target, direction: mode === 'follow' ? 'forward' : 'backward', cursor, limit: 50 }, controller.signal);
          if (!this.active(generation) || this.selected() !== tab) return;
          if (result?.status !== 'available' || !this.validLog(result.value, target)) throw new Error(`Log is unavailable${result?.status === 'unavailable' ? `: ${result.reason}` : ''}. Refresh to retry.`);
          const height = this.log.scrollHeight; const scroll = this.log.scrollTop;
          mergeLog(tab, result.value, mode); this.draw();
          if (direction === 'older') { this.log.scrollTop = scroll + Math.max(0, this.log.scrollHeight - height); tab.scrollTop = this.log.scrollTop; }
        }
      }
      tab.error = ''; await this.restorePending(generation);
    } catch (error) { if (this.active(generation) && this.selected() === tab) { tab.error = error instanceof Error ? error.message : 'Run could not be read.'; tab.summary = null; } }
    finally {
      if (this.active(generation)) {
        this.reading = false;
        const queuedOlder = this.queuedOlder === tabKey(tab); this.queuedOlder = null;
        if (queuedOlder) void this.load('older');
        else { this.busy = false; this.draw(); this.schedule(generation); }
      }
    }
  }
  private validLog(page: RunInspectLogPageV1 | null | undefined, target: RunInspectTargetV1): page is RunInspectLogPageV1 {
    return !!page?.target && page.target.repo === target.repo && page.target.runId === target.runId && page.target.expectedAttempt === target.expectedAttempt
      && Array.isArray(page.events) && page.events.length <= 50 && page.events.every(event => !!event && typeof event.text === 'string' && event.text.length <= 4000 && Number.isSafeInteger(event.sequence));
  }
  private persist(): Promise<boolean> {
    if (this.unsupported || this.disposed) return Promise.resolve(false);
    const snapshot = saveState(this.tabs, this.activeKey, this.results, this.logHeight);
    const work = this.saveQueue.catch(() => false).then(async () => {
      if (this.disposed) return false;
      try { await this.context.saveState(snapshot); this.saveError = ''; return true; }
      catch { this.saveError = 'Viewer state could not be saved. Tabs and command results are kept here; requests are not acknowledged.'; return false; }
      finally { if (!this.disposed) this.draw(); }
    }); this.saveQueue = work; return work;
  }
  private activate(tab: RunTab) {
    if (!this.active() || !this.inScope(tab.repo)) return;
    try {
      if (!this.context.selectPresentation) throw new Error('Run selection is unavailable.');
      this.context.selectPresentation(canonical(tab)); this.handled = locatorKey(canonical(tab));
      this.activeKey = tabKey(tab); this.cancel(); this.controller = new AbortController(); this.message = ''; this.error = ''; void this.persist(); void this.load(tab.loaded ? 'follow' : 'initial');
    } catch (error) { this.error = error instanceof Error ? error.message : 'Run selection is unavailable.'; this.draw(); }
  }
  private close(tab: RunTab) {
    if (!this.active()) return;
    if (this.activeKey === tabKey(tab)) {
      const next = this.tabs.find(item => item !== tab && this.inScope(item.repo));
      const previousTabs = this.tabs; const previousKey = this.activeKey; const previousHandled = this.handled;
      try {
        if (!this.context.selectPresentation) throw new Error('Run selection is unavailable.');
        this.tabs = this.tabs.filter(item => item !== tab); this.activeKey = next ? tabKey(next) : null; this.handled = locatorKey(next ? canonical(next) : null);
        this.context.selectPresentation(next ? canonical(next) : null);
      } catch (error) { this.tabs = previousTabs; this.activeKey = previousKey; this.handled = previousHandled; this.error = error instanceof Error ? error.message : 'Run selection is unavailable.'; this.draw(); return; }
      this.cancel(); this.controller = new AbortController();
    } else this.tabs = this.tabs.filter(item => item !== tab);
    void this.persist(); this.draw(); void this.load('follow');
  }
  private async restorePending(generation: number) {
    if (!this.active(generation)) return;
    try {
      const pending = await this.context.services.runCommands!.pending();
      if (!this.active(generation)) return;
      if (!Array.isArray(pending)) throw new Error('Saved requests are unavailable.');
      this.pending = pending.filter(item => !!item?.command && (item.command.action === 'stop' || item.command.action === 'retry') && this.inScope(item.command.repo));
      this.evidenceReady = true; this.commandError = '';
    } catch { if (this.active(generation)) { this.evidenceReady = false; this.commandError = 'Saved requests are unavailable. Refresh before issuing another command.'; } }
  }
  private blocked(tab: RunTab) { return this.pending.some(item => item.command.action !== 'launch' && item.command.repo === tab.repo && item.command.target.runId === tab.runId); }
  private async submit(action: 'stop' | 'retry', tab: RunTab) {
    const target = tab.target;
    if (!this.active() || !this.evidenceReady || this.commandBusy || !target || this.blocked(tab) || !tab.summary || tab.summary.attempt !== target.expectedAttempt
      || (action === 'stop' ? tab.summary.status !== 'running' : tab.summary.status !== 'failed')) return;
    await this.deliver({ version: 1, repo: tab.repo, action, target: { runId: target.runId, expectedAttempt: target.expectedAttempt } });
  }
  private async deliver(input: RunCommandInputV1 | RunCommandReceiptQueryV1) {
    if (!this.active() || !this.evidenceReady || this.commandBusy || !this.inScope(input.repo)) return;
    const generation = this.generation; this.commandBusy = true; this.commandError = ''; this.draw();
    try {
      const service = this.context.services.runCommands!;
      if ('requestId' in input && !service.retry) throw new Error('Original request retry is unavailable.');
      const result = 'requestId' in input ? await service.retry!(input, this.controller?.signal) : await service.submit(input, this.controller?.signal);
      if (!this.active(generation)) return;
      if (result?.status !== 'available') this.commandError = 'Command outcome is not confirmed. Check the saved request before trying again.';
      else this.message = `Request ${result.value?.status ?? 'pending'}. Worker status is reported separately.`;
    } catch { if (this.active(generation)) this.commandError = 'Command outcome is not confirmed. Its original request is retained.'; }
    finally { if (this.active(generation)) { await this.restorePending(generation); this.commandBusy = false; this.draw(); } }
  }
  private async checkRequest(entry: RunCommandPendingV1) {
    if (!this.active() || this.commandBusy || !this.inScope(entry.command.repo)) return;
    const generation = this.generation; this.commandBusy = true; this.draw();
    try {
      const result = await this.context.services.runCommands!.receipt({ repo: entry.command.repo, requestId: entry.command.requestId }, this.controller?.signal);
      if (!this.active(generation)) return;
      this.commandError = result?.status === 'available' ? result.value ? '' : 'The server has no receipt. Retry delivery keeps the original identity.' : 'Receipt is unavailable. The original request is retained.';
      await this.restorePending(generation);
    } catch { if (this.active(generation)) this.commandError = 'Receipt is unavailable. The original request is retained.'; }
    finally { if (this.active(generation)) { this.commandBusy = false; this.draw(); } }
  }
  private async acknowledge(entry: RunCommandPendingV1) {
    if (!this.active() || this.commandBusy || !terminal(entry.receipt) || !entry.receipt || !this.inScope(entry.command.repo)) return;
    if (!this.results.some(result => result.requestId === entry.command.requestId)) {
      if (this.results.length >= 16) { this.commandError = 'Remove a saved result before recording another. The request is retained.'; this.draw(); return; }
      this.results.push(entry.receipt);
    }
    const generation = this.generation; this.commandBusy = true; this.draw();
    try {
      if (!await this.persist() || !this.active(generation)) return;
      await this.context.services.runCommands!.acknowledge({ repo: entry.command.repo, requestId: entry.command.requestId });
      if (this.active(generation)) { await this.restorePending(generation); this.commandError = ''; }
    } catch { if (this.active(generation)) this.commandError = 'Result is saved, but the request could not be acknowledged. Retry safely.'; }
    finally { if (this.active(generation)) { this.commandBusy = false; this.draw(); } }
  }
  private download(tab: RunTab) {
    const target = tab.target; const service = this.context.services.downloads;
    if (!service || !this.active() || !target) return;
    const generation = this.generation; const controller = new AbortController(); this.downloads.add(controller);
    let operation;
    try { operation = service.save({ filename: `helmsman-${tab.runId}.log`, contentType: 'text/plain; charset=utf-8', open: async signal => {
      const result = await this.context.services.runInspect!.exportLog({ version: 1, target }, signal);
      if (result?.status !== 'available' || !result.value?.stream) throw new Error('Log export is unavailable.');
      return result.value.stream;
    } }, controller.signal); }
    catch { this.downloads.delete(controller); controller.abort(); this.message = 'Log download is unavailable.'; this.draw(); return; }
    void operation.then(result => {
      if (!this.active(generation)) return;
      this.message = result?.status === 'saved' ? 'Log saved.' : result?.status === 'delivered-to-browser' ? 'Log delivered to the browser. Disk save is not confirmed.'
        : result?.status === 'cancelled-stream' ? 'Log stream cancelled. The browser download may still appear pending.' : 'Log download failed or is unavailable. Retry when the run is current.';
      this.draw();
    }).catch(() => { if (this.active(generation)) { this.message = 'Log download failed. Retry when the run is current.'; this.draw(); } }).finally(() => this.downloads.delete(controller));
  }
  private copy(tab: RunTab, idOnly: boolean) {
    if (!this.active()) return;
    const generation = this.generation;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      void navigator.clipboard.writeText(idOnly ? tab.runId : logText(tab)).then(() => { if (this.active(generation)) { this.message = idOnly ? 'Run ID copied.' : 'Visible log preview copied. Download contains full stored text.'; this.draw(); } })
        .catch(() => { if (this.active(generation)) { this.message = 'Copy unavailable. Select text in the log preview.'; this.draw(); } });
    } catch { this.message = 'Copy unavailable. Select text in the log preview.'; this.draw(); }
  }
  private openRecommendation(tab: RunTab) {
    if (!this.active() || this.selected() !== tab || !this.inScope(tab.repo) || !tab.summary || tab.summary.repo !== tab.repo || tab.summary.id !== tab.runId) return;
    try { this.context.navigate(prepareRecommendation(tab.summary, this.state.headerRepo === undefined ? this.state.repo : this.state.headerRepo)); }
    catch (error) { this.message = error instanceof Error ? error.message : 'The review draft could not be opened. Refresh to try again.'; this.draw(); }
  }
  private button(label: string, action: () => void, disabled = false, symbol?: IconName, compact = false) {
    const button = node('button'); if (symbol) button.append(icon(symbol)); button.append(node('span', label));
    if (compact) { button.className = 'run-icon-action'; button.title = label; }
    button.type = 'button'; button.disabled = disabled || !this.active(); button.addEventListener('click', action); return button;
  }
  private disclosure(key: string, label: string, className: string) {
    const details = node('details'); details.className = className; details.open = this.disclosures.has(key); details.append(node('summary', label));
    details.addEventListener('toggle', () => { if (details.isConnected) { if (details.open) this.disclosures.add(key); else this.disclosures.delete(key); } }); return details;
  }
  private draw() {
    if (this.disposed) return;
    const selected = this.selected();
    if (selected && this.logLoaded && this.logIdentity === tabKey(selected) && this.log.isConnected && !selected.follow) selected.scrollTop = this.log.scrollTop;
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null;
    const focus = focused?.dataset.focus;
    const retained = new Map<Node, HTMLElement>();
    const keep = (element: HTMLElement) => { const marker = document.createComment(''); retained.set(marker, element); return marker; };
    const root = node('section'); root.className = 'plugin-run-viewer'; root.append(node('style', styles));
    if (!this.container.closest('[data-composition-page]')) {
      const header = node('div'); header.className = 'run-tools'; header.append(node('h2', this.state.pirateMode ? 'Voyage viewer' : 'Run viewer'), this.button('Refresh', () => { void this.refresh(); }, this.busy)); root.append(header);
    }
    const tabs = node('div'); tabs.className = 'run-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Open runs');
    const visibleTabs = this.tabs.filter(item => this.inScope(item.repo));
    for (const [index, tab] of visibleTabs.entries()) {
      const group = node('span'); group.className = 'run-tab'; group.dataset.runKey = tabKey(tab);
      const outcome = tab.summary?.status === 'succeeded' ? tab.summary.review?.outcome : null;
      const recommendation = outcome === 'APPROVE' ? 'Approve' : outcome === 'REQUEST_CHANGES' ? 'Request changes' : outcome === 'COMMENT' ? 'Comment only' : null;
      const feedback = feedbackLabel(tab.summary);
      const statusLabel = feedback ?? recommendation ?? tab.summary?.status ?? 'Status unavailable';
      group.dataset.runStatus = tab.summary?.status ?? '';
      const prNumber = tab.summary?.prNumber;
      const displayKey = tab.summary?.displayKey === 'rerun' ? `Branch update${typeof prNumber === 'number' && Number.isSafeInteger(prNumber) && prNumber > 0 ? ` #${prNumber}` : ''}`
        : tab.summary?.displayKey === 'review' && prNumber
          ? `${this.state.pirateMode ? 'Inspection' : 'Review'} #${prNumber}` : tab.summary?.displayKey ?? tab.runId;
      const label = `${displayKey} · ${tab.repo} · ${tab.runId}`;
      const button = this.button(displayKey, () => this.activate(tab), !this.context.selectPresentation); button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(this.activeKey === tabKey(tab)));
      button.setAttribute('aria-label', `${label}${tab.summary ? ` · Attempt ${tab.summary.attempt}` : ''} · ${statusLabel}`);
      button.title = label;
      const identity = node('small', `${tab.repo} · ${tab.runId}`); identity.className = 'run-tab-identity'; button.append(identity);
      const status = node('span', statusLabel); status.className = 'run-tab-status';
      status.title = feedback ? tab.summary?.feedbackOutcome?.summary ?? feedback : recommendation ? `Review recommendation: ${recommendation}` : statusLabel;
      if (feedback) status.dataset.feedbackOutcome = feedback === 'Feedback completed' ? 'completed' : feedback === 'Awaiting decision' ? 'awaiting_decision' : 'changes_remaining';
      if (!feedback && recommendation && outcome) status.dataset.reviewOutcome = outcome;
      button.append(status);
      button.tabIndex = this.activeKey === tabKey(tab) || this.activeKey === null && index === 0 ? 0 : -1;
      button.addEventListener('keydown', event => {
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? visibleTabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % visibleTabs.length : event.key === 'ArrowLeft' ? (index + visibleTabs.length - 1) % visibleTabs.length : null;
        const next = nextIndex === null ? null : visibleTabs[nextIndex];
        if (!next) return; event.preventDefault(); this.activate(next);
        [...this.container.querySelectorAll<HTMLElement>('[role=tab]')].find(control => control.closest<HTMLElement>('[data-run-key]')?.dataset.runKey === tabKey(next))?.focus({ preventScroll: true });
      });
      const close = this.button('', () => this.close(tab), !this.context.selectPresentation, 'x'); close.setAttribute('aria-label', `Close run ${tab.runId}`); close.title = 'Close tab';
      const open = node('a'); open.append(icon('arrow-square-out')); open.className = 'run-tab-open';
      const headerRepo = this.state.headerRepo === undefined ? this.state.repo : this.state.headerRepo;
      open.href = `/run-viewer?${new URLSearchParams({ ...(headerRepo ? { repo: headerRepo } : {}), runRepo: tab.repo, run: tab.runId })}`;
      open.target = '_blank'; open.rel = 'noopener noreferrer'; open.setAttribute('aria-label', `Open ${label} in a new browser tab`); open.title = 'Open in a new browser tab';
      group.append(button, open, close); tabs.append(group);
    } root.append(tabs);
    for (const text of [this.error, this.saveError, this.commandError, this.unsupported ? 'Saved viewer state uses an unsupported version. It is preserved; request acknowledgment is unavailable.' : '']) if (text) { const error = node('p', text); error.setAttribute('role', 'alert'); root.append(error); }
    if (this.message) { const status = node('p', this.message); status.setAttribute('role', 'status'); root.append(status); }
    const tab = this.selected();
    if (!tab) {
      const empty = node('section'); empty.className = 'run-picker';
      const heading = node('h3', this.state.pirateMode ? 'Choose a voyage' : 'Choose a run'); heading.prepend(icon('tray')); empty.append(heading);
      const message = node('p', this.busy ? 'Resolving selected run…' : this.recentLoading ? 'Loading recent runs…' : this.recentError
        || (!this.recentLoaded || this.recentRuns.length ? 'Select a run to see its log and controls.' : 'No runs in this scope yet. Start a run, then open its log here.'));
      message.className = 'run-picker-state'; message.setAttribute('role', this.recentError ? 'alert' : 'status'); empty.append(message);
      if (!this.busy && !this.recentLoading && !this.recentError) {
        const list = node('ul'); list.className = 'run-picker-list';
        for (const run of this.recentRuns) {
          const item = this.button(run.displayKey === 'rerun' ? `Branch update${run.prNumber ? ` #${run.prNumber}` : ''}` : run.displayKey === 'review' ? `${this.state.pirateMode ? 'Inspection' : 'Review'}${run.prNumber ? ` #${run.prNumber}` : ''}` : run.displayKey,
            () => this.selectRecent(run), !this.context.selectPresentation);
          const title = node('span', item.textContent ?? ''); title.className = 'run-picker-title'; item.replaceChildren(title);
          item.className = 'run-picker-row'; item.dataset.runKey = tabKey({ repo: run.repo, runId: run.id }); item.dataset.selectRun = run.id; item.dataset.runStatus = run.status;
          const kind = node('span'); kind.className = 'run-picker-kind'; kind.dataset.kind = run.displayKey === 'review' ? 'review' : 'work';
          kind.append(icon(run.displayKey === 'review' ? 'magnifying-glass' : run.displayKey === 'rerun' ? 'git-branch' : 'robot'));
          const content = node('span'); content.className = 'run-picker-content';
          const identity = node('span'); identity.className = 'run-picker-identity'; identity.append(title);
          const status = node('span', run.status); status.className = 'run-picker-status'; status.setAttribute('aria-label', `Worker: ${run.status}`);
          status.dataset.tone = run.status === 'succeeded' ? 'good' : run.status === 'failed' ? 'bad' : run.status === 'running' ? 'review' : 'neutral';
          status.prepend(icon(run.status === 'succeeded' ? 'check-circle' : run.status === 'failed' ? 'x-circle' : run.status === 'running' ? 'clock-counter-clockwise' : 'stop'));
          identity.append(status); content.append(identity);
          if (typeof run.title === 'string' && run.title) { const subject = node('span', run.title); subject.className = 'run-picker-subject'; content.append(subject); }
          const meta = node('span', run.repo); meta.className = 'run-picker-meta'; meta.prepend(icon('git-branch')); content.append(meta);
          const feedback = feedbackLabel(run);
          const outcome = run.status === 'succeeded' ? run.review?.outcome : null;
          const recommendation = outcome === 'APPROVE' ? 'Recommend approval' : outcome === 'REQUEST_CHANGES' ? 'Recommend changes' : outcome === 'COMMENT' ? 'Comment only' : null;
          if (feedback || recommendation) {
            const result = node('span', feedback ?? recommendation ?? ''); result.className = 'run-picker-outcome';
            result.dataset.tone = feedback ? feedback === 'Feedback completed' ? 'good' : feedback === 'Awaiting decision' ? 'review' : 'bad' : outcome === 'APPROVE' ? 'good' : outcome === 'REQUEST_CHANGES' ? 'bad' : 'review';
            result.prepend(icon(result.dataset.tone === 'good' ? 'check-circle' : result.dataset.tone === 'bad' ? 'warning-circle' : 'chat-circle-text')); content.append(result);
          }
          const affordance = icon('caret-right'); affordance.classList.add('run-picker-open');
          item.replaceChildren(kind, content, affordance); const row = node('li'); row.append(item); list.append(row);
        }
        empty.append(list);
      }
      root.append(empty);
    }
    else {
      const overview = node('div'); overview.className = 'run-overview';
      const identity = node('div'); identity.className = 'run-overview-identity'; identity.append(icon('git-branch'), node('strong', tab.repo));
      const technical = this.disclosure(`run:${tabKey(tab)}`, 'Run details', 'run-identity-details'); technical.querySelector('summary')?.prepend(icon('fingerprint'));
      technical.append(node('code', tab.runId)); identity.append(technical); overview.append(identity);
      const statusLine = node('div'); statusLine.className = 'run-status-line';
      const badge = (text: string, symbol: IconName, tone = 'neutral') => { const item = node('span'); item.className = 'run-badge'; item.dataset.tone = tone; item.append(icon(symbol), node('span', text)); return item; };
      if (tab.summary) {
        statusLine.append(badge(`Worker: ${tab.summary.status}`, 'robot', tab.summary.status === 'failed' ? 'bad' : tab.summary.status === 'succeeded' ? 'good' : tab.summary.status === 'running' ? 'review' : 'neutral'),
          badge(tab.summary.costUsd === null ? 'Spend unknown' : `$${tab.summary.costUsd.toFixed(2)} observed spend`, 'currency-dollar'));
        const feedback = feedbackLabel(tab.summary);
        if (feedback) { const outcome = badge(feedback, feedback === 'Feedback completed' ? 'check-circle' : 'warning-circle', feedback === 'Feedback completed' ? 'good' : feedback === 'Awaiting decision' ? 'review' : 'bad'); outcome.classList.add('run-feedback-outcome'); outcome.title = tab.summary.feedbackOutcome?.summary ?? ''; statusLine.append(outcome); }
        if (tab.summary.sourceSettlement) overview.append(node('p', `Source settlement: ${tab.summary.sourceSettlement.state}`));
        if (tab.summary.review) {
          const recommendation = node('div'); recommendation.className = 'run-review-recommendation'; recommendation.append(node('p', `Review recommendation: ${tab.summary.review.outcome} — ${tab.summary.review.verdict}`));
          if (tab.summary.status === 'succeeded' && typeof tab.summary.prNumber === 'number' && Number.isSafeInteger(tab.summary.prNumber) && tab.summary.prNumber > 0
            && (tab.summary.review.outcome === 'APPROVE' || tab.summary.review.outcome === 'REQUEST_CHANGES')) {
            const approve = tab.summary.review.outcome === 'APPROVE';
            const action = this.button(approve ? 'Approve…' : 'Request changes…', () => this.openRecommendation(tab), this.busy, approve ? 'check-circle' : 'warning-circle');
            action.dataset.prepareReview = tab.summary.review.outcome; action.title = 'Open a GitHub review draft. Inspect the current diff before submitting.'; action.setAttribute('aria-label', `${approve ? 'Approve' : 'Request changes'}: open GitHub review draft`); recommendation.append(action);
          }
          overview.append(recommendation);
        }
      }
      if (tab.target) statusLine.append(badge(`Attempt ${tab.target.expectedAttempt}`, 'clock-counter-clockwise'));
      overview.insertBefore(statusLine, identity.nextSibling); root.append(overview);
      if (tab.error) { const error = node('p', tab.error); error.setAttribute('role', 'alert'); root.append(error); }
      const tools = node('div'); tools.className = 'run-tools';
      this.earlier.disabled = !this.active() || this.busy || !tab.hasEarlier && !tab.olderTrimmed;
      tools.append(this.button(tab.follow ? 'Pause follow' : 'Follow latest', () => {
        tab.follow = !tab.follow; void this.persist(); this.draw(); if (tab.follow && !this.busy) void this.load(tab.newerTrimmed ? 'initial' : 'follow');
      }, false, tab.follow ? 'pause' : 'arrow-line-down'), keep(this.earlier),
      this.button('Copy preview', () => this.copy(tab, false), !tab.loaded, 'copy', true), this.button('Copy run ID', () => this.copy(tab, true), false, 'fingerprint', true), this.button('Download full log', () => this.download(tab), !tab.target, 'download-simple'));
      const commandDisabled = !this.evidenceReady || this.commandBusy || this.busy || this.blocked(tab) || !tab.summary || !tab.target;
      if (tab.summary?.status === 'running') { const stop = this.button('Stop run', () => { void this.submit('stop', tab); }, commandDisabled, 'stop'); stop.className = 'run-stop'; tools.append(stop); }
      if (tab.summary?.status === 'failed') tools.append(this.button('Retry run', () => { void this.submit('retry', tab); }, commandDisabled, 'arrow-counter-clockwise'));
      if (tab.summary?.status === 'failed' || tab.summary?.status === 'stopped') tools.append(this.button('Ask about this failure', () => { this.postmortem.open({ repo: tab.repo, runId: tab.runId }); }, commandDisabled || !this.context.services.postmortem, 'chat-circle-text'));
      tools.append(keep(this.whiteboard.element)); this.tools.className = 'run-tools'; renderChildren(this.tools, tools, retained);
      this.tools.classList.add('run-log-toolbar');
      const logHeader = node('div'); logHeader.className = 'run-log-heading'; const logTitle = node('h3', 'Log preview'); logTitle.prepend(icon('terminal-window'));
      const preview = this.disclosure('preview', `${tab.events.length} events`, 'run-preview-details'); preview.append(node('small', 'Run-wide log preview · Maximum 300 events · Preview text may be clipped at 4,000 characters per event. Download the full log for complete text.'));
      logHeader.append(logTitle, preview); root.append(logHeader, keep(this.tools));
      if (tab.newerTrimmed || tab.olderTrimmed) root.append(node('small', `${tab.olderTrimmed ? 'Earlier preview events were released. Earlier logs reopens the latest bounded window.' : 'Newer preview events were released. Follow latest returns to the current tail.'} Download preserves full stored text.`));
      const text = tab.loaded ? logText(tab) || 'No log events yet.' : this.busy ? 'Loading log…' : 'Log unavailable.';
      if (this.log.textContent !== text) this.log.textContent = text;
      this.logIdentity = tabKey(tab); root.append(keep(this.log), keep(this.resize.element));
    }
    this.instructions.update(this.state, tab?.summary ? { version: 1, repo: tab.repo, runId: tab.runId, expectedAttempt: tab.summary.attempt } : null);
    root.append(keep(this.instructions.element));
    this.whiteboard.update(this.state, tab?.summary ? { kind: 'run', repo: tab.repo, runId: tab.runId, expectedAttempt: tab.summary.attempt } : null);
    this.postmortem.update(this.state, tab ? { repo: tab.repo, runId: tab.runId } : null);
    root.append(keep(this.postmortem.element));
    this.drawRequests(root);
    this.root.className = root.className; renderChildren(this.root, root, retained);
    if (this.root.parentNode !== this.container) this.container.replaceChildren(this.root);
    this.logLoaded = tab?.loaded ?? false;
    for (const control of this.root.querySelectorAll<HTMLElement>('button, a')) control.dataset.focus = JSON.stringify([control.closest<HTMLElement>('[data-run-key]')?.dataset.runKey, control.closest<HTMLElement>('[data-request-id]')?.dataset.requestId, control.getAttribute('role') === 'tab' ? 'select-tab' : control.classList.contains('run-tab-open') ? 'open-tab' : control.getAttribute('aria-label') ?? control.textContent]);
    if (tab?.loaded) { const scrollTop = tab.follow ? this.log.scrollHeight - this.log.clientHeight : tab.scrollTop; if (this.log.scrollTop !== scrollTop) this.log.scrollTop = scrollTop; if (tab.follow) tab.scrollTop = this.log.scrollTop; }
    if (focused === this.log && this.log.isConnected) this.log.focus({ preventScroll: true });
    else if (focused?.isConnected && (this.instructions.element.contains(focused) || this.postmortem.element.contains(focused) || this.whiteboard.element.contains(focused))) focused.focus({ preventScroll: true });
    else if (focus) [...this.root.querySelectorAll<HTMLElement>('[data-focus]')].find(control => control.dataset.focus === focus)?.focus({ preventScroll: true });
  }
  private drawRequests(root: HTMLElement) {
    if (this.pending.length) {
      const requests = node('section'); requests.className = 'run-saved-requests'; const heading = node('h3', 'Saved requests'); heading.prepend(icon('tray')); heading.append(node('span', String(this.pending.length))); requests.append(heading);
      for (const entry of this.pending) {
        const command = entry.command; if (command.action === 'launch') continue;
        const row = node('article'); row.className = 'run-row'; row.dataset.requestId = command.requestId;
        const header = node('div'); header.className = 'run-request-header'; const title = node('strong', command.action === 'stop' ? 'Stop requested' : 'Retry requested'); title.prepend(icon(command.action === 'stop' ? 'stop' : 'arrow-counter-clockwise'));
        const status = node('span', entry.receipt?.status ?? 'Outcome unknown'); status.className = 'run-badge'; status.dataset.tone = entry.receipt?.status === 'accepted' ? 'good' : entry.receipt?.status === 'rejected' || entry.receipt?.status === 'recovery-required' ? 'bad' : 'neutral'; header.append(title, status);
        const details = this.disclosure(`request:${command.repo}:${command.requestId}`, 'Request details', 'run-request-details'); details.append(node('small', `Run ${command.target.runId} · Request ${command.requestId}`));
        row.append(header, node('small', `${command.repo} · Original attempt ${command.target.expectedAttempt}`),
          node('p', `${entry.receipt?.message ?? 'Worker status is reported separately.'}`), details);
        const tools = node('div'); tools.className = 'run-tools';
        if (terminal(entry.receipt)) tools.append(this.button('Save result and dismiss request', () => { void this.acknowledge(entry); }, this.commandBusy || this.unsupported, 'check'));
        else {
          tools.append(this.button('Check request', () => { void this.checkRequest(entry); }, this.commandBusy, 'arrow-clockwise'));
          if (!entry.receipt || entry.receipt.status === 'pending') tools.append(this.button('Retry delivery', () => {
            void this.deliver({ repo: command.repo, requestId: command.requestId });
          }, this.commandBusy || !this.evidenceReady || !this.context.services.runCommands?.retry, 'arrow-counter-clockwise'));
          if (entry.receipt?.status === 'recovery-required') tools.append(node('p', 'Requires Recovery. No new request will be issued.'));
        }
        if (entry.receipt?.status === 'accepted' && command.action === 'retry' && entry.receipt.runId) {
          const result = entry.receipt; tools.append(this.button('Open retry run', () => {
            try { this.context.selectPresentation?.({ version: 1, kind: 'run', repo: result.repo, runId: result.runId! }); }
            catch { this.commandError = 'The retry run cannot be selected in this scope.'; this.draw(); }
          }, !this.context.selectPresentation));
        }
        row.append(tools); requests.append(row);
      } root.append(requests);
    }
    const visibleResults = this.results.filter(result => this.inScope(result.repo));
    if (visibleResults.length) {
      const results = node('details'); results.className = 'run-saved-results'; results.open = this.resultsOpen; results.addEventListener('toggle', () => { if (results.isConnected) this.resultsOpen = results.open; }); const title = node('summary', `Saved command results (${visibleResults.length})`); title.prepend(icon('receipt')); results.append(title);
      for (const result of visibleResults) {
        const row = node('article'); row.className = 'run-row'; row.dataset.requestId = result.requestId;
        row.append(node('p', `${result.action} · ${result.status} · ${result.repo} · ${result.runId ?? 'No run admitted'}${result.message ? ` — ${result.message}` : ''}`),
          this.button('Remove saved result', () => { this.results = this.results.filter(item => item !== result); void this.persist(); this.draw(); }, this.commandBusy)); results.append(row);
      } root.append(results);
    }
  }
}
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.runInspect?.version !== 1 || context.services.runs?.version !== 1 || context.services.runCommands?.version !== 1 || context.services.downloads?.version !== 1) throw new Error('Run viewer requires version 1 inspection, run reads, commands and downloads.');
  return new ViewerPanel(container, context);
} };
export default panel;
