import type { CommunicationNotificationV1, CommunicationNotificationsV1, PluginPageContext, PluginPageInstance, PluginPageState, PluginPanelContext, PluginPanelState } from '@helmsman/plugin-sdk';
import { esc, message, relativeTime, runHref, safePrUrl, safeSlackUrl } from './util.js';
import { styles } from './styles.js';
type Context = PluginPageContext | PluginPanelContext;
type State = PluginPageState | PluginPanelState;
function validItem(value: unknown): value is CommunicationNotificationV1 {
  if (!value || typeof value !== 'object') return false; const item = value as CommunicationNotificationV1;
  return ['id', 'repo', 'prUrl', 'sourceUrl', 'author', 'channelName', 'status', 'createdAt', 'updatedAt'].every(key => typeof (value as Record<string, unknown>)[key] === 'string') && (item.kind === 'voyage-completed' ? typeof item.title === 'string' && ['succeeded', 'failed', 'stopped'].includes(item.status) : (item.kind === undefined || item.kind === 'review-request') && ['queued', 'launched', 'failed', 'blocked'].includes(item.status));
}
function validHealth(value: unknown): value is CommunicationNotificationsV1['health'] { if (!value || typeof value !== 'object') return false; const health = value as CommunicationNotificationsV1['health']; return typeof health.status === 'string' && typeof health.channelName === 'string' && Number.isFinite(health.intervalMs); }

