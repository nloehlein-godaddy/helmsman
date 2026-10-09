import { WhiteboardCompanion } from './whiteboard.js';
import type { PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, PullRequestInspectDetailV1, PullRequestInspectDiffV1, PullRequestReadPageV1, PullRequestCommandPendingV1, PullRequestCommandReceiptV1, RunCommandPendingV1, RunCommandReceiptV1, RunCommandInputV1, RunReadSummaryV1 } from '@helmsman/plugin-sdk';
import { PrStorage, subscribeStorage, type Draft } from './storage.js';
import { esc, target, sameTarget, parseLookup, renderDetail, renderDiff, renderList, renderRuns, type Identity } from './render.js';
import { validDetail, validDiff, validList, validRun, validPending } from './validation.js';
import { styles } from './styles.js';
function selection(state: PluginPanelState): { target: Identity; mode: 'review' | 'rerun' | null; pane: string | null } | null {
  const value = state.routeState?.version === 1 ? state.routeState.value : null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>; const selected = target(record.target);
    if (selected) return { target: selected, mode: record.mode === 'review' || record.mode === 'rerun' ? record.mode : null, pane: state.pane };
  }
  const requested = state.pullRequest;
  if (requested?.version === 1) { const selected = target(requested); if (selected) return { target: selected, mode: requested.mode, pane: state.pane }; }
  const selected = state.presentation?.kind === 'pull-request' ? target(state.presentation) : null;
  return selected ? { target: selected, mode: null, pane: state.pane } : null;
}
class PrPanel implements PluginPanelInstance {
  private state: PluginPanelState;
  private readonly whiteboard: WhiteboardCompanion;
  private disposed = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private selected: Identity | null;
  private route: string;
  private lookup = '';
  private localTarget = false;
  private closePending = false;
  private detail: PullRequestInspectDetailV1 | null = null;
  private diff: PullRequestInspectDiffV1 | null = null;
  private lists: { requested: PullRequestReadPageV1 | null; authored: PullRequestReadPageV1 | null } = { requested: null, authored: null };
  private listErrors = { requested: '', authored: '' };
  private runs: readonly RunReadSummaryV1[] = [];
  private moreRuns = false;
  private runsError = '';
  private pendingReviews: readonly PullRequestCommandPendingV1[] = [];
  private pendingRuns: readonly RunCommandPendingV1[] = [];
  private journalsReady = false;
  private loading = false;
  private busy = false;
  private error = '';
  private result = '';
  private storageError = '';
  private draft: Draft = { body: '', feedback: '', model: '', effort: '' };
  private focusMode: 'review' | 'rerun' | null;
  private focusPane: string | null;
  private readonly storage: PrStorage;
  private readonly unsubscribe: () => void;
  private watches: (() => void)[] = [];
  private watchKey = '';
  private readonly unsupported: boolean;
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private readonly unsaved = new Map<string, { draft: Draft; error: string }>();
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.whiteboard = new WhiteboardCompanion(context.services.whiteboard);
    this.container = container; this.context = context; this.state = context.state; this.storage = new PrStorage(context.contributionId);
    const routed = selection(this.state); this.route = JSON.stringify(routed);
    const saved = this.state.savedState;
    this.unsupported = saved !== null && (saved.version !== 1 || !saved.value || typeof saved.value !== 'object' || Array.isArray(saved.value) || Object.keys(saved.value).some(key => key !== 'target') || ((saved.value as Record<string, unknown>).target !== null && !target((saved.value as Record<string, unknown>).target)));
    this.selected = routed?.target ?? (!this.unsupported && saved?.value ? target((saved.value as Record<string, unknown>).target) : null);
    this.focusMode = routed?.mode ?? null; this.focusPane = this.state.pane;
    this.lookup = this.selected ? `${this.selected.repo}#${this.selected.number}` : '';
    this.readDraft();
    this.unsubscribe = subscribeStorage(source => { if (source !== this.storage && !this.disposed && !this.container.contains(document.activeElement)) { this.readDraft(); this.draw(); } });
    this.container.addEventListener('click', this.click); this.container.addEventListener('input', this.input); this.container.addEventListener('change', this.input); this.container.addEventListener('keydown', this.keydown);
    this.context.signal.addEventListener('abort', this.dispose, { once: true }); this.state.activity.signal.addEventListener('abort', this.cancel, { once: true }); this.context.onDispose(this.dispose);
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private cancel = () => { ++this.generation; this.controller?.abort(); this.controller = null; this.loading = false; for (const stop of this.watches) stop(); this.watches = []; this.watchKey = ''; };
  dispose = () => {
    if (this.disposed) return; this.disposed = true; this.cancel(); this.unsubscribe(); this.whiteboard.dispose();
    this.context.signal.removeEventListener('abort', this.dispose); this.state.activity.signal.removeEventListener('abort', this.cancel);
    this.container.removeEventListener('click', this.click); this.container.removeEventListener('input', this.input); this.container.removeEventListener('change', this.input); this.container.removeEventListener('keydown', this.keydown);
  };
  update(next: PluginPanelState) {
    if (this.disposed) return;
    const previous = this.state; previous.activity.signal.removeEventListener('abort', this.cancel); this.state = next; next.activity.signal.addEventListener('abort', this.cancel, { once: true });
    const routed = selection(next); const route = JSON.stringify(routed);
    const scopeChanged = previous.activity.repo !== next.activity.repo;
    const changed = scopeChanged || previous.visible !== next.visible || previous.activity !== next.activity || route !== this.route;
    if (previous.pane !== next.pane) this.focusPane = next.pane;
    if (route !== this.route) {
      this.localTarget = false; this.route = route; this.focusMode = routed?.mode ?? null; this.focusPane = next.pane;
      if (routed) this.selected = routed.target;
      else if (scopeChanged) this.selected = null;
      this.lookup = this.selected ? `${this.selected.repo}#${this.selected.number}` : ''; this.detail = null; this.diff = null; this.readDraft();
    }
    if (changed) { this.cancel(); if (scopeChanged) { this.lists = { requested: null, authored: null }; this.runs = []; this.detail = null; this.diff = null; } void this.refresh(); }
    this.draw();
  }
  private readDraft() {
    if (!this.selected) { this.draft = { body: '', feedback: '', model: '', effort: '' }; return; }
    const unsaved = this.unsaved.get(JSON.stringify(this.selected));
    if (unsaved) { this.draft = unsaved.draft; this.storageError = unsaved.error; return; }
    try { this.draft = this.storage.draft(this.selected.repo, this.selected.number); this.storageError = ''; }
    catch (error) { this.storageError = error instanceof Error ? error.message : 'Draft storage unavailable. Existing evidence is kept.'; }
  }
  private input = (event: Event) => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) return;
    if (control.matches('[data-pr-compat-lookup]')) { this.lookup = control.value; return; }
    const field = control.dataset.draft as keyof Draft | undefined;
    if (!field || !['body', 'feedback', 'model', 'effort'].includes(field) || !this.selected) return;
    this.draft = { ...this.draft, [field]: control.value };
    try { this.storage.edit(this.selected.repo, this.selected.number, field, control.value); this.unsaved.delete(JSON.stringify(this.selected)); this.storageError = ''; }
    catch (error) { this.storageError = error instanceof Error ? error.message : 'Draft could not be saved. Keep this page open and retry.'; this.unsaved.set(JSON.stringify(this.selected), { draft: { ...this.draft }, error: this.storageError }); }
    this.paintSafety();
  };
  private keydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.isComposing && !event.repeat && event.target instanceof Element && event.target.matches('[data-pr-compat-lookup]')) { event.preventDefault(); event.stopPropagation(); void this.lookupTarget(); }
  };
  private click = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>('a.app-link');
    if (link && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); this.context.navigate(link.getAttribute('href') ?? '/prs'); return; }
    const button = event.target.closest<HTMLButtonElement>('button'); if (!button || button.disabled || !this.active()) return;
    event.stopPropagation();
    if (button.matches('[data-load]')) void this.lookupTarget();
    else if (button.matches('[data-save-draft]')) this.saveDraft();
    else if (button.matches('[data-refresh]')) void this.refresh();
    else if (button.matches('[data-close-inspection]')) void this.closeInspection();
    else if (button.dataset.selectRepo) { const next = target({ repo: button.dataset.selectRepo, number: Number(button.dataset.selectNumber) }); if (next) void this.select(next); }
    else if (button.dataset.run && button.dataset.repo) this.context.selectPresentation?.({ version: 1, kind: 'run', repo: button.dataset.repo, runId: button.dataset.run });
    else if (button.dataset.review) void this.review(button.dataset.review as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT');
    else if (button.dataset.launch) void this.launch(button.dataset.launch as 'review' | 'rerun');
    else if (button.dataset.pendingId && button.dataset.pendingRepo) void this.reconcile(button.dataset.pendingKind === 'review' ? 'review' : 'run', button.dataset.pendingRepo, button.dataset.pendingId, button.dataset.retry === 'true');
  };
  private saveDraft() {
    if (!this.selected) return;
    try { for (const field of ['body', 'feedback', 'model', 'effort'] as const) this.storage.edit(this.selected.repo, this.selected.number, field, this.draft[field]); this.unsaved.delete(JSON.stringify(this.selected)); this.storageError = ''; }
    catch (error) { this.storageError = error instanceof Error ? error.message : 'Draft could not be saved.'; }
    this.draw();
  }
  private async lookupTarget() {
    const repo = this.state.headerRepo === undefined ? this.state.repo : this.state.headerRepo;
    const next = parseLookup(this.lookup, repo);
    if (!next) {
      this.error = !repo && /^#?\d+$/.test(this.lookup.trim())
        ? `Select a ${this.state.pirateMode ? 'galleon' : 'repository'} to look up a PR by number, or enter a full GitHub URL or owner/name#number.`
        : 'Enter a PR number, GitHub URL or owner/name#number.';
      this.draw(); return;
    }
    await this.select(next);
  }
  private async closeInspection() {
    if (this.busy) return;
    this.busy = true; this.closePending = true;
    this.cancel(); this.localTarget = true; this.selected = null; this.lookup = ''; this.detail = null; this.diff = null;
    this.focusMode = null; this.focusPane = null; this.error = ''; this.readDraft(); this.draw();
    try {
      const url = new URL(window.location.href);
      for (const key of ['pr', 'prRepo', 'mode', 'pane']) url.searchParams.delete(key);
      try {
        const states: unknown = JSON.parse(url.searchParams.get('panelState') ?? '{}');
        if (states && typeof states === 'object' && !Array.isArray(states)) {
          const values = states as Record<string, unknown>;
          if (this.context.contributionId) delete values[this.context.contributionId];
          if (Object.keys(values).length) url.searchParams.set('panelState', JSON.stringify(values));
          else url.searchParams.delete('panelState');
        }
      } catch { url.searchParams.delete('panelState'); }
      this.context.navigate(url.pathname + url.search);
      await this.context.setScope?.({ kind: 'inherit' });
      if (!this.unsupported) await this.context.saveState({ version: 1, value: { target: null } });
      this.closePending = false;
      await this.refresh();
      this.container.querySelector<HTMLInputElement>('[data-pr-compat-lookup]')?.focus({ preventScroll: true });
    } catch { this.error = 'Could not close the inspection. Choose Close inspection to try again.'; }
    finally { this.busy = false; this.draw(); if (this.closePending) this.container.querySelector<HTMLButtonElement>('[data-close-inspection]')?.focus({ preventScroll: true }); }
  }
  private async select(next: Identity) {
    if (this.busy) return;
    this.closePending = false; this.localTarget = true; this.selected = next; this.lookup = `${next.repo}#${next.number}`; this.detail = null; this.diff = null; this.error = ''; this.focusMode = null; this.readDraft();
    try {
      if (!this.unsupported) await this.context.saveState({ version: 1, value: { target: next } });
      if (this.state.activity.repo !== next.repo) {
        if (!this.context.setScope) throw new Error('This host cannot set an explicit panel scope.');
        await this.context.setScope({ kind: 'galleon', repo: next.repo });
      }
      const url = new URL(window.location.href); let values: Record<string, unknown> = {};
      try { const parsed: unknown = JSON.parse(url.searchParams.get('panelState') ?? '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) values = parsed as Record<string, unknown>; } catch { /* Malformed route state is replaced only by explicit target selection. */ }
      values[this.context.contributionId!] = { version: 1, value: { target: next, mode: null } };
      url.searchParams.set('panelState', JSON.stringify(values)); url.searchParams.set('panel', this.state.instanceId); url.searchParams.set('prRepo', next.repo); url.searchParams.set('pr', String(next.number)); url.searchParams.delete('mode');
      this.context.navigate(url.pathname + url.search); await this.refresh();
    } catch (error) { this.error = error instanceof Error ? error.message : 'Target could not be selected. Refresh and retry.'; this.draw(); }
  }
  private async journals() {
    const [reviews, runs] = await Promise.all([this.context.services.pullRequestCommands!.pending(), this.context.services.runCommands!.pending()]);
    if (!Array.isArray(reviews) || !Array.isArray(runs) || reviews.some(item => !validPending(item, 'review')) || runs.some(item => !validPending(item, 'run'))) throw new Error('Command journal unavailable. Existing requests are kept.');
    this.pendingReviews = reviews; this.pendingRuns = runs; this.journalsReady = true;
  }
  refresh = async () => {
    if (!this.active()) return;
    const routed = this.localTarget ? this.selected : selection(this.state)?.target ?? this.selected;
    if (routed && this.state.activity.repo !== routed.repo) {
      try { if (!this.context.setScope) throw new Error('Explicit panel scope is unavailable.'); await this.context.setScope({ kind: 'galleon', repo: routed.repo }); }
      catch (error) { this.error = error instanceof Error ? error.message : 'Explicit panel scope is unavailable.'; this.draw(); }
      if (this.state.activity.repo !== routed.repo) return;
    }
    this.cancel(); const generation = this.generation; const controller = new AbortController(); this.controller = controller; this.loading = true; this.error = ''; this.journalsReady = false; this.draw();
    const current = this.selected; const repo = this.state.activity.repo;
    const list = async (kind: 'review-requested' | 'authored-recent', name: 'requested' | 'authored') => {
      try { const result = await this.context.services.pullRequests!.list({ version: 1, repo, kind, limit: 50 }, controller.signal);
        if (!this.active(generation)) return;
        if (result?.status !== 'available' || !validList(result.value, repo)) throw new Error(`Pull request list unavailable: ${result?.status === 'unavailable' ? result.reason : 'invalid response'}`);
        this.lists[name] = result.value; this.listErrors[name] = '';
      } catch (error) { if (this.active(generation)) this.listErrors[name] = this.lists[name]?.items.length ? 'Could not refresh pull requests. Showing previous results.' : 'Could not load pull requests.'; }
    };
    const detail = async () => {
      if (!current || repo !== null && current.repo !== repo) { this.detail = null; this.diff = null; return; }
      try {
        const result = await this.context.services.pullRequestInspect!.detail({ version: 1, ...current }, controller.signal);
        if (!this.active(generation)) return;
        if (result?.status !== 'available' || !validDetail(result.value, current)) throw new Error(`Pull request unavailable: ${result?.status === 'unavailable' ? result.reason : 'invalid response'}`);
        this.detail = result.value;
        const diff = await this.context.services.pullRequestInspect!.diff({ version: 1, target: result.value.target }, controller.signal);
        if (!this.active(generation)) return;
        if (diff?.status !== 'available' || !validDiff(diff.value, result.value.target)) throw new Error('Comparison preview unavailable. Refresh to retry.');
        this.diff = diff.value;
      } catch (error) { if (this.active(generation)) { this.diff = null; this.error = error instanceof Error ? error.message : 'Pull request unavailable.'; } }
    };
    const runs = async () => {
      try { const result = await this.context.services.runs!.list({ version: 1, repo, kind: 'all', limit: 100, cursor: null }, controller.signal);
        if (!this.active(generation)) return;
        if (result?.status !== 'available' || !Array.isArray(result.value?.items) || result.value.items.some(run => !validRun(run, repo))) throw new Error('Recent PR runs unavailable.');
        const matches = result.value.items.filter(run => run && run.prNumber !== null && (repo === null || run.repo === repo)); this.runs = matches.slice(0, 10); this.moreRuns = result.value.nextCursor !== null || matches.length > 10; this.runsError = '';
      } catch { if (this.active(generation)) this.runsError = 'Recent PR runs unavailable.'; }
    };
    await Promise.all([list('review-requested', 'requested'), list('authored-recent', 'authored'), detail(), runs(), this.journals().catch(() => { if (this.active(generation)) { this.journalsReady = false; this.error = 'Command journal unavailable. Existing requests are kept.'; } })]);
    if (this.active(generation)) { this.loading = false; this.readDraft(); this.draw(); this.watch(); }
  };
  private watch() {
    const key = JSON.stringify([this.state.activity.epoch, this.state.activity.repo]); if (!this.active() || this.watchKey === key) return; this.watchKey = key;
    const repo = this.state.activity.repo; const generation = this.generation;
    for (const [kind, name] of [['review-requested', 'requested'], ['authored-recent', 'authored']] as const) this.watches.push(this.context.services.pullRequests!.watchList({ version: 1, repo, kind, limit: 50 }, result => {
      if (!this.active(generation)) return;
      if (result?.status === 'available' && validList(result.value, repo)) { this.lists[name] = result.value; this.listErrors[name] = ''; } else this.listErrors[name] = this.lists[name]?.items.length ? 'Could not refresh pull requests. Showing previous results.' : 'Could not load pull requests.';
      this.draw();
    }, this.state.activity.signal));
  }
  private unresolved() { return this.pendingReviews.some(item => sameTarget(item?.command ?? null, this.selected)) || this.pendingRuns.some(item => item?.command?.action === 'launch' && ['review', 'rerun'].includes(item.command.launch.mode) && sameTarget({ repo: item.command.repo, number: 'prNumber' in item.command.launch ? item.command.launch.prNumber : 0 }, this.selected)); }
  private async review(event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT') {
    if (!this.detail || !this.selected || this.busy || this.storageError || !this.journalsReady || this.unresolved()) return;
    if (event !== 'APPROVE' && !this.draft.body.trim()) { this.error = 'Write a review before submitting.'; this.draw(); return; }
    const input = { version: 1 as const, repo: this.selected.repo, number: this.selected.number, expectedHeadSha: this.detail.target.headSha, event, body: this.draft.body };
    await this.command(async () => { await this.journals(); if (this.unresolved()) { this.error = 'Reconcile the retained request before submitting another.'; return; } const result = await this.context.services.pullRequestCommands!.submit(input, this.state.activity.signal);
      if (result?.status === 'available') await this.consumeReview(result.value); else this.error = 'Review result unavailable. Check the retained request before retrying.';
    });
  }
  private async launch(mode: 'review' | 'rerun') {
    if (!this.detail || !this.selected || this.busy || this.storageError || !this.journalsReady || this.unresolved()) return;
    if (mode === 'rerun' && !this.draft.feedback.trim()) { this.error = 'Describe the changes to make before launching.'; this.draw(); return; }
    const input: RunCommandInputV1 = { version: 1, action: 'launch', repo: this.selected.repo, launch: { ...(mode === 'review' ? { mode, prNumber: this.selected.number, headSha: this.detail.target.headSha } : { mode, prNumber: this.selected.number, feedback: this.draft.feedback }), ...(this.draft.model ? { model: this.draft.model } : {}), ...(this.draft.effort ? { effort: this.draft.effort } : {}) } };
    await this.command(async () => { await this.journals(); if (this.unresolved()) { this.error = 'Reconcile the retained request before submitting another.'; return; } const result = await this.context.services.runCommands!.submit(input, this.state.activity.signal);
      if (result?.status === 'available') await this.consumeRun(result.value, input); else this.error = 'Launch result unavailable. Check the retained request before retrying.';
    });
  }
  private async command(action: () => Promise<void>) {
    this.busy = true; this.error = ''; this.result = ''; this.draw();
    try { await action(); }
    catch (error) { this.error = error instanceof Error ? error.message : 'Command result unavailable. Original request evidence is retained.'; }
    finally { try { await this.journals(); } catch { this.journalsReady = false; this.error = 'Command journal unavailable. Existing evidence is kept.'; } this.busy = false; if (!this.disposed) this.draw(); }
  }
  private async consumeReview(receipt: PullRequestCommandReceiptV1) {
    this.result = receipt.reason ?? `Review ${receipt.status}${receipt.result ? ` by ${receipt.result.actor}` : ''}.`;
    if (receipt.status !== 'succeeded' && receipt.status !== 'rejected') return;
    if (this.storageError) throw new Error('Save the current draft before saving the terminal result and acknowledging its request.');
    this.storage.result('review', receipt.input.repo, receipt.requestId, receipt);
    await this.context.services.pullRequestCommands!.acknowledge({ repo: receipt.input.repo, requestId: receipt.requestId });
  }
  private async consumeRun(receipt: RunCommandReceiptV1, input: RunCommandInputV1) {
    this.result = receipt.message ?? `Run command ${receipt.status}.`;
    if (receipt.status !== 'accepted' && receipt.status !== 'rejected') return;
    if (this.storageError) throw new Error('Save the current draft before saving the terminal result and acknowledging its request.');
    this.storage.result('run', receipt.repo, receipt.requestId, { input, receipt });
    await this.context.services.runCommands!.acknowledge({ repo: receipt.repo, requestId: receipt.requestId });
    if (receipt.status === 'accepted' && receipt.runId && this.active()) this.context.selectPresentation?.({ version: 1, kind: 'run', repo: receipt.repo, runId: receipt.runId });
  }
  private async reconcile(kind: 'review' | 'run', repo: string, requestId: string, retry: boolean) {
    if (this.busy) return;
    await this.command(async () => {
      if (kind === 'review') {
        const entry = this.pendingReviews.find(item => item?.command?.repo === repo && item.command.requestId === requestId); if (!entry) throw new Error('The original request is no longer retained.');
        const service = this.context.services.pullRequestCommands!;
        const result = retry ? await service.retry({ repo, requestId }, this.state.activity.signal) : await service.receipt({ repo, requestId }, this.state.activity.signal);
        if (result?.status === 'available' && result.value) await this.consumeReview(result.value); else this.error = 'Original request has no available receipt. Its evidence is kept.';
      } else {
        const entry = this.pendingRuns.find(item => item?.command?.repo === repo && item.command.requestId === requestId); if (!entry) throw new Error('The original request is no longer retained.');
        const service = this.context.services.runCommands!;
        const result = retry && service.retry ? await service.retry({ repo, requestId }, this.state.activity.signal) : await service.receipt({ repo, requestId }, this.state.activity.signal);
        if (result?.status === 'available' && result.value) { const { requestId: _id, ...input } = entry.command; await this.consumeRun(result.value, input); } else this.error = 'Original request has no available receipt. Its evidence is kept.';
      }
    });
  }
  private pendingMarkup() {
    const rows = [...this.pendingReviews.map(item => ({ kind: 'review', command: item.command, status: item.receipt?.status ?? 'Uncertain result', text: `${item.command.event}: ${item.command.body}`, number: item.command.number })),
      ...this.pendingRuns.filter(item => item.command.action === 'launch' && ['review', 'rerun'].includes(item.command.launch.mode)).map(item => ({ kind: 'run', command: item.command, status: item.receipt?.status ?? 'Uncertain result', text: item.command.action === 'launch' ? JSON.stringify(item.command.launch) : '', number: item.command.action === 'launch' && 'prNumber' in item.command.launch ? item.command.launch.prNumber : 0 }))];
    return rows.filter(row => this.state.activity.repo === null || row.command.repo === this.state.activity.repo).map(row => `<article class="pr-pending"><h4>${esc(row.command.repo)} #${row.number} · ${esc(row.status)}</h4><p>${esc(row.text)}</p><code>${esc(row.command.requestId)}</code><div class="pr-review-actions"><button data-pending-kind="${row.kind}" data-pending-repo="${esc(row.command.repo)}" data-pending-id="${esc(row.command.requestId)}">Check original receipt</button><button data-pending-kind="${row.kind}" data-pending-repo="${esc(row.command.repo)}" data-pending-id="${esc(row.command.requestId)}" data-retry="true"${row.kind === 'run' && !this.context.services.runCommands?.retry ? ' disabled' : ''}>Retry original request</button>${row.status === 'recovery-required' ? '<a class="app-link" href="/recovery">Open Core Recovery ↗</a>' : ''}</div></article>`).join('');
  }
  private savedResults() {
    if (!this.selected) return '';
    try { return this.storage.results(this.selected.repo, this.selected.number).map(value => `<p class="pr-saved-result">${esc(value)}</p>`).join(''); }
    catch { return '<p role="alert">Saved command results unavailable. Existing evidence is kept.</p>'; }
  }
  private paintSafety() {
    const unsafe = this.busy || !this.active() || Boolean(this.storageError) || !this.journalsReady || this.unresolved() || !this.detail || this.detail.status !== 'open';
    this.container.querySelectorAll<HTMLButtonElement>('[data-review], [data-launch]').forEach(button => { button.disabled = unsafe; });
    const error = this.container.querySelector('[data-storage-error]'); if (error) error.textContent = this.storageError; const save = this.container.querySelector<HTMLElement>('[data-save-draft]'); if (save) save.hidden = !this.storageError;
  }
  private draw() {
    if (this.disposed) return;
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null;
    const field = focused?.dataset.draft; const action = focused?.dataset.launch ? ['data-launch', focused.dataset.launch] : focused?.dataset.review ? ['data-review', focused.dataset.review] : focused?.dataset.pendingId ? ['data-pending-id', focused.dataset.pendingId] : focused?.matches('[data-close-inspection]') ? ['data-close-inspection', ''] : null; const lookupFocus = focused?.matches('[data-pr-compat-lookup]'); const selection = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement ? [focused.selectionStart, focused.selectionEnd] as const : null;
    const disclosureKey = (detail: HTMLDetailsElement) => detail.dataset.prDisclosure ?? detail.querySelector('.diff-file-name')?.textContent ?? null;
    const opened = new Set([...this.container.querySelectorAll<HTMLDetailsElement>('details[open]')].map(disclosureKey).filter(key => key !== null));
    const selectedFocus = focused?.dataset.selectRepo ? [focused.dataset.selectRepo, focused.dataset.selectNumber] : null;
    const runFocus = focused?.dataset.run;
    const disclosureFocus = focused?.matches('summary') && focused.parentElement instanceof HTMLDetailsElement ? disclosureKey(focused.parentElement) : null;
    const composed = this.container.closest('[data-composition-page]') !== null;
    const refreshLabel = composed ? 'Refresh page' : 'Refresh panel';
    const headerRepo = this.state.headerRepo === undefined ? this.state.repo : this.state.headerRepo;
    this.container.innerHTML = `<section class="plugin-public-pr" aria-busy="${this.loading}"><style>${styles}</style>${composed ? '' : '<div class="pr-panel-tools"><button data-refresh>Refresh panel</button></div>'}
      ${this.unsupported ? '<p role="alert">Saved panel state uses an unsupported format. Its original data is kept.</p>' : ''}<p role="alert" data-storage-error>${esc(this.storageError)}</p><button data-save-draft${this.storageError ? '' : ' hidden'}>Save current draft</button>${this.error ? `<p role="alert" class="pr-review-error">${esc(this.error)}</p>` : ''}${this.result ? `<p role="status" class="pr-command-result">${esc(this.result)}</p>` : ''}
      <section class="pr-lookup-panel panel" data-pr-pane="lookup"><div class="pr-lookup-heading"><h3>${this.state.pirateMode ? 'Inspect a bounty' : 'Review a PR'}</h3>${this.selected || this.closePending ? '<button data-close-inspection>Close inspection</button>' : ''}</div>${this.state.activity.repo !== headerRepo ? `<p class="pr-scope-override">Inspection scope: ${esc(this.state.activity.repo ?? (this.state.pirateMode ? 'All galleons' : 'All repositories'))}</p>` : ''}<div class="pr-lookup-form"><label class="interface-field">Pull request number, URL or owner/name#number<input class="pr-lookup-input" data-pr-compat-lookup placeholder="PR number, #number, URL or owner/name#number" value="${esc(this.lookup)}"></label><button class="pr-lookup-go" data-load>Load ${this.state.pirateMode ? 'bounty' : 'PR'}</button></div><div class="pr-lookup-result">${this.detail ? renderDetail(this.detail, this.draft, headerRepo, this.state.pirateMode) : this.selected ? `<p class="empty-note" role="status">${this.loading ? 'Loading pull request…' : `Pull request unavailable. ${refreshLabel} to retry.`}</p>` : ''}</div></section>${this.diff ? renderDiff(this.diff) : ''}
      <div class="pr-inbox">${renderList('review-requested', this.lists.requested, this.listErrors.requested, this.state.pirateMode, refreshLabel)}${renderList('authored-recent', this.lists.authored, this.listErrors.authored, this.state.pirateMode, refreshLabel)}</div>${renderRuns(this.runs, this.moreRuns, this.runsError, this.state.pirateMode)}
      <section aria-label="Retained pull request commands">${this.pendingMarkup()}</section><section aria-label="Saved command results">${this.savedResults()}</section></section>`;
    this.whiteboard.update(this.state, this.detail ? { kind: 'pull-request', ...this.detail.target } : null);
    this.container.querySelector('.pr-lookup-result')?.append(this.whiteboard.element);
    if (focused?.isConnected && this.whiteboard.element.contains(focused)) focused.focus({ preventScroll: true });
    for (const detail of this.container.querySelectorAll<HTMLDetailsElement>('details')) if (opened.has(disclosureKey(detail) ?? '')) detail.open = true;
    if (!this.active() || this.busy) this.container.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; }); this.paintSafety();
    const next = field ? this.container.querySelector<HTMLTextAreaElement>(`[data-draft="${field}"]`) : lookupFocus ? this.container.querySelector<HTMLInputElement>('[data-pr-compat-lookup]') : null;
    if (next) { next.focus({ preventScroll: true }); if (selection && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) next.setSelectionRange(...selection); }
    if (selectedFocus) [...this.container.querySelectorAll<HTMLElement>('[data-select-repo]')].find(control => control.dataset.selectRepo === selectedFocus[0] && control.dataset.selectNumber === selectedFocus[1])?.focus({ preventScroll: true });
    if (runFocus) [...this.container.querySelectorAll<HTMLElement>('[data-run]')].find(control => control.dataset.run === runFocus)?.focus({ preventScroll: true });
    if (disclosureFocus) [...this.container.querySelectorAll<HTMLDetailsElement>('details')].find(detail => disclosureKey(detail) === disclosureFocus)?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    if (action) [...this.container.querySelectorAll<HTMLElement>(`[${action[0]}]`)].find(control => control.getAttribute(action[0]!) === action[1])?.focus({ preventScroll: true });
    if (this.focusMode && this.active()) { const control = this.container.querySelector<HTMLElement>(this.focusMode === 'rerun' ? '.pr-rerun-feedback' : '.pr-review-agent'); if (control && !(control instanceof HTMLButtonElement && control.disabled)) { this.focusMode = null; control.focus({ preventScroll: true }); control.scrollIntoView?.({ block: 'nearest' }); } }
    else if (this.focusPane && !this.loading) { const pane = [...this.container.querySelectorAll<HTMLElement>('[data-pr-pane]')].find(node => node.dataset.prPane === this.focusPane); if (pane) { if (pane instanceof HTMLDetailsElement) pane.open = true; pane.scrollIntoView?.({ block: 'start' }); this.focusPane = null; } }
  }
}
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.pullRequests?.version !== 1 || context.services.pullRequestInspect?.version !== 1 || context.services.pullRequestCommands?.version !== 1 || context.services.runCommands?.version !== 1 || context.services.runs?.version !== 1) throw new Error('Pull requests require version 1 public read, inspection and command services.');
  return new PrPanel(container, context);
} };
export default panel;
