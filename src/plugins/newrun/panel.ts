import type { PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, RunCommandInputV1,
  RunCommandPendingV1, TaskReadSourceV1, TaskReadTaskV1 } from '@helmsman/plugin-sdk';
import { emptyDraft, efforts, launchInput, readState, saveValue, validRepo, type Draft, type DraftState, type Mode } from './state.js';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;
};
const sourceKey = (value: { sourceId: string; instanceId: string; instanceRevision: number; repo: string } | null | undefined): string => JSON.stringify([value?.repo, value?.sourceId, value?.instanceId, value?.instanceRevision]);
const refKey = (value: { sourceId: string; externalId: string } | null | undefined): string => JSON.stringify([value?.sourceId, value?.externalId]);
const styles = `.plugin-newrun{display:grid;gap:12px;color:var(--text);font:14px var(--sans,sans-serif);min-width:0}.plugin-newrun :is(h2,h3,p){margin:0}.plugin-newrun :is(header,.newrun-actions){display:flex;gap:8px;align-items:center;flex-wrap:wrap}.plugin-newrun form,.plugin-newrun section,.plugin-newrun label{display:grid;gap:8px}.plugin-newrun :is(input,textarea,select,button){font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);padding:7px 9px;border-radius:var(--radius,4px);max-width:100%;box-sizing:border-box}.plugin-newrun textarea{min-height:110px;resize:vertical;width:100%}.plugin-newrun button{cursor:pointer}.plugin-newrun button:disabled{opacity:.5}.plugin-newrun small{color:var(--text-dim)}.plugin-newrun [role=alert]{color:var(--bad)}.plugin-newrun a{color:var(--accent)}.plugin-newrun :is(button,input,textarea,select,a):focus-visible{outline:2px solid var(--accent);outline-offset:2px}`;