function itemMarkup(item: CommunicationNotificationV1, state: State): string {
  const pirate = state.pirateMode; const run = pirate ? 'voyage' : 'run'; const review = pirate ? 'Inspection' : 'Review'; const header = 'headerRepo' in state && state.headerRepo !== undefined ? state.headerRepo : state.repo;
  const voyage = item.kind === 'voyage-completed'; const source = safeSlackUrl(item.sourceUrl) ?? safePrUrl(item.sourceUrl, item.repo, item.prNumber); const prUrl = safePrUrl(item.prUrl, item.repo, item.prNumber);
  const status = voyage ? item.status === 'succeeded' ? pirate ? 'Shipshape' : 'Succeeded' : item.status === 'failed' ? pirate ? 'Marooned' : 'Failed' : 'Stopped' : item.status === 'failed' ? `${review}: ${pirate ? 'Marooned' : 'Failed'}` : `${review} ${item.status === 'launched' ? 'started' : item.status}`;
  const created = !voyage && item.channelName === 'Helmsman created PRs'; const github = !voyage && item.channelName === 'GitHub requested reviews';
  const parent = created ? /^\/runs\?run=([a-z\d_-]{1,128})$/i.exec(item.sourceUrl)?.[1] : null;
  const routing = [!voyage && item.complexity ? `${item.complexity} complexity` : null, item.model, item.effort ? `${item.effort} effort` : null].filter(Boolean).join(' · ');
  const time = voyage ? item.updatedAt : item.createdAt;
  return `<li class="slack-notification${voyage ? ' slack-voyage-notification' : ''}${item.readAt ? '' : ' is-unread'}" data-notification-id="${esc(item.id)}"><div class="slack-notification-top"><strong class="slack-status slack-status--${esc(item.status)}">${esc(status)}</strong><time datetime="${esc(time)}" title="${esc(new Date(time).toLocaleString())}">${esc(relativeTime(time))}</time></div>
    ${voyage ? `<div class="slack-voyage-title">${esc(item.title)}</div><div class="slack-author">${pirate ? 'Voyage' : 'Run'} · ${esc(item.repo)}</div>` : `<div class="slack-pr">${prUrl ? `<a href="${esc(prUrl)}" target="_blank" rel="noopener noreferrer">${esc(item.repo)} #${item.prNumber}</a>` : `${esc(item.repo)} #${item.prNumber}`}</div><div class="slack-author">${created ? `Helmsman ${review.toLowerCase()} · newly opened ${pirate ? 'Bounty' : 'PR'}` : github ? `GitHub ${review.toLowerCase()} request · ${esc(item.author || 'Unknown author')}` : `${esc(item.author || 'Someone')} posted in #${esc(item.channelName.replace(/^#/, ''))}`}</div>`}
    ${routing ? `<div class="slack-routing">${esc(routing)}</div>` : ''}${item.error ? `<p class="slack-error">${esc(item.error)}</p>` : ''}<div class="slack-notification-actions">${item.runId && (voyage || item.status === 'launched' || item.status === 'failed') ? `<a class="app-link" href="${esc(runHref(header, item.repo, item.runId))}">View ${run}</a>` : ''}${parent ? `<a class="app-link" href="${esc(runHref(header, item.repo, parent))}">Original ${run}</a>` : ''}${source ? `<a href="${esc(source)}" target="_blank" rel="noopener noreferrer">${safeSlackUrl(source) ? 'Slack message' : 'GitHub request'}</a>` : ''}${voyage && prUrl ? `<a href="${esc(prUrl)}" target="_blank" rel="noopener noreferrer">${pirate ? 'Bounty' : 'PR'} #${item.prNumber}</a>` : ''}${item.readAt ? '<span class="slack-read">Read</span>' : `<button type="button" data-slack-read="${esc(item.id)}" data-repo="${esc(item.repo)}">Mark read</button>`}</div></li>`;
}
function healthMarkup(health: CommunicationNotificationsV1['health'], source: string): string {
  const status = health.status === 'healthy' ? `Scanning every ${Math.round(health.intervalMs / 60_000)} min` : health.status === 'scanning' ? 'Scanning now' : health.status === 'disabled' ? 'Automatic checks off' : health.status === 'partial' ? 'Scan incomplete' : 'Automatic checks unavailable';
  return `<div class="slack-health" role="status"><strong>${esc(source)}</strong><span>${status}</span>${health.lastSuccessAt ? `<span>Last scanned ${esc(relativeTime(health.lastSuccessAt))}</span>` : ''}${health.error ? `<span class="slack-error">${esc(health.error)}</span>` : ''}</div>`;
}
export class NotificationView implements PluginPageInstance {
  private state: State;
  private disposed = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: CommunicationNotificationsV1 | null = null;
  private open = false;
  private error = '';
  private readonly reading = new Map<string, AbortController>();
  private readonly container: HTMLElement;
  private readonly context: Context;
  private readonly header: boolean;
  private readonly popoverId = `communication-${crypto.randomUUID()}`;
  constructor(container: HTMLElement, context: Context, header: boolean) {
    this.container = container; this.context = context; this.header = header; this.state = context.state;
    container.addEventListener('click', this.click); document.addEventListener('click', this.outside); document.addEventListener('keydown', this.keydown);
    context.signal.addEventListener('abort', this.dispose, { once: true }); context.onDispose(this.dispose);
    if ('activity' in this.state) this.state.activity.signal.addEventListener('abort', this.cancel, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && (!('activity' in this.state) || this.state.activity.active && !this.state.activity.signal.aborted) && generation === this.generation; }
  private cancelReads = () => { ++this.generation; this.controller?.abort(); this.controller = null; if (this.timer) clearTimeout(this.timer); this.timer = null; };
  private cancel = () => { this.cancelReads(); for (const controller of this.reading.values()) controller.abort(); this.reading.clear(); };
  dispose = () => { if (this.disposed) return; this.disposed = true; this.cancel(); this.container.removeEventListener('click', this.click); document.removeEventListener('click', this.outside); document.removeEventListener('keydown', this.keydown); this.context.signal.removeEventListener('abort', this.dispose); if ('activity' in this.state) this.state.activity.signal.removeEventListener('abort', this.cancel); };
  update(next: State) { if (this.disposed) return; const changed = this.state.repo !== next.repo || this.state.visible !== next.visible || 'activity' in this.state && 'activity' in next && this.state.activity !== next.activity; if ('activity' in this.state) this.state.activity.signal.removeEventListener('abort', this.cancel); if (this.state.repo !== next.repo) { this.snapshot = null; this.error = ''; } this.state = next; if ('activity' in next) next.activity.signal.addEventListener('abort', this.cancel, { once: true }); if (changed) { this.cancel(); void this.refresh(); } this.draw(); }
  refresh = async () => {
    if (!this.active()) return; this.cancelReads(); const generation = this.generation; const controller = new AbortController(); this.controller = controller;
    try { const result = await this.context.services!.communication!.notifications({ version: 1, repo: this.state.repo, limit: 256 }, controller.signal);
      if (!this.active(generation)) return;
      if (result?.status !== 'available' || result.value?.version !== 1 || !Array.isArray(result.value.notifications) || !validHealth(result.value.health) || result.value.githubHealth !== null && !validHealth(result.value.githubHealth) || result.value.notifications.some(item => !validItem(item) || this.state.repo !== null && item.repo.toLowerCase() !== this.state.repo.toLowerCase())) throw new Error('Notifications unavailable. Showing retained notifications.');
      this.snapshot = result.value; this.error = '';
    } catch (error) { if (this.active(generation)) this.error = message(error, 'Notifications unavailable. Showing retained notifications.'); }
    finally { if (this.active(generation)) { this.draw(); this.timer = setTimeout(() => { void this.refresh(); }, 15_000); } }
  };
  private close(focus: boolean) { this.open = false; this.draw(); if (focus) this.container.querySelector<HTMLElement>('[data-slack-toggle]')?.focus({ preventScroll: true }); }
  private outside = (event: MouseEvent) => { if (this.header && this.open && event.target instanceof Node && !this.container.contains(event.target)) this.close(false); };
  private keydown = (event: KeyboardEvent) => { if (this.header && this.open && event.key === 'Escape') { event.preventDefault(); this.close(true); } };
  private click = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>('a.app-link'); if (link && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); this.context.navigate(link.getAttribute('href') ?? '/communication'); this.close(false); return; }
    const button = event.target.closest<HTMLButtonElement>('button'); if (!button || button.disabled || !this.active()) return; event.stopPropagation();
    if (button.matches('[data-slack-toggle]')) { this.open = !this.open; this.draw(); this.container.querySelector<HTMLElement>('[data-slack-toggle]')?.focus({ preventScroll: true }); }
    else if (button.matches('[data-slack-close]')) this.close(true);
    else if (button.dataset.slackRead && button.dataset.repo) void this.markRead(button.dataset.repo, button.dataset.slackRead);
    else if (button.matches('[data-refresh]')) void this.refresh();
  };
  private async markRead(repo: string, id: string) {
    if (this.reading.has(id)) return; const controller = new AbortController(); this.reading.set(id, controller); this.draw();
    try { const result = await this.context.services!.communication!.markRead({ repo, id }, controller.signal);
      if (controller.signal.aborted || !this.active()) return;
      if (result?.status !== 'available' || result.value?.id !== id) throw new Error('Could not mark notification read. Try again.');
      this.cancelReads(); if (this.snapshot) this.snapshot = { ...this.snapshot, unread: this.snapshot.unread === null ? null : Math.max(0, this.snapshot.unread - (this.snapshot.notifications.some(item => item.id === id && !item.readAt) ? 1 : 0)), notifications: this.snapshot.notifications.map(item => item.id === id ? { ...item, readAt: result.value.readAt } : item) };
      this.error = ''; void this.refresh();
    } catch (error) { if (!controller.signal.aborted && this.active()) this.error = message(error, 'Could not mark notification read. Try again.'); }
    finally { if (this.reading.get(id) === controller) this.reading.delete(id); this.draw(); }
  }
  private paint(markup: string) {
    const toggle = this.header ? this.container.querySelector<HTMLElement>('[data-slack-toggle]') : null;
    const popover = this.header ? this.container.querySelector<HTMLElement>('.slack-popover') : null;
    if (!toggle || !popover) { this.container.innerHTML = markup; return; }
    const template = document.createElement('template'); template.innerHTML = markup;
    for (const [current, selector] of [[toggle, '[data-slack-toggle]'], [popover, '.slack-popover']] as const) {
      const next = template.content.querySelector<HTMLElement>(selector); if (!next) continue;
      for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
      for (const attribute of [...next.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
      if (current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
    }
  }
  private draw() {
    if (this.disposed) return; const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null; const readId = focused?.dataset.slackRead; const toggleFocused = focused?.hasAttribute('data-slack-toggle'); const scroll = this.container.querySelector('.slack-popover')?.scrollTop ?? 0;
    const data = this.snapshot; const count = data?.unread ?? null; const items = data?.notifications ?? []; const headerRepo = 'headerRepo' in this.state && this.state.headerRepo !== undefined ? this.state.headerRepo : this.state.repo; const params = new URLSearchParams(headerRepo ? { repo: headerRepo } : {});
    const markup = `<div class="plugin-communication${this.header ? '' : ' communication-page'}"><style>${styles}</style>${this.header ? `<button type="button" class="slack-toggle${count ? ' has-unread' : ''}" data-slack-toggle aria-expanded="${this.open}" aria-controls="${this.popoverId}" aria-label="Notifications, ${count === null ? 'unread count unavailable' : `${count} unread`}"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 8a5 5 0 0 1 10 0v4l2 3H3l2-3zM8 17h4"/></svg>${count ? `<span class="slack-count" aria-hidden="true">${count}</span>` : ''}</button>` : ''}<section id="${this.popoverId}" class="slack-popover" aria-label="Notifications"${this.header && !this.open ? ' hidden' : ''}><div class="slack-popover-head"><h2>Notifications</h2>${this.header ? '<button type="button" data-slack-close aria-label="Close notifications">×</button>' : '<button type="button" data-refresh>Refresh</button>'}</div>${data ? healthMarkup(data.health, data.health.channelName ? `Slack #${data.health.channelName.replace(/^#/, '')}` : 'Slack') + (data.githubHealth ? healthMarkup(data.githubHealth, this.state.pirateMode ? 'GitHub requested inspections' : 'GitHub requested reviews') : '') : ''}${this.error ? `<p class="slack-action-error" role="alert">${esc(this.error)}</p>` : ''}${data?.quality === 'partial' ? '<p class="slack-empty">Notification results are incomplete; unread total may be unknown.</p>' : ''}${items.length ? `<ol class="slack-notification-list">${items.map(item => itemMarkup(item, this.state)).join('')}</ol>` : `<p class="slack-empty">${data ? 'No notifications yet' : 'Notifications unavailable'}${this.state.repo ? ` for this ${this.state.pirateMode ? 'galleon' : 'repository'}` : ''}.</p>`}<div class="slack-empty"><a class="app-link" href="/communication${params.size ? `?${params}` : ''}">Communication settings and review requests ↗</a></div></section></div>`;
    this.paint(markup);
    this.container.querySelectorAll<HTMLButtonElement>('[data-slack-read]').forEach(button => { button.disabled = !this.active() || this.reading.has(button.dataset.slackRead ?? ''); }); const popover = this.container.querySelector('.slack-popover'); if (popover) popover.scrollTop = scroll;
    if (readId) ([...this.container.querySelectorAll<HTMLElement>('[data-slack-read]')].find(button => button.dataset.slackRead === readId) ?? this.container.querySelector<HTMLElement>('[data-slack-toggle]'))?.focus({ preventScroll: true }); else if (toggleFocused) this.container.querySelector<HTMLElement>('[data-slack-toggle]')?.focus({ preventScroll: true });
  }
}
