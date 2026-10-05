import type { PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, PullRequestReadItemV1, PullRequestReadPageV1, PullRequestReadResultV1 } from '@helmsman/plugin-sdk';

const presentation: { kind: 'repo-open' | 'authored-recent'; name: string; limit: number } = { kind: 'authored-recent', name: 'shipped', limit: 12 };
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
const styles = `.plugin-pr-list{display:grid;gap:12px;font:16px var(--sans,sans-serif);color:var(--text);min-width:0}.plugin-pr-list h2,.plugin-pr-list p{margin:0}.plugin-pr-list h2{font-size:17px}.plugin-pr-list header,.plugin-pr-list .pr-identity,.plugin-pr-list .pr-links{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.plugin-pr-list header{justify-content:space-between}.plugin-pr-list ul{list-style:none;padding:0;margin:0}.plugin-pr-list li{display:grid;gap:8px;padding:12px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.plugin-pr-list small{color:var(--text-dim)}.plugin-pr-list a,.plugin-pr-list button{font:inherit;color:var(--accent)}.plugin-pr-list button{background:var(--face-hi);border:1px solid var(--line-strong);border-radius:6px;padding:5px 8px}.plugin-pr-list button:disabled{opacity:.5}.plugin-pr-list .pr-state{font-weight:600}.plugin-pr-list :is(a,button):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.plugin-pr-list{line-height:1.5;overflow-wrap:anywhere}
.plugin-pr-list :is(h2,h3,p){margin:0}
.plugin-pr-list h2{font-size:17px;font-weight:650}
.plugin-pr-list h3{font-size:15px;font-weight:600;color:var(--text-dim)}
.plugin-pr-list :is(button,select,input:not([type=checkbox]):not([type=radio])){min-height:34px}
.plugin-pr-list :is(button,select,input,textarea){font-family:var(--sans,sans-serif);min-width:0}
.plugin-pr-list button{transition:background-color 160ms ease,color 160ms ease}
.plugin-pr-list button:not(:disabled):hover{background:var(--panel-hover,var(--panel));border-color:var(--accent)}
.plugin-pr-list button:disabled{cursor:not-allowed}
.plugin-pr-list :is(a,button){text-underline-offset:3px}
.plugin-pr-list small{font-size:14px;line-height:1.5}
.plugin-pr-list li:last-child{border-bottom:0}
@media(prefers-reduced-motion:reduce){.plugin-pr-list button{transition:none}}
.plugin-pr-list .pr-identity{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 12px;align-items:start}
.plugin-pr-list .pr-identity>a{font-size:17px;font-weight:600;line-height:1.45;color:var(--text);text-decoration:none}
.plugin-pr-list .pr-identity>a:hover{color:var(--accent);text-decoration:underline}
.plugin-pr-list .pr-state{padding:2px 8px;border:1px solid var(--line);border-radius:6px;font-size:14px;background:var(--panel)}
.plugin-pr-list .pr-state[data-state=merged]{color:var(--accent)}
@media(max-width:480px){.plugin-pr-list .pr-identity{grid-template-columns:minmax(0,1fr)}.plugin-pr-list .pr-state{justify-self:start}}
[role=tabpanel][aria-labelledby][data-panel-instance] .plugin-pr-list>header>h2{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
[role=tabpanel][aria-labelledby][data-panel-instance] .plugin-pr-list>header{display:contents}
`;

