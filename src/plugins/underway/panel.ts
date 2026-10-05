import type { PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, TaskContextSnapshotV1, TaskReadSourceV1, TaskReadTaskV1, RunCommandInputV1, RunCommandPendingV1, RunCommandReceiptV1 } from '@helmsman/plugin-sdk';

interface Selection { sourceId: string; instanceId: string; repo: string; }
interface Section { source: TaskReadSourceV1; tasks: readonly TaskReadTaskV1[]; context: Map<string, TaskContextSnapshotV1>; cursor: string | null; pages: number; error: string; loading: boolean; }
interface LaunchState { input: RunCommandInputV1; requestId: string | null; receipt: RunCommandReceiptV1 | null; busy: boolean; message: string; }
function commandKey(input: RunCommandInputV1): string | null {
  return input.action === 'launch' && input.launch.mode === 'source' ? JSON.stringify([input.repo, input.launch.workRef.sourceId, input.launch.workRef.externalId]) : null;
}
const key = (source: Selection): string => JSON.stringify([source.repo, source.sourceId, source.instanceId]);
const taskKey = (task: TaskReadTaskV1): string => JSON.stringify([task.ref.sourceId, task.ref.externalId, task.revision]);
const taskFocusKey = (source: TaskReadSourceV1, task: TaskReadTaskV1, control: string): string => JSON.stringify([source.repo, source.sourceId, source.instanceId, task.ref.sourceId, task.ref.externalId, control]);
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;
};
const styles = `.plugin-underway{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;color:var(--text);font:16px var(--sans,sans-serif);min-width:0}.plugin-underway h2,.plugin-underway h3{font-size:16px;margin:0}.plugin-underway .underway-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0}.plugin-underway :is(button,select){font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);padding:6px 9px;border-radius:6px;max-width:100%}.plugin-underway select{background-color:var(--control-bg,var(--face-hi));border-color:var(--control-border,var(--line-strong))}.plugin-underway button{cursor:pointer}.plugin-underway button:disabled{opacity:.5}.plugin-underway ul{list-style:none;padding:0;margin:0}.plugin-underway li{padding:12px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.plugin-underway a{color:var(--accent)}.plugin-underway small{display:block;color:var(--text-dim)}.plugin-underway section{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;min-width:0}.plugin-underway [role=alert]{color:var(--bad)}.plugin-underway :is(button,select,a):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-underway{line-height:1.5;overflow-wrap:anywhere}
.plugin-underway :is(h2,h3,p){margin:0}
.plugin-underway h2{font-size:17px;font-weight:650}
.plugin-underway h3{font-size:15px;font-weight:600;color:var(--text-dim)}
.plugin-underway :is(button,select,input:not([type=checkbox]):not([type=radio])){min-height:34px}
.plugin-underway :is(button,select,input,textarea){font-family:var(--sans,sans-serif);min-width:0}
.plugin-underway button{transition:background-color 160ms ease,color 160ms ease}
.plugin-underway button:not(:disabled):hover{background:var(--panel-hover,var(--panel));border-color:var(--accent)}
.plugin-underway button:disabled{cursor:not-allowed}
.plugin-underway :is(a,button){text-underline-offset:3px}
.plugin-underway small{font-size:14px;line-height:1.5}
.plugin-underway li:last-child{border-bottom:0}
.plugin-underway .work-state{display:inline-flex;align-items:center;justify-self:start;gap:4px;padding:2px 8px;border:1px solid var(--line);border-radius:6px;font-size:14px;font-weight:600;color:var(--text);background:var(--panel)}
.plugin-underway .work-identity{font-family:var(--mono,monospace);font-size:14px;overflow-wrap:anywhere}
@media(prefers-reduced-motion:reduce){.plugin-underway button{transition:none}}
.plugin-underway li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 12px;align-items:start}
.plugin-underway .task-title{grid-column:1/-1;font-size:17px;font-weight:600;line-height:1.45;color:var(--text);text-decoration:none}
.plugin-underway a.task-title:hover{color:var(--accent);text-decoration:underline}
.plugin-underway .task-evidence{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;grid-column:1/-1}
.plugin-underway li>small{grid-column:1/-1}
.plugin-underway .task-title + .task-evidence{margin-bottom:4px}
.plugin-underway li>button{justify-self:start}
.plugin-underway .underway-toolbar select{flex:1;max-width:100%;min-width:0}
[role=tabpanel][aria-labelledby][data-panel-instance] .plugin-underway>.underway-toolbar>h2{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
`;
function selection(value: unknown): Selection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return typeof input.sourceId === 'string' && typeof input.instanceId === 'string' && typeof input.repo === 'string'
    && input.sourceId.length <= 160 && input.instanceId.length <= 160 && input.repo.length <= 512
    ? { sourceId: input.sourceId, instanceId: input.instanceId, repo: input.repo } : null;
}

