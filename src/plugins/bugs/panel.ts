import type { PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, TaskReadSourceV1, TaskBugsReportV1, TaskBugCountV1 } from '@helmsman/plugin-sdk';
import { styles } from './styles.js';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
const phosphorGlyphs = { refresh: '\ue094', open: '\ue282', created: '\ue3d6', completed: '\ue184', overdue: '\ue4e2' } as const;
const icon = (name: keyof typeof phosphorGlyphs): HTMLSpanElement => {
  const value = node('span', phosphorGlyphs[name]); value.className = 'bugs-icon'; value.setAttribute('aria-hidden', 'true'); return value;
};
const humanDate = (value: string, includeTime = false): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC', ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(date) + (includeTime ? ' UTC' : '');
};
const dateNode = (value: string, includeTime = false): HTMLTimeElement => {
  const date = node('time', humanDate(value, includeTime)); date.dateTime = value; date.title = value; return date;
};
interface View { source: TaskReadSourceV1; report: TaskBugsReportV1 | null; error: string; }
interface Selection { repo: string; sourceId: string; instanceId: string; }
const key = (source: Selection) => JSON.stringify([source.repo, source.sourceId, source.instanceId]);
const count = (value: TaskBugCountV1): string => value.value === null ? 'Unavailable' : `${value.quality === 'approximate' ? '≈ ' : ''}${value.value.toLocaleString('en-US')}`;
const severity = (value: string | null): { code: string; label: string } | null => {
  if (value === null) return null;
  const match = /^\s*(?:Severity\s+)?(S[0-5])(?:\s*[-:–—]\s*\S[\s\S]*)?\s*$/.exec(value);
  return match ? { code: match[1]!, label: value } : null;
};
function selection(value: unknown): Selection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null; const source = value as Record<string, unknown>;
  return typeof source.repo === 'string' && typeof source.sourceId === 'string' && typeof source.instanceId === 'string'
    ? { repo: source.repo, sourceId: source.sourceId, instanceId: source.instanceId } : null;
}
function savedSelection(value: unknown): Selection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const direct = selection(value); if (direct) return direct;
  const source = (value as Record<string, unknown>).source;
  return source === null ? null : selection(source);
}
function validSavedSettings(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return selection(value) !== null || (value as Record<string, unknown>).source === null || selection((value as Record<string, unknown>).source) !== null;
}
class BugsPanel implements PluginPanelInstance {
  private readonly container: HTMLElement; private readonly context: PluginPanelContext;
  private state: PluginPanelState; private disposed = false; private generation = 0;
  private controller: AbortController | null = null; private pending: Promise<void> | null = null;
  private views: View[] = []; private sources: TaskReadSourceV1[] = []; private messages: string[] = [];
  private selected: Selection | null; private invalidSelection = false; private dirty = false; private saveSequence = 0; private saveError = '';
  private descriptionExpanded = new Set<string>();
  private focusKey: string | undefined;
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context;
    this.state = context.state; this.selected = context.state.savedState?.version === 1 ? savedSelection(context.state.savedState.value) : null;
    this.descriptionExpanded = new Set(this.descriptionKeys(context.state.savedState?.version === 1 ? context.state.savedState.value : null));
    this.invalidSelection = context.state.savedState !== null && !validSavedSettings(context.state.savedState.version === 1 ? context.state.savedState.value : null);
    context.onDispose(() => this.dispose()); context.signal.addEventListener('abort', this.dispose, { once: true });
    this.state.activity.signal.addEventListener('abort', this.cancel, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation): boolean { return !this.disposed && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private cancel = (): void => { ++this.generation; this.controller?.abort(); this.controller = null; this.pending = null; };
  refresh(): Promise<void> {
    if (!this.active()) return Promise.resolve(); if (this.pending) return this.pending;
    const generation = ++this.generation; const controller = new AbortController(); this.controller = controller; this.messages = [];
    const previous = new Map(this.views.map(view => [key(view.source), view]));
    const pending = Promise.resolve().then(async () => {
      const discovered = await this.context.services.tasks!.discover(controller.signal); if (!this.active(generation)) return;
      if (discovered.status === 'unavailable') { this.messages.push(`Task sources unavailable (${discovered.reason}).${this.views.some(view => view.report !== null) ? ' Showing the last observed reports.' : ''} Refresh to retry.`); return; }
      this.sources = [];
      for (const galleon of discovered.value.galleons) {
        if (galleon.sources.status === 'unavailable') this.messages.push(`${galleon.repo}: task sources unavailable.`);
        else this.sources.push(...galleon.sources.value.filter(source => source.readViews?.includes('bugs')));
      }
      const selected = this.invalidSelection ? [] : this.selected ? this.sources.filter(source => key(source) === key(this.selected!)) : this.sources;
      if (this.invalidSelection) this.messages.push('The saved source selection is unsupported. Choose a source to replace it.');
      if (this.selected && !selected.length) this.messages.push('The selected source is unavailable in this scope. Your selection is kept.');
      if (selected.length > 50) this.messages.push('Showing the first 50 source views. Select a source to inspect another view.');
      this.views = selected.slice(0, 50).map(source => ({ source, report: source.availability === 'available' && previous.get(key(source))?.source.instanceRevision === source.instanceRevision ? previous.get(key(source))?.report ?? null : null, error: source.availability === 'available' ? '' : `Source ${source.availability}.` })); this.draw();
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
    }).catch(() => { if (this.active(generation)) this.messages = [`Task sources could not be read.${this.views.some(view => view.report !== null) ? ' Showing the last observed reports.' : ''} Refresh to retry.`]; }).finally(() => {
      if (!this.disposed && generation === this.generation) { this.pending = null; this.controller = null; this.draw(); }
    });
    this.pending = pending; this.draw(); return pending;
  }
  private async choose(value: string): Promise<void> {
    const source = this.sources.find(source => key(source) === value); if (value && !source) return;
    this.selected = source ? { repo: source.repo, sourceId: source.sourceId, instanceId: source.instanceId } : null; this.invalidSelection = false; this.dirty = true;
    const selection = this.selected; const sequence = ++this.saveSequence; this.cancel(); this.views = []; void this.refresh();
    try { await this.context.saveState(this.savedSettings(selection)); if (!this.disposed && sequence === this.saveSequence) { this.dirty = false; this.saveError = ''; } }
    catch { if (!this.disposed && sequence === this.saveSequence) { this.saveError = 'The source selection could not be saved.'; this.draw(); } }
  }
  private descriptionKeys(value: unknown): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const expanded = (value as Record<string, unknown>).descriptionExpanded;
    return Array.isArray(expanded) ? expanded.filter((item): item is string => typeof item === 'string' && item.length <= 2048).slice(0, 150) : [];
  }
  private savedSettings(selection = this.selected) { return { version: 1 as const, value: { source: selection, descriptionExpanded: [...this.descriptionExpanded] } }; }
  private descriptionKey(view: View, bug: TaskBugsReportV1['rows'][number]): string {
    return JSON.stringify([view.source.repo, view.source.sourceId, view.source.instanceId, bug.ref.sourceId, bug.ref.externalId]);
  }
  private toggleDescription(view: View, bug: TaskBugsReportV1['rows'][number]): void {
    const id = this.descriptionKey(view, bug);
    if (this.descriptionExpanded.has(id)) this.descriptionExpanded.delete(id);
    else { if (this.descriptionExpanded.size >= 150) this.descriptionExpanded.delete(this.descriptionExpanded.values().next().value!); this.descriptionExpanded.add(id); }
    const sequence = ++this.saveSequence; this.dirty = true; this.draw();
    void this.context.saveState(this.savedSettings()).then(() => {
      if (!this.disposed && sequence === this.saveSequence) { this.dirty = false; this.saveError = ''; }
    }).catch(() => {
      if (!this.disposed && sequence === this.saveSequence) { this.saveError = 'Description expansion could not be saved.'; this.draw(); }
    });
  }
  private description(view: View, bug: TaskBugsReportV1['rows'][number]): HTMLElement {
    const key = this.descriptionKey(view, bug); const expanded = this.descriptionExpanded.has(key); const contentId = `bugs-description-${encodeURIComponent(JSON.stringify([this.state.instanceId, key]))}`;
    const container = node('div'); container.className = 'bugs-description'; const toggle = node('button', expanded ? 'Hide description' : 'Show description'); toggle.type = 'button';
    toggle.setAttribute('aria-label', `${toggle.textContent} for ${bug.displayKey}`); toggle.setAttribute('aria-expanded', String(expanded)); toggle.setAttribute('aria-controls', contentId); toggle.dataset.bugsFocus = `description:${key}`;
    toggle.addEventListener('click', () => { toggle.focus({ preventScroll: true }); this.toggleDescription(view, bug); }); container.append(toggle);
    if (expanded) { const content = node('div'); content.id = contentId; content.className = 'bugs-description-content';
      content.append(node('p', bug.description?.trim() ? bug.description : 'No description available.')); container.append(content); }
    return container;
  }
  private link(label: string, url: string | null): HTMLElement {
    if (!url) return node('span', label); const link = node('a', label); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
  }
  private severity(value: string | null): HTMLElement {
    const parsed = severity(value);
    if (!parsed) return node('span', value ?? 'Unknown');
    const badge = node('span', parsed.code); badge.className = `severity-badge severity-${parsed.code.toLowerCase()}`;
    badge.setAttribute('aria-label', /^severity\b/i.test(parsed.label.trim()) ? parsed.label.trim() : `Severity ${parsed.label}`); badge.title = parsed.label;
    return badge;
  }
  private sourceLabel(source: TaskReadSourceV1): string {
    const repeated = this.sources.filter(item => item.label === source.label && item.repo === source.repo).length > 1;
    return `${source.label}${repeated ? ` · ${source.instanceId}` : ''}${source.repo === this.state.repo ? '' : ` · ${source.repo}`}`;
  }
  private report(view: View): HTMLElement {
    const section = node('section'); section.className = 'bugs-report';
    const heading = node('div'); heading.className = 'bugs-report-heading';
    const identity = node('div'); identity.className = 'bugs-report-identity'; identity.append(node('h3', view.source.label));
    if (view.source.repo !== this.state.repo) identity.append(node('small', view.source.repo));
    if (this.sources.filter(source => source.label === view.source.label && source.repo === view.source.repo).length > 1) identity.append(node('small', view.source.instanceId));
    heading.append(identity);
    const report = view.report;
    if (report) { const observed = node('small', 'Observed '); observed.className = 'bugs-observed'; observed.append(dateNode(report.asOf, true)); observed.title = 'Counts reflect current source status; time windows end at this observation.'; heading.append(observed); }
    section.append(heading);
    if (view.error) { const error = node('p', `${view.error}${report ? ' Showing the last observed report.' : ''}`); error.className = 'bugs-notice'; error.setAttribute('role', 'status'); section.append(error); }
    if (!report) { if (!view.error) section.append(node('p', 'Loading bug metrics…')); return section; }
    const metrics = node('dl'); metrics.className = 'bugs-metrics';
    for (const [label, value, glyph] of [['Open bugs', report.open, 'open'], ['Created · 7 days', report.createdLast7d, 'created'], ['Completed · 7 days', report.completedLast7d, 'completed'], ['Past due date', report.pastSla, 'overdue']] as const) {
      const metric = node('div'); const title = node('dt', label); title.prepend(icon(glyph)); metric.append(title, node('dd', count(value))); metrics.append(metric);
    }
    section.append(metrics);
    const evidence = node('dl'); evidence.className = 'bugs-evidence';
    const oldest = node('div'); oldest.append(node('dt', 'Oldest open'));
    const oldestValue = node('dd'); const age = report.oldest ? Math.max(0, Math.floor((Date.parse(report.asOf) - Date.parse(report.oldest.createdAt)) / 86_400_000)) : null;
    oldestValue.append(report.oldest ? this.link(`${report.oldest.displayKey} · ${Number.isFinite(age) ? `${age} days` : 'Age unavailable'}`, report.oldest.url)
      : node('span', report.oldestQuality === 'complete' ? 'None' : 'Unavailable'));
    if (report.oldestQuality !== 'complete') oldestValue.append(node('small', ` · ${report.oldestQuality} coverage`)); oldest.append(oldestValue); evidence.append(oldest);
    const sample = report.resolutionP75; const duration = node('div'); duration.append(node('dt', 'Resolution time · 75th percentile'), node('dd', sample.days === null ? 'Unavailable' : `${sample.days} days`),
      node('small', `${sample.sampleSize} sampled · Population ${count(sample.population)} · ${sample.quality}${sample.capped ? ' · capped sample' : ''}`),
      ...(sample.days !== null ? [node('small', '75% of sampled completions resolved within this time.')] : [])); evidence.append(duration); section.append(evidence);
    if (report.rowsQuality !== 'complete') { const coverage = node('p', `Open bug rows have ${report.rowsQuality} coverage.`); coverage.className = 'bugs-coverage'; section.append(coverage); }
    const table = node('table'); table.setAttribute('role', 'table'); table.setAttribute('aria-label', `Open bugs · ${this.sourceLabel(view.source)}`);
    const head = node('thead'); head.setAttribute('role', 'rowgroup'); const labels = node('tr'); labels.setAttribute('role', 'row');
    for (const title of ['Bug', 'Priority', 'Severity', 'Due']) { const cell = node('th', title); cell.scope = 'col'; cell.setAttribute('role', 'columnheader'); labels.append(cell); } head.append(labels); table.append(head);
    const body = node('tbody'); body.setAttribute('role', 'rowgroup');
    for (const bug of report.rows) {
      const row = node('tr'); row.setAttribute('role', 'row'); const title = node('td'); title.setAttribute('role', 'cell'); title.className = 'bugs-title-cell';
      const titleLink = this.link(bug.title, bug.url); titleLink.className = 'bugs-title'; title.append(titleLink, node('small', bug.displayKey), this.description(view, bug)); row.append(title);
      const priority = node('td', bug.priority ?? 'Unknown'); priority.dataset.label = 'Priority'; priority.setAttribute('role', 'cell');
      const severityCell = node('td'); severityCell.dataset.label = 'Severity'; severityCell.setAttribute('role', 'cell'); severityCell.append(this.severity(bug.severity));
      const due = node('td'); due.dataset.label = 'Due'; due.setAttribute('role', 'cell'); due.append(bug.dueAt ? dateNode(bug.dueAt) : node('span', 'Not set'));
      row.append(priority, severityCell, due); body.append(row);
    }
    if (!report.rows.length) { const row = node('tr'); row.setAttribute('role', 'row'); const empty = node('td', report.rowsQuality === 'complete' ? 'No open bugs.' : 'Open bug rows are unavailable or incomplete.'); empty.setAttribute('role', 'cell'); empty.colSpan = 4; empty.className = 'bugs-empty'; row.append(empty); body.append(row); }
    table.append(body); section.append(table); return section;
  }
  private draw(): void {
    if (this.disposed) return;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && this.container.contains(active) ? active.dataset.bugsFocus : undefined;
    if (focused) this.focusKey = focused;
    else if (active instanceof HTMLElement && active !== document.body && active !== document.documentElement) this.focusKey = undefined;
    const root = node('div'); root.className = 'plugin-bugs'; root.setAttribute('aria-busy', String(Boolean(this.pending))); root.append(node('style', styles));
    const composed = this.container.closest('[data-composition-page]') !== null;
    const toolbar = node('div'); toolbar.className = 'bugs-toolbar'; if (!composed) toolbar.append(node('h2', 'Bugs'));
    const sources = node('select'); sources.setAttribute('aria-label', 'Bug source'); sources.dataset.bugsFocus = 'source'; const all = node('option', 'All bug sources'); all.value = ''; sources.append(all);
    for (const source of this.sources) { const option = node('option', `${this.sourceLabel(source)}${source.availability === 'available' ? '' : ` (${source.availability})`}`); option.value = key(source); sources.append(option); }
    if (this.selected && !this.sources.some(source => key(source) === key(this.selected!))) { const missing = node('option', `Unavailable source · ${this.selected.repo}`); missing.value = key(this.selected); sources.append(missing); }
    if (this.invalidSelection) { const invalid = node('option', 'Saved selection unavailable'); invalid.value = 'unsupported'; sources.append(invalid); }
    sources.value = this.invalidSelection ? 'unsupported' : this.selected ? key(this.selected) : ''; sources.addEventListener('change', () => { void this.choose(sources.value); });
    const refresh = node('button', 'Refresh'); refresh.type = 'button'; refresh.dataset.bugsFocus = 'refresh'; refresh.disabled = Boolean(this.pending); refresh.addEventListener('click', () => { void this.refresh(); }); refresh.prepend(icon('refresh')); if (!composed) { toolbar.append(refresh); root.append(toolbar); }
    const filters = node('div'); filters.className = 'bugs-filters'; const label = node('label', 'Source'); label.className = 'bugs-source'; label.append(sources); filters.append(label); root.append(filters);
    for (const message of [...this.messages, ...(this.saveError ? [this.saveError] : [])]) { const note = node('p', message); note.setAttribute('role', 'status'); note.className = 'bugs-notice'; root.append(note); }
    for (const view of this.views) root.append(this.report(view));
    if (!this.views.length && !this.messages.length) root.append(node('p', this.pending ? 'Loading bug sources…' : 'No source provides bug metrics in this scope.'));
    this.container.replaceChildren(root); if (this.focusKey) Array.from(root.querySelectorAll<HTMLElement>('[data-bugs-focus]')).find(element => element.dataset.bugsFocus === this.focusKey)?.focus({ preventScroll: true });
  }
  update(state: PluginPanelState): void {
    if (this.disposed) return; const previous = this.state; this.state = state;
    const changed = !this.dirty && JSON.stringify(previous.savedState) !== JSON.stringify(state.savedState);
    if (changed) { this.selected = state.savedState?.version === 1 ? savedSelection(state.savedState.value) : null; this.descriptionExpanded = new Set(this.descriptionKeys(state.savedState?.version === 1 ? state.savedState.value : null)); this.invalidSelection = state.savedState !== null && !validSavedSettings(state.savedState?.version === 1 ? state.savedState.value : null); }
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