class PullRequestPanel implements PluginPanelInstance {
  private readonly context: PluginPanelContext;
  private readonly container: HTMLElement;
  private state: PluginPanelState;
  private generation = 0;
  private disposed = false;
  private controller: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private page: PullRequestReadPageV1 | null = null;
  private error = '';
  private loading = true;
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state;
    context.onDispose(this.dispose); context.signal.addEventListener('abort', this.dispose, { once: true });
    this.state.activity.signal.addEventListener('abort', this.cancel, { once: true });
    if (context.signal.aborted) this.dispose(); else this.refresh();
  }
  private active(generation = this.generation): boolean { return !this.disposed && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private cancel = () => { ++this.generation; this.controller?.abort(); this.controller = null; this.unsubscribe?.(); this.unsubscribe = null; };
  dispose = () => {
    if (this.disposed) return; this.disposed = true; this.cancel();
    this.context.signal.removeEventListener('abort', this.dispose); this.state.activity.signal.removeEventListener('abort', this.cancel);
  };
  update(next: PluginPanelState): void {
    if (this.disposed) return; const previous = this.state; this.state = next;
    if (previous.activity.signal !== next.activity.signal) { previous.activity.signal.removeEventListener('abort', this.cancel); next.activity.signal.addEventListener('abort', this.cancel, { once: true }); }
    if (previous.repo !== next.repo || previous.visible !== next.visible || previous.activity.epoch !== next.activity.epoch || previous.activity.signal !== next.activity.signal || previous.activity.active !== next.activity.active) {
      this.cancel(); if (previous.repo !== next.repo) this.page = null;
      this.refresh();
    } else this.draw();
  }
  refresh(): void {
    if (!this.active()) { this.draw(); return; }
    this.cancel(); const generation = this.generation; this.loading = true; this.error = '';
    if (presentation.kind === 'repo-open' && this.state.repo === null) { this.loading = false; this.page = null; this.draw(); return; }
    const controller = new AbortController(); this.controller = controller; this.draw();
    try {
      this.unsubscribe = this.context.services.pullRequests!.watchList({ version: 1, repo: this.state.repo, kind: presentation.kind, limit: presentation.limit }, result => this.receive(result, generation), controller.signal);
    } catch { this.loading = false; this.error = 'Pull requests are unavailable. Refresh to retry.'; this.draw(); }
  }
  private receive(result: PullRequestReadResultV1<PullRequestReadPageV1>, generation: number): void {
    if (!this.active(generation)) return; this.loading = false;
    if (result?.status === 'available' && result.value?.repo === this.state.repo && result.value.kind === presentation.kind && Array.isArray(result.value.items)) { this.page = result.value; this.error = ''; }
    else { this.page = null; this.error = `Pull requests are unavailable${result?.status === 'unavailable' ? `: ${result.reason}` : ''}. Refresh to retry.`; }
    this.draw();
  }
  private link(label: string, href: string, external = false): HTMLAnchorElement | null {
    if (external) { try { const url = new URL(href); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null; } catch { return null; } }
    const link = node('a', label); link.href = href;
    if (external) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    else link.addEventListener('click', event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) { event.preventDefault(); this.context.navigate(href); } });
    return link;
  }
  private route(pr: PullRequestReadItemV1, review = false): string {
    const query = new URLSearchParams({ prRepo: pr.repo, pr: String(pr.number), pane: review ? 'newrun' : 'lookup' });
    if (this.state.repo) query.set('repo', this.state.repo); if (review) query.set('mode', 'review');
    return `${review ? '/runs' : '/prs'}?${query}`;
  }
  private draw(): void {
    if (this.disposed) return;
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement.dataset.prFocus : undefined;
    const root = node('section'); root.className = `plugin-pr-list plugin-${presentation.name}`; root.setAttribute('aria-busy', String(this.loading)); root.append(node('style', styles));
    const header = node('header'); header.append(node('h2', presentation.kind === 'repo-open' ? this.state.pirateMode ? 'Galleon pull requests' : 'Repository pull requests' : this.state.pirateMode ? 'Out to sea' : 'Recent authored PRs'));
    const refresh = node('button', 'Refresh'); refresh.type = 'button'; refresh.disabled = !this.active(); refresh.addEventListener('click', () => this.refresh()); root.append(header);
    if (presentation.kind === 'authored-recent') root.append(node('small', 'Recent authored pull requests, including open, closed, and merged work.'));
    const status = (text: string) => { const message = node('p', text); message.setAttribute('role', 'status'); root.append(message); };
    if (presentation.kind === 'repo-open' && this.state.repo === null) status(this.state.pirateMode ? 'Select a galleon to see its open bounties.' : 'Select a repository to see its open PRs.');
    else if (this.error) status(this.error);
    else if (this.loading) status(this.state.pirateMode ? 'Loading bounties…' : 'Loading PRs…');
    const page = this.page;
    if (page?.quality === 'degraded') status('Some provider results are unavailable. This list may be incomplete.');
    else if (page?.quality === 'partial') status('Showing a limited provider result window. More pull requests may be available.');
    if (page?.truncated && page.quality !== 'partial') status('The result limit was reached. More pull requests may be available.');
    const list = node('ul');
    for (const pr of page?.items.slice(0, presentation.limit) ?? []) {
      if (!pr || typeof pr.repo !== 'string' || typeof pr.title !== 'string' || !Number.isSafeInteger(pr.number) || pr.number < 1 || this.state.repo !== null && pr.repo !== this.state.repo) continue;
      const row = node('li'); row.dataset.prKey = `${pr.repo}#${pr.number}`;
      const identity = node('div'); identity.className = 'pr-identity'; const detail = this.link(`#${pr.number} · ${pr.title}`, this.route(pr)); if (detail) identity.append(detail);
      const state = node('span', pr.status === 'merged' ? 'Merged' : pr.status === 'closed' ? 'Closed' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Open'); state.className = 'pr-state'; state.dataset.state = pr.status; identity.append(state); if (pr.draft) identity.append(node('span', 'Draft')); row.append(identity);
      const created = Number.isFinite(Date.parse(pr.createdAt)) ? new Date(pr.createdAt).toLocaleString() : 'unknown'; row.append(node('small', `${pr.repo}${pr.ticketId ? ` · ${pr.ticketId}` : ''} · Opened ${created}`));
      if (pr.reviewDecision && pr.status === 'open') row.append(node('small', `Review: ${{ APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Required' }[pr.reviewDecision]}`));
      const stats = [['Comments', pr.comments], ['Approvals', pr.reviews?.approved], ['Changes requested', pr.reviews?.changesRequested], [this.state.pirateMode ? 'Pending inspections' : 'Pending reviews', pr.reviews?.requested]] as const;
      const counts = stats.flatMap(([label, count]) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? [`${label}: ${count}`] : []);
      if (counts.length) row.append(node('small', counts.join(' · ')));
      const links = node('div'); links.className = 'pr-links';
      if (pr.url) { const external = this.link('Open at provider ↗', pr.url, true); if (external) links.append(external); }
      if (pr.status === 'open') { const review = this.link('Open review setup ↗', this.route(pr, true)); if (review) links.append(review); }
      row.append(links); list.append(row);
    }
    root.append(list);
    if (page && !page.items.length && !this.loading && !this.error && page.quality === 'complete') status(presentation.kind === 'repo-open' ? this.state.pirateMode ? 'No open bounties in this galleon.' : 'No open pull requests in this repository.' : this.state.pirateMode ? 'No recent bounties.' : 'No recent pull requests.');
    const footer = node('footer'); footer.className = 'pr-links'; footer.append(refresh);
    if (page?.browseUrl) { const browse = this.link('View more at provider ↗', page.browseUrl, true); if (browse) footer.append(browse); }
    root.append(footer);
    const controls = Array.from(root.querySelectorAll<HTMLElement>('a,button'));
    for (const control of controls) control.dataset.prFocus = JSON.stringify([control.closest<HTMLElement>('[data-pr-key]')?.dataset.prKey ?? '', control.textContent, control.getAttribute('href')]);
    this.container.replaceChildren(root); if (focused) controls.find(control => control.dataset.prFocus === focused)?.focus({ preventScroll: true });
  }
}
const panel: PluginPanelModule = { mount(container, context) { if (context.services.pullRequests?.version !== 1) throw new Error('Pull request panels require version 1 reads.'); return new PullRequestPanel(container, context); } };
export default panel;
