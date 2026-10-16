import type { PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, TaskReadSourceV1, TaskTriageItemV1, RunCommandInputV1, RunCommandPendingV1, RunCommandReceiptV1, TaskTriageGroupV1, TaskTriageReadSnapshotV1, SourceRemoteActionInputV1, SourceRemoteActionReceiptV1, SourceRemoteActionDiscoveryV1 } from '@helmsman/plugin-sdk';
import { styles } from './styles.js';

interface Selection { sourceId: string; instanceId: string; repo: string; }
interface Section { source: TaskReadSourceV1; group: TaskTriageGroupV1; tasks: readonly TaskTriageItemV1[]; cursor: string | null; pages: number; error: string; loading: boolean; snapshots: TaskTriageReadSnapshotV1[]; }
interface AssignmentState { input: SourceRemoteActionInputV1; requestId: string | null; receipt: SourceRemoteActionReceiptV1 | null; busy: boolean; message: string; }
const assignmentKey = (input: SourceRemoteActionInputV1) => JSON.stringify([input.selection.repo, input.target.ref.sourceId, input.target.ref.externalId, input.action]);
const actionSourceKey = (source: TaskReadSourceV1) => JSON.stringify([source.repo, source.sourceId, source.instanceId, source.instanceRevision]);
interface Description { readonly status: 'loading' | 'loaded' | 'unavailable'; readonly text?: string; readonly truncated?: boolean; readonly message?: string; }
const groups: readonly TaskTriageGroupV1[] = ['unassigned-backlog', 'unassigned-todo', 'mine-open'];
const titles: Record<TaskTriageGroupV1, string> = { 'unassigned-backlog': 'Backlog', 'unassigned-todo': 'To do', 'mine-open': 'My open work' };
const dayOptions = [0, 30, 7, 1]; const pageSizes = [5, 10, 25, 50, 100];
interface LaunchState { input: RunCommandInputV1; requestId: string | null; receipt: RunCommandReceiptV1 | null; busy: boolean; message: string; }
function commandKey(input: RunCommandInputV1): string | null {
  return input.action === 'launch' && input.launch.mode === 'source' ? JSON.stringify([input.repo, input.launch.workRef.sourceId, input.launch.workRef.externalId]) : null;
}
const key = (source: Selection): string => JSON.stringify([source.repo, source.sourceId, source.instanceId]);
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;
};

const phosphorGlyphs = { ready: '\ue3fe', in_progress: '\ue3d2', review: '\ue282', done: '\ue184', blocked: '\ue3de', unknown: '\ue4e2', priority: '\ue244', refresh: '\ue094', run: '\ue3d2' } as const;
const createIcon = (name: keyof typeof phosphorGlyphs): HTMLSpanElement => {
  const icon = element('span'); icon.className = 'triage-phosphor'; icon.dataset.glyph = phosphorGlyphs[name]; icon.setAttribute('aria-hidden', 'true'); return icon;
};
const taskStates = { ready: 'Ready', in_progress: 'In progress', review: 'In review', done: 'Done', blocked: 'Blocked' } as const;
function updatedDate(value: string | null): string {
  if (!value) return 'Update date unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Update date unknown' : `Updated ${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date)}`;
}

function selection(value: unknown): Selection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return typeof input.sourceId === 'string' && typeof input.instanceId === 'string' && typeof input.repo === 'string'
    && input.sourceId.length <= 160 && input.instanceId.length <= 160 && input.repo.length <= 512
    ? { sourceId: input.sourceId, instanceId: input.instanceId, repo: input.repo } : null;
}

