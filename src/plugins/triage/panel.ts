import type { PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, TaskReadSourceV1, TaskTriageItemV1, RunCommandInputV1, RunCommandPendingV1, RunCommandReceiptV1, TaskTriageGroupV1, TaskTriageReadSnapshotV1 } from '@helmsman/plugin-sdk';
import { styles } from './styles.js';

interface Selection { sourceId: string; instanceId: string; repo: string; }
interface Section { source: TaskReadSourceV1; group: TaskTriageGroupV1; tasks: readonly TaskTriageItemV1[]; cursor: string | null; pages: number; error: string; loading: boolean; snapshots: TaskTriageReadSnapshotV1[]; }
const groups: readonly TaskTriageGroupV1[] = ['unassigned-backlog', 'unassigned-todo', 'mine-open'];
const titles: Record<TaskTriageGroupV1, string> = { 'unassigned-backlog': 'Unassigned · Backlog', 'unassigned-todo': 'Unassigned · To Do', 'mine-open': 'Mine · Open' };
const dayOptions = [0, 30, 7, 1]; const pageSizes = [5, 10, 25, 50, 100];
interface LaunchState { input: RunCommandInputV1; requestId: string | null; receipt: RunCommandReceiptV1 | null; busy: boolean; message: string; }
function commandKey(input: RunCommandInputV1): string | null {
  return input.action === 'launch' && input.launch.mode === 'source' ? JSON.stringify([input.repo, input.launch.workRef.sourceId, input.launch.workRef.externalId]) : null;
}
const key = (source: Selection): string => JSON.stringify([source.repo, source.sourceId, source.instanceId]);
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;
};

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
  private cancel() { ++this.generation; this.controller?.abort(); this.controller = null; this.pending = null; this.evidenceReady = false; for (const command of this.commands.values()) command.busy = false; }
  private current(generation: number): boolean { return !this.disposed && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  refresh(): Promise<void> {
    if (this.disposed || !this.state.activity.active || this.state.activity.signal.aborted || !this.state.visible) return Promise.resolve();
    if (this.pending) return this.pending;
    this.evidenceReady = false; this.sections = []; this.until = new Date().toISOString();
    const generation = ++this.generation; const controller = new AbortController(); this.controller = controller;
    const promise = Promise.resolve().then(async () => {
      await this.restoreCommands(generation);
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
      this.draw(); let index = 0;
      await Promise.all(Array.from({ length: Math.min(4, this.sections.length) }, async () => {
        while (index < this.sections.length && this.current(generation)) {
          const section = this.sections[index++]!;
          if (section.source.availability === 'available') await this.readPage(section, generation, controller.signal);
        }
      }));
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
  private showPage(section: Section, page: number): void {
    const snapshot = section.snapshots[page - 1]; if (!snapshot || this.pending) return;
    section.pages = page; section.tasks = snapshot.page.items; section.cursor = snapshot.page.nextCursor; section.error = snapshot.page.quality === 'unavailable' ? 'This group is unavailable.' : ''; this.draw();
  }
  private restoreSettings(saved: PluginPanelState['savedState']): void {
    const value = saved?.version === 1 && saved.value && typeof saved.value === 'object' && !Array.isArray(saved.value) ? saved.value as Record<string, unknown> : null;
    this.chosen = selection(value?.source); this.invalidSelection = saved !== null && (!value || value.source !== null && !this.chosen);
    this.priorities = Array.isArray(value?.priorities) ? [0, 1, 2, 3, 4].filter(number => (value.priorities as unknown[]).includes(number)) : [0, 1, 2, 3, 4];
    this.days = dayOptions.find(number => number === value?.days) ?? 0; this.pageSize = pageSizes.find(number => number === value?.pageSize) ?? 10;
    this.collapsed = new Set(Array.isArray(value?.collapsed) ? value.collapsed.filter((id): id is string => typeof id === 'string' && id.length < 2048).slice(0, 150) : []);
  }
  private savedSettings(chosen = this.chosen) { return { version: 1, value: { source: chosen, priorities: this.priorities, days: this.days, pageSize: this.pageSize, collapsed: [...this.collapsed] } }; }
  private async persistSettings(): Promise<void> {
    if (this.invalidSelection) return;
    const save = ++this.selectionSave; this.selectionDirty = true;
    try { await this.context.saveState(this.savedSettings()); if (!this.disposed && save === this.selectionSave) { this.selectionDirty = false; this.saveError = ''; } }
    catch { if (!this.disposed && save === this.selectionSave) { this.saveError = 'These panel settings could not be saved.'; this.draw(); } }
  }
  private filterChanged(): void { this.cancel(); void this.persistSettings(); void this.refresh(); }
  private filters(page: HTMLElement): void {
    const filters = element('fieldset'); filters.disabled = this.invalidSelection; filters.append(element('legend', 'Filter all triage columns'));
    for (let priority = 0; priority < 5; priority++) { const label = element('label', `P${priority}`); const input = element('input'); input.type = 'checkbox'; input.checked = this.priorities.includes(priority); input.setAttribute('aria-label', `Priority P${priority}`); input.dataset.triageFocus = `priority-${priority}`;
      input.addEventListener('change', () => { this.priorities = [0, 1, 2, 3, 4].filter(number => number === priority ? input.checked : this.priorities.includes(number)); this.filterChanged(); }); label.prepend(input); filters.append(label); }
    for (const [title, values, current, apply] of [['Last updated', dayOptions, this.days, (value: number) => { this.days = value; }], ['Tickets per column', pageSizes, this.pageSize, (value: number) => { this.pageSize = value; }]] as const) {
      const label = element('label', title); const select = element('select'); select.setAttribute('aria-label', title); select.dataset.triageFocus = title;
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
        const result = action === 'retry' ? await this.context.services.runCommands!.submit(command.input, this.state.activity.signal)
          : await this.context.services.runCommands!.receipt(query, this.state.activity.signal);
        if (this.current(generation)) {
          if (result.status === 'available' && result.value) { command.receipt = result.value; command.message = ''; }
          else command.message = 'No confirmed receipt is available. The saved request remains protected.';
        }
      }
    } catch { if (this.current(generation)) command.message = 'Could not update the saved request. Refresh to retry.'; }
    finally { if (this.current(generation)) { command.busy = false; await this.restoreCommands(generation); this.draw(); } }
  }
  private draw(): void {
    if (this.disposed) return;
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement.dataset.triageFocus : null;
    const page = element('div'); page.className = 'plugin-triage'; page.append(element('style', styles));
    const toolbar = element('div'); toolbar.className = 'triage-toolbar'; toolbar.append(element('h2', 'Triage'));
    const select = element('select'); select.setAttribute('aria-label', 'Task source'); select.dataset.triageFocus = 'source';
    const all = element('option', 'All task sources'); all.value = ''; select.append(all);
    if (this.invalidSelection) { const unsupported = element('option', 'Saved source selection unavailable'); unsupported.value = 'unsupported'; select.append(unsupported); }
    for (const source of this.sources) { const option = element('option', `${source.label} · ${source.repo}${source.availability === 'available' ? '' : ` (${source.availability})`}`); option.value = key(source); select.append(option); }
    if (this.chosen && !this.sources.some(source => key(source) === key(this.chosen!))) { const option = element('option', `Unavailable source · ${this.chosen.repo}`); option.value = key(this.chosen); select.append(option); }
    select.value = this.invalidSelection ? 'unsupported' : this.chosen ? key(this.chosen) : ''; select.addEventListener('change', () => { void this.choose(select.value); }); toolbar.append(select);
    const refresh = element('button', 'Refresh'); refresh.type = 'button'; refresh.dataset.triageFocus = 'refresh'; refresh.disabled = Boolean(this.pending); refresh.addEventListener('click', () => { void this.refresh(); }); toolbar.append(refresh); page.append(toolbar);
    this.filters(page);
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
          const retry = element('button', 'Retry delivery'); retry.type = 'button'; retry.disabled = command.busy;
          retry.addEventListener('click', () => { void this.commandAction(command, 'retry'); }); box.append(retry);
        }
      }
      if (receipt?.status === 'recovery-required') { const recovery = element('a', 'Open Recovery'); recovery.href = `/recovery?${new URLSearchParams({ repo: command.input.repo })}`; box.append(recovery); }
      page.append(box);
    }
    if (!this.sections.length && !this.messages.length) { const note = element('p', this.pending ? 'Loading task sources…' : 'No task sources in this scope.'); note.setAttribute('role', 'status'); page.append(note); }
    const sections = element('div'); sections.className = 'triage-grid';
    for (const section of this.sections) {
      const view = element('section'); view.append(element('h3', `${section.source.label} · ${section.source.repo} · ${titles[section.group]}`));
      if (section.error) { const error = element('p', section.error); error.setAttribute('role', 'status'); view.append(error); }
      const collapse = element('button', this.collapsed.has(this.sectionKey(section)) ? 'Expand group' : 'Collapse group'); collapse.type = 'button'; collapse.setAttribute('aria-label', `${collapse.textContent} ${titles[section.group]}`);
      collapse.addEventListener('click', () => { const id = this.sectionKey(section); if (!this.collapsed.delete(id)) this.collapsed.add(id); this.draw(); void this.persistSettings(); }); view.append(collapse);
      if (this.collapsed.has(this.sectionKey(section))) { sections.append(view); continue; }
      const snapshot = section.snapshots[section.pages - 1];
      if (snapshot?.page.quality === 'partial') view.append(element('p', 'Partial coverage. Continue to inspect more matching tasks.'));
      if (snapshot && snapshot.relatedRunsQuality !== 'complete') view.append(element('p', 'Some related runs are unavailable.'));
      const list = element('ul');
      for (const task of section.tasks) {
        const row = element('li');
        if (task.url) { const link = element('a', `${task.displayKey}: ${task.title}`); link.href = task.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
        else row.append(element('span', `${task.displayKey}: ${task.title}`));
        row.append(element('small', `P${task.priority} · ${task.state} · Updated ${task.updatedAt}`)); list.append(row);
        const related = snapshot?.relatedRuns.find(run => run.ref.sourceId === task.ref.sourceId && run.ref.externalId === task.ref.externalId);
        if (related) { const href = `/runs?${new URLSearchParams({ repo: related.repo, run: related.runId })}`; const link = element('a', this.state.pirateMode ? 'Open related voyage' : 'Open related run'); link.href = href; row.append(link); }
        if (this.state.repo !== null && task.state !== 'ready') row.append(element('small', 'Not ready for a new run.'));
        if (this.state.repo !== null && task.state === 'ready') {
          const launch = element('button', 'Launch'); launch.type = 'button';
          launch.disabled = !this.evidenceReady || !this.state.visible || !this.state.activity.active || this.state.repo !== section.source.repo
            || Boolean(this.pending) || section.loading || Boolean(section.error) || this.hasCommand(JSON.stringify([section.source.repo, task.ref.sourceId, task.ref.externalId]));
          launch.addEventListener('click', () => { void this.launch(section, task); }); row.append(launch);
        }
      }
      view.append(list);
      if (!section.tasks.length && !section.error) view.append(element('p', section.loading ? 'Loading tasks…' : 'No tasks match these filters.'));
      const previous = element('button', 'Previous'); previous.type = 'button'; previous.setAttribute('aria-label', `Previous page for ${titles[section.group]}`); previous.disabled = section.pages <= 1 || Boolean(this.pending); previous.addEventListener('click', () => this.showPage(section, section.pages - 1));
      const next = element('button', 'Next'); next.type = 'button'; next.setAttribute('aria-label', `Next page for ${titles[section.group]}`); next.disabled = !section.cursor || section.pages >= 20 || Boolean(this.pending); next.addEventListener('click', () => this.more(section));
      view.append(previous, element('span', `Page ${Math.max(1, section.pages)}`), next);
      if (section.cursor && section.pages >= 20) view.append(element('p', 'Coverage is limited to 20 pages per group. Narrow the filters.'));
      sections.append(view);
    }
    page.append(sections);
    this.container.replaceChildren(page);
    if (focused) Array.from(this.container.querySelectorAll<HTMLElement>('[data-triage-focus]')).find(value => value.dataset.triageFocus === focused)?.focus({ preventScroll: true });
  }
  update(state: PluginPanelState): void {
    if (this.disposed) return;
    const previous = this.state; this.state = state;
    const selectionChanged = !this.selectionDirty && JSON.stringify(previous.savedState) !== JSON.stringify(state.savedState);
    if (selectionChanged) this.restoreSettings(state.savedState);
    if (previous.activity.signal !== state.activity.signal) { previous.activity.signal.removeEventListener('abort', this.suspend); state.activity.signal.addEventListener('abort', this.suspend, { once: true }); }
    if (selectionChanged || previous.activity.epoch !== state.activity.epoch || previous.repo !== state.repo) { this.cancel(); this.sections = []; this.sources = []; this.messages = []; this.commands.clear(); this.commandError = ''; }
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
