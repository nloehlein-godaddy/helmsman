import type { PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, TaskReadSourceV1, TaskBugsReportV1, TaskBugCountV1 } from '@helmsman/plugin-sdk';
import { styles } from './styles.js';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
interface View { source: TaskReadSourceV1; report: TaskBugsReportV1 | null; error: string; }
interface Selection { repo: string; sourceId: string; instanceId: string; }
const key = (source: Selection) => JSON.stringify([source.repo, source.sourceId, source.instanceId]);
const count = (value: TaskBugCountV1): string => value.value === null ? 'Unavailable' : `${value.quality === 'approximate' ? '≈ ' : ''}${value.value.toLocaleString('en-US')}`;
function selection(value: unknown): Selection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null; const source = value as Record<string, unknown>;
  return typeof source.repo === 'string' && typeof source.sourceId === 'string' && typeof source.instanceId === 'string'
    ? { repo: source.repo, sourceId: source.sourceId, instanceId: source.instanceId } : null;
}
class BugsPanel implements PluginPanelInstance {
  private readonly container: HTMLElement; private readonly context: PluginPanelContext;
  private state: PluginPanelState; private disposed = false; private generation = 0;
  private controller: AbortController | null = null; private pending: Promise<void> | null = null;
  private views: View[] = []; private sources: TaskReadSourceV1[] = []; private messages: string[] = [];
  private selected: Selection | null; private invalidSelection = false; private dirty = false; private saveSequence = 0; private saveError = '';
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context;
    this.state = context.state; this.selected = context.state.savedState?.version === 1 ? selection(context.state.savedState.value) : null;
    this.invalidSelection = context.state.savedState !== null && !this.selected;
    context.onDispose(() => this.dispose()); context.signal.addEventListener('abort', this.dispose, { once: true });
    this.state.activity.signal.addEventListener('abort', this.cancel, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation): boolean { return !this.disposed && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private cancel = (): void => { ++this.generation; this.controller?.abort(); this.controller = null; this.pending = null; };
  refresh(): Promise<void> {
    if (!this.active()) return Promise.resolve(); if (this.pending) return this.pending;
    const generation = ++this.generation; const controller = new AbortController(); this.controller = controller; this.views = []; this.messages = [];
    const pending = Promise.resolve().then(async () => {
      const discovered = await this.context.services.tasks!.discover(controller.signal); if (!this.active(generation)) return;
      this.sources = [];
      if (discovered.status === 'unavailable') { this.messages.push(`Task sources unavailable (${discovered.reason}).`); return; }
      for (const galleon of discovered.value.galleons) {
        if (galleon.sources.status === 'unavailable') this.messages.push(`${galleon.repo}: task sources unavailable.`);
        else this.sources.push(...galleon.sources.value.filter(source => source.readViews?.includes('bugs')));
      }
      const selected = this.invalidSelection ? [] : this.selected ? this.sources.filter(source => key(source) === key(this.selected!)) : this.sources;
      if (this.invalidSelection) this.messages.push('The saved source selection is unsupported. Choose a source to replace it.');
      if (this.selected && !selected.length) this.messages.push('The selected source is unavailable in this scope. Your selection is kept.');
      if (selected.length > 50) this.messages.push('Showing the first 50 source views. Select a source to inspect another view.');
      this.views = selected.slice(0, 50).map(source => ({ source, report: null, error: source.availability === 'available' ? '' : `Source ${source.availability}.` })); this.draw();
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(4, this.views.length) }, async () => {
        while (this.active(generation) && index < this.views.length) {
          const view = this.views[index++]!; if (view.error) continue;
          try {
            const result = await this.context.services.taskViews!.bugs(view.source, controller.signal); if (!this.active(generation)) return;
            if (result.status === 'unavailable') view.error = `Bug metrics unavailable (${result.reason}).`; else view.report = result.value.report;
          } catch { if (this.active(generation)) view.error = 'Bug metrics could not be read. Refresh to retry.'; }
          if (this.active(generation)) this.draw();
        }
      }));
    }).catch(() => { if (this.active(generation)) this.messages = ['Task sources could not be read. Refresh to retry.']; }).finally(() => {
      if (!this.disposed && generation === this.generation) { this.pending = null; this.controller = null; this.draw(); }
    });
    this.pending = pending; this.draw(); return pending;
  }
  private async choose(value: string): Promise<void> {
    const source = this.sources.find(source => key(source) === value); if (value && !source) return;
    this.selected = source ? { repo: source.repo, sourceId: source.sourceId, instanceId: source.instanceId } : null; this.invalidSelection = false; this.dirty = true;
    const selection = this.selected; const sequence = ++this.saveSequence; this.cancel(); void this.refresh();
    try { await this.context.saveState(selection ? { version: 1, value: selection } : null); if (!this.disposed && sequence === this.saveSequence) { this.dirty = false; this.saveError = ''; } }
    catch { if (!this.disposed && sequence === this.saveSequence) { this.saveError = 'The source selection could not be saved.'; this.draw(); } }
  }
  private link(label: string, url: string | null): HTMLElement {
    if (!url) return node('span', label); const link = node('a', label); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
  }
  private report(view: View): HTMLElement {
    const section = node('section'); section.append(node('h3', `${view.source.label} · ${view.source.repo}`));
    if (view.error) { section.append(node('p', view.error)); return section; }
    const report = view.report; if (!report) { section.append(node('p', 'Loading bug metrics…')); return section; }
    section.append(node('p', `Observed ${report.asOf}. Counts reflect current source status; time windows end at this observation.`));
    const metrics = node('dl');
    for (const [label, value] of [['Open bugs', report.open], ['Created · 7 days', report.createdLast7d], ['Completed · 7 days', report.completedLast7d], ['Past due date', report.pastSla]] as const) {
      const metric = node('div'); metric.append(node('dt', label), node('dd', count(value))); metrics.append(metric);
    }
    const oldest = node('div'); oldest.append(node('dt', 'Oldest open'));
    const oldestValue = node('dd'); oldestValue.append(report.oldest ? this.link(`${report.oldest.displayKey} · ${Math.max(0, Math.floor((Date.parse(report.asOf) - Date.parse(report.oldest.createdAt)) / 86_400_000))} days`, report.oldest.url)
      : node('span', report.oldestQuality === 'complete' ? 'None' : 'Unavailable'));
    if (report.oldestQuality !== 'complete') oldestValue.append(node('small', ` · ${report.oldestQuality} coverage`)); oldest.append(oldestValue); metrics.append(oldest);
    const sample = report.resolutionP75; const duration = node('div'); duration.append(node('dt', 'Resolution time · P75'), node('dd', sample.days === null ? 'Unavailable' : `${sample.days} days`),
      node('small', `${sample.sampleSize} sampled · Population ${count(sample.population)} · ${sample.quality}${sample.capped ? ' · capped sample' : ''}`)); metrics.append(duration); section.append(metrics);
    if (report.rowsQuality !== 'complete') section.append(node('p', `Open bug rows have ${report.rowsQuality} coverage.`));
    const scroll = node('div'); scroll.className = 'table-scroll'; const table = node('table'); const head = node('thead'); const labels = node('tr');
    for (const title of ['Key', 'Title', 'Priority', 'Severity', 'Due date']) { const cell = node('th', title); cell.scope = 'col'; labels.append(cell); } head.append(labels); table.append(head);
    const body = node('tbody');
    for (const bug of report.rows) { const row = node('tr'); const id = node('td'); id.append(this.link(bug.displayKey, bug.url)); row.append(id);
      for (const value of [bug.title, bug.priority ?? 'Unknown', bug.severity ?? 'Unknown', bug.dueAt ?? 'Not set']) row.append(node('td', value)); body.append(row); }
    if (!report.rows.length) { const row = node('tr'); const empty = node('td', report.rowsQuality === 'complete' ? 'No open bugs.' : 'Open bug rows are unavailable or incomplete.'); empty.colSpan = 5; row.append(empty); body.append(row); }
    table.append(body); scroll.append(table); section.append(scroll); return section;
  }
  private draw(): void {
    if (this.disposed) return;
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement.dataset.bugsFocus : null;
    const root = node('div'); root.className = 'plugin-bugs'; root.append(node('style', styles));
    const toolbar = node('div'); toolbar.className = 'bugs-toolbar'; toolbar.append(node('h2', 'Bugs'));
    const sources = node('select'); sources.setAttribute('aria-label', 'Bug source'); sources.dataset.bugsFocus = 'source'; const all = node('option', 'All bug sources'); all.value = ''; sources.append(all);
    for (const source of this.sources) { const option = node('option', `${source.label} · ${source.repo}`); option.value = key(source); sources.append(option); }
    if (this.selected && !this.sources.some(source => key(source) === key(this.selected!))) { const missing = node('option', `Unavailable source · ${this.selected.repo}`); missing.value = key(this.selected); sources.append(missing); }
    if (this.invalidSelection) { const invalid = node('option', 'Saved selection unavailable'); invalid.value = 'unsupported'; sources.append(invalid); }
    sources.value = this.invalidSelection ? 'unsupported' : this.selected ? key(this.selected) : ''; sources.addEventListener('change', () => { void this.choose(sources.value); });
    const refresh = node('button', 'Refresh'); refresh.type = 'button'; refresh.dataset.bugsFocus = 'refresh'; refresh.disabled = Boolean(this.pending); refresh.addEventListener('click', () => { void this.refresh(); }); toolbar.append(sources, refresh); root.append(toolbar);
    for (const message of [...this.messages, ...(this.saveError ? [this.saveError] : [])]) { const note = node('p', message); note.setAttribute('role', 'status'); root.append(note); }
    for (const view of this.views) root.append(this.report(view));
    if (!this.views.length && !this.messages.length) root.append(node('p', this.pending ? 'Loading bug sources…' : 'No source provides bug metrics in this scope.'));
    this.container.replaceChildren(root); if (focused) Array.from(root.querySelectorAll<HTMLElement>('[data-bugs-focus]')).find(element => element.dataset.bugsFocus === focused)?.focus({ preventScroll: true });
  }
  update(state: PluginPanelState): void {
    if (this.disposed) return; const previous = this.state; this.state = state;
    const changed = !this.dirty && JSON.stringify(previous.savedState) !== JSON.stringify(state.savedState);
    if (changed) { this.selected = state.savedState?.version === 1 ? selection(state.savedState.value) : null; this.invalidSelection = state.savedState !== null && !this.selected; }
    if (previous.activity.signal !== state.activity.signal) { previous.activity.signal.removeEventListener('abort', this.cancel); state.activity.signal.addEventListener('abort', this.cancel, { once: true }); }
    if (changed || previous.repo !== state.repo || previous.activity.epoch !== state.activity.epoch) { this.cancel(); this.views = []; this.sources = []; this.messages = []; }
    if (!this.active()) this.cancel(); this.draw();
    if (this.active() && (changed || previous.repo !== state.repo || previous.activity.epoch !== state.activity.epoch || !previous.visible || !previous.activity.active)) void this.refresh();
  }
  dispose = (): void => { if (this.disposed) return; this.disposed = true; this.cancel(); this.context.signal.removeEventListener('abort', this.dispose); this.state.activity.signal.removeEventListener('abort', this.cancel); };
}
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.tasks?.version !== 1 || context.services.taskViews?.version !== 1) throw new Error('Bugs requires task sources and task views');
  return new BugsPanel(container, context);
} };
export default panel;
