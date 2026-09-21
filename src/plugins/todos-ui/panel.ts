import type { PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, SourceCommandInputV1, SourceCommandPendingV1,
  RunCommandInputV1, RunCommandPendingV1, TaskEditEnvelopeV1, TaskEditListItemV1, TaskEditSourceV1, TaskReadSelectionV1, WorkRefV1 } from '@helmsman/plugin-sdk';
import type { LegacyTodoCommandReceipt, TodoLegacyPendingV1 } from '@helmsman/plugin-sdk';
import { consumeResult, emptyState, followHeader, priorities, readState, sameSelection, sameSubmission, sameValues, saveValue, states, values, type Draft, type SavedState, type Values } from './state.js';
import { styles } from './styles.js';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; }
const sourceKey = (selection: TaskReadSelectionV1) => JSON.stringify([selection.repo, selection.sourceId, selection.instanceId, selection.instanceRevision]);
const sameRef = (left: WorkRefV1 | undefined, right: WorkRefV1 | undefined) => !!left && !!right && left.sourceId === right.sourceId && left.externalId === right.externalId;
const labels: Record<Values['state'], string> = { todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done', blocked: 'Blocked' };
const LOCAL_TASK_EDITOR_V1 = { id: 'helmsman/local-task-editor', version: 1 as const };
interface TaskGroup { source: TaskEditSourceV1; items: TaskEditListItemV1[]; cursor: string | null; cursors: Set<string>; total: number | null; status: 'waiting' | 'ready' | 'unavailable'; error: string | null; }
const loadedTaskLimit = 1000;

class TodosPanel implements PluginPanelInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private state: PluginPanelState;
  private saved: SavedState;
  private unsupported: boolean;
  private disposed = false;
  private generation = 0;
  private editGeneration = 0;
  private sources: TaskEditSourceV1[] = [];
  private groups: TaskGroup[] = [];
  private listGeneration = 0;
  private envelope: TaskEditEnvelopeV1 | null = null;
  private pending: SourceCommandPendingV1[] = [];
  private pendingReady = false;
  private runPending: RunCommandPendingV1[] = [];
  private runPendingReady = false;
  private legacyPending: readonly TodoLegacyPendingV1[] = [];
  private legacyReceipts = new Map<string, LegacyTodoCommandReceipt>();
  private legacyError = '';
  private legacyNeedsAll = false;
  private busy = false;
  private loading = false;
  private error = '';
  private saveError = '';
  private saveRevision = 0;
  private dirty = false;
  private snapshots = new Set<string>();
  private saveQueue: Promise<boolean> = Promise.resolve(true);
  private confirmedDelete: string | null = null;
  private discardDraftKey: string | null = null;
  private editorSignature = '';
  private readonly tools = node('div');
  private readonly list = node('div');
  private readonly editor = node('div');
  private readonly requests = node('div');
  private readonly message = node('p');
  private readonly saveMessage = node('p');
  private readonly search = node('input');
  private readonly filter = node('select');
  private readonly rows = node('div');
  private readonly pagination = node('div');
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state;
    const parsed = readState(context.state.savedState); this.unsupported = !parsed; this.saved = parsed ?? emptyState();
    const root = node('div'); root.className = 'plugin-todos'; this.tools.className = 'todo-tools'; this.list.className = 'todo-list'; this.editor.className = 'todo-editor';
    this.message.setAttribute('role', 'alert'); this.saveMessage.setAttribute('role', 'status');
    this.search.type = 'search'; this.search.maxLength = 500; this.search.placeholder = 'Search Todos'; this.search.setAttribute('aria-label', 'Search Todos');
    this.search.addEventListener('input', () => {
      this.saved.filters.search = this.search.value; this.change();
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.searchTimer = null; void this.reloadList(); }, 200);
    });
    this.filter.setAttribute('aria-label', 'Todo state filter');
    for (const [value, label] of [['', 'All states'], ...states.map(state => [state, labels[state]])]) { const option = node('option', label); option.value = value!; this.filter.append(option); }
    this.filter.addEventListener('change', () => { this.saved.filters.state = (this.filter.value || null) as Values['state'] | null; this.change(); void this.reloadList(); });
    this.list.append(this.search, this.filter, this.rows, this.pagination);
    const columns = node('div'); columns.className = 'todo-columns'; columns.append(this.list, this.editor);
    root.append(node('style', styles), this.tools, this.message, this.saveMessage, columns, this.requests); container.replaceChildren(root);
    context.onDispose(this.dispose); context.signal.addEventListener('abort', this.dispose, { once: true });
    this.state.activity.signal.addEventListener('abort', this.suspend, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private draft() { return this.saved.drafts.find(draft => draft.key === this.saved.activeDraftKey) ?? null; }
  private selected() {
    if (this.saved.selectedSource) return this.sources.find(source => sameSelection(source.selection, this.saved.selectedSource)) ?? null;
    const available = this.sources.filter(source => source.availability === 'available'); return available.length === 1 ? available[0]! : null;
  }
  private suspend = () => { ++this.generation; ++this.editGeneration; this.pendingReady = false; this.runPendingReady = false; this.loading = false; this.busy = false; this.envelope = null; };
  dispose = () => {
    if (this.disposed) return; this.disposed = true; this.suspend();
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.state.activity.signal.removeEventListener('abort', this.suspend); this.context.signal.removeEventListener('abort', this.dispose); this.container.replaceChildren();
  };
  update(next: PluginPanelState) {
    if (this.disposed) return;
    const changed = next.activity.epoch !== this.state.activity.epoch || next.repo !== this.state.repo || next.visible !== this.state.visible;
    const allScope = next.activity.repo === null && this.state.activity.repo !== null;
    const savedChanged = JSON.stringify(next.savedState) !== JSON.stringify(this.state.savedState);
    this.state.activity.signal.removeEventListener('abort', this.suspend); this.state = next;
    next.activity.signal.addEventListener('abort', this.suspend, { once: true });
    if (savedChanged && !this.dirty && !this.snapshots.has(JSON.stringify(next.savedState))) {
      const parsed = readState(next.savedState); this.unsupported = !parsed;
      if (parsed) { this.saved = parsed; this.envelope = null; this.editorSignature = ''; }
    }
    if (allScope && this.saved.selectedSource) { this.saved.selectedSource = null; this.change(); }
    if (changed) { this.suspend(); this.sources = []; this.groups = []; this.pending = []; this.runPending = []; this.legacyPending = []; this.legacyReceipts.clear(); }
    this.draw(); if (changed && this.active()) void this.refresh();
  }
  private change() { this.dirty = true; ++this.saveRevision; void this.save(); }
  private save(): Promise<boolean> {
    if (this.unsupported || this.disposed) return Promise.resolve(false);
    let snapshot;
    try { snapshot = saveValue(this.saved); } catch (error) { this.saveError = error instanceof Error ? error.message : 'Drafts could not be saved.'; this.saveMessage.textContent = this.saveError; return Promise.resolve(false); }
    const revision = this.saveRevision; const text = JSON.stringify(snapshot); this.snapshots.add(text);
    if (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.values().next().value!);
    const pending = this.saveQueue.catch(() => false).then(async () => {
      if (this.disposed || revision !== this.saveRevision) return false;
      try { await this.context.saveState(snapshot); if (revision === this.saveRevision) { this.dirty = false; this.saveError = ''; } return true; }
      catch { this.saveError = 'Drafts could not be saved. Your text is kept. Retry saving before submitting.'; return false; }
      finally { this.saveMessage.textContent = this.saveError; }
    }); this.saveQueue = pending; return pending;
  }
  async refresh() {
    if (!this.active() || this.unsupported || this.busy) return;
    const generation = ++this.generation; this.loading = true; this.error = ''; this.draw();
    await Promise.all([this.discover(generation), this.restorePending(generation), this.restoreRuns(generation), this.restoreLegacy(generation)]);
    if (!this.active(generation)) return;
    await this.readList(generation, false);
    const draft = this.draft();
    if (draft && this.inScope(draft.selection.repo)) await this.readEnvelope(draft, false);
    if (this.active(generation)) { this.loading = false; this.draw(); }
  }
  private inScope(repo: string) { return this.state.activity.repo === null || this.state.activity.repo === repo; }
  private async discover(generation: number) {
    try {
      const result = await this.context.services.taskEdit!.discover(this.state.activity.signal);
      if (!this.active(generation)) return;
      if (result?.status !== 'available') throw new Error('Task sources are unavailable. Your drafts are kept.');
      this.sources = result.value.sources.filter(source => source?.editors?.some(editor => editor.id === LOCAL_TASK_EDITOR_V1.id && editor.version === 1));
      if (this.saved.selectedSource && !this.selected()) {
        const previous = this.saved.selectedSource;
        const next = this.sources.find(source => source.availability === 'available' && (!previous || source.selection.sourceId === previous.sourceId && source.selection.instanceId === previous.instanceId && source.selection.instanceRevision === previous.instanceRevision));
        if (next) { this.saved.selectedSource = next.selection; this.change(); }
      }
      const draft = this.draft(); const selected = this.selected();
      if (draft && selected && !draft.target && draft.destinationPolicy === 'inherit' && this.state.activity.repo === selected.selection.repo && !sameSelection(draft.selection, selected.selection)) {
        const envelope = await this.context.services.taskEdit!.create({ selection: selected.selection, editor: LOCAL_TASK_EDITOR_V1 }, this.state.activity.signal);
        if (!this.active(generation) || this.draft()?.key !== draft.key) return;
        if (envelope?.status === 'available') {
          const next = followHeader(draft, selected.selection, envelope.value.sourceRevision);
          this.saved.drafts = this.saved.drafts.map(value => value.key === draft.key ? next : value); this.envelope = envelope.value; this.change();
        }
      }
    } catch (error) { if (this.active(generation)) this.error = error instanceof Error ? error.message : 'Task sources are unavailable.'; }
  }
  private async restorePending(generation: number) {
    this.pendingReady = false;
    try {
      const pending = await this.context.services.sourceCommands!.pending();
      if (!this.active(generation)) return;
      this.pending = pending.filter(entry => entry?.command?.editor?.id === LOCAL_TASK_EDITOR_V1.id && entry.command.editor.version === 1);
      this.pendingReady = true;
    } catch { if (this.active(generation)) this.error = 'Saved requests are unavailable. Refresh before making changes.'; }
  }
  private async restoreRuns(generation: number) {
    this.runPendingReady = false; const service = this.context.services.runCommands; if (!service) return;
    try {
      const pending = await service.pending(); if (!this.active(generation)) return;
      this.runPending = pending.filter(entry => entry?.command?.action === 'launch' && entry.command.launch?.mode === 'source'); this.runPendingReady = true;
    } catch { if (this.active(generation)) this.error = 'Saved launch requests are unavailable. Refresh before launching.'; }
  }
  private async restoreLegacy(generation: number) {
    const service = this.context.services.todoLegacyRecovery; if (!service) return;
    try {
      const result = await service.pending(this.state.activity.signal); if (!this.active(generation)) return;
      this.legacyNeedsAll = result?.status === 'unavailable' && result.reason === 'all-galleons-required';
      if (result?.status !== 'available') {
        this.legacyPending = []; this.legacyError = this.legacyNeedsAll ? 'Older Todo requests require an explicit All scope to inspect their original outcomes.' : 'Older Todo requests could not be read. Their original identities are kept.';
      } else { this.legacyPending = result.value; this.legacyError = ''; }
    } catch { if (this.active(generation)) this.legacyError = 'Older Todo requests could not be read. Refresh to retry.'; }
  }
  private async legacyRequest(requestId: string, acknowledge: boolean) {
    const service = this.context.services.todoLegacyRecovery;
    if (!service || !this.active() || this.busy) return;
    const generation = this.generation; this.busy = true; this.legacyError = ''; this.draw();
    try {
      if (acknowledge) {
        const receipt = this.legacyReceipts.get(requestId);
        if (!receipt || !['succeeded', 'rejected'].includes(receipt.status) || !await this.save() || !this.active(generation)) return;
        const result = await service.acknowledge(requestId, this.state.activity.signal);
        if (result?.status !== 'available') throw new Error('The original request could not be dismissed. Check it again.');
        this.legacyReceipts.delete(requestId); await this.restoreLegacy(generation);
      } else {
        const result = await service.check(requestId, this.state.activity.signal);
        if (!this.active(generation)) return;
        if (result?.status !== 'available') throw new Error('The original receipt is unavailable. Keep this request for recovery.');
        this.legacyReceipts.set(requestId, result.value); this.envelope = null;
      }
    } catch (error) { if (this.active(generation)) this.legacyError = error instanceof Error ? error.message : 'The original request is still protected.'; }
    finally { if (this.active(generation)) { this.busy = false; this.draw(); } }
  }
  private taskPending(draft: Draft) {
    return !!draft.submitted || this.pending.some(entry => sameSelection(entry.command.selection, draft.selection) && sameRef(entry.command.target?.ref, draft.target?.ref))
      || this.runPending.some(entry => entry.command.action === 'launch' && entry.command.launch.mode === 'source' && entry.command.repo === draft.selection.repo
        && entry.command.launch.sourceInstanceId === draft.selection.instanceId && sameRef(entry.command.launch.workRef, draft.target?.ref));
  }
  private async readList(generation: number, more: boolean) {
    const selected = this.saved.selectedSource; const listGeneration = ++this.listGeneration;
    const filter = this.saved.filters.state; const search = this.saved.filters.search;
    if (!more) this.groups = this.sources.filter(source => !selected || sameSelection(source.selection, selected)).map(source => ({ source, items: [], cursor: null, cursors: new Set(), total: null,
      status: source.availability === 'available' ? 'waiting' : 'unavailable', error: source.availability === 'available' ? null : source.availability }));
    const remaining = loadedTaskLimit - this.groups.reduce((count, group) => count + group.items.length, 0);
    const candidates = [...this.groups.filter(group => group.status === 'waiting'), ...this.groups.filter(group => group.status === 'ready' && group.cursor !== null)].slice(0, Math.min(8, Math.ceil(remaining / 25)));
    const queue = candidates.map((group, index) => ({ group, limit: Math.min(25, remaining - index * 25) }));
    const current = () => this.active(generation) && listGeneration === this.listGeneration && sameSelection(selected, this.saved.selectedSource)
      && filter === this.saved.filters.state && search === this.saved.filters.search;
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length && current()) {
        const next = queue.shift(); if (!next) return; const { group, limit } = next;
        try {
          const result = await this.context.services.taskEdit!.list({ selection: group.source.selection, editor: LOCAL_TASK_EDITOR_V1,
            filter: { state: filter, search }, cursor: group.status === 'waiting' ? null : group.cursor, limit }, this.state.activity.signal);
          if (!current()) return;
          if (result?.status !== 'available') throw new Error(result?.status === 'unavailable' ? result.reason : 'Invalid source response');
          if (result.value.nextCursor && group.cursors.has(result.value.nextCursor)) throw new Error('Pagination did not advance');
          if (result.value.nextCursor) group.cursors.add(result.value.nextCursor);
          const items = [...group.items, ...result.value.items];
          group.items = items.filter((value, index) => items.findIndex(item => sameRef(item.ref, value.ref)) === index);
          group.cursor = result.value.nextCursor; group.total = result.value.total; group.status = 'ready'; group.error = null;
        } catch (error) { if (current()) { group.status = 'unavailable'; group.total = null; group.error = error instanceof Error ? error.message : 'Source unavailable'; } }
      }
    }));
  }
  private listRows() {
    return this.groups.flatMap(group => group.items.map(task => ({ task, selection: group.source.selection }))).sort((left, right) => {
      const priority = (left.task.priority ?? Number.MAX_SAFE_INTEGER) - (right.task.priority ?? Number.MAX_SAFE_INTEGER); if (priority) return priority;
      const leftAge = left.task.createdAt === null ? Number.POSITIVE_INFINITY : Date.parse(left.task.createdAt);
      const rightAge = right.task.createdAt === null ? Number.POSITIVE_INFINITY : Date.parse(right.task.createdAt);
      if (leftAge !== rightAge) return leftAge < rightAge ? -1 : 1;
      return `${sourceKey(left.selection)}:${left.task.ref.externalId}`.localeCompare(`${sourceKey(right.selection)}:${right.task.ref.externalId}`);
    });
  }
  private moreTasks() { return this.groups.some(group => group.status === 'waiting' || group.status === 'ready' && group.cursor !== null); }
  private async reloadList() {
    if (!this.active() || this.unsupported) return;
    const generation = this.generation; this.loading = true; this.draw();
    await this.readList(generation, false);
    if (this.active(generation)) { this.loading = false; this.draw(); }
  }
  private async open(ref: WorkRefV1 | null, origin?: TaskReadSelectionV1) {
    const selection = origin ?? this.selected()?.selection;
    if (!selection || !this.active() || this.busy || this.unsupported) return;
    const existing = ref ? this.saved.drafts.find(draft => sameSelection(draft.selection, selection) && sameRef(draft.target?.ref, ref)) : null;
    if (existing) { this.saved.activeDraftKey = existing.key; this.envelope = null; this.confirmedDelete = null; this.change(); this.draw(); await this.readEnvelope(existing, false); return; }
    const generation = this.generation; const editGeneration = ++this.editGeneration; this.busy = true; this.error = ''; this.draw();
    try {
      const query = { selection, editor: LOCAL_TASK_EDITOR_V1 };
      const response = ref ? await this.context.services.taskEdit!.load({ ...query, ref }, this.state.activity.signal) : await this.context.services.taskEdit!.create(query, this.state.activity.signal);
      if (!this.active(generation) || editGeneration !== this.editGeneration) return;
      if (response?.status !== 'available' || !response.value) throw new Error('The requested Todo is unavailable.');
      const envelope = response.value; const fields = values(envelope.value); if (!fields) throw new Error('The source returned an unsupported Todo document.');
      const draft: Draft = { key: crypto.randomUUID(), selection: envelope.selection, sourceRevision: envelope.sourceRevision,
        target: envelope.target, destinationPolicy: ref ? 'fixed' : 'inherit', values: fields, baseline: { ...fields }, submitted: null };
      this.saved.drafts.push(draft); this.saved.activeDraftKey = draft.key; this.envelope = envelope; this.confirmedDelete = null; this.change();
    } catch (error) { if (this.active(generation)) this.error = error instanceof Error ? error.message : 'Todo editor is unavailable.'; }
    finally { if (this.active(generation) && editGeneration === this.editGeneration) { this.busy = false; this.draw(); } }
  }
  private async readEnvelope(draft: Draft, reconcile: boolean) {
    const generation = this.generation; const editGeneration = ++this.editGeneration;
    try {
      const query = { selection: draft.selection, editor: LOCAL_TASK_EDITOR_V1 };
      const response = draft.target ? await this.context.services.taskEdit!.load({ ...query, ref: draft.target.ref }, this.state.activity.signal) : await this.context.services.taskEdit!.create(query, this.state.activity.signal);
      if (!this.active(generation) || editGeneration !== this.editGeneration || this.draft()?.key !== draft.key) return;
      if (response?.status !== 'available' || !response.value) { this.envelope = null; throw new Error('This draft’s source or Todo is unavailable. The draft is kept.'); }
      const envelope = response.value; this.envelope = envelope;
      if (reconcile) {
        const fields = values(envelope.value); if (!fields) throw new Error('Unsupported Todo document.');
        const merged = { ...draft.values };
        for (const key of Object.keys(fields) as (keyof Values)[]) if (draft.values[key] === draft.baseline[key]) Object.assign(merged, { [key]: fields[key] });
        draft.values = merged;
        draft.sourceRevision = envelope.sourceRevision; draft.target = envelope.target; draft.baseline = fields; this.change();
        this.error = '';
      }
    } catch (error) { if (this.active(generation)) this.error = error instanceof Error ? error.message : 'Todo editor is unavailable.'; }
    finally { if (this.active(generation)) this.draw(); }
  }
  private currentEnvelope(draft: Draft): TaskEditEnvelopeV1 | null {
    const envelope = this.envelope;
    return envelope && sameSelection(envelope.selection, draft.selection) && envelope.sourceRevision === draft.sourceRevision
      && (draft.target ? sameRef(envelope.target?.ref, draft.target.ref) && envelope.target?.revision === draft.target.revision : envelope.target === null) ? envelope : null;
  }
  private async submit(action: 'create' | 'update' | 'delete') {
    const draft = this.draft(); const envelope = draft && this.currentEnvelope(draft);
    if (!draft || !envelope || !envelope.commands[action]?.available || !this.active() || this.busy || !this.pendingReady || this.taskPending(draft) || !this.inScope(draft.selection.repo)) return;
    if (action === 'delete' && this.confirmedDelete !== draft.key) return;
    if (action === 'create' && draft.destinationPolicy === 'inherit' && this.state.activity.repo === null) { this.error = 'Choose a destination before creating a Todo.'; this.draw(); return; }
    const fields: Values = { ...draft.values, title: draft.values.title.trim(), description: draft.values.description.trim(), acceptanceCriteria: draft.values.acceptanceCriteria.trim() };
    if (action !== 'delete' && (!fields.title || !envelope.destinationRepos.includes(fields.repo) || fields.state === 'in_progress')) { this.error = 'Enter a title and an allowed destination before saving.'; this.draw(); return; }
    if (action === 'create' && fields.repo !== draft.selection.repo) { this.error = 'Select the draft’s destination scope before creating it.'; this.draw(); return; }
    const input: SourceCommandInputV1 = { version: 1, selection: draft.selection, sourceRevision: draft.sourceRevision, editor: LOCAL_TASK_EDITOR_V1, action,
      commandId: envelope.commands[action]!.commandId, target: draft.target ? { ref: draft.target.ref, expectedRevision: draft.target.revision } : null,
      destinationRepo: action === 'delete' ? null : fields.repo, input: action === 'delete' ? {} : { ...fields } };
    const generation = this.generation; this.busy = true; this.error = ''; draft.submitted = input; this.change(); this.draw();
    try {
      if (!await this.save() || !this.active(generation)) return;
      const response = await this.context.services.sourceCommands!.submit(input, this.state.activity.signal);
      if (this.active(generation) && response?.status !== 'available') this.error = 'The outcome is unconfirmed. Check the saved request before making another change.';
    } catch { if (this.active(generation)) this.error = 'The outcome is unconfirmed. Check or retry the saved request.'; }
    finally { if (this.active(generation)) { await this.restorePending(generation); this.busy = false; this.draw(); } }
  }
  private async request(entry: SourceCommandPendingV1, action: 'check' | 'retry' | 'consume') {
    if (!this.active() || this.busy) return;
    const generation = this.generation; this.busy = true; this.error = ''; this.draw();
    const query = { repo: entry.command.selection.repo, requestId: entry.command.requestId };
    try {
      if (action === 'consume') {
        this.saved = consumeResult(this.saved, entry); this.change();
        if (!await this.save() || !this.active(generation)) return;
        await this.context.services.sourceCommands!.acknowledge(query); this.envelope = null; this.confirmedDelete = null;
        this.saved.consumedRequests = this.saved.consumedRequests.filter(id => id !== query.requestId); this.change();
      } else if (action === 'retry') {
        if (entry.receipt && entry.receipt.status !== 'pending') return;
        const { requestId: _requestId, ...input } = entry.command;
        const response = await this.context.services.sourceCommands!.submit(input, this.state.activity.signal);
        if (response?.status !== 'available') throw new Error('The outcome remains unconfirmed. Keep this request.');
      } else {
        const response = await this.context.services.sourceCommands!.receipt(query, this.state.activity.signal);
        if (response?.status !== 'available' || !response.value) throw new Error('No receipt is available yet. The original request is kept.');
      }
    } catch (error) { if (this.active(generation)) this.error = error instanceof Error ? error.message : 'The request is still protected. Retry checking it.'; }
    finally { if (this.active(generation)) { await this.restorePending(generation); this.busy = false; this.draw(); } }
  }
  private button(label: string, action: () => void, disabled = false) { const button = node('button', label); button.type = 'button'; button.disabled = disabled; button.addEventListener('click', action); return button; }
  private link(label: string, repo: string, runId: string) {
    const link = node('a', label); const href = `/runs?${new URLSearchParams({ repo, run: runId })}`; link.href = href;
    link.addEventListener('click', event => { if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); this.context.navigate(href); } }); return link;
  }
  private launchReason(draft: Draft): string | null {
    if (!draft.target) return 'Save this Todo before starting a run.';
    if (!sameValues(draft.values, draft.baseline)) return 'Save your changes before starting a run.';
    const envelope = this.currentEnvelope(draft); const persisted = values(envelope?.value);
    if (!envelope || !persisted) return 'Reconcile the current source and task revision before starting a run.';
    if (!envelope.commands.update?.available) return envelope.commands.update?.reason ?? 'This Todo cannot start a run.';
    if (persisted.state !== 'todo') return 'Set the state to To do before starting a run.';
    if (!persisted.description.trim()) return 'Add a description before starting a run.';
    if (this.taskPending(draft)) return 'Resolve the saved request before starting another run.';
    if (!this.runPendingReady) return 'Saved launch requests are unavailable.';
    return null;
  }
  private updateLaunch() {
    const draft = this.draft(); const button = this.editor.querySelector<HTMLButtonElement>('[data-todo-launch]'); const hint = this.editor.querySelector<HTMLElement>('[data-todo-launch-hint]');
    if (!draft || !button || !hint) return; const reason = this.launchReason(draft); hint.textContent = reason ?? '';
    button.disabled = !!reason || this.busy || !this.active() || !this.inScope(draft.selection.repo);
  }
  private async launch() {
    const draft = this.draft(); const service = this.context.services.runCommands;
    if (!draft?.target || !service || this.busy || !this.active() || !this.inScope(draft.selection.repo) || this.launchReason(draft)) return;
    const generation = this.generation; this.busy = true; this.error = ''; this.draw();
    try {
      if (!await this.save() || !this.active(generation)) return;
      await this.readEnvelope(draft, false); if (!this.active(generation)) return;
      const reason = this.launchReason(draft); if (reason) throw new Error(reason);
      const input: RunCommandInputV1 = { version: 1, action: 'launch', repo: draft.selection.repo,
        launch: { mode: 'source', workRef: draft.target.ref, sourceInstanceId: draft.selection.instanceId, sourceInstanceRevision: draft.selection.instanceRevision } };
      const response = await service.submit(input, this.state.activity.signal);
      if (this.active(generation) && response?.status !== 'available') this.error = 'Launch outcome is unconfirmed. Check its saved request.';
    } catch (error) { if (this.active(generation)) this.error = error instanceof Error ? error.message : 'Launch outcome is unconfirmed. Check the saved request.'; }
    finally { if (this.active(generation)) { await this.restoreRuns(generation); this.busy = false; this.draw(); } }
  }
  private async runRequest(entry: RunCommandPendingV1, action: 'check' | 'retry' | 'dismiss') {
    const service = this.context.services.runCommands; if (!service || this.busy || !this.active()) return;
    const generation = this.generation; this.busy = true; this.error = ''; this.draw();
    const query = { repo: entry.command.repo, requestId: entry.command.requestId };
    try {
      if (action === 'dismiss') {
        if (!entry.receipt || !['accepted', 'rejected'].includes(entry.receipt.status) || !await this.save() || !this.active(generation)) return;
        await service.acknowledge(query);
      } else if (action === 'retry') {
        if (entry.receipt && entry.receipt.status !== 'pending') return;
        const { requestId: _requestId, ...input } = entry.command; const response = await service.submit(input, this.state.activity.signal);
        if (response?.status !== 'available') throw new Error('Launch outcome is still unconfirmed. Keep the original request.');
      } else {
        const response = await service.receipt(query, this.state.activity.signal);
        if (response?.status !== 'available' || !response.value) throw new Error('No launch receipt is available yet. Its request is kept.');
      }
    } catch (error) { if (this.active(generation)) this.error = error instanceof Error ? error.message : 'Launch request is still protected.'; }
    finally { if (this.active(generation)) { await this.restoreRuns(generation); this.busy = false; this.draw(); } }
  }
  private draw() {
    if (this.disposed) return;
    this.message.textContent = this.unsupported ? 'This saved Todo state uses an unsupported format. It is kept unchanged.' : this.error;
    this.saveMessage.textContent = this.saveError;
    const source = node('select'); source.setAttribute('aria-label', 'Task source'); source.disabled = this.busy || !this.active() || this.unsupported;
    const empty = node('option', 'All task sources'); empty.value = ''; source.append(empty);
    for (const item of this.sources) { const option = node('option', `${item.label} · ${item.selection.repo}${item.availability === 'available' ? '' : ` (${item.availability})`}`); option.value = sourceKey(item.selection); source.append(option); }
    source.value = this.saved.selectedSource ? sourceKey(this.saved.selectedSource) : '';
    source.addEventListener('change', () => { this.saved.selectedSource = this.sources.find(value => sourceKey(value.selection) === source.value)?.selection ?? null; this.change(); void this.refresh(); });
    this.tools.replaceChildren(source, this.button('New Todo', () => { void this.open(null); }, this.busy || this.unsupported || !this.selected() || !this.active()),
      this.button('Refresh Todos', () => { void this.refresh(); }, this.loading || this.busy || !this.active()), this.button('Save drafts', () => { void this.save(); }, this.unsupported));
    this.drawList(); this.drawEditor(); this.updateLaunch(); this.drawRequests();
  }
  private drawList() {
    if (this.search.value !== this.saved.filters.search) this.search.value = this.saved.filters.search;
    this.filter.value = this.saved.filters.state ?? ''; this.search.disabled = this.busy || !this.active(); this.filter.disabled = this.search.disabled;
    this.drawRows(this.rows); this.pagination.replaceChildren();
    if (this.moreTasks()) {
      const limited = this.groups.reduce((count, group) => count + group.items.length, 0) >= loadedTaskLimit;
      this.pagination.append(this.button('Load more Todos', () => { if (!this.loading && !limited) { this.loading = true; const generation = this.generation; void this.readList(generation, true).finally(() => { if (this.active(generation)) { this.loading = false; this.draw(); } }); } }, this.loading || limited));
      if (limited) this.pagination.append(node('p', `Showing at most ${loadedTaskLimit} Todos. Narrow the search or task source to load other results.`));
    }
  }
  private drawRows(rows: HTMLElement) {
    const items = this.listRows(); const knownTotal = this.groups.length > 0 && this.groups.every(group => group.total !== null && group.status === 'ready');
    const total = knownTotal ? this.groups.reduce((count, group) => count + (group.total ?? 0), 0) : null;
    rows.replaceChildren(node('p', `${items.length}${total === null ? '' : ` of ${total}`} matching Todos loaded${this.moreTasks() ? '; more matches available' : ''}.`));
    const waiting = this.groups.filter(group => group.status === 'waiting').length;
    if (waiting) rows.append(node('p', `${waiting} task sources have not been loaded yet.`));
    if (this.moreTasks()) rows.append(node('p', 'Loaded results are ordered by priority, then oldest creation time.'));
    if (items.some(item => item.task.createdAt === null)) rows.append(node('p', 'Some sources do not report creation times. Those tasks follow tasks with known creation times within their priority.'));
    for (const group of this.groups.filter(value => value.status === 'unavailable')) rows.append(node('p', `${group.source.label} · ${group.source.selection.repo}: ${group.error ?? 'unavailable'}. Refresh to retry. Its count is unknown.`));
    if (!this.groups.length && !this.loading) rows.append(node('p', this.saved.selectedSource ? 'The selected task source is unavailable. Your drafts are kept.' : 'No task sources support Todo editing in this scope.'));
    if (!this.selected() && this.sources.some(source => source.availability === 'available')) rows.append(node('p', 'Choose a task source to create a new Todo.'));
    for (const { task, selection } of items) {
      const button = this.button(task.title, () => { void this.open(task.ref, selection); }, this.busy || !this.active()); button.className = 'todo-row';
      button.append(node('small', `${task.displayKey} · ${task.repo} · ${task.priority === null ? 'Unspecified priority' : `P${task.priority}`} · ${task.state === 'ready' ? 'To do' : task.state === 'review' ? 'In review' : task.state.replaceAll('_', ' ')}`)); rows.append(button);
    }
  }
  private drawEditor() {
    const draft = this.draft(); const envelope = draft && this.currentEnvelope(draft);
    const signature = JSON.stringify([draft?.key, draft?.target, draft?.selection, draft?.sourceRevision, !!draft?.submitted,
      envelope?.sourceRevision, envelope?.commands, envelope?.destinationRepos, envelope?.relatedRun, this.busy, this.active(), this.state.activity.repo, this.unsupported, this.confirmedDelete, this.discardDraftKey, this.pendingReady,
      draft && this.taskPending(draft), this.saved.drafts.map(value => value.key)]);
    if (signature === this.editorSignature) return; this.editorSignature = signature;
    const focused = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
    const focus = focused && this.editor.contains(focused) ? { label: focused.getAttribute('aria-label'), start: focused.selectionStart, end: focused.selectionEnd } : null;
    this.editor.replaceChildren();
    const choose = node('select'); choose.setAttribute('aria-label', 'Saved draft'); const blank = node('option', 'Choose a draft'); blank.value = ''; choose.append(blank);
    for (const item of this.saved.drafts) { const option = node('option', `${item.target?.ref.externalId ?? 'New'} · ${item.values.title || 'Untitled'} · ${item.selection.repo}`); option.value = item.key; choose.append(option); }
    choose.value = this.saved.activeDraftKey ?? ''; choose.disabled = this.busy;
    choose.addEventListener('change', () => { this.saved.activeDraftKey = choose.value || null; this.envelope = null; this.confirmedDelete = null; this.change(); this.draw(); const next = this.draft(); if (next && this.inScope(next.selection.repo)) void this.readEnvelope(next, false); }); this.editor.append(choose);
    if (!draft) { this.editor.append(node('p', 'Choose a Todo or create a new one.')); return; }
    this.editor.append(node('h2', draft.target ? `Edit ${draft.target.ref.externalId}` : 'New Todo'));
    if (!this.inScope(draft.selection.repo)) {
      this.editor.append(node('p', `This draft belongs to ${draft.selection.repo}. Select its scope to save it.`), this.button(`Use ${draft.selection.repo} for this panel`, () => { void this.scope(draft.selection.repo); }, !this.context.setScope || !this.active()));
    }
    if (!envelope) this.editor.append(node('p', 'The source or task revision changed, or the editor is unavailable. Your draft is kept.'), this.button('Reconcile with current revision', () => { void this.readEnvelope(draft, true); }, this.busy || !!draft.submitted || !this.inScope(draft.selection.repo) || !this.active()));
    const locked = this.unsupported || !this.active() || draft.values.state === 'in_progress' || !!envelope && !(envelope.commands[draft.target ? 'update' : 'create']?.available ?? false);
    for (const [key, label, maximum] of [['title', 'Title', 240], ['description', 'Description', 20000], ['acceptanceCriteria', 'Acceptance criteria', 20000]] as const) {
      const wrapper = node('label', label); const field = key === 'title' ? node('input') : node('textarea'); field.value = draft.values[key]; field.maxLength = maximum;
      field.setAttribute('aria-label', label); field.id = `${this.state.instanceId}-${key}`; field.disabled = locked;
      field.addEventListener('input', () => { draft.values[key] = field.value; this.change(); this.updateLaunch(); }); wrapper.append(field); this.editor.append(wrapper);
    }
    for (const [key, label, options] of [['priority', 'Priority', priorities], ['state', 'State', states]] as const) {
      const wrapper = node('label', label); const field = node('select'); field.setAttribute('aria-label', label); field.disabled = locked;
      for (const value of options) { const option = node('option', key === 'state' ? labels[value as Values['state']] : value); option.value = value; option.disabled = value === 'in_progress'; field.append(option); }
      field.value = draft.values[key]; field.addEventListener('change', () => { if (key === 'priority') draft.values.priority = field.value as Values['priority']; else draft.values.state = field.value as Values['state']; this.change(); this.updateLaunch(); }); wrapper.append(field); this.editor.append(wrapper);
    }
    const destination = node('select'); destination.setAttribute('aria-label', this.state.pirateMode ? 'Destination galleon' : 'Destination repository'); destination.disabled = locked || !!draft.submitted;
    if (!draft.target) { const option = node('option', this.state.activity.repo === null ? 'Choose destination' : `Follow header (${draft.values.repo})`); option.value = ''; destination.append(option); }
    for (const repo of new Set([draft.values.repo, ...(envelope?.destinationRepos ?? [])])) { const option = node('option', repo); option.value = repo; destination.append(option); }
    destination.value = !draft.target && draft.destinationPolicy === 'inherit' ? '' : draft.values.repo; destination.addEventListener('change', () => {
      if (!draft.target && !destination.value) { void this.inheritScope(draft); return; }
      draft.values.repo = destination.value; draft.destinationPolicy = 'fixed'; this.change();
      if (!draft.target) void this.scope(destination.value, draft.key); else this.draw();
    }); this.editor.append(destination);
    const action = draft.target ? 'update' : 'create'; const unavailable = envelope?.commands[action];
    if (unavailable && !unavailable.available) this.editor.append(node('p', unavailable.reason ?? 'This Todo cannot be changed.'));
    this.editor.append(this.button(draft.target ? 'Save Todo' : 'Create Todo', () => { void this.submit(action); }, locked || this.busy || this.taskPending(draft) || !envelope || !this.pendingReady || !this.inScope(draft.selection.repo)));
    if (draft.target) {
      this.editor.append(this.button('Delete Todo', () => { this.confirmedDelete = draft.key; this.draw(); }, locked || this.busy || this.taskPending(draft) || !envelope?.commands.delete?.available || !this.inScope(draft.selection.repo)));
      if (this.confirmedDelete === draft.key) this.editor.append(node('p', `Delete ${draft.target.ref.externalId}: ${draft.values.title}?`), this.button('Confirm deletion', () => { void this.submit('delete'); }, this.busy), this.button('Cancel deletion', () => { this.confirmedDelete = null; this.draw(); }));
    }
    const launch = this.button(this.state.pirateMode ? 'Weigh anchor' : 'Start run', () => { void this.launch(); }); launch.dataset.todoLaunch = '';
    const hint = node('p'); hint.dataset.todoLaunchHint = ''; hint.id = `${this.state.instanceId}-launch-hint`; launch.setAttribute('aria-describedby', hint.id); this.editor.append(launch, hint);
    if (envelope?.relatedRun) this.editor.append(this.link(this.state.pirateMode ? 'Open related voyage' : 'Open related run', envelope.relatedRun.repo, envelope.relatedRun.runId));
    if (draft.submitted && !this.pending.some(entry => sameSubmission(draft.submitted, entry))) this.editor.append(node('p', 'This draft has an unconfirmed submission. Refresh saved requests before retrying.'), this.button('Retry saved submission', () => { void this.retrySaved(draft); }, this.busy || !this.pendingReady));
    if (!draft.submitted) {
      this.editor.append(this.button('Discard draft', () => { this.discardDraftKey = draft.key; this.draw(); }, this.busy || this.unsupported));
      if (this.discardDraftKey === draft.key) this.editor.append(node('p', `Discard the saved draft for ${draft.values.title || 'this new Todo'}? The stored task is unchanged.`),
        this.button('Confirm discard', () => {
          if (draft.submitted || this.busy) return;
          this.saved.drafts = this.saved.drafts.filter(value => value.key !== draft.key); this.saved.activeDraftKey = null;
          this.envelope = null; this.discardDraftKey = null; this.change(); this.draw();
        }), this.button('Keep draft', () => { this.discardDraftKey = null; this.draw(); }));
    }
    if (focus?.label) {
      const field = Array.from(this.editor.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')).find(value => value.getAttribute('aria-label') === focus.label);
      field?.focus({ preventScroll: true }); if (field && focus.start !== null && focus.end !== null) field.setSelectionRange(focus.start, focus.end);
    }
  }
  private async scope(repo: string, draftKey?: string) {
    if (!this.context.setScope || !this.active() || this.busy) return;
    try {
      if (!await this.save()) return;
      await this.context.setScope({ kind: 'galleon', repo });
      const draft = this.saved.drafts.find(value => value.key === draftKey);
      if (draft && !draft.target && !draft.submitted && this.state.activity.repo === repo) {
        const source = this.sources.find(value => value.selection.repo === repo && value.selection.sourceId === draft.selection.sourceId && value.selection.instanceId === draft.selection.instanceId && value.selection.instanceRevision === draft.selection.instanceRevision);
        const selection = source?.selection ?? { ...draft.selection, repo };
        draft.selection = selection; this.saved.selectedSource = selection; this.envelope = null; this.change(); await this.readEnvelope(draft, true);
      }
    } catch { this.error = 'The panel scope could not be changed. Your draft is kept.'; this.draw(); }
  }
  private async inheritScope(draft: Draft) {
    if (!this.context.setScope || !this.active() || this.busy || draft.target || draft.submitted) return;
    draft.destinationPolicy = 'inherit'; this.change();
    try {
      if (!await this.save()) return;
      await this.context.setScope({ kind: 'inherit' });
      if (this.active()) await this.refresh();
    } catch { this.error = 'The header scope could not be restored. Your draft is kept.'; this.draw(); }
  }
  private async retrySaved(draft: Draft) {
    if (!draft.submitted || !this.active() || this.busy || !this.pendingReady) return;
    const generation = this.generation; this.busy = true; this.draw();
    try { if (await this.save() && this.active(generation)) await this.context.services.sourceCommands!.submit(draft.submitted, this.state.activity.signal); }
    catch { if (this.active(generation)) this.error = 'The outcome is still unconfirmed. Keep this draft.'; }
    finally { if (this.active(generation)) { await this.restorePending(generation); this.busy = false; this.draw(); } }
  }
  private drawRequests() {
    this.requests.replaceChildren();
    if (this.legacyError) this.requests.append(node('p', this.legacyError));
    if (this.legacyNeedsAll) this.requests.append(this.button(this.state.pirateMode ? 'Use All galleons to inspect older requests' : 'Use All repositories to inspect older requests', () => {
      if (this.context.setScope) void this.context.setScope({ kind: 'all' }).catch(() => { this.legacyError = 'The panel scope could not be changed. Refresh to retry.'; this.draw(); });
    }, !this.context.setScope || !this.active() || this.busy));
    for (const entry of this.legacyPending) {
      const row = node('section'); row.className = 'todo-request'; const receipt = this.legacyReceipts.get(entry.requestId);
      row.append(node('p', `Older Todo ${entry.commandId} · ${entry.externalId ?? 'new task'} · ${entry.requestId} · ${receipt?.status ?? 'unchecked'}`));
      if (receipt?.message) row.append(node('p', receipt.message));
      if (receipt?.result) row.append(node('p', `${receipt.result.kind} · ${receipt.result.ref.externalId}${'repo' in receipt.result ? ` · ${receipt.result.repo}` : ''}`));
      row.append(this.button('Check original request', () => { void this.legacyRequest(entry.requestId, false); }, this.busy || !this.active()));
      if (receipt && ['succeeded', 'rejected'].includes(receipt.status)) row.append(this.button('Dismiss confirmed older request', () => { void this.legacyRequest(entry.requestId, true); }, this.busy || !this.active()));
      else row.append(node('p', 'Keep the original request until its outcome is confirmed.'));
      this.requests.append(row);
    }
    for (const entry of this.pending) {
      const row = node('section'); row.className = 'todo-request';
      row.append(node('p', `${entry.command.action} · ${entry.command.selection.repo} · ${entry.command.requestId} · ${entry.receipt?.status ?? 'unconfirmed'}`));
      if (entry.receipt?.message) row.append(node('p', entry.receipt.message));
      const terminal = entry.receipt && ['succeeded', 'rejected'].includes(entry.receipt.status);
      if (terminal) row.append(this.button(entry.receipt?.status === 'succeeded' ? 'Apply saved result' : 'Dismiss rejection', () => { void this.request(entry, 'consume'); }, this.busy || !this.active()));
      else {
        row.append(this.button('Check request', () => { void this.request(entry, 'check'); }, this.busy || !this.active()));
        if (!entry.receipt || entry.receipt.status === 'pending') row.append(this.button('Retry delivery', () => { void this.request(entry, 'retry'); }, this.busy || !this.active()));
        row.append(this.button('Open Recovery', () => this.context.navigate(`/recovery?${new URLSearchParams({ repo: entry.command.selection.repo })}`), !this.active()));
      }
      this.requests.append(row);
    }
    for (const entry of this.runPending) {
      const row = node('section'); row.className = 'todo-request'; const receipt = entry.receipt;
      row.append(node('p', `Launch · ${entry.command.repo} · ${entry.command.requestId} · ${receipt?.status ?? 'unconfirmed'}`));
      if (receipt?.message) row.append(node('p', receipt.message));
      if (receipt?.status === 'accepted' && receipt.runId) row.append(this.link(this.state.pirateMode ? 'Open voyage' : 'Open run', entry.command.repo, receipt.runId));
      if (receipt && ['accepted', 'rejected'].includes(receipt.status)) row.append(this.button('Dismiss launch request', () => { void this.runRequest(entry, 'dismiss'); }, this.busy || !this.active()));
      else {
        row.append(this.button('Check launch request', () => { void this.runRequest(entry, 'check'); }, this.busy || !this.active()));
        if (!receipt || receipt.status === 'pending') row.append(this.button('Retry launch delivery', () => { void this.runRequest(entry, 'retry'); }, this.busy || !this.active()));
        row.append(this.button('Open Recovery', () => this.context.navigate(`/recovery?${new URLSearchParams({ repo: entry.command.repo })}`), !this.active()));
      }
      this.requests.append(row);
    }
  }
}
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.taskEdit?.version !== 1 || context.services.sourceCommands?.version !== 1) throw new Error('Todos requires task editor and source command services');
  return new TodosPanel(container, context);
} };
export default panel;
