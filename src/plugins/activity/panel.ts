import type { ActivityReadSnapshotV1, PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, TaskReadSourceV1 } from '@helmsman/plugin-sdk';

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
interface SourceView { source: TaskReadSourceV1; snapshot: ActivityReadSnapshotV1 | null; error: string; }
interface EventView { id: string; at: string; text: string; url: string | null; }
const styles = `.plugin-activity{display:grid;gap:12px;color:var(--text);font:14px var(--sans,sans-serif);min-width:0}.plugin-activity :is(h2,h3,p){margin:0}.plugin-activity h2,.plugin-activity h3{font-size:14px}.plugin-activity header{display:flex;gap:8px;align-items:center;justify-content:space-between}.plugin-activity button{font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);padding:6px 9px;border-radius:var(--radius,4px);cursor:pointer}.plugin-activity button:disabled{opacity:.5}.plugin-activity section{display:grid;gap:8px}.plugin-activity ol{list-style:none;padding:0;margin:0}.plugin-activity li{padding:8px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.plugin-activity a{color:var(--accent)}.plugin-activity small{display:block;color:var(--text-dim)}.plugin-activity dl{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;margin:0}.plugin-activity dt{font-size:11px;color:var(--text-dim)}.plugin-activity dd{margin:4px 0 0}.plugin-activity :is(button,a):focus-visible{outline:2px solid var(--accent);outline-offset:2px}`;
class ActivityPanel implements PluginPanelInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private state: PluginPanelState;
  private views: SourceView[] = [];
  private prEvents: EventView[] = [];
  private messages: string[] = [];
  private complete = false;
  private disposed = false;
  private generation = 0;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context;
    this.state = context.state; context.onDispose(() => this.dispose()); context.signal.addEventListener('abort', this.abort, { once: true });
    this.state.activity.signal.addEventListener('abort', this.suspend, { once: true });
    if (context.signal.aborted) { this.dispose(); return; }
    this.draw(); this.start();
  }
  private active(generation = this.generation): boolean { return !this.disposed && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private abort = () => this.dispose();
  private suspend = () => {
    ++this.generation; this.controller?.abort(); this.controller = null; this.pending = null;
    if (this.timer !== null) clearInterval(this.timer); this.timer = null;
  };
  private start(): void { if (!this.active()) return; if (this.timer === null) this.timer = setInterval(() => { void this.refresh(); }, 30_000); void this.refresh(); }
  refresh(): Promise<void> {
    if (!this.active()) return Promise.resolve(); if (this.pending) return this.pending;
    const generation = ++this.generation; const controller = new AbortController(); this.controller = controller;
    this.views = []; this.prEvents = []; this.messages = []; this.complete = true;
    const promise = Promise.all([
      Promise.resolve().then(async () => {
        const result = await this.context.services.tasks!.discover(controller.signal); if (!this.active(generation)) return;
        if (result.status === 'unavailable') { this.complete = false; this.messages.push(`Task history unavailable (${result.reason}).`); return; }
        const sources: TaskReadSourceV1[] = [];
        for (const galleon of result.value.galleons) {
          if (galleon.sources.status === 'unavailable') { this.complete = false; this.messages.push(`${galleon.repo}: source history unavailable (${galleon.sources.reason}).`); }
          else sources.push(...galleon.sources.value);
        }
        if (sources.length > 50) { this.complete = false; this.messages.push('Showing history for the first 50 source views. Select a repository to narrow this view.'); }
        this.views = sources.slice(0, 50).map(source => ({ source, snapshot: null, error: source.availability !== 'available' ? `Source ${source.availability}.`
          : !source.readViews?.includes('history') ? 'This source does not provide task history.' : '' }));
        if (this.views.some(view => view.error)) this.complete = false;
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(4, this.views.length) }, async () => {
          while (this.active(generation) && index < this.views.length) {
            const view = this.views[index++]!; if (view.error) continue;
            try {
              const history = await this.context.services.activity!.query(view.source, controller.signal); if (!this.active(generation)) return;
              if (history.status === 'unavailable') { view.error = `Source history unavailable (${history.reason}).`; this.complete = false; }
              else { view.snapshot = history.value; if (history.value.history.historyQuality !== 'complete') this.complete = false; }
            } catch { if (this.active(generation)) { view.error = 'Source history could not be read.'; this.complete = false; } }
            if (this.active(generation)) this.draw();
          }
        }));
      }).catch(() => { if (this.active(generation)) { this.complete = false; this.messages.push('Task history could not be read.'); } }),
      Promise.resolve().then(async () => {
        const result = await this.context.services.pullRequests!.list({ version: 1, repo: this.state.repo, kind: 'authored-recent', limit: 12 }, controller.signal);
        if (!this.active(generation)) return;
        if (result.status === 'unavailable') { this.complete = false; this.messages.push(`Pull request activity unavailable (${result.reason}).`); return; }
        if (result.value.quality !== 'complete' || result.value.truncated) { this.complete = false; this.messages.push(`Pull request history is ${result.value.quality}${result.value.truncated ? ' and truncated' : ''}.`); }
        this.prEvents = result.value.items.flatMap(pr => [
          { id: JSON.stringify(['pr', pr.repo, pr.number, 'opened']), at: pr.createdAt, text: `${pr.repo} · PR #${pr.number} opened`, url: pr.url },
          ...(pr.mergedAt ? [{ id: JSON.stringify(['pr', pr.repo, pr.number, 'merged']), at: pr.mergedAt, text: `${pr.repo} · PR #${pr.number} merged`, url: pr.url }] : []),
        ]);
      }).catch(() => { if (this.active(generation)) { this.complete = false; this.messages.push('Pull request activity could not be read.'); } }),
    ]).then(() => {}).finally(() => { if (this.active(generation)) { this.pending = null; this.controller = null; this.draw(); } });
    this.pending = promise; this.draw(); return promise;
  }
  private draw(): void {
    if (this.disposed) return; const focused = this.container.contains(document.activeElement) && document.activeElement?.getAttribute('data-activity-focus') === 'refresh';
    const root = element('section'); root.className = 'plugin-activity'; root.append(element('style', styles));
    const header = element('header'); header.append(element('h2', this.state.pirateMode ? "Ship's log" : 'Activity log'));
    const refresh = element('button', 'Refresh'); refresh.type = 'button'; refresh.dataset.activityFocus = 'refresh'; refresh.disabled = Boolean(this.pending) || !this.active(); refresh.addEventListener('click', () => { void this.refresh(); }); header.append(refresh); root.append(header);
    for (const message of this.messages) { const note = element('p', message); note.setAttribute('role', 'status'); root.append(note); }
    const events = new Map<string, EventView>(this.prEvents.map(event => [event.id, event]));
    for (const view of this.views) {
      const section = element('section'); section.append(element('h3', `${view.source.label} · ${view.source.repo}`));
      if (view.error) { const note = element('p', view.error); note.setAttribute('role', 'status'); section.append(note); }
      else if (!view.snapshot) section.append(element('p', 'Loading source history…'));
      else {
        const history = view.snapshot.history;
        section.append(element('small', `Tasks currently done · recorded completion date · ${history.from.slice(0, 10)}–${history.until.slice(0, 10)} UTC`));
        const days = element('dl'); days.setAttribute('aria-label', `${view.source.label} current done tasks by recorded completion date`);
        for (const day of history.days) { const cell = element('div'); cell.append(element('dt', day.date.slice(5)), element('dd', day.completed === null ? 'Unknown' : String(day.completed))); days.append(cell); }
        section.append(days);
        if (history.throughputQuality !== 'complete') section.append(element('p', `Current done-task counts are ${history.throughputQuality}.`));
        if (history.historyQuality !== 'complete') section.append(element('p', `Source event history is ${history.historyQuality}.`));
        for (const event of history.events) {
          const id = JSON.stringify(['source', event.ref.sourceId, event.ref.externalId, event.id]);
          events.set(id, { id, at: event.at, text: `${view.source.label} · ${view.source.repo} · ${event.displayKey} ${event.kind === 'status-changed' ? `→ ${event.status}` : event.kind}`, url: event.url });
        }
      }
      root.append(section);
    }
    const list = element('ol'); list.setAttribute('aria-label', 'Recent activity');
    for (const event of [...events.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id)).slice(0, 12)) {
      const item = element('li'); if (event.url) { const link = element('a', event.text); link.href = event.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); } else item.append(element('span', event.text));
      const time = element('time', new Date(event.at).toISOString().replace('T', ' ').replace('.000Z', ' UTC')); time.dateTime = event.at; item.append(element('small')); item.lastChild?.appendChild(time); list.append(item);
    }
    root.append(list);
    if (!events.size) root.append(element('p', this.pending ? 'Loading activity…' : this.complete ? 'No activity in the available history.' : 'No events available from the incomplete history.'));
    this.container.replaceChildren(root); if (focused) refresh.focus({ preventScroll: true });
  }
  update(state: PluginPanelState): void {
    if (this.disposed) return; const old = this.state;
    old.activity.signal.removeEventListener('abort', this.suspend); this.state = state; state.activity.signal.addEventListener('abort', this.suspend, { once: true });
    const changed = old.repo !== state.repo || old.activity.epoch !== state.activity.epoch || old.activity.signal !== state.activity.signal || old.activity.active !== state.activity.active || old.visible !== state.visible;
    if (changed) { this.suspend(); this.views = []; this.prEvents = []; this.messages = []; this.complete = false; }
    this.draw(); if (changed && this.active()) this.start();
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.suspend(); this.context.signal.removeEventListener('abort', this.abort); this.state.activity.signal.removeEventListener('abort', this.suspend); }
}
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.tasks?.version !== 1 || context.services.activity?.version !== 1 || context.services.pullRequests?.version !== 1) throw new Error('Activity requires task discovery, source history and pull request reads.');
  return new ActivityPanel(container, context);
} };
export default panel;
