import type { LocalGitControlInputV1, LocalGitControlReceiptV1, LocalGitPendingV1, LocalGitPreviewV1, LocalGitSnapshotV1, LocalGitTargetV1, PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState } from '@helmsman/plugin-sdk';
import { LocalGitStorage, esc, message, pendingValid, previewValid, receiptValid, sameInput, sameTarget, snapshotValid, type LocalGitViewState } from './state.js';
import { renderLocalGit } from './render.js';
import { styles } from './styles.js';

class LocalGitPanel implements PluginPanelInstance {
  private state: PluginPanelState;
  private readonly storage: LocalGitStorage;
  private snapshot: LocalGitSnapshotV1 | null = null;
  private preview: LocalGitPreviewV1 | null = null;
  private confirmation: LocalGitControlInputV1 | null = null;
  private cleanupForce = false;
  private deleteForce = false;
  private pending: readonly LocalGitPendingV1[] = [];
  private results: LocalGitControlReceiptV1[] = [];
  private journalsReady = false;
  private storageError = '';
  private readError = '';
  private error = '';
  private busy = false;
  private loading = false;
  private disposed = false;
  private generation = 0;
  private reader: AbortController | null = null;
  private operation: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context;
    this.state = context.state; this.storage = new LocalGitStorage(context.contributionId,context.state.instanceId); this.readResults();
    container.classList.add('plugin-local-git'); container.addEventListener('click',this.click); container.addEventListener('change',this.change);
    context.onDispose(this.dispose); context.signal.addEventListener('abort',this.dispose,{once:true}); this.state.activity.signal.addEventListener('abort',this.cancel,{once:true});
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private target(): LocalGitTargetV1 | null { return this.snapshot ? {repo:this.snapshot.repo,revision:this.snapshot.revision} : null; }
  private inScope(repo: string) { return this.state.activity.repo === null || repo === this.state.activity.repo; }
  private cancelReads() { ++this.generation; this.reader?.abort(); this.reader = null; this.loading = false; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private cancel = () => { this.cancelReads(); this.operation?.abort(); this.confirmation = null; this.preview = null; this.deleteForce = false; this.cleanupForce = false; this.journalsReady = false; };
  dispose = () => { if (this.disposed) return; this.disposed = true; this.cancel(); this.container.removeEventListener('click',this.click); this.container.removeEventListener('change',this.change); this.context.signal.removeEventListener('abort',this.dispose); this.state.activity.signal.removeEventListener('abort',this.cancel); this.container.replaceChildren(); this.container.classList.remove('plugin-local-git'); };
  update(next: PluginPanelState) {
    if (this.disposed) return; const previous = this.state; previous.activity.signal.removeEventListener('abort',this.cancel); this.state = next; next.activity.signal.addEventListener('abort',this.cancel,{once:true});
    if (previous.activity !== next.activity || previous.visible !== next.visible) { this.cancel(); if (previous.activity.repo !== next.activity.repo) { this.snapshot = null; this.readError = ''; this.error = ''; } void this.refresh(); }
    this.draw();
  }
  private readResults() { try { this.results = this.storage.results(); this.storageError = ''; } catch (error) { this.storageError = message(error,'Saved Local Git evidence unavailable.'); } }
  private async loadPending(signal?: AbortSignal) { const values = await this.context.services.localGit!.pending(signal); if (!pendingValid(values)) throw new Error('Local Git journal unavailable. Original commands are kept.'); return values; }
  refresh = async () => {
    if (!this.active() || this.busy) return; this.cancelReads(); const generation = this.generation; const controller = new AbortController(); this.reader = controller; const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null; this.loading = true; this.draw(); const repo = this.state.activity.repo;
    try {
      const values = await Promise.allSettled([repo ? this.context.services.localGit!.snapshot({version:1,repo},controller.signal) : Promise.resolve(null),this.loadPending(controller.signal)]); if (!this.active(generation)) return;
      const journal = values[1]; if (journal.status === 'fulfilled') { this.pending = journal.value; this.journalsReady = true; } else { this.journalsReady = false; this.error = message(journal.reason,'Local Git journal unavailable. Original commands are kept.'); }
      const result = values[0];
      if (!repo) { this.snapshot = null; this.readError = ''; }
      else if (result.status === 'fulfilled' && result.value?.status === 'available' && snapshotValid(result.value.value) && result.value.value.repo === repo) { const snapshot = result.value.value; this.snapshot = snapshot; this.readError = snapshot.error ?? ''; }
      else this.readError = 'Local Git could not be refreshed. Existing evidence is kept; controls are disabled until refresh succeeds.';
      this.readResults();
    } catch (error) { if (this.active(generation)) this.readError = message(error,'Local Git unavailable.'); }
    finally { if (this.active(generation)) { this.loading = false; this.draw(); if (document.activeElement === document.body && focused?.isConnected) focused.focus({preventScroll:true}); this.timer = setTimeout(() => { void this.refresh(); },30_000); } }
  };
  private canControl() { return this.active() && !this.loading && !this.busy && !!this.snapshot?.path && this.snapshot.repo === this.state.activity.repo && !this.readError && !this.storageError && this.journalsReady && !this.pending.some(row => row.command.target.repo === this.state.activity.repo); }
  private change = (event: Event) => {
    const input = event.target; if (!(input instanceof HTMLInputElement) || !this.active() || this.busy || input.disabled) return; event.stopPropagation();
    if (input.matches('.local-git-cleanup-force')) { this.cleanupForce = input.checked; this.preview = null; this.draw(); }
    else if (input.matches('.local-git-force')) this.deleteForce = input.checked;
  };
  private click = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null; if (!button || button.disabled || !this.active()) return; event.stopPropagation();
    if (button.dataset.receipt) { void this.reconcile(button.dataset.receipt,button.hasAttribute('data-inspect')); return; }
    if (button.matches('.local-git-cleanup-cancel')) { this.preview = null; this.cleanupForce = false; this.draw(); return; }
    if (button.matches('.local-git-cancel')) { this.confirmation = null; this.deleteForce = false; this.draw(); return; }
    if (button.matches('[data-check-storage]')) { this.readResults(); this.draw(); return; }
    if (button.matches('.local-git-refresh') && !button.matches('.local-git-check-remotes')) { void this.refresh(); return; }
    if (!this.canControl()) return; const target = this.target()!;
    if (button.matches('.local-git-check-remotes')) { void this.control({version:1,target,operation:{action:'refresh-remotes'}}); return; }
    if (button.matches('.local-git-cleanup-preview')) { void this.loadPreview(target,this.cleanupForce); return; }
    if (button.matches('.local-git-cleanup-confirm') && this.preview) { const preview = this.preview; void this.control({version:1,target:preview.target,operation:{action:'delete-untracked-branches',expectedHead:preview.cleanup.expectedHead,branches:preview.cleanup.candidates.map(({branch,expectedCommit}) => ({branch,expectedCommit})),force:preview.cleanup.force}}); return; }
    if (button.matches('.local-git-confirm-delete,.local-git-confirm-release') && this.confirmation) { const input = this.confirmation; void this.control({...input,operation:input.operation.action === 'delete-branch' ? {...input.operation,force:this.deleteForce} : input.operation}); return; }
    const branch = this.snapshot?.branches.find(row => row.name === button.dataset.localBranch);
    const releasePath = button.dataset.localRelease;
    const tree = this.snapshot?.worktrees.find(row => row.path === (releasePath ?? button.dataset.localWorktree));
    if (releasePath) {
      if (!tree?.branch || tree.active || tree.locked || tree.bare || tree.detached || tree.prunable || tree.path === this.snapshot?.path || tree.releaseBlockedReason) return;
      this.confirmation = {version:1,target,operation:{action:'release-worktree',path:tree.path,expectedCommit:tree.commit,expectedBranch:tree.branch}};
    } else if (branch && !branch.current && !branch.deletionBlockedReason) this.confirmation = {version:1,target,operation:{action:'delete-branch',branch:branch.name,expectedCommit:branch.commit}};
    else if (tree && !tree.locked && !tree.bare && tree.path !== this.snapshot?.path && !tree.deletionBlockedReason) this.confirmation = {version:1,target,operation:{action:'delete-worktree',path:tree.path,expectedCommit:tree.commit}};
    else return; this.preview = null; this.deleteForce = false; this.draw();
  };
  private async loadPreview(target: LocalGitTargetV1, force: boolean) {
    if (!this.canControl()) return; this.cancelReads(); const generation = this.generation; this.busy = true; this.error = ''; this.operation = new AbortController(); const signal = AbortSignal.any([this.operation.signal,this.context.signal,this.state.activity.signal]); this.draw();
    try { const result = await this.context.services.localGit!.preview({target,force},signal); if (signal.aborted || !this.active(generation)) return; if (result?.status !== 'available' || !previewValid(result.value) || !sameTarget(result.value.target,target) || result.value.cleanup.force !== force) throw new Error('Cleanup preview unavailable. Refresh local data and preview again.'); this.preview = result.value; this.confirmation = null; }
    catch (error) { if (this.active(generation)) this.error = message(error,'Cleanup preview unavailable.'); }
    finally { this.busy = false; this.operation = null; this.draw(); void this.refresh(); }
  }
  private async control(input: LocalGitControlInputV1) {
    if (!this.canControl()) return; this.cancelReads(); this.busy = true; this.error = ''; this.operation = new AbortController(); const signal = AbortSignal.any([this.operation.signal,this.context.signal,this.state.activity.signal]); this.draw();
    try {
      this.pending = await this.loadPending(signal); if (signal.aborted || !this.active() || input.target.repo !== this.state.activity.repo || this.pending.some(row => row.command.target.repo === input.target.repo)) throw new Error('Reconcile the original Local Git command before another operation.');
      const result = await this.context.services.localGit!.control(input,signal); if (result?.status !== 'available' || !receiptValid(result.value) || !sameInput(result.value.input,input)) throw new Error('Local Git outcome is unknown. Check its original receipt before another operation.'); await this.consume(result.value,false);
      if (result.value.status === 'rejected' && input.operation.action === 'delete-untracked-branches' && this.state.activity.repo === input.target.repo) this.preview = null;
      if (result.value.status === 'succeeded' && this.state.activity.repo === input.target.repo) { this.confirmation = null; this.preview = null; this.deleteForce = false; this.cleanupForce = false; }
    } catch (error) { this.error = message(error,'Local Git outcome unavailable. Original evidence is kept.'); }
    finally { await this.finishOperation(); }
  }
  private async consume(value: LocalGitControlReceiptV1, inspected: boolean) {
    this.error = value.status === 'succeeded' ? `Local Git operation confirmed for ${value.input.target.repo}.` : value.reason ?? `Local Git operation ${value.status}.`;
    if (value.status === 'pending') return;
    this.storage.result(value); this.readResults(); if (this.storageError) throw new Error(this.storageError);
    if (value.status === 'recovery-required') { if (!inspected) return; this.storage.inspected(value); this.error = 'Uncertain operation history saved after inspection. Completion was not confirmed.'; }
    await this.context.services.localGit!.acknowledge({repo:value.input.target.repo,requestId:value.requestId});
  }
  private async reconcile(requestId: string, inspected: boolean) {
    if (!this.active() || this.busy || this.storageError) return; const original = this.pending.find(row => row.command.requestId === requestId && this.inScope(row.command.target.repo)); if (!original) return;
    this.cancelReads(); this.busy = true; this.operation = new AbortController(); const signal = AbortSignal.any([this.operation.signal,this.context.signal,this.state.activity.signal]); this.draw();
    try { const query = {repo:original.command.target.repo,requestId}; const service = this.context.services.localGit!; const result = inspected ? await service.inspect(query,signal) : await service.receipt(query,signal); if (result?.status !== 'available' || !result.value || !receiptValid(result.value) || result.value.requestId !== requestId || !sameInput(result.value.input,original.command)) throw new Error('Original Local Git receipt unavailable. Its request identity is kept.'); await this.consume(result.value,inspected); }
    catch (error) { this.error = message(error,'Original Local Git receipt unavailable.'); }
    finally { await this.finishOperation(); }
  }
  private async finishOperation() { try { this.pending = await this.loadPending(); this.journalsReady = true; } catch { this.journalsReady = false; } this.busy = false; this.operation = null; this.draw(); void this.refresh(); }
  private draw() {
    if (this.disposed) return; const headerRepo = this.state.headerRepo === undefined ? this.state.repo : this.state.headerRepo;
    const view: LocalGitViewState = {repo:this.state.activity.repo,headerRepo,pirateMode:this.state.pirateMode,path:this.snapshot?.path ?? null,branches:this.snapshot?.branches ?? [],worktrees:this.snapshot?.worktrees ?? [],error:this.readError || null,loading:this.loading,pendingAction:this.busy ? 'Waiting for the original Local Git operation…' : undefined,cleanup:this.preview?.cleanup,cleanupForce:this.cleanupForce,deleteForce:this.deleteForce,confirmation:this.confirmation?.operation.action === 'delete-branch' || this.confirmation?.operation.action === 'delete-worktree' || this.confirmation?.operation.action === 'release-worktree' ? this.confirmation.operation : undefined};
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null; const force = this.container.querySelector<HTMLInputElement>('.local-git-force'); const cleanupForce = this.container.querySelector<HTMLInputElement>('.local-git-cleanup-force'); const scrolls = [...this.container.querySelectorAll<HTMLElement>('.local-git-list,.local-git-cleanup-list')].map(node => node.scrollTop); const open = this.container.querySelector<HTMLDetailsElement>('.local-git-cleanup-skipped')?.open;
    const template = document.createElement('template'); template.innerHTML = `<style>${styles}</style>${renderLocalGit(view)}<section class="local-git-recovery"><p role="status">${esc(this.error)}</p><p role="alert">${esc(this.storageError)}</p>${this.storageError ? '<button data-check-storage>Check saved evidence again</button>' : ''}${this.confirmation && !sameTarget(this.confirmation.target,this.target()) || this.preview && !sameTarget(this.preview.target,this.target()) ? '<p role="status">This confirmation retains its original checkout revision. Cancel and preview again to use newer local data.</p>' : ''}${this.pending.filter(row => this.inScope(row.command.target.repo)).map(row => `<article><h3>${esc(row.command.operation.action)} · ${esc(row.command.target.repo)} · ${esc(row.receipt?.status ?? 'Uncertain outcome')}</h3><p>${esc(row.receipt?.reason ?? 'Check the original receipt before another operation. The original command is retained and is never replayed automatically.')}</p><code>${esc(row.command.requestId)}</code><details><summary>Original operation</summary><pre>${esc(JSON.stringify(row.command.operation,null,2))}</pre></details><button data-check data-receipt="${esc(row.command.requestId)}">Check original receipt</button>${row.receipt === null || row.receipt.status === 'recovery-required' ? `<button data-inspect data-receipt="${esc(row.command.requestId)}">Resume operations after inspection</button><p>Inspect the local branches and worktrees before resuming. Inspection fences delayed delivery and never repeats the operation. It does not confirm completion.</p>` : ''}</article>`).join('')}<details data-results><summary>Saved Local Git results</summary>${this.results.filter(row => this.inScope(row.input.target.repo)).slice(-50).map(row => `<article>${esc(row.input.operation.action)} · ${esc(row.input.target.repo)} · ${esc(row.status)}<p>${esc(row.reason)}</p><code>${esc(row.requestId)}</code></article>`).join('')}</details></section>`;
    for (const [selector,previous,checked] of [['.local-git-force',force,this.deleteForce],['.local-git-cleanup-force',cleanupForce,this.cleanupForce]] as const) { const next = template.content.querySelector<HTMLInputElement>(selector); if (previous && next) { previous.checked = checked; previous.disabled = next.disabled; next.replaceWith(previous); } }
    const resultsOpen = this.container.querySelector<HTMLDetailsElement>('[data-results]')?.open ?? false; this.container.replaceChildren(template.content); const details = this.container.querySelector<HTMLDetailsElement>('.local-git-cleanup-skipped'); if (details && open !== undefined) details.open = open; const results = this.container.querySelector<HTMLDetailsElement>('[data-results]'); if (results) results.open = resultsOpen;
    [...this.container.querySelectorAll<HTMLElement>('.local-git-list,.local-git-cleanup-list')].forEach((node,index) => { node.scrollTop = scrolls[index] ?? 0; });
    for (const button of this.container.querySelectorAll<HTMLButtonElement>('.local-git-delete,.local-git-release,.local-git-confirm-release,.local-git-check-remotes')) button.disabled ||= !this.canControl();
    for (const input of this.container.querySelectorAll<HTMLInputElement>('input')) input.disabled ||= !this.canControl();
    for (const button of this.container.querySelectorAll<HTMLButtonElement>('[data-receipt]')) button.disabled = this.busy || !this.active() || !!this.storageError;
    if (focused?.isConnected) focused.focus({preventScroll:true});
  }
}
const panel: PluginPanelModule = {mount(container,context) { if (context.services.localGit?.version !== 1) throw new Error('Local Git requires version 1 public Local Git services.'); return new LocalGitPanel(container,context); }};
export default panel;