class TriagePanel implements PluginPanelInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private state: PluginPanelState;
  private chosen: Selection | null;
  private priorities = [0, 1, 2, 3, 4]; private days = 0; private pageSize = 10;
  private until = new Date().toISOString(); private collapsed = new Set<string>();
  private legacyCollapsedGroups = new Set<TaskTriageGroupV1>(); private expanded = new Set<string>(); private descriptionExpanded = new Set<string>();
  private descriptions = new Map<string, Description>(); private readonly descriptionControllers = new Set<AbortController>();
  private revealedRoute: string | null = null;
  private invalidSelection = false;
  private selectionDirty = false;
  private selectionSave = 0;
  private sources: readonly TaskReadSourceV1[] = [];
  private sections: Section[] = [];
  private messages: string[] = [];
  private saveError = '';
  private evidenceReady = false;
  private commandError = '';
  private commands = new Map<string, LaunchState>();
  private assignments = new Map<string, AssignmentState>();
  private assignmentReady = false;
  private assignmentError = '';
  private actionCapabilities = new Map<string, SourceRemoteActionDiscoveryV1>();
  private actionController: AbortController | null = null;
  private actionErrors = new Map<string, string>();
  private disposed = false;
  private controller: AbortController | null = null;
  private generation = 0;
  private pending: Promise<void> | null = null;
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state;
    const saved = context.state.savedState;
    this.chosen = null; this.restoreSettings(saved);
    context.onDispose(() => this.dispose()); context.signal.addEventListener('abort', this.abort, { once: true });
    this.state.activity.signal.addEventListener('abort', this.suspend, { once: true });
    if (context.signal.aborted) { this.dispose(); return; }
    this.draw(); void this.refresh();
  }
  private abort = () => this.dispose();
  private suspend = () => { this.cancel(); };
  private cancelDescriptions() { for (const controller of this.descriptionControllers) controller.abort(); this.descriptionControllers.clear(); for (const [id, description] of this.descriptions) if (description.status === 'loading') this.descriptions.delete(id); }
  private cancel() { ++this.generation; this.actionController?.abort(); this.actionController = null; this.assignmentReady = false; this.actionCapabilities.clear(); this.actionErrors.clear(); for (const assignment of this.assignments.values()) assignment.busy = false; this.controller?.abort(); this.controller = null; this.cancelDescriptions(); this.pending = null; this.evidenceReady = false; for (const command of this.commands.values()) command.busy = false; }
  private current(generation: number): boolean { return !this.disposed && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  refresh(): Promise<void> {
    if (this.disposed || !this.state.activity.active || this.state.activity.signal.aborted || !this.state.visible) return Promise.resolve();
    if (this.pending) return this.pending;
    this.actionController?.abort(); this.actionController = new AbortController(); for (const assignment of this.assignments.values()) assignment.busy = false; this.assignmentReady = false; this.actionCapabilities.clear(); this.actionErrors.clear();
    this.evidenceReady = false; this.cancelDescriptions(); this.descriptions.clear(); this.sections = []; this.until = new Date().toISOString();
    const generation = ++this.generation; const controller = new AbortController(); this.controller = controller;
    const promise = Promise.resolve().then(async () => {
      await Promise.all([this.restoreCommands(generation), this.restoreAssignments(generation)]);
      if (!this.current(generation)) return;
      const discovery = await this.context.services.tasks!.discover(controller.signal);
      if (!this.current(generation)) return;
      this.messages = []; this.sections = []; this.sources = [];
      if (discovery.status === 'unavailable') { this.messages.push(`Task sources are unavailable (${discovery.reason}).`); return; }
      const sources: TaskReadSourceV1[] = [];
      for (const galleon of discovery.value.galleons) {
        if (galleon.sources.status === 'unavailable') this.messages.push(`${galleon.repo}: task sources unavailable (${galleon.sources.reason}).`);
        else sources.push(...galleon.sources.value.filter(source => source.readViews?.includes('triage')));
      }
      this.sources = sources;
      const selected = this.invalidSelection ? [] : this.chosen ? sources.filter(source => key(source) === key(this.chosen!)) : sources;
      if (this.invalidSelection) this.messages.push('The saved source selection uses unsupported data. Choose a source to replace it.');
      if (this.chosen && !selected.length) this.messages.push('The selected source is unavailable in this scope. Your selection is kept.');
      if (selected.length > 50) this.messages.push('Showing the first 50 source views. Select a source to inspect another view.');
      this.sections = selected.slice(0, 50).filter(source => source.readViews?.includes('triage')).flatMap(source => groups.map(group => ({ source, group, tasks: [], cursor: null, pages: 0, snapshots: [], error: source.availability !== 'available' ? `Source ${source.availability}.` : '', loading: source.availability === 'available' })));
      void this.discoverActions(selected.slice(0, 50), generation, this.actionController!.signal);
      this.draw(); let index = 0;
      await Promise.all(Array.from({ length: Math.min(4, this.sections.length) }, async () => {
        while (index < this.sections.length && this.current(generation)) {
          const section = this.sections[index++]!;
          if (section.source.availability === 'available') await this.readPage(section, generation, controller.signal);
        }
      }));
      if (this.current(generation)) this.reloadExpandedDescriptions(generation);
    }).catch(() => { if (this.current(generation) && !controller.signal.aborted) this.messages = ['Tasks could not be read. Refresh to retry.']; }).finally(() => {
      if (generation === this.generation && !this.disposed) { this.controller = null; this.pending = null; this.draw(); }
    });
    this.pending = promise; this.draw(); return promise;
  }
  private async readPage(section: Section, generation: number, signal: AbortSignal): Promise<void> {
    try {
      const result = await this.context.services.taskViews!.triage({ ...section.source, group: section.group, priorities: this.priorities, updatedSince: this.days ? new Date(Date.parse(this.until) - this.days * 86_400_000).toISOString() : null, until: this.until, cursor: section.cursor, limit: this.pageSize }, signal);
      if (!this.current(generation)) return;
      if (result.status === 'unavailable') { section.error = `Tasks unavailable (${result.reason}).`; return; }
      const seen = new Set(section.snapshots.flatMap(snapshot => snapshot.page.items.map(task => JSON.stringify(task.ref))));
      if (result.value.page.items.some(task => seen.has(JSON.stringify(task.ref)))) { section.error = 'Task pagination changed. Refresh this panel.'; section.cursor = null; return; }
      section.snapshots.push(result.value); section.pages = section.snapshots.length; section.tasks = result.value.page.items; section.cursor = result.value.page.nextCursor; section.error = result.value.page.quality === 'unavailable' ? 'This group is unavailable.' : '';
      this.reloadExpandedDescriptions(generation);
    } catch { if (this.current(generation) && !signal.aborted) section.error = 'Tasks could not be read. Refresh to retry.'; }
    finally { if (this.current(generation)) { section.loading = false; this.draw(); } }
  }
  private more(section: Section): void {
    if (this.disposed || !section.cursor || section.loading || section.pages >= 20 || this.pending || !this.state.activity.active) return;
    if (section.pages < section.snapshots.length) { this.showPage(section, section.pages + 1); return; }
    const controller = new AbortController(); this.controller = controller; section.loading = true;
    const generation = this.generation;
    this.pending = this.readPage(section, generation, controller.signal).finally(() => {
      if (generation === this.generation) { this.pending = null; this.controller = null; this.draw(); }
    }); this.draw();
  }
  private async choose(value: string): Promise<void> {
    const source = this.sources.find(source => key(source) === value);
    if (value && !source) return;
    this.chosen = source ? { sourceId: source.sourceId, instanceId: source.instanceId, repo: source.repo } : null;
    this.invalidSelection = false; this.selectionDirty = true;
    this.cancel(); this.sections = []; this.saveError = ''; this.draw(); void this.refresh();
    const chosen = this.chosen;
    const save = ++this.selectionSave;
    try { await this.context.saveState(this.savedSettings(chosen)); if (!this.disposed && save === this.selectionSave) this.selectionDirty = false; }
    catch { if (!this.disposed && save === this.selectionSave) { this.saveError = 'The source selection could not be saved. It remains selected in this panel.'; this.draw(); } }
  }
  private sectionKey(section: Section): string { return JSON.stringify([key(section.source), section.group]); }
  private descriptionKey(section: Section, task: TaskTriageItemV1): string { return JSON.stringify([section.source.repo, section.source.sourceId, section.source.instanceId, task.ref.sourceId, task.ref.externalId]); }
  private descriptionStateKey(section: Section, task: TaskTriageItemV1): string { return JSON.stringify([this.descriptionKey(section, task), section.source.instanceRevision, task.revision]); }
  private descriptionFocusKey(section: Section, task: TaskTriageItemV1): string { return JSON.stringify([this.sectionKey(section), task.ref.externalId]); }
  private isCollapsed(section: Section): boolean {
    const id = this.sectionKey(section);
    return this.collapsed.has(id) || this.legacyCollapsedGroups.has(section.group) && !this.expanded.has(id);
  }
  private expand(section: Section): void { const id = this.sectionKey(section); this.collapsed.delete(id); this.expanded.add(id); }
  private routeGroup(): TaskTriageGroupV1 | null {
    const route = this.state.routeState;
    if (route?.version !== 1 || !route.value || typeof route.value !== 'object' || Array.isArray(route.value)) return null;
    const pane = (route.value as Record<string, unknown>).pane;
    return pane === 'backlog' ? 'unassigned-backlog' : pane === 'todo' ? 'unassigned-todo' : pane === 'mine' ? 'mine-open' : null;
  }
  private showPage(section: Section, page: number): void {
    const snapshot = section.snapshots[page - 1]; if (!snapshot || this.pending) return;
    section.pages = page; section.tasks = snapshot.page.items; section.cursor = snapshot.page.nextCursor; section.error = snapshot.page.quality === 'unavailable' ? 'This group is unavailable.' : ''; this.draw(); this.reloadExpandedDescriptions(this.generation);
  }
  private restoreSettings(saved: PluginPanelState['savedState']): void {
    const value = saved?.version === 1 && saved.value && typeof saved.value === 'object' && !Array.isArray(saved.value) ? saved.value as Record<string, unknown> : null;
    this.chosen = selection(value?.source); this.invalidSelection = saved !== null && (!value || value.source !== null && !this.chosen);
    this.priorities = Array.isArray(value?.priorities) ? [0, 1, 2, 3, 4].filter(number => (value.priorities as unknown[]).includes(number)) : [0, 1, 2, 3, 4];
    this.days = dayOptions.find(number => number === value?.days) ?? 0; this.pageSize = pageSizes.find(number => number === value?.pageSize) ?? 10;
    const keys = (input: unknown) => Array.isArray(input) ? input.filter((id): id is string => typeof id === 'string' && id.length < 2048).slice(0, 150) : [];
    this.collapsed = new Set(keys(value?.collapsed)); this.expanded = new Set(keys(value?.expanded)); this.descriptionExpanded = new Set(keys(value?.descriptionExpanded));
    this.legacyCollapsedGroups = new Set(groups.filter(group => Array.isArray(value?.legacyCollapsedGroups) && value.legacyCollapsedGroups.includes(group)));
  }
  private savedSettings(chosen = this.chosen) { return { version: 1, value: { source: chosen, priorities: this.priorities, days: this.days, pageSize: this.pageSize, collapsed: [...this.collapsed], expanded: [...this.expanded], descriptionExpanded: [...this.descriptionExpanded], legacyCollapsedGroups: [...this.legacyCollapsedGroups] } }; }
  private async persistSettings(): Promise<void> {
    if (this.invalidSelection) return;
    const save = ++this.selectionSave; this.selectionDirty = true;
    try { await this.context.saveState(this.savedSettings()); if (!this.disposed && save === this.selectionSave) { this.selectionDirty = false; this.saveError = ''; } }
    catch { if (!this.disposed && save === this.selectionSave) { this.saveError = 'These panel settings could not be saved.'; this.draw(); } }
  }
  private filterChanged(): void { this.cancel(); void this.persistSettings(); void this.refresh(); }
  private reloadExpandedDescriptions(generation: number): void {
    for (const section of this.sections) for (const task of section.tasks) {
      if (!this.isCollapsed(section) && this.descriptionExpanded.has(this.descriptionKey(section, task)) && !this.descriptions.has(this.descriptionStateKey(section, task)) && this.descriptionCurrent(section, task, generation)) void this.loadDescription(section, task);
    }
  }
  private descriptionCurrent(section: Section, task: TaskTriageItemV1, generation: number): boolean {
    return this.current(generation) && this.sections.includes(section) && section.tasks.some(item => item.ref.sourceId === task.ref.sourceId && item.ref.externalId === task.ref.externalId && item.revision === task.revision);
  }
  private descriptionText(value: string): { text: string; truncated: boolean } {
    const limit = 32 * 1024; const encoder = new TextEncoder(); if (encoder.encode(value).byteLength <= limit) return { text: value, truncated: false };
    let text = ''; let bytes = 0;
    for (const character of value) { const size = encoder.encode(character).byteLength; if (bytes + size > limit) break; text += character; bytes += size; }
    return { text, truncated: true };
  }
  private async loadDescription(section: Section, task: TaskTriageItemV1): Promise<void> {
    const id = this.descriptionStateKey(section, task); if (this.descriptions.get(id)?.status === 'loading') return;
    const generation = this.generation; const controller = new AbortController(); this.descriptionControllers.add(controller);
    const loading: Description = { status: 'loading' }; this.descriptions.set(id, loading); this.draw();
    try {
      const result = await this.context.services.tasks!.load({ ...section.source, ref: task.ref }, AbortSignal.any([controller.signal, this.context.signal, this.state.activity.signal]));
      if (!this.descriptionCurrent(section, task, generation)) return;
      if (result.status === 'unavailable') { this.descriptions.set(id, { status: 'unavailable', message: `Description unavailable (${result.reason}).` }); return; }
      const loaded = result.value;
      if (loaded.selection.sourceId !== section.source.sourceId || loaded.selection.instanceId !== section.source.instanceId || loaded.selection.instanceRevision !== section.source.instanceRevision
        || loaded.selection.repo !== section.source.repo || loaded.ref.sourceId !== task.ref.sourceId || loaded.ref.externalId !== task.ref.externalId || loaded.task?.ref.sourceId !== task.ref.sourceId || loaded.task?.ref.externalId !== task.ref.externalId || loaded.task?.revision !== task.revision) {
        this.descriptions.set(id, { status: 'unavailable', message: 'Description changed. Refresh to retry.' }); return;
      }
      if (!loaded.task || !loaded.task.requirements.description.trim()) { this.descriptions.set(id, { status: 'loaded', text: '' }); return; }
      const description = this.descriptionText(loaded.task.requirements.description);
      this.descriptions.set(id, { status: 'loaded', ...description });
    } catch {
      if (this.descriptionCurrent(section, task, generation) && !controller.signal.aborted) this.descriptions.set(id, { status: 'unavailable', message: 'Description unavailable. Refresh to retry.' });
    } finally {
      this.descriptionControllers.delete(controller);
      if (this.descriptions.get(id) === loading) this.descriptions.delete(id);
      if (this.current(generation)) { this.draw(); this.reloadExpandedDescriptions(generation); }
    }
  }
  private toggleDescription(section: Section, task: TaskTriageItemV1): void {
    const id = this.descriptionKey(section, task);
    if (this.descriptionExpanded.has(id)) { this.descriptionExpanded.delete(id); this.draw(); void this.persistSettings(); return; }
    if (this.descriptionExpanded.size >= 150) this.descriptionExpanded.delete(this.descriptionExpanded.values().next().value!);
    this.descriptionExpanded.add(id); this.draw(); void this.persistSettings(); void this.loadDescription(section, task);
  }
  private description(section: Section, task: TaskTriageItemV1): HTMLElement {
    const id = this.descriptionKey(section, task); const expanded = this.descriptionExpanded.has(id); const state = this.descriptions.get(this.descriptionStateKey(section, task));
    const view = element('div'); view.className = 'triage-description';
    const toggle = element('button', expanded ? 'Hide description' : 'Show description'); toggle.type = 'button'; toggle.setAttribute('aria-label', `${toggle.textContent} for ${task.displayKey}`); toggle.setAttribute('aria-expanded', String(expanded)); toggle.dataset.triageFocus = `description:${this.descriptionFocusKey(section, task)}`;
    toggle.addEventListener('click', () => { toggle.focus({ preventScroll: true }); this.toggleDescription(section, task); }); view.append(toggle);
    if (!expanded) return view;
    const content = element('div'); content.id = `triage-description-${encodeURIComponent(JSON.stringify([this.state.instanceId, section.source.repo, section.source.sourceId, section.source.instanceId, section.group, task.ref.sourceId, task.ref.externalId]))}`; content.className = 'triage-description-content'; toggle.setAttribute('aria-controls', content.id);
    if (!state) { content.append(element('p', 'Loading description…')); content.setAttribute('role', 'status'); }
    else if (state.status === 'loading') { content.append(element('p', 'Loading description…')); content.setAttribute('role', 'status'); }
    else if (state.status === 'unavailable') { content.append(element('p', state.message ?? 'Description unavailable.')); content.setAttribute('role', 'status'); }
    else if (!state.text) content.append(element('p', 'No description available.'));
    else { const text = element('p', state.text); text.className = 'triage-description-text'; content.append(text); if (state.truncated) content.append(element('p', 'Description truncated for display.')); }
    view.append(content); return view;
  }
  private filters(page: HTMLElement, sourceLabel: HTMLElement): void {
    const filters = element('fieldset'); filters.className = 'triage-filters'; filters.append(element('legend', 'Filters'), sourceLabel);
    const priorities = element('div'); priorities.className = 'triage-priorities'; priorities.setAttribute('role', 'group'); priorities.setAttribute('aria-label', 'Priorities'); priorities.append(element('span', 'Priority'));
    for (let priority = 0; priority < 5; priority++) { const label = element('label', `P${priority}`); const input = element('input'); input.type = 'checkbox'; input.disabled = this.invalidSelection; input.checked = this.priorities.includes(priority); input.setAttribute('aria-label', `Priority P${priority}`); input.dataset.triageFocus = `priority-${priority}`;
      input.addEventListener('change', () => { this.priorities = [0, 1, 2, 3, 4].filter(number => number === priority ? input.checked : this.priorities.includes(number)); this.filterChanged(); }); label.prepend(input); priorities.append(label); }
    filters.append(priorities);
    for (const [title, values, current, apply] of [['Last updated', dayOptions, this.days, (value: number) => { this.days = value; }], ['Tickets per column', pageSizes, this.pageSize, (value: number) => { this.pageSize = value; }]] as const) {
      const label = element('label', title); const select = element('select'); select.disabled = this.invalidSelection; select.setAttribute('aria-label', title); select.dataset.triageFocus = title;
      for (const value of values) { const option = element('option', title === 'Last updated' ? value ? `Last ${value} ${value === 1 ? 'day' : 'days'}` : 'Any time' : String(value)); option.value = String(value); select.append(option); }
      select.value = String(current); select.addEventListener('change', () => { const value = Number(select.value); if (!values.includes(value)) return; apply(value); this.filterChanged(); }); label.append(select); filters.append(label);
    } page.append(filters);
  }
  private async restoreCommands(generation: number): Promise<void> {
    try {
      const entries: readonly RunCommandPendingV1[] = await this.context.services.runCommands!.pending();
      if (!this.current(generation)) return;
      if (!Array.isArray(entries)) throw new Error('Saved launches unavailable');
      const commands = new Map<string, LaunchState>();
      for (const entry of entries) {
        if (!entry?.command || entry.command.action !== 'launch' || entry.command.launch.mode !== 'source'
          || this.state.repo !== null && entry.command.repo !== this.state.repo) continue;
        const id = commandKey(entry.command); if (!id) continue;
        const previous = this.commands.get(entry.command.requestId) ?? Array.from(this.commands.values()).find(command => command.requestId === null && commandKey(command.input) === id);
        const { requestId, ...input } = entry.command;
        commands.set(requestId, { input, requestId, receipt: entry.receipt,
          busy: previous?.busy ?? false, message: previous?.message ?? '' });
      }
      for (const [id, command] of this.commands) if (command.busy && !commands.has(id) && !Array.from(commands.values()).some(saved => commandKey(saved.input) === commandKey(command.input))) commands.set(id, command);
      this.commands = commands; this.evidenceReady = true; this.commandError = '';
    } catch { if (this.current(generation)) { this.evidenceReady = false; this.commandError = 'Saved launch requests are unavailable. Launch controls are disabled until refresh succeeds.'; } }
  }
  private hasCommand(id: string): boolean { return Array.from(this.commands.values()).some(command => commandKey(command.input) === id); }
  private async launch(section: Section, task: TaskTriageItemV1): Promise<void> {
    if (!this.current(this.generation) || !this.evidenceReady || this.state.repo === null || section.source.repo !== this.state.repo || task.state !== 'ready' || this.pending || section.loading || section.error || !this.sections.includes(section)) return;
    const input: RunCommandInputV1 = { version: 1, action: 'launch', repo: section.source.repo, launch: { mode: 'source', workRef: task.ref,
      sourceInstanceId: section.source.instanceId, sourceInstanceRevision: section.source.instanceRevision } };
    const id = commandKey(input); if (!id || this.hasCommand(id)) return;
    const command: LaunchState = { input, requestId: null, receipt: null, busy: true, message: '' }; this.commands.set(id, command);
    const generation = this.generation; this.draw();
    try {
      const result = await this.context.services.runCommands!.submit(input, this.state.activity.signal);
      if (!this.current(generation)) return;
      if (result.status === 'available') { command.requestId = result.value.requestId; command.receipt = result.value; }
      else command.message = 'The launch outcome is not confirmed. Check its saved receipt before trying again.';
    } catch { if (this.current(generation)) command.message = 'The launch outcome is not confirmed. Check its saved receipt before trying again.'; }
    finally { if (this.current(generation)) { command.busy = false; await this.restoreCommands(generation); this.draw(); } }
  }
  private async commandAction(command: LaunchState, action: 'dismiss' | 'receipt' | 'retry'): Promise<void> {
    if (!this.current(this.generation) || command.busy || !command.requestId) return;
    const query = { repo: command.input.repo, requestId: command.requestId }; const generation = this.generation;
    command.busy = true; this.draw();
    try {
      if (action === 'dismiss') await this.context.services.runCommands!.acknowledge(query);
      else {
        if (action === 'retry' && command.receipt?.status === 'recovery-required') return;
        if (action === 'retry' && !this.context.services.runCommands?.retry) throw new Error('Original request retry is unavailable. Check its receipt instead.');
        const result = action === 'retry' ? await this.context.services.runCommands!.retry!(query, this.state.activity.signal)
          : await this.context.services.runCommands!.receipt(query, this.state.activity.signal);
        if (this.current(generation)) {
          if (result.status === 'available' && result.value) { command.receipt = result.value; command.message = ''; }
          else command.message = 'No confirmed receipt is available. The saved request remains protected.';
        }
      }
    } catch { if (this.current(generation)) command.message = 'Could not update the saved request. Refresh to retry.'; }
    finally { if (this.current(generation)) { command.busy = false; await this.restoreCommands(generation); this.draw(); } }
  }
  private async restoreAssignments(generation: number): Promise<void> {
    const service = this.context.services.taskActions;
    if (service?.version !== 1) { this.assignmentReady = false; this.assignments.clear(); return; }
    try {
      const entries = await service.pending();
      if (!this.current(generation)) return;
      if (!Array.isArray(entries)) throw new Error('Saved assignments unavailable');
      const assignments = new Map<string, AssignmentState>();
      for (const entry of entries) {
        if (!entry?.command?.target?.ref || !entry.command.selection || entry.command.action !== 'assign-self'
          || typeof entry.command.requestId !== 'string' || typeof entry.command.target.ref.externalId !== 'string') throw new Error('Invalid saved assignment');
        if (this.state.repo !== null && entry.command.selection.repo !== this.state.repo) continue;
        const { requestId, ...input } = entry.command; const id = assignmentKey(input); const previous = this.assignments.get(id);
        assignments.set(id, { input, requestId, receipt: entry.receipt, busy: previous?.busy ?? false, message: previous?.message ?? '' });
      }
      for (const [id, value] of this.assignments) if (value.busy && !assignments.has(id)) assignments.set(id, value);
      this.assignments = assignments; this.assignmentReady = true; this.assignmentError = '';
    } catch { if (this.current(generation)) { this.assignmentReady = false; this.assignmentError = 'Saved assignments are unavailable. Assign to me is disabled until refresh succeeds.'; } }
  }
  private async discoverActions(sources: readonly TaskReadSourceV1[], generation: number, signal: AbortSignal): Promise<void> {
    const service = this.context.services.taskActions; if (service?.version !== 1) return;
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
      while (index < sources.length && this.current(generation) && !signal.aborted) {
        const source = sources[index++]!; if (source.availability !== 'available') continue;
        try {
          const result = await service.discover(source, signal);
          if (!this.current(generation) || signal.aborted) return;
          const selection = result?.status === 'available' ? result.value?.selection : null;
          if (result?.status === 'available' && selection?.sourceId === source.sourceId && selection.instanceId === source.instanceId
            && selection.instanceRevision === source.instanceRevision && selection.repo === source.repo && Number.isSafeInteger(result.value.sourceRevision)
            && result.value.sourceRevision > 0 && Array.isArray(result.value.actions)) this.actionCapabilities.set(actionSourceKey(source), result.value);
          else this.actionErrors.set(actionSourceKey(source), 'Assignment actions are unavailable. Refresh to retry.');
        } catch { if (this.current(generation) && !signal.aborted) this.actionErrors.set(actionSourceKey(source), 'Assignment actions are unavailable. Refresh to retry.'); }
        if (this.current(generation)) this.draw();
      }
    }));
  }
  private assignmentInput(section: Section, task: TaskTriageItemV1): SourceRemoteActionInputV1 | null {
    const capability = this.actionCapabilities.get(actionSourceKey(section.source));
    if (section.group === 'mine-open' || !capability?.actions.includes('assign-self')) return null;
    const { sourceId, instanceId, instanceRevision, repo } = section.source;
    return { version: 1, action: 'assign-self', selection: { version: 1, sourceId, instanceId, instanceRevision, repo },
      sourceRevision: capability.sourceRevision, target: { ref: task.ref, repo, expectedRevision: task.revision } };
  }
  private async assign(section: Section, task: TaskTriageItemV1): Promise<void> {
    const input = this.assignmentInput(section, task); const service = this.context.services.taskActions;
    if (!input || !service || !this.assignmentReady || !this.descriptionCurrent(section, task, this.generation) || this.pending || section.loading || section.error) return;
    const id = assignmentKey(input); if (this.assignments.has(id)) return;
    const assignment: AssignmentState = { input, requestId: null, receipt: null, busy: true, message: '' }; this.assignments.set(id, assignment);
    const generation = this.generation; this.draw();
    try {
      const result = await service.submit(input, AbortSignal.any([this.context.signal, this.state.activity.signal, this.actionController!.signal]));
      if (!this.current(generation)) return;
      if (result?.status === 'available') { assignment.requestId = result.value.requestId; assignment.receipt = result.value; }
      else assignment.message = 'Assignment outcome is not confirmed. Check its saved receipt before trying again.';
    } catch { if (this.current(generation)) assignment.message = 'Assignment outcome is not confirmed. Check its saved receipt before trying again.'; }
    finally { if (this.current(generation)) { assignment.busy = false; await this.restoreAssignments(generation); this.draw(); } }
  }
  private async assignmentAction(assignment: AssignmentState, action: 'receipt' | 'retry' | 'dismiss'): Promise<void> {
    const service = this.context.services.taskActions;
    if (!service || !this.current(this.generation) || assignment.busy || !assignment.requestId) return;
    const query = { repo: assignment.input.selection.repo, requestId: assignment.requestId }; const generation = this.generation;
    assignment.busy = true; this.draw();
    try {
      if (action === 'dismiss') { await service.acknowledge(query); if (this.current(generation)) { this.assignments.delete(assignmentKey(assignment.input)); await this.refresh(); } return; }
      if (action === 'retry' && assignment.receipt?.status === 'recovery-required') return;
      const signal = AbortSignal.any([this.context.signal, this.state.activity.signal, this.actionController!.signal]);
      const result = action === 'retry' ? await service.retry(query, signal) : await service.receipt(query, signal);
      if (this.current(generation)) {
        if (result?.status === 'available' && result.value) { assignment.receipt = result.value; assignment.message = ''; }
        else assignment.message = 'No confirmed assignment receipt is available. The saved request remains protected.';
      }
    } catch { if (this.current(generation)) assignment.message = 'Could not update the saved assignment. Refresh to retry.'; }
    finally { if (this.current(generation)) { assignment.busy = false; await this.restoreAssignments(generation); this.draw(); } }
  }
  private drawAssignments(page: HTMLElement): void {
    if (this.assignmentError) { const error = element('p', this.assignmentError); error.setAttribute('role', 'status'); page.append(error); }
    for (const [id, assignment] of this.assignments) {
      const receipt = assignment.receipt; const box = element('section'); box.setAttribute('aria-label', 'Saved assignment');
      box.append(element('h3', `${assignment.input.selection.repo} · ${assignment.input.target.ref.externalId}`));
      const note = element('p', assignment.busy ? 'Updating assignment…' : receipt?.status === 'succeeded' ? 'Assigned to you.'
        : receipt?.status === 'rejected' ? `Assignment rejected: ${receipt.reason ?? 'Refresh the task before trying again.'}`
          : receipt?.status === 'recovery-required' ? 'Assignment requires Recovery. Its outcome is not confirmed.' : assignment.message || 'Assignment pending. Its outcome is not confirmed.');
      note.setAttribute('role', 'status'); note.tabIndex = -1; note.dataset.triageFocus = `assignment-status:${id}`; box.append(note);
      const terminal = receipt?.status === 'succeeded' || receipt?.status === 'rejected';
      if (assignment.requestId) {
        const actions: readonly ('receipt' | 'retry' | 'dismiss')[] = terminal ? ['dismiss'] : !receipt || receipt.status === 'pending' ? ['receipt', 'retry'] : ['receipt'];
        for (const action of actions) {
          const button = element('button', action === 'dismiss' ? 'Dismiss saved assignment' : action === 'retry' ? 'Retry assignment delivery' : 'Check assignment receipt');
          button.type = 'button'; button.disabled = assignment.busy || !this.assignmentReady || !this.current(this.generation); button.dataset.triageFocus = `assignment:${id}:${action}`;
          button.addEventListener('click', () => { void this.assignmentAction(assignment, action); }); box.append(button);
        }
      }
      if (receipt?.status === 'recovery-required') { const recovery = element('a', 'Open Recovery'); recovery.href = `/recovery?${new URLSearchParams({ repo: assignment.input.selection.repo })}`; box.append(recovery); }
      page.append(box);
    }
  }
  private sourceLabel(source: TaskReadSourceV1): string {
    const repeated = this.sources.filter(item => item.label === source.label && item.repo === source.repo).length > 1;
    return `${source.label}${repeated ? ` · ${source.instanceId}` : ''}${source.repo === this.state.repo ? '' : ` · ${source.repo}`}`;
  }
  private draw(): void {
    if (this.disposed) return;
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement.dataset.triageFocus : null;
    const page = element('div'); page.className = 'plugin-triage triage-panel'; page.append(element('style', styles));
    const composed = this.container.closest('[data-composition-page]') !== null;
    const toolbar = element('div'); toolbar.className = 'triage-toolbar'; if (!composed) toolbar.append(element('h2', 'Triage'));
    const select = element('select'); select.setAttribute('aria-label', 'Task source'); select.dataset.triageFocus = 'source';
    const all = element('option', 'All task sources'); all.value = ''; select.append(all);
    if (this.invalidSelection) { const unsupported = element('option', 'Saved source selection unavailable'); unsupported.value = 'unsupported'; select.append(unsupported); }
    for (const source of this.sources) { const option = element('option', `${this.sourceLabel(source)}${source.availability === 'available' ? '' : ` (${source.availability})`}`); option.value = key(source); select.append(option); }
    if (this.chosen && !this.sources.some(source => key(source) === key(this.chosen!))) { const option = element('option', `Unavailable source · ${this.chosen.repo}`); option.value = key(this.chosen); select.append(option); }
    select.value = this.invalidSelection ? 'unsupported' : this.chosen ? key(this.chosen) : ''; select.addEventListener('change', () => { void this.choose(select.value); }); const sourceLabel = element('label', 'Task source'); sourceLabel.className = 'triage-source-filter'; sourceLabel.append(select);
    const refresh = element('button', 'Refresh'); refresh.type = 'button'; refresh.dataset.triageFocus = 'refresh'; refresh.disabled = Boolean(this.pending); refresh.addEventListener('click', () => { void (this.context.refresh?.() ?? this.refresh()); }); refresh.prepend(createIcon('refresh')); if (!composed) { toolbar.append(refresh); page.append(toolbar); }
    this.filters(page, sourceLabel); this.drawAssignments(page);
    for (const message of [...this.messages, ...(this.saveError ? [this.saveError] : []), ...(this.commandError ? [this.commandError] : [])]) { const note = element('p', message); note.setAttribute('role', 'status'); page.append(note); }
    if (this.state.repo === null) page.append(element('p', this.state.pirateMode ? 'Select one galleon to launch work.' : 'Select one repository to launch work.'));
    for (const command of this.commands.values()) {
      const receipt = command.receipt; const box = element('section');
      if (command.input.action === 'launch' && command.input.launch.mode === 'source') box.append(element('h3', `${command.input.repo} · ${command.input.launch.workRef.externalId}`));
      const note = element('p', command.busy ? 'Updating launch request…' : receipt?.status === 'accepted' ? 'Launch accepted.'
        : receipt?.status === 'rejected' ? `Launch rejected: ${receipt.message ?? 'Review the source and retry.'}`
          : receipt?.status === 'recovery-required' ? 'Launch requires Recovery. Its outcome is not confirmed.' : command.message || 'Launch pending. Its outcome is not confirmed.');
      note.setAttribute('role', 'status'); box.append(note);
      if (receipt?.status === 'accepted' && receipt.runId) {
        const href = `/runs?${new URLSearchParams({ run: receipt.runId, repo: command.input.repo })}`; const link = element('a', this.state.pirateMode ? 'Open voyage' : 'Open run'); link.href = href;
        link.addEventListener('click', event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); this.context.navigate(href); } }); box.append(link);
      }
      if (command.requestId) {
        const terminal = receipt?.status === 'accepted' || receipt?.status === 'rejected';
        const action = element('button', terminal ? 'Dismiss saved launch' : 'Check launch receipt'); action.type = 'button'; action.disabled = command.busy;
        action.addEventListener('click', () => { void this.commandAction(command, terminal ? 'dismiss' : 'receipt'); }); box.append(action);
        if (!receipt || receipt.status === 'pending') {
          const retry = element('button', 'Retry delivery'); retry.type = 'button'; retry.disabled = command.busy || !this.context.services.runCommands?.retry;
          retry.addEventListener('click', () => { void this.commandAction(command, 'retry'); }); box.append(retry);
        }
      }
      if (receipt?.status === 'recovery-required') { const recovery = element('a', 'Open Recovery'); recovery.href = `/recovery?${new URLSearchParams({ repo: command.input.repo })}`; box.append(recovery); }
      page.append(box);
    }
    if (!this.sections.length && !this.messages.length) { const note = element('p', this.pending ? 'Loading task sources…' : 'No task sources in this scope.'); note.setAttribute('role', 'status'); page.append(note); }
    const routeGroup = this.routeGroup(); const routeKey = routeGroup ? JSON.stringify([this.state.activity.repo, this.state.routeState]) : null;
    if (!routeKey) this.revealedRoute = null;
    const routeSections = routeKey !== this.revealedRoute && this.current(this.generation) ? this.sections.filter(section => section.group === routeGroup) : [];
    if (routeSections.length) { for (const section of routeSections) this.expand(section); this.revealedRoute = routeKey; }
    const sections = element('div'); sections.className = 'triage-grid';
    for (const section of this.sections) {
      const view = element('section'); view.dataset.triageGroup = section.group; view.dataset.triageFocus = `group:${this.sectionKey(section)}`; view.tabIndex = -1; view.className = 'triage-column';
      const heading = element('div'); heading.className = 'triage-column-heading';
      const identity = element('div'); identity.className = 'triage-column-identity'; identity.append(element('h3', titles[section.group]));
      const sourceContext = element('small', this.sourceLabel(section.source)); sourceContext.className = 'triage-column-source'; identity.append(sourceContext); heading.append(identity); view.append(heading);
      if (section.group !== 'mine-open' && this.actionErrors.has(actionSourceKey(section.source))) { const note = element('p', this.actionErrors.get(actionSourceKey(section.source))); note.setAttribute('role', 'status'); view.append(note); }
      if (section.error) { const error = element('p', section.error); error.setAttribute('role', 'status'); view.append(error); }
      const collapse = element('button', this.isCollapsed(section) ? 'Expand group' : 'Collapse group'); collapse.type = 'button'; collapse.setAttribute('aria-label', `${collapse.textContent} ${titles[section.group]}`);
      collapse.className = 'triage-collapse'; collapse.setAttribute('aria-expanded', String(!this.isCollapsed(section)));
      collapse.dataset.triageFocus = `collapse:${this.sectionKey(section)}`;
      collapse.addEventListener('click', () => { const id = this.sectionKey(section); const expanding = this.isCollapsed(section); if (expanding) this.expand(section); else { this.expanded.delete(id); this.collapsed.add(id); } this.draw(); if (expanding) this.reloadExpandedDescriptions(this.generation); void this.persistSettings(); }); heading.append(collapse);
      if (this.isCollapsed(section)) { sections.append(view); continue; }
      const snapshot = section.snapshots[section.pages - 1];
      if (snapshot?.page.quality === 'partial') view.append(element('p', 'Partial coverage. Continue to inspect more matching tasks.'));
      if (snapshot && snapshot.relatedRunsQuality !== 'complete') view.append(element('p', 'Some related runs are unavailable.'));
      const list = element('ul');
      for (const task of section.tasks) {
        const row = element('li'); row.className = 'triage-task';
        const title = element(task.url ? 'a' : 'span', task.title); title.className = 'triage-task-title';
        if (title instanceof HTMLAnchorElement && task.url) { title.href = task.url; title.target = '_blank'; title.rel = 'noopener noreferrer'; }
        row.append(title);
        const identity = element('div'); identity.className = 'triage-task-identity'; identity.append(element('small', task.displayKey));
        const date = element('small', updatedDate(task.updatedAt)); if (task.updatedAt) date.title = task.updatedAt; identity.append(date); row.append(identity);
        const metadata = element('div'); metadata.className = 'triage-task-metadata';
        const knownState = task.state && Object.hasOwn(taskStates, task.state) ? task.state as keyof typeof taskStates : 'unknown';
        const state = element('span', knownState === 'unknown' ? 'Status unknown' : taskStates[knownState]); state.className = 'triage-task-state'; state.dataset.state = knownState; state.prepend(createIcon(knownState)); metadata.append(state);
        const priority = element('span', task.priority !== null && Number.isInteger(task.priority) && task.priority >= 0 && task.priority <= 4 ? `P${task.priority}` : 'Priority unknown'); priority.className = 'triage-task-priority'; priority.dataset.priority = task.priority === null ? 'unknown' : String(task.priority); priority.prepend(createIcon('priority')); metadata.append(priority); row.append(metadata); list.append(row);
        row.append(this.description(section, task));
        const actions = element('div'); actions.className = 'triage-task-actions'; row.append(actions);
        const assignment = this.assignmentInput(section, task);
        if (assignment) {
          const assign = element('button', 'Assign to me'); assign.type = 'button'; assign.setAttribute('aria-label', `Assign ${task.displayKey} to me`);
          assign.dataset.triageFocus = `assign:${this.descriptionFocusKey(section, task)}`; assign.dataset.assignmentKey = assignmentKey(assignment);
          assign.disabled = !this.assignmentReady || !this.current(this.generation) || Boolean(this.pending) || section.loading || Boolean(section.error) || this.assignments.has(assignmentKey(assignment));
          assign.addEventListener('click', () => { assign.focus({ preventScroll: true }); void this.assign(section, task); }); actions.append(assign);
        }
        const related = snapshot?.relatedRuns.find(run => run.ref.sourceId === task.ref.sourceId && run.ref.externalId === task.ref.externalId);
        if (related) { const href = `/runs?${new URLSearchParams({ repo: related.repo, run: related.runId })}`; const link = element('a', this.state.pirateMode ? 'Open related voyage' : 'Open related run'); link.href = href; link.prepend(createIcon('run')); actions.append(link); }
        if (this.state.repo !== null && task.state !== 'ready') { const note = element('small', 'Not ready for a new run.'); note.className = 'triage-launch-note'; row.append(note); }
        if (this.state.repo !== null && task.state === 'ready') {
          const launch = element('button', 'Launch'); launch.type = 'button'; launch.className = 'triage-launch'; launch.prepend(createIcon('ready')); launch.setAttribute('aria-label', `Launch ${task.displayKey}`);
          launch.disabled = !this.evidenceReady || !this.state.visible || !this.state.activity.active || this.state.repo !== section.source.repo
            || Boolean(this.pending) || section.loading || Boolean(section.error) || this.hasCommand(JSON.stringify([section.source.repo, task.ref.sourceId, task.ref.externalId]));
          launch.addEventListener('click', () => { void this.launch(section, task); }); actions.append(launch);
        }
      }
      view.append(list);
      if (!section.tasks.length && !section.error) view.append(element('p', section.loading ? 'Loading tasks…' : 'No tasks match these filters.'));
      const previous = element('button', 'Previous'); previous.type = 'button'; previous.setAttribute('aria-label', `Previous page for ${titles[section.group]}`); previous.disabled = section.pages <= 1 || Boolean(this.pending); previous.addEventListener('click', () => this.showPage(section, section.pages - 1));
      const next = element('button', 'Next'); next.type = 'button'; next.setAttribute('aria-label', `Next page for ${titles[section.group]}`); next.disabled = !section.cursor || section.pages >= 20 || Boolean(this.pending); next.addEventListener('click', () => this.more(section));
      const pagination = element('nav'); pagination.className = 'triage-pagination'; pagination.setAttribute('aria-label', `${titles[section.group]} pages`); pagination.append(previous, element('span', `Page ${Math.max(1, section.pages)}`), next); view.append(pagination);
      if (section.cursor && section.pages >= 20) view.append(element('p', 'Coverage is limited to 20 pages per group. Narrow the filters.'));
      sections.append(view);
    }
    page.append(sections);
    this.container.replaceChildren(page);
    const routeTarget = routeSections[0] ? `group:${this.sectionKey(routeSections[0])}` : null;
    const target = routeTarget ?? focused;
    if (target) {
      const node = Array.from(this.container.querySelectorAll<HTMLElement>('[data-triage-focus]')).find(value => value.dataset.triageFocus === target);
      const focusTarget = node instanceof HTMLButtonElement && node.disabled && node.dataset.assignmentKey
        ? Array.from(this.container.querySelectorAll<HTMLElement>('[data-triage-focus]')).find(value => value.dataset.triageFocus === `assignment-status:${node.dataset.assignmentKey}`) : node;
      focusTarget?.focus({ preventScroll: true }); if (routeTarget) node?.scrollIntoView?.({ block: 'nearest' });
    }
  }
  update(state: PluginPanelState): void {
    if (this.disposed) return;
    const previous = this.state; this.state = state;
    const selectionChanged = !this.selectionDirty && JSON.stringify(previous.savedState) !== JSON.stringify(state.savedState);
    if (selectionChanged) this.restoreSettings(state.savedState);
    if (previous.activity.signal !== state.activity.signal) { previous.activity.signal.removeEventListener('abort', this.suspend); state.activity.signal.addEventListener('abort', this.suspend, { once: true }); }
    if (selectionChanged || previous.activity.epoch !== state.activity.epoch || previous.repo !== state.repo) { this.cancel(); this.sections = []; this.sources = []; this.messages = []; this.descriptions.clear(); this.commands.clear(); this.commandError = ''; this.assignments.clear(); this.assignmentError = ''; }
    if (!state.activity.active || !state.visible) this.cancel();
    this.draw();
    if (state.activity.active && state.visible && (selectionChanged || previous.activity.epoch !== state.activity.epoch || !previous.activity.active || !previous.visible)) void this.refresh();
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.cancel();
    this.context.signal.removeEventListener('abort', this.abort); this.state.activity.signal.removeEventListener('abort', this.suspend);
  }
}
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.tasks?.version !== 1 || context.services.taskViews?.version !== 1 || context.services.runCommands?.version !== 1) throw new Error('Triage requires task reads and durable run commands');
  return new TriagePanel(container, context);
} };
export default panel;