class NewRunPanel implements PluginPanelInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private state: PluginPanelState;
  private drafts: DraftState;
  private unsupported: boolean;
  private dirty = false;
  private revision = 0;
  private savedSnapshots = new Set<string>();
  private saveQueue: Promise<boolean> = Promise.resolve(true);
  private saveMessage = '';
  private error = '';
  private sourceError = '';
  private galleons: string[] = [];
  private sources: TaskReadSourceV1[] = [];
  private tasks: TaskReadTaskV1[] = [];
  private cursor: string | null = null;
  private cursors = new Set<string>();
  private pages = 0;
  private loadingTasks = false;
  private lookupBusy = false;
  private pending: RunCommandPendingV1[] = [];
  private pendingReady = false;
  private busy = false;
  private disposed = false;
  private generation = 0;
  private controller: AbortController | null = null;
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state;
    const parsed = readState(context.state.savedState); this.unsupported = parsed === null; this.drafts = parsed ?? { selectedRepo: null, drafts: [] };
    context.onDispose(() => this.dispose()); context.signal.addEventListener('abort', this.dispose, { once: true });
    this.state.activity.signal.addEventListener('abort', this.suspend, { once: true });
    if (context.signal.aborted) { this.dispose(); return; }
    this.draw(); void this.refresh();
  }
  private repo(): string | null { return this.state.repo ?? this.drafts.selectedRepo; }
  private linkedTicket(): string | null {
    const route = this.state.routeState; const value = route?.value;
    if (route?.version !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) return null;
    const ticket = (value as { legacyTicket?: unknown }).legacyTicket;
    return typeof ticket === 'string' && ticket.trim() && ticket.length <= 512 && !/[\x00-\x1f\x7f]/.test(ticket) ? ticket : null;
  }
  private draft(): Draft {
    const repo = this.repo(); const previous = this.drafts.drafts.find(item => item.repo === repo);
    if (previous) return previous.draft;
    const draft = emptyDraft(); if (repo) this.drafts.drafts.push({ repo, draft }); return draft;
  }
  private active(generation = this.generation): boolean {
    return !this.disposed && this.state.visible && this.state.activity.active && !this.context.signal.aborted
      && !this.state.activity.signal.aborted && generation === this.generation;
  }
  private suspend = () => { ++this.generation; this.controller?.abort(); this.controller = null; this.busy = false; this.lookupBusy = false; this.pendingReady = false; };
  dispose = (): void => {
    if (this.disposed) return; this.disposed = true; this.suspend();
    this.context.signal.removeEventListener('abort', this.dispose); this.state.activity.signal.removeEventListener('abort', this.suspend);
    this.container.replaceChildren();
  };
  update(state: PluginPanelState): void {
    if (this.disposed) return;
    const changed = state.repo !== this.state.repo || state.activity.epoch !== this.state.activity.epoch || state.visible !== this.state.visible;
    const savedChanged = state.savedState !== this.state.savedState;
    this.state.activity.signal.removeEventListener('abort', this.suspend); this.state = state;
    state.activity.signal.addEventListener('abort', this.suspend, { once: true });
    let draftChanged = false;
    if (savedChanged && !this.dirty && !this.savedSnapshots.has(JSON.stringify(state.savedState))) {
      const parsed = readState(state.savedState); this.unsupported = parsed === null;
      if (parsed) { this.drafts = parsed; draftChanged = true; }
    }
    if (changed || draftChanged) { this.suspend(); this.tasks = []; this.sources = []; this.pending = []; this.draw(); if (this.active()) void this.refresh(); }
    else this.draw();
  }
  private change(): void { this.dirty = true; ++this.revision; void this.save(); }
  private save(): Promise<boolean> {
    if (this.unsupported || this.disposed) return Promise.resolve(false);
    const revision = this.revision;
    let value;
    try { value = saveValue(this.drafts); }
    catch (error) { this.saveMessage = error instanceof Error ? error.message : 'Draft could not be saved.'; this.updateSaveMessage(); return Promise.resolve(false); }
    const snapshot = value;
    const serialized = JSON.stringify(snapshot); this.savedSnapshots.add(serialized);
    if (this.savedSnapshots.size > 32) this.savedSnapshots.delete(this.savedSnapshots.values().next().value!);
    const next = this.saveQueue.catch(() => false).then(async () => {
      if (revision !== this.revision || this.disposed) return false;
      try {
        await this.context.saveState(snapshot);
        if (revision === this.revision) { this.dirty = false; this.saveMessage = ''; }
        return true;
      } catch { if (revision === this.revision) this.saveMessage = 'Draft could not be saved. Your text is kept; retry saving before launching.'; return false; }
      finally { this.updateSaveMessage(); }
    });
    this.saveQueue = next; return next;
  }
  private updateSaveMessage(): void {
    const message = this.container.querySelector<HTMLElement>('.newrun-save-message'); if (message) message.textContent = this.saveMessage;
  }
  async refresh(): Promise<void> {
    if (!this.active()) return;
    this.controller?.abort(); const controller = new AbortController(); this.controller = controller; const generation = ++this.generation;
    this.pendingReady = false; this.lookupBusy = false; this.sourceError = ''; this.tasks = []; this.cursor = null; this.cursors.clear(); this.pages = 0; this.loadingTasks = false;
    this.draw();
    await Promise.all([
      this.restorePending(generation),
      Promise.resolve().then(async () => {
        const result = await this.context.services.tasks!.discover(controller.signal);
        if (!this.active(generation)) return;
        if (result?.status !== 'available' || !Array.isArray(result.value?.galleons)) throw new Error('Task sources unavailable.');
        const galleons = result.value.galleons.filter(item => item && validRepo(item.repo) && (this.state.repo === null || item.repo === this.state.repo));
        this.galleons = galleons.map(item => item.repo);
        this.sources = galleons.flatMap(item => item.sources?.status === 'available' && Array.isArray(item.sources.value) ? item.sources.value.filter((source: TaskReadSourceV1) => source?.repo === item.repo) : []);
        const selected = this.repo();
        if (selected && !this.galleons.includes(selected)) this.sourceError = 'The selected galleon is unavailable. Your draft is kept.';
        else if (galleons.find(item => item.repo === selected)?.sources.status === 'unavailable') this.sourceError = 'Task sources are unavailable for this galleon.';
        this.draw();
        if (this.draft().mode === 'source') await this.loadTasks(generation);
      }).catch(() => { if (this.active(generation)) { this.sources = []; this.sourceError = 'Task sources could not be read. Refresh to retry.'; } }),
    ]);
    if (this.active(generation)) this.draw();
  }
  private async restorePending(generation: number): Promise<void> {
    try {
      const entries = await this.context.services.runCommands!.pending(); if (!this.active(generation)) return;
      if (!Array.isArray(entries) || entries.length > 256) throw new Error('Saved requests unavailable');
      this.pending = entries.filter(entry => entry?.command?.action === 'launch' && validRepo(entry.command.repo)
        && (this.state.repo === null || entry.command.repo === this.state.repo));
      this.pendingReady = true;
    } catch { if (this.active(generation)) { this.pendingReady = false; this.error = 'Saved launch requests could not be read. Refresh before launching.'; } }
  }
  private selectedSource(): TaskReadSourceV1 | null {
    const selected = this.draft().source;
    return selected ? this.sources.find(source => source.repo === this.repo() && sourceKey(source) === sourceKey(selected) && source.availability === 'available') ?? null : null;
  }
  private async loadTasks(generation: number, more = false): Promise<void> {
    const source = this.selectedSource();
    if (!this.active(generation) || !source || this.loadingTasks) return;
    if (more && (!this.cursor || this.pages >= 10)) return;
    const cursor = more ? this.cursor : null; this.loadingTasks = true; this.draw();
    try {
      const result = await this.context.services.tasks!.list({ ...source, state: 'ready', cursor, limit: 25 }, this.controller?.signal);
      if (!this.active(generation) || !this.selectedSource() || sourceKey(this.selectedSource()!) !== sourceKey(source)) return;
      if (result?.status !== 'available' || !Array.isArray(result.value?.items) || sourceKey(result.value.selection) !== sourceKey(source)) {
        throw new Error(`Tasks unavailable${result?.status === 'unavailable' ? `: ${result.reason}` : ''}.`);
      }
      const items = result.value.items.filter(task => task?.repo === source.repo && task.ref?.sourceId === source.sourceId && typeof task.ref.externalId === 'string'
        && typeof task.displayKey === 'string' && typeof task.title === 'string' && task.state === 'ready');
      const keys = new Set(more ? this.tasks.map(task => refKey(task.ref)) : []);
      for (const task of items) { if (keys.has(refKey(task.ref))) throw new Error('Task pagination changed. Refresh before selecting more tasks.'); keys.add(refKey(task.ref)); }
      const next = result.value.nextCursor;
      if (next !== null && (typeof next !== 'string' || !next || this.cursors.has(next))) throw new Error('Task pagination did not advance. Refresh to retry.');
      if (next) this.cursors.add(next);
      this.tasks = more ? [...this.tasks, ...items] : items; this.cursor = next; this.pages += 1; this.sourceError = '';
    } catch (error) { if (this.active(generation)) this.sourceError = error instanceof Error ? error.message : 'Tasks could not be read.'; }
    finally { if (this.active(generation)) { this.loadingTasks = false; this.draw(); } }
  }
  private async launch(): Promise<void> {
    const repo = this.repo();
    if (!this.active() || this.busy || this.lookupBusy || !repo || !this.pendingReady || this.unsupported || this.pending.some(entry => entry.command.repo === repo)) return;
    const generation = this.generation; const draft = this.draft(); let input: RunCommandInputV1;
    try { input = launchInput(repo, draft); } catch (error) { this.error = error instanceof Error ? error.message : 'Invalid launch.'; this.draw(); return; }
    this.busy = true; this.error = ''; this.draw();
    try {
      if (!await this.save()) return;
      if (!this.active(generation)) return;
      if (draft.mode === 'source') {
        const source = this.selectedSource(); if (!source || !draft.ref) throw new Error('The saved source selection changed. Choose its current source before launching.');
        const result = await this.context.services.tasks!.load({ ...source, ref: draft.ref }, this.controller?.signal);
        if (!this.active(generation)) return;
        if (result?.status !== 'available' || !result.value?.task || sourceKey(result.value.selection) !== sourceKey(source)
          || refKey(result.value.task.ref) !== refKey(draft.ref) || result.value.task.repo !== repo || result.value.task.state !== 'ready') {
          throw new Error('The selected task is no longer ready in this galleon. Refresh before launching.');
        }
      }
      await this.deliver(input, generation);
    } catch (error) { if (this.active(generation)) this.error = error instanceof Error ? error.message : 'Launch outcome is unconfirmed. Check the saved request.'; }
    finally { if (this.active(generation)) { this.busy = false; this.draw(); } }
  }
  private async lookupTask(): Promise<void> {
    const lookup = this.context.services.tasks?.lookup; const source = this.selectedSource(); const draft = this.draft();
    const displayKey = draft.lookupKey.trim(); const generation = this.generation;
    if (!this.active() || this.lookupBusy || this.busy || !lookup || !source) return;
    if (!displayKey || displayKey.length > 512 || /[\x00-\x1f\x7f]/.test(displayKey)) { this.sourceError = 'Enter a task key of at most 512 characters.'; this.draw(); return; }
    this.lookupBusy = true; this.sourceError = ''; this.draw();
    try {
      const result = await lookup({ version: 1, sourceId: source.sourceId, instanceId: source.instanceId,
        instanceRevision: source.instanceRevision, repo: source.repo, displayKey }, this.controller?.signal);
      if (!this.active(generation) || this.draft() !== draft || draft.lookupKey.trim() !== displayKey || sourceKey(this.selectedSource()) !== sourceKey(source)) return;
      if (result?.status !== 'available') throw new Error(`Task lookup unavailable${result?.status === 'unavailable' ? `: ${result.reason}` : ''}.`);
      if (!result.value) throw new Error('Task key not found in the selected source and galleon.');
      const item = result.value; const task = item.task;
      if (!task) throw new Error('The task disappeared before it could be loaded.');
      if (sourceKey(item.selection) !== sourceKey(source) || refKey(item.ref) !== refKey(task.ref) || task.ref?.sourceId !== source.sourceId || task.repo !== source.repo) {
        throw new Error('Task lookup returned a different source or galleon.');
      }
      if (task.state !== 'ready') throw new Error('The task is not ready for a new run.');
      draft.ref = { ...item.ref }; this.tasks = [task, ...this.tasks.filter(value => refKey(value.ref) !== refKey(task.ref))].slice(0, 250); this.change();
    } catch (error) { if (this.active(generation) && draft.lookupKey.trim() === displayKey) this.sourceError = error instanceof Error ? error.message : 'Task lookup failed.'; }
    finally { if (this.active(generation)) { this.lookupBusy = false; this.draw(); } }
  }
  private async deliver(input: RunCommandInputV1, generation: number): Promise<void> {
    try {
      const result = await this.context.services.runCommands!.submit(input, this.controller?.signal);
      if (!this.active(generation)) return;
      this.error = result?.status === 'available' ? '' : 'Launch outcome is unconfirmed. Check or retry delivery of the saved request.';
    } catch { if (this.active(generation)) this.error = 'Launch outcome is unconfirmed. Check the saved request before trying again.'; }
    finally { if (this.active(generation)) await this.restorePending(generation); }
  }
  private async requestAction(entry: RunCommandPendingV1, action: 'check' | 'retry' | 'dismiss'): Promise<void> {
    if (!this.active() || this.busy) return;
    const generation = this.generation; this.busy = true; this.error = ''; this.draw();
    try {
      if (action === 'dismiss') {
        if (!entry.receipt || !['accepted', 'rejected'].includes(entry.receipt.status) || !await this.save() || !this.active(generation)) return;
        await this.context.services.runCommands!.acknowledge({ repo: entry.command.repo, requestId: entry.command.requestId });
      } else if (action === 'retry') {
        if (entry.receipt && entry.receipt.status !== 'pending') return;
        const service = this.context.services.runCommands!;
        if (!service.retry) throw new Error('Original request retry is unavailable.');
        const result = await service.retry({ repo: entry.command.repo, requestId: entry.command.requestId }, this.controller?.signal);
        if (this.active(generation) && result?.status !== 'available') this.error = 'Launch outcome is unconfirmed. Check the original request before trying again.';
      } else {
        const result = await this.context.services.runCommands!.receipt({ repo: entry.command.repo, requestId: entry.command.requestId }, this.controller?.signal);
        if (this.active(generation) && (result?.status !== 'available' || !result.value)) this.error = 'No recorded receipt is available. The saved request remains protected; Retry delivery reuses its request ID.';
      }
      if (this.active(generation)) await this.restorePending(generation);
    } catch { if (this.active(generation)) this.error = 'The saved request could not be updated. Its identity is kept.'; }
    finally { if (this.active(generation)) { this.busy = false; this.draw(); } }
  }
  private button(text: string, callback: () => void, disabled = false): HTMLButtonElement {
    const button = node('button', text); button.type = 'button'; button.disabled = disabled; button.addEventListener('click', callback); return button;
  }
  private link(text: string, href: string): HTMLAnchorElement {
    const link = node('a', text); link.href = href;
    link.addEventListener('click', event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); this.context.navigate(href); } }); return link;
  }
  private field(parent: HTMLElement, label: string, value: string, change: (value: string) => void, multiline = false): void {
    const wrapper = node('label', label); const control = multiline ? node('textarea') : node('input');
    control.value = value; control.setAttribute('aria-label', label); control.disabled = this.busy || !this.active();
    control.addEventListener('input', () => { change(control.value); this.change(); }); wrapper.append(control); parent.append(wrapper);
  }
  private select(parent: HTMLElement, label: string, options: readonly { value: string; label: string; disabled?: boolean }[], value: string, change: (value: string) => void): void {
    const wrapper = node('label', label); const select = node('select'); select.setAttribute('aria-label', label); select.disabled = this.busy || !this.active();
    for (const option of options) { const element = node('option', option.label); element.value = option.value; element.disabled = option.disabled ?? false; select.append(element); }
    select.value = value; select.addEventListener('change', () => change(select.value)); wrapper.append(select); parent.append(wrapper);
  }
  private draw(): void {
    if (this.disposed) return;
    const focused = this.container.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focusLabel = focused?.getAttribute('aria-label');
    const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
      ? { start: focused.selectionStart, end: focused.selectionEnd } : null;
    const root = node('section'); root.className = 'plugin-newrun'; root.append(node('style', styles));
    const header = node('header'); header.append(node('h2', this.state.pirateMode ? 'New voyage' : 'New run'), this.button('Refresh', () => { void this.refresh(); }, this.busy || !this.active())); root.append(header);
    for (const text of [this.error, this.sourceError, this.unsupported ? 'Saved drafts use an unsupported format. Restore a compatible panel to edit them.' : '']) {
      if (text) { const error = node('p', text); error.setAttribute('role', 'alert'); root.append(error); }
    }
    const saving = node('p', this.saveMessage); saving.className = 'newrun-save-message'; saving.setAttribute('role', 'alert'); root.append(saving);
    const repo = this.repo(); const draft = this.draft();
    const linked = this.linkedTicket();
    if (linked) {
      const prompt = node('section'); prompt.className = 'newrun-linked-task'; prompt.setAttribute('role', 'status');
      prompt.append(node('p', `Linked task: ${linked}. Choose its source to resolve the task key.`));
      prompt.append(this.button('Choose source for linked task', () => {
        draft.mode = 'source'; draft.lookupKey = linked; draft.source = null; draft.ref = null;
        this.change(); this.suspend(); this.draw(); void this.refresh();
      }, !repo || this.busy || !this.active() || this.unsupported)); root.append(prompt);
    }
    if (this.state.repo === null) {
      const choices = [{ value: '', label: 'Choose a galleon' }, ...this.galleons.map(repo => ({ value: repo, label: repo }))];
      if (repo && !this.galleons.includes(repo)) choices.push({ value: repo, label: `${repo} (unavailable)` });
      this.select(root, 'Galleon', choices, repo ?? '', value => { this.drafts.selectedRepo = value || null; this.change(); this.suspend(); this.draw(); void this.refresh(); });
    } else root.append(node('p', `Galleon: ${this.state.repo}`));
    if (repo && !this.unsupported) {
      const form = node('form'); form.addEventListener('submit', event => { event.preventDefault(); void this.launch(); });
      this.select(form, 'Launch mode', [{ value: 'freeform', label: 'Freeform task' }, { value: 'source', label: 'Source task' }, { value: 'review', label: 'Review PR' }, { value: 'rerun', label: 'Update PR' }], draft.mode, value => {
        draft.mode = value as Mode; this.change(); this.draw(); if (draft.mode === 'source') void this.loadTasks(this.generation);
      });
      if (draft.mode === 'freeform') this.field(form, 'Task instructions', draft.task, value => { draft.task = value; }, true);
      else if (draft.mode === 'source') {
        const sources = this.sources.filter(source => source.repo === repo);
        const selected = draft.source ? sourceKey(draft.source) : '';
        const choices = [{ value: '', label: 'Choose a source', disabled: false }, ...sources.map(source => ({ value: sourceKey(source), label: `${source.label}${source.availability === 'available' ? '' : ` (${source.availability})`}`, disabled: source.availability !== 'available' }))];
        if (selected && !sources.some(source => sourceKey(source) === selected)) choices.push({ value: selected, label: 'Saved source unavailable or changed', disabled: true });
        this.select(form, 'Task source', choices, selected, value => {
          const source = sources.find(source => sourceKey(source) === value);
          draft.source = source ? { version: 1, sourceId: source.sourceId, instanceId: source.instanceId, instanceRevision: source.instanceRevision, repo } : null;
          draft.ref = null; this.tasks = []; this.cursor = null; this.pages = 0; this.cursors.clear(); this.change(); this.suspend(); this.draw(); void this.refresh();
        });
        if (typeof this.context.services.tasks?.lookup === 'function') {
          this.field(form, 'Task key', draft.lookupKey, value => {
            draft.lookupKey = value; draft.ref = null;
            const selected = this.container.querySelector<HTMLSelectElement>('select[aria-label="Task"]'); if (selected) selected.value = '';
          });
          form.append(this.button(this.lookupBusy ? 'Looking up task…' : 'Find task', () => { void this.lookupTask(); }, this.lookupBusy || this.busy || !this.selectedSource() || !this.active()));
        }
        const tasks = [{ value: '', label: this.loadingTasks ? 'Loading tasks…' : 'Choose a ready task' }, ...this.tasks.map(task => ({ value: refKey(task.ref), label: `${task.displayKey}: ${task.title}` }))];
        const chosen = draft.ref ? refKey(draft.ref) : '';
        if (chosen && !this.tasks.some(task => refKey(task.ref) === chosen)) tasks.push({ value: chosen, label: `Saved task ${draft.ref?.externalId}; verified again at launch` });
        this.select(form, 'Task', tasks, chosen, value => { const task = this.tasks.find(task => refKey(task.ref) === value); draft.ref = task ? { ...task.ref } : null; this.change(); });
        if (this.cursor) form.append(this.button(this.pages >= 10 ? 'Task page limit reached' : 'Load more tasks', () => { void this.loadTasks(this.generation, true); }, this.loadingTasks || this.pages >= 10 || this.busy));
        form.append(node('small', typeof this.context.services.tasks?.lookup === 'function'
          ? 'Browse ready tasks or find a key within the selected source and galleon.' : 'Choose a task returned by its source. Task-key lookup is unavailable from this host.'));
      } else {
        this.field(form, 'PR number', draft.prNumber, value => { draft.prNumber = value; });
        if (draft.mode === 'rerun') this.field(form, 'PR feedback', draft.feedback, value => { draft.feedback = value; }, true);
      }
      this.field(form, 'Model (optional)', draft.model, value => { draft.model = value; });
      this.select(form, 'Effort', efforts.map(value => ({ value, label: value || 'Default effort' })), draft.effort, value => { draft.effort = value; this.change(); });
      const actions = node('div'); actions.className = 'newrun-actions';
      actions.append(this.button(this.state.pirateMode ? 'Weigh anchor' : 'Start run', () => { void this.launch(); }, this.busy || this.lookupBusy || !this.active() || !this.pendingReady
        || this.pending.some(entry => entry.command.repo === repo) || this.state.repo === null && !this.galleons.includes(repo)),
      this.button('Save draft', () => { void this.save(); }, this.busy || !this.active())); form.append(actions); root.append(form);
    }
    if (this.pending.length) {
      const section = node('section'); section.append(node('h3', 'Saved launch requests'));
      if (this.pending.length > 100) section.append(node('p', `Showing 100 of ${this.pending.length} saved requests. Dismiss handled requests to reveal the remaining ${this.pending.length - 100}.`));
      for (const entry of this.pending.slice(0, 100)) {
        if (entry.command.action !== 'launch') continue;
        const row = node('section'); const receipt = entry.receipt;
        row.append(node('p', `${entry.command.repo} · ${entry.command.launch.mode} · ${receipt?.status ?? 'delivery unconfirmed'}`));
        if (receipt?.message) row.append(node('p', receipt.message));
        if (receipt?.status === 'accepted' && receipt.runId) row.append(this.link(this.state.pirateMode ? 'Open voyage' : 'Open run', `/runs?${new URLSearchParams({ repo: entry.command.repo, run: receipt.runId })}`));
        if (receipt && ['accepted', 'rejected'].includes(receipt.status)) row.append(this.button('Dismiss request', () => { void this.requestAction(entry, 'dismiss'); }, this.busy || !this.active()));
        else {
          row.append(this.button('Check request', () => { void this.requestAction(entry, 'check'); }, this.busy || !this.active()));
          if (!receipt || receipt.status === 'pending') row.append(this.button('Retry delivery', () => { void this.requestAction(entry, 'retry'); }, this.busy || !this.active() || !this.context.services.runCommands?.retry));
          if (receipt?.status === 'recovery-required') row.append(this.link('Recovery', `/recovery?${new URLSearchParams({ repo: entry.command.repo })}`));
        }
        section.append(row);
      }
      root.append(section);
    }
    this.container.replaceChildren(root);
    if (focusLabel) {
      const replacement = Array.from(root.querySelectorAll<HTMLElement>('[aria-label]')).find(value => value.getAttribute('aria-label') === focusLabel);
      replacement?.focus({ preventScroll: true });
      if (selection?.start !== null && selection?.start !== undefined && selection.end !== null
        && (replacement instanceof HTMLInputElement || replacement instanceof HTMLTextAreaElement)) replacement.setSelectionRange(selection.start, selection.end);
    }
  }
}
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.tasks?.version !== 1 || context.services.runCommands?.version !== 1) throw new Error('New Run requires version 1 task reads and run commands.');
  return new NewRunPanel(container, context);
} };
export default panel;