class UnderwayPanel implements PluginPanelInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private state: PluginPanelState;
  private chosen: Selection | null;
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
  private contextController: AbortController | null = null;
  private generation = 0;
  private pending: Promise<void> | null = null;
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state;
    const saved = context.state.savedState;
    this.chosen = saved?.version === 1 ? selection(saved.value) : null;
    this.invalidSelection = saved !== null && !this.chosen;
    context.onDispose(() => this.dispose()); context.signal.addEventListener('abort', this.abort, { once: true });
    this.state.activity.signal.addEventListener('abort', this.suspend, { once: true });
    if (context.signal.aborted) { this.dispose(); return; }
    this.draw(); void this.refresh();
  }
  private abort = () => this.dispose();
  private suspend = () => { this.cancel(); };
  private cancel() { ++this.generation; this.controller?.abort(); this.controller = null; this.contextController?.abort(); this.contextController = null; this.pending = null; this.evidenceReady = false; for (const command of this.commands.values()) command.busy = false; }
  private current(generation: number): boolean { return !this.disposed && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  refresh(): Promise<void> {
    if (this.disposed || !this.state.activity.active || this.state.activity.signal.aborted || !this.state.visible) return Promise.resolve();
    if (this.pending) return this.pending;
    this.contextController?.abort(); this.contextController = null;
    this.evidenceReady = false; this.sections = [];
    const generation = ++this.generation; const controller = new AbortController(); const contextController = new AbortController(); this.controller = controller; this.contextController = contextController;
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
        else sources.push(...galleon.sources.value);
      }
      this.sources = sources;
      const selected = this.invalidSelection ? [] : this.chosen ? sources.filter(source => key(source) === key(this.chosen!)) : sources;
      if (this.invalidSelection) this.messages.push('The saved source selection uses unsupported data. Choose a source to replace it.');
      if (this.chosen && !selected.length) this.messages.push('The selected source is unavailable in this scope. Your selection is kept.');
      if (selected.length > 50) this.messages.push('Showing the first 50 source views. Select a source to inspect another view.');
      this.sections = selected.slice(0, 50).map(source => ({ source, tasks: [], context: new Map(), cursor: null, pages: 0, error: source.availability !== 'available' ? `Source ${source.availability}.` : !source.readViews?.includes('underway') ? 'This source does not provide the Underway view.' : '', loading: source.availability === 'available' && Boolean(source.readViews?.includes('underway')) }));
      this.draw(); let index = 0;
      await Promise.all(Array.from({ length: Math.min(4, this.sections.length) }, async () => {
        while (index < this.sections.length && this.current(generation)) {
          const section = this.sections[index++]!;
          if (section.source.availability === 'available' && section.source.readViews?.includes('underway')) await this.readPage(section, generation, controller.signal, contextController.signal);
        }
      }));
    }).catch(() => { if (this.current(generation) && !controller.signal.aborted) this.messages = ['Tasks could not be read. Refresh to retry.']; }).finally(() => {
      if (generation === this.generation && !this.disposed) { this.controller = null; this.pending = null; this.draw(); }
    });
    this.pending = promise; this.draw(); return promise;
  }
  private async readPage(section: Section, generation: number, signal: AbortSignal, contextSignal: AbortSignal): Promise<void> {
    try {
      const result = await this.context.services.tasks!.underway!({ ...section.source, cursor: section.cursor, limit: 25 }, signal);
      if (!this.current(generation)) return;
      if (result.status === 'unavailable') { section.error = `Tasks unavailable (${result.reason}).`; return; }
      const seen = new Set(section.tasks.map(task => JSON.stringify(task.ref)));
      if (result.value.items.some(task => seen.has(JSON.stringify(task.ref)))) { section.error = 'Task pagination changed. Refresh this panel.'; section.cursor = null; return; }
      section.tasks = [...section.tasks, ...result.value.items]; section.cursor = result.value.nextCursor; section.pages++; section.error = '';
      this.draw(); void this.readContext(section, result.value.items, generation, AbortSignal.any([signal, contextSignal]));
    } catch { if (this.current(generation) && !signal.aborted) section.error = 'Tasks could not be read. Refresh to retry.'; }
    finally { if (this.current(generation)) { section.loading = false; this.draw(); } }
  }
  private async readContext(section: Section, tasks: readonly TaskReadTaskV1[], generation: number, signal: AbortSignal): Promise<void> {
    const service = this.context.services.taskContext;
    if (service?.version !== 1 || typeof service.resolve !== 'function') return;
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, async () => {
      while (index < tasks.length && this.current(generation)) {
        const task = tasks[index++]!;
        try {
          const result = await service.resolve({ version: 1, selection: section.source, ref: task.ref, taskRevision: task.revision, claim: 'active' }, signal);
          if (this.current(generation) && result.status === 'available') { section.context.set(taskKey(task), result.value); this.draw(); }
        } catch {}
      }
    }));
  }
  private presentationLink(label: string, locator: { readonly version: 1; readonly kind: 'run'; readonly repo: string; readonly runId: string } | { readonly version: 1; readonly kind: 'pull-request'; readonly repo: string; readonly number: number }, href: string, focus: string): HTMLAnchorElement {
    const link = element('a', label); link.href = href;
    link.dataset.underwayFocus = focus;
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (this.context.selectPresentation) this.context.selectPresentation(locator); else this.context.navigate(href);
    });
    return link;
  }
  private presentationHref(kind: 'run' | 'pull-request', repo: string, value: string): string {
    const headerRepo = this.state.headerRepo === undefined ? this.state.repo : this.state.headerRepo;
    const params = new URLSearchParams({ ...(headerRepo ? { repo: headerRepo } : {}), ...(kind === 'run' ? { runRepo: repo, run: value } : { prRepo: repo, pr: value }) });
    return `/${kind === 'run' ? 'runs' : 'prs'}?${params}`;
  }
  private more(section: Section): void {
    if (this.disposed || !section.cursor || section.loading || section.pages >= 10 || this.pending || !this.state.activity.active) return;
    const controller = new AbortController(); this.controller = controller; section.loading = true;
    const generation = this.generation;
    const contextSignal = this.contextController?.signal;
    if (!contextSignal) return;
    this.pending = this.readPage(section, generation, controller.signal, contextSignal).finally(() => {
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
    try { await this.context.saveState(chosen ? { version: 1, value: chosen } : null); if (!this.disposed && save === this.selectionSave) this.selectionDirty = false; }
    catch { if (!this.disposed && save === this.selectionSave) { this.saveError = 'The source selection could not be saved. It remains selected in this panel.'; this.draw(); } }
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
  private async launch(section: Section, task: TaskReadTaskV1): Promise<void> {
    if (!this.current(this.generation) || !this.evidenceReady || this.state.repo === null || task.repo !== this.state.repo || task.state !== 'ready' || this.pending || section.loading || section.error || !this.sections.includes(section)) return;
    const input: RunCommandInputV1 = { version: 1, action: 'launch', repo: task.repo, launch: { mode: 'source', workRef: task.ref,
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
  private draw(): void {
    if (this.disposed) return;
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement.dataset.underwayFocus : null;
    const page = element('div'); page.className = 'plugin-underway'; page.append(element('style', styles));
    const toolbar = element('div'); toolbar.className = 'underway-toolbar'; toolbar.append(element('h2', 'Underway'));
    const select = element('select'); select.setAttribute('aria-label', 'Task source'); select.dataset.underwayFocus = 'source';
    const all = element('option', 'All task sources'); all.value = ''; select.append(all);
    if (this.invalidSelection) { const unsupported = element('option', 'Saved source selection unavailable'); unsupported.value = 'unsupported'; select.append(unsupported); }
    for (const source of this.sources) { const option = element('option', `${source.label} · ${source.repo}${source.availability === 'available' ? '' : ` (${source.availability})`}`); option.value = key(source); select.append(option); }
    if (this.chosen && !this.sources.some(source => key(source) === key(this.chosen!))) { const option = element('option', `Unavailable source · ${this.chosen.repo}`); option.value = key(this.chosen); select.append(option); }
    select.value = this.invalidSelection ? 'unsupported' : this.chosen ? key(this.chosen) : ''; select.addEventListener('change', () => { void this.choose(select.value); }); toolbar.append(select);
    const refresh = element('button', 'Refresh'); refresh.type = 'button'; refresh.dataset.underwayFocus = 'refresh'; refresh.disabled = Boolean(this.pending); refresh.addEventListener('click', () => { void this.refresh(); }); toolbar.append(refresh); page.append(toolbar);
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
      if (receipt?.status === 'recovery-required') { const recovery = element('a', 'Open Recovery'); recovery.href = '/recovery'; box.append(recovery); }
      page.append(box);
    }
    if (!this.sections.length && !this.messages.length) { const note = element('p', this.pending ? 'Loading task sources…' : 'No task sources in this scope.'); note.setAttribute('role', 'status'); page.append(note); }
    for (const section of this.sections) {
      const view = element('section'); view.append(element('h3', `${section.source.label} · ${section.source.repo}`));
      if (section.error) { const error = element('p', section.error); error.setAttribute('role', 'status'); view.append(error); }
      const list = element('ul');
      for (const task of section.tasks) {
        const row = element('li');
        if (task.url) { const link = element('a', task.title); link.className = 'task-title'; link.href = task.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.dataset.underwayFocus = taskFocusKey(section.source, task, 'source'); row.append(link); }
        else { const title = element('span', task.title); title.className = 'task-title'; row.append(title); }
        const evidence = element('div'); evidence.className = 'task-evidence';
        const identity = element('span', task.displayKey); identity.className = 'work-identity';
        const state = element('span', { ready: 'Ready', in_progress: 'In progress', review: 'In review', done: 'Done', blocked: 'Blocked' }[task.state]); state.className = 'work-state';
        evidence.append(identity, state, element('small', task.priority === null ? 'Priority unknown' : `Priority ${task.priority}`)); row.append(evidence);
        const context = section.context.get(taskKey(task));
        if (context && this.state.visible && this.state.activity.active) {
          if (context.run) {
            const locator = { version: 1 as const, kind: 'run' as const, repo: context.run.repo, runId: context.run.runId };
            row.append(this.presentationLink('Open run', locator, this.presentationHref('run', locator.repo, locator.runId), taskFocusKey(section.source, task, 'run')));
          }
          if (context.pullRequest) {
            const locator = { version: 1 as const, kind: 'pull-request' as const, repo: context.pullRequest.repo, number: context.pullRequest.number };
            row.append(this.presentationLink('Open pull request', locator, this.presentationHref('pull-request', locator.repo, String(locator.number)), taskFocusKey(section.source, task, 'pull-request')));
          }
        }
        list.append(row);
        if (this.state.repo !== null && task.state !== 'ready') row.append(element('small', 'Not ready for a new run.'));
        if (this.state.repo !== null && task.state === 'ready') {
          const launch = element('button', 'Launch'); launch.type = 'button';
          launch.dataset.underwayFocus = taskFocusKey(section.source, task, 'launch');
          launch.disabled = !this.evidenceReady || !this.state.visible || !this.state.activity.active || this.state.repo !== task.repo
            || Boolean(this.pending) || section.loading || Boolean(section.error) || this.hasCommand(JSON.stringify([task.repo, task.ref.sourceId, task.ref.externalId]));
          launch.addEventListener('click', () => { void this.launch(section, task); }); row.append(launch);
        }
      }
      view.append(list);
      if (!section.tasks.length && !section.error) view.append(element('p', section.loading ? 'Loading tasks…' : 'No unfinished tasks.'));
      if (section.cursor && section.pages < 10) { const more = element('button', section.loading ? 'Loading…' : 'Load more'); more.type = 'button'; more.disabled = Boolean(this.pending); more.dataset.underwayFocus = key(section.source); more.addEventListener('click', () => this.more(section)); view.append(more); }
      else if (section.cursor) view.append(element('p', `Showing ${section.tasks.length} tasks. Narrow this source in its configuration to see more.`));
      page.append(view);
    }
    this.container.replaceChildren(page);
    if (focused) Array.from(this.container.querySelectorAll<HTMLElement>('[data-underway-focus]')).find(value => value.dataset.underwayFocus === focused)?.focus({ preventScroll: true });
  }
  update(state: PluginPanelState): void {
    if (this.disposed) return;
    const previous = this.state; this.state = state;
    const selectionChanged = !this.selectionDirty && JSON.stringify(previous.savedState) !== JSON.stringify(state.savedState);
    if (selectionChanged) { this.chosen = state.savedState?.version === 1 ? selection(state.savedState.value) : null; this.invalidSelection = state.savedState !== null && !this.chosen; }
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
  if (context.services.tasks?.version !== 1 || typeof context.services.tasks.underway !== 'function' || context.services.runCommands?.version !== 1) throw new Error('Underway requires task views and durable run commands');
  return new UnderwayPanel(container, context);
} };
export default panel;
