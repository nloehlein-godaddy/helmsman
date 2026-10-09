import type { ActivityReadSnapshotV1, PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, TaskReadSourceV1 } from '@helmsman/plugin-sdk';

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
interface SourceView { source: TaskReadSourceV1; snapshot: ActivityReadSnapshotV1 | null; error: string; }
interface EventView { id: string; at: string; title: string; identity: string; source: string; repo: string; kind: 'opened' | 'merged' | 'created' | 'updated' | 'completed' | 'status-changed'; status: string; url: string | null; }
interface Notice { title: string; detail: string; }
const phosphorGlyphs = { refresh: '\ue094', warning: '\ue4e2', calendar: '\ue10a', clock: '\ue19a', opened: '\ue282', merged: '\ue280', created: '\ue3d6', updated: '\ue3b4', completed: '\ue184', 'status-changed': '\ue0a0' } as const;
const createIcon = (name: keyof typeof phosphorGlyphs): HTMLSpanElement => {
  const icon = element('span'); icon.className = 'activity-phosphor'; icon.dataset.glyph = phosphorGlyphs[name] ?? phosphorGlyphs.warning; icon.setAttribute('aria-hidden', 'true'); return icon;
};
const phosphorFontUrl = new URL('./phosphor-regular.woff2', import.meta.url).href;
const dateLabel = (at: string): string => {
  const date = new Date(at); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(date) + ' UTC' : 'Time unavailable';
};
const styles = `@font-face{font-family:"Helmsman Phosphor Regular";src:url("${phosphorFontUrl}") format("woff2");font-weight:400;font-style:normal;font-display:block}
.plugin-activity{display:grid;gap:20px;color:var(--text);font:16px/1.5 var(--sans,sans-serif);min-width:0;container-type:inline-size;overflow-wrap:anywhere}
.plugin-activity :is(h2,h3,p){margin:0}
.plugin-activity h2{font-size:17px;font-weight:650}
.plugin-activity h3{font-size:15px;font-weight:600}
.plugin-activity header{display:flex;gap:8px;align-items:center;justify-content:space-between}
.plugin-activity button{font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);padding:8px;border-radius:6px;cursor:pointer;min-height:34px;transition:background-color 160ms ease,color 160ms ease}
.plugin-activity button:not(:disabled):hover{background:var(--panel-hover,var(--panel));border-color:var(--accent)}
.plugin-activity button:disabled{opacity:.5;cursor:not-allowed}
.plugin-activity .activity-source{display:grid;gap:12px;min-width:0}
.plugin-activity .source-heading{display:flex;gap:4px 12px;flex-wrap:wrap;align-items:baseline}
.plugin-activity ol{list-style:none;padding:0;margin:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.plugin-activity li{display:grid;gap:8px;padding:20px 0;border-bottom:1px solid var(--line);min-width:0}
.plugin-activity li:last-child{border-bottom:0}
.plugin-activity a{color:var(--accent-text,var(--accent));text-underline-offset:3px}
.plugin-activity small{display:block;color:var(--text-dim);font-size:13px}
.plugin-activity .activity-range{display:flex;gap:4px 12px;flex-wrap:wrap;align-items:center;color:var(--text-dim);font-size:13px}
.plugin-activity .activity-range>span{display:inline-flex;gap:6px;align-items:center}
.plugin-activity dl{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;margin:0}
.plugin-activity .activity-day{padding:8px 0;border-bottom:1px solid var(--line-faint,var(--line));text-align:center}
.plugin-activity dt{font-size:12px;color:var(--text-dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.plugin-activity dd{margin:4px 0 0;font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--text-dim)}
.plugin-activity .activity-day[data-count=positive]{border-color:var(--good);background:color-mix(in srgb,var(--good) 6%,transparent)}
.plugin-activity .activity-day[data-count=positive] dd{color:var(--good)}
.plugin-activity .activity-day[data-count=unknown] dd{color:var(--queued,var(--accent))}
.plugin-activity :is(button,a,summary):focus-visible{outline:2px solid var(--accent-text,var(--accent));outline-offset:3px}
.plugin-activity .activity-notice{font-size:13px;color:var(--queued,var(--accent));min-width:0}
.plugin-activity .activity-notice summary{cursor:pointer;width:fit-content;max-width:100%;min-height:24px}
.plugin-activity .activity-notice summary>span{display:inline-flex;gap:6px;align-items:center;vertical-align:middle}
.plugin-activity .activity-notice p{margin-top:6px;max-width:70ch;color:var(--text-dim);line-height:1.5}
.plugin-activity .activity-main{display:flex;gap:8px 16px;flex-wrap:wrap;align-items:baseline;min-width:0}
.plugin-activity .event-title{flex:1;min-width:min(100%,200px);font-size:18px;font-weight:650;line-height:1.45;color:var(--text);text-decoration:none}
.plugin-activity a.event-title:hover{color:var(--accent-text,var(--accent));text-decoration:underline}
.plugin-activity .event-state{display:inline-flex;gap:6px;align-items:center;font-size:13px;font-weight:600;color:var(--accent-text,var(--accent))}
.plugin-activity .event-state:is([data-kind=merged],[data-kind=completed]){color:var(--good)}
.plugin-activity .event-state[data-kind=opened]{color:var(--review,var(--accent))}
.plugin-activity .event-evidence{display:flex;gap:4px 16px;flex-wrap:wrap;align-items:center;color:var(--text-dim);font-size:13px}
.plugin-activity .event-identity{font-family:var(--mono,monospace);font-size:13px}
.plugin-activity time{display:inline-flex;gap:6px;align-items:center;font-variant-numeric:tabular-nums}
.plugin-activity .activity-phosphor{display:inline-block;width:16px;height:16px;flex-shrink:0;font-family:"Helmsman Phosphor Regular";font-size:16px;font-weight:400;font-style:normal;font-synthesis:none;line-height:1;letter-spacing:normal;text-transform:none}
.plugin-activity .activity-phosphor::before{content:attr(data-glyph)}
.plugin-activity footer{display:flex;justify-content:flex-end}
.plugin-activity footer button{display:inline-flex;align-items:center;justify-content:center;width:34px}
@container(max-width:360px){.plugin-activity dl{gap:4px}.plugin-activity dt{font-size:11px}}
@media(pointer:coarse){.plugin-activity :is(button,summary),.plugin-activity a.event-title{min-height:44px}.plugin-activity a.event-title{display:flex;align-items:center}.plugin-activity footer button{width:44px}}
@media(prefers-reduced-motion:reduce){.plugin-activity button{transition:none}}
[role=tabpanel][aria-labelledby][data-panel-instance] .plugin-activity>header>h2{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
[role=tabpanel][aria-labelledby][data-panel-instance] .plugin-activity>header{display:contents}
`;
class ActivityPanel implements PluginPanelInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private state: PluginPanelState;
  private views: SourceView[] = [];
  private prEvents: EventView[] = [];
  private messages: string[] = [];
  private complete = false;
  private prNotice: Notice | null = null;
  private expanded = new Set<string>();
  private refreshFocusPending = false;
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
    this.views = []; this.prEvents = []; this.messages = []; this.prNotice = null; this.complete = true;
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
              else { view.snapshot = history.value; if (history.value.history.historyQuality !== 'complete' || history.value.history.throughputQuality !== 'complete') this.complete = false; }
            } catch { if (this.active(generation)) { view.error = 'Source history could not be read.'; this.complete = false; } }
            if (this.active(generation)) this.draw();
          }
        }));
      }).catch(() => { if (this.active(generation)) { this.complete = false; this.messages.push('Task history could not be read.'); } }),
      Promise.resolve().then(async () => {
        const result = await this.context.services.pullRequests!.list({ version: 1, repo: this.state.repo, kind: 'authored-recent', limit: 12 }, controller.signal);
        if (!this.active(generation)) return;
        if (result.status === 'unavailable') { this.complete = false; this.messages.push(`Pull request activity unavailable (${result.reason}).`); return; }
        if (result.value.quality !== 'complete' || result.value.truncated) { this.complete = false; this.prNotice = { title: 'PR history limited', detail: `Pull request history is ${result.value.quality}${result.value.truncated ? ' and truncated' : ''}. Some pull request events may be missing; refresh to retry.` }; }
        this.prEvents = result.value.items.flatMap(pr => [
          { id: JSON.stringify(['pr', pr.repo, pr.number, 'opened']), at: pr.createdAt, title: pr.title, identity: `PR #${pr.number}`, source: 'Pull request', repo: pr.repo, kind: 'opened' as const, status: 'Opened', url: pr.url },
          ...(pr.mergedAt ? [{ id: JSON.stringify(['pr', pr.repo, pr.number, 'merged']), at: pr.mergedAt, title: pr.title, identity: `PR #${pr.number}`, source: 'Pull request', repo: pr.repo, kind: 'merged' as const, status: 'Merged', url: pr.url }] : []),
        ]);
      }).catch(() => { if (this.active(generation)) { this.complete = false; this.messages.push('Pull request activity could not be read.'); } }),
    ]).then(() => {}).finally(() => { if (this.active(generation)) { this.pending = null; this.controller = null; this.draw(); } });
    this.pending = promise; this.draw(); return promise;
  }
  private notice(value: Notice, key: string): HTMLDetailsElement {
    const details = element('details'); details.className = 'activity-notice'; details.setAttribute('aria-live', 'polite'); details.open = this.expanded.has(key);
    const summary = element('summary'); summary.dataset.activityFocus = key;
    const label = element('span'); label.append(createIcon('warning'), element('span', value.title)); summary.append(label);
    details.append(summary, element('p', value.detail));
    details.addEventListener('toggle', () => { if (details.isConnected) { if (details.open) this.expanded.add(key); else this.expanded.delete(key); } });
    return details;
  }
  private draw(): void {
    if (this.disposed) return;
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement.dataset.activityFocus : null;
    if (focused === 'refresh' && this.pending) this.refreshFocusPending = true;
    const root = element('section'); root.className = 'plugin-activity'; root.append(element('style', styles));
    const header = element('header'); header.append(element('h2', this.state.pirateMode ? "Ship's log" : 'Activity log'));
    const refresh = element('button'); refresh.setAttribute('aria-label', 'Refresh'); refresh.title = 'Refresh'; refresh.append(createIcon('refresh')); refresh.type = 'button'; refresh.dataset.activityFocus = 'refresh'; refresh.disabled = Boolean(this.pending) || !this.active(); refresh.addEventListener('click', () => { this.refreshFocusPending = true; void this.refresh(); }); root.append(header);
    for (const message of this.messages) root.append(this.notice({ title: message, detail: 'Some activity may be missing from this view. Refresh to retry.' }, message));
    if (this.prNotice) root.append(this.notice(this.prNotice, 'pr-history'));
    const events = new Map<string, EventView>(this.prEvents.map(event => [event.id, event]));
    for (const view of this.views) {
      const section = element('section'); section.className = 'activity-source';
      const heading = element('div'); heading.className = 'source-heading'; heading.append(element('h3', view.source.label));
      if (this.state.repo !== view.source.repo) heading.append(element('small', view.source.repo)); section.append(heading);
      const sourceKey = JSON.stringify([view.source.repo, view.source.sourceId, view.source.instanceId]);
      if (view.error) section.append(this.notice({ title: view.error, detail: 'Source counts and events could not be read for this view.' }, sourceKey));
      else if (!view.snapshot) section.append(element('p', 'Loading source history…'));
      else {
        const history = view.snapshot.history;
        const range = element('div'); range.className = 'activity-range';
        const description = element('span'); description.append(createIcon('completed'), element('span', 'Currently done · by completion date'));
        description.title = 'Current Done tasks grouped by recorded completion date. Reopened or deleted tasks are excluded.';
        const window = element('span'); window.append(createIcon('calendar'), element('span', `${history.from.slice(0, 10)}–${history.until.slice(0, 10)} UTC`)); range.append(description, window); section.append(range);
        const days = element('dl'); days.setAttribute('aria-label', `${view.source.label} current done tasks by recorded completion date`);
        for (const day of history.days) {
          const cell = element('div'); cell.className = 'activity-day'; cell.dataset.count = day.completed == null ? 'unknown' : day.completed > 0 ? 'positive' : 'zero';
          const count = element('dd', day.completed == null ? '?' : String(day.completed));
          if (day.completed == null) { count.setAttribute('aria-label', 'Unknown'); count.title = 'Completion count unavailable'; }
          const date = element('dt', day.date.slice(5)); date.title = `${day.date} UTC`; cell.append(date, count); days.append(cell);
        }
        section.append(days);
        if (history.throughputQuality !== 'complete') section.append(this.notice({ title: `Done counts ${history.throughputQuality}`, detail: 'Completion counts could not be fully read. A question mark means unknown, not zero.' }, `${sourceKey}:counts`));
        if (history.historyQuality !== 'complete') section.append(this.notice({ title: `Event history ${history.historyQuality}`, detail: `Source event history is ${history.historyQuality}. Some source events may be missing; this is not a complete transition log.` }, `${sourceKey}:events`));
        for (const event of history.events) {
          const id = JSON.stringify(['source', event.ref.sourceId, event.ref.externalId, event.id]);
          const status = event.kind === 'status-changed' ? event.status ?? 'Status changed' : { created: 'Created', updated: 'Updated', completed: 'Completed' }[event.kind];
          events.set(id, { id, at: event.at, title: event.title, identity: event.displayKey, source: view.source.label, repo: view.source.repo, kind: event.kind, status, url: event.url });
        }
      }
      root.append(section);
    }
    const list = element('ol'); list.setAttribute('aria-label', 'Recent activity');
    for (const event of [...events.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id)).slice(0, 12)) {
      const item = element('li'); const main = element('div'); main.className = 'activity-main';
      const title = element(event.url ? 'a' : 'span', event.title); title.className = 'event-title';
      if (title instanceof HTMLAnchorElement && event.url) { title.href = event.url; title.target = '_blank'; title.rel = 'noopener noreferrer'; title.dataset.activityFocus = event.id; }
      const state = element('span'); state.className = 'event-state'; state.dataset.kind = event.kind; state.append(createIcon(event.kind), element('span', event.status)); main.append(title, state);
      const evidence = element('div'); evidence.className = 'event-evidence'; const identity = element('span', event.identity); identity.className = 'event-identity'; evidence.append(identity, element('span', event.source));
      if (this.state.repo !== event.repo) evidence.append(element('span', event.repo));
      const time = element('time'); time.append(createIcon('clock'), element('span', dateLabel(event.at))); time.dateTime = event.at; time.title = event.at; evidence.append(time); item.append(main, evidence); list.append(item);
    }
    if (events.size) root.append(list);
    else root.append(element('p', this.pending ? 'Loading activity…' : this.complete ? 'No activity in the available history.' : 'No events available from the incomplete history.'));
    const footer = element('footer'); footer.append(refresh); root.append(footer);
    const restoreRefresh = this.refreshFocusPending && !refresh.disabled && (document.activeElement === document.body || focused === 'refresh');
    if (!refresh.disabled) this.refreshFocusPending = false;
    this.container.replaceChildren(root);
    if (restoreRefresh) refresh.focus({ preventScroll: true });
    else if (focused) (Array.from(this.container.querySelectorAll<HTMLElement>('[data-activity-focus]')).find(control => control.dataset.activityFocus === focused) ?? refresh).focus({ preventScroll: true });
  }
  update(state: PluginPanelState): void {
    if (this.disposed) return; const old = this.state;
    old.activity.signal.removeEventListener('abort', this.suspend); this.state = state; state.activity.signal.addEventListener('abort', this.suspend, { once: true });
    const changed = old.repo !== state.repo || old.activity.epoch !== state.activity.epoch || old.activity.signal !== state.activity.signal || old.activity.active !== state.activity.active || old.visible !== state.visible;
    if (changed) { this.refreshFocusPending = false; this.suspend(); this.views = []; this.prEvents = []; this.messages = []; this.prNotice = null; this.complete = false; }
    this.draw(); if (changed && this.active()) this.start();
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.suspend(); this.context.signal.removeEventListener('abort', this.abort); this.state.activity.signal.removeEventListener('abort', this.suspend); }
}
const panel: PluginPanelModule = { mount(container, context) {
  if (context.services.tasks?.version !== 1 || context.services.activity?.version !== 1 || context.services.pullRequests?.version !== 1) throw new Error('Activity requires task discovery, source history and pull request reads.');
  return new ActivityPanel(container, context);
} };
export default panel;
