import type { JiraSettingsSnapshotV1, PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState } from '@helmsman/plugin-sdk';
import { schema, validSnapshot } from './state.js';
import { styles } from './styles.js';

class JiraSettingsPanel implements PluginPanelInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private state: PluginPanelState;
  private snapshot: JiraSettingsSnapshotV1 | null = null;
  private token = '';
  private revision: string | null = null;
  private busy = false;
  private readReady = false;
  private disposed = false;
  private generation = 0;
  private readController: AbortController | null = null;
  private saveController: AbortController | null = null;
  private error = '';
  private readonly input: HTMLInputElement;
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state;
    const helpId = `jira-token-help-${crypto.randomUUID()}`;
    container.innerHTML = `<section class="plugin-jira-settings"><style>${styles}</style><h2>Global Jira settings</h2><p data-global-scope></p><p data-token-status></p><p data-source-status></p><p>Manage live project, JQL, assignee and source enablement in <a data-source-settings>Source settings</a>. Updating the token does not provision or enable a source.</p><div class="settings-tools"><button data-refresh>Refresh settings</button><button data-rebase>Use latest revision and keep token</button><button data-discard>Discard token draft</button></div><form><label>${schema.fields.token.label}<input data-token type="password" autocomplete="new-password" spellcheck="false" maxlength="${schema.fields.token.maxLength}" aria-describedby="${helpId}"></label><p id="${helpId}">Write-only. The token stays in memory until submitted or discarded and is never saved in browser storage. Existing tokens are never displayed.</p><p role="alert" data-conflict></p><p role="status" data-status></p><button type="submit" data-save>Update Jira token</button></form></section>`;
    this.input = container.querySelector<HTMLInputElement>('[data-token]')!;
    container.addEventListener('input',this.edit); container.addEventListener('change',this.edit); container.addEventListener('click',this.click); container.addEventListener('submit',this.submit);
    context.onDispose(this.dispose); context.signal.addEventListener('abort',this.dispose,{once:true}); this.state.activity.signal.addEventListener('abort',this.cancel,{once:true});
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private cancel = () => { ++this.generation; this.readController?.abort(); this.saveController?.abort(); this.readReady = false; };
  dispose = () => { if (this.disposed) return; this.disposed = true; this.cancel(); this.token = ''; this.input.value = ''; this.container.removeEventListener('input',this.edit); this.container.removeEventListener('change',this.edit); this.container.removeEventListener('click',this.click); this.container.removeEventListener('submit',this.submit); this.context.signal.removeEventListener('abort',this.dispose); this.state.activity.signal.removeEventListener('abort',this.cancel); this.container.replaceChildren(); };
  update(next: PluginPanelState) { if (this.disposed) return; const changed = this.state.activity !== next.activity || this.state.visible !== next.visible; this.state.activity.signal.removeEventListener('abort',this.cancel); this.state = next; next.activity.signal.addEventListener('abort',this.cancel,{once:true}); if (changed) { this.cancel(); void this.refresh(); } this.draw(); }
  refresh = async () => {
    if (!this.active() || this.busy) return; ++this.generation; this.readController?.abort(); const generation = this.generation; const controller = new AbortController(); this.readController = controller; this.readReady = false; this.draw();
    try { const result = await this.context.services.jiraSettings!.snapshot({version:1,scope:'global'},controller.signal); if (!this.active(generation)) return; if (result?.status !== 'available' || !validSnapshot(result.value)) throw new Error(); this.snapshot = result.value; if (this.revision === null || !this.token) this.revision = result.value.revision; this.readReady = true; this.error = ''; }
    catch { if (this.active(generation)) this.error = 'Jira settings unavailable. Your in-memory token and original revision are kept.'; }
    finally { if (this.active(generation)) this.draw(); }
  };
  private edit = (event: Event) => { if (event.target !== this.input || !this.active()) return; this.token = this.input.value; this.draw(); };
  private click = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null; if (!button || button.disabled || !this.active()) return; event.stopPropagation();
    if (button.hasAttribute('data-refresh')) void this.refresh();
    else if (button.hasAttribute('data-rebase') && this.snapshot) { this.revision = this.snapshot.revision; this.error = ''; this.draw(); }
    else if (button.hasAttribute('data-discard')) { this.token = ''; this.input.value = ''; this.revision = this.snapshot?.revision ?? null; this.error = ''; this.draw(); }
  };
  private submit = (event: Event) => { event.preventDefault(); event.stopPropagation(); void this.save(); };
  private async save() {
    if (!this.active() || this.busy || !this.readReady || !this.revision || !this.token.trim() || this.token.length > schema.fields.token.maxLength) return;
    const token = this.token; const revision = this.revision; const generation = ++this.generation; this.readController?.abort(); this.busy = true; this.error = ''; const controller = new AbortController(); this.saveController = controller; const signal = AbortSignal.any([controller.signal,this.context.signal,this.state.activity.signal]); this.draw();
    try { const result = await this.context.services.jiraSettings!.rotateToken({version:1,scope:'global',namespace:schema.namespace,expectedRevision:revision,token},signal); if (!this.active(generation) || signal.aborted) return;
      if (result?.status !== 'available' || !validSnapshot(result.value) || !result.value.tokenSet) { this.readReady = false; this.error = 'Token update was not confirmed. Your token and original revision are kept. Refresh settings, then explicitly use the latest revision before another save.'; return; }
      this.snapshot = result.value; if (this.token === token && this.revision === revision) { this.token = ''; this.input.value = ''; this.revision = result.value.revision; }
      this.error = 'Jira token updated. Source configuration and enablement are unchanged.';
    } catch { this.readReady = false; if (!this.disposed) this.error = 'Token update was not confirmed. Your in-memory token and original revision are kept. No automatic retry will occur.'; }
    finally { this.busy = false; this.saveController = null; if (!this.disposed) { this.draw(); if (this.active() && generation !== this.generation) void this.refresh(); } }
  }
  private draw() {
    if (this.disposed) return; const set = (selector: string, text: string) => { const node = this.container.querySelector(selector); if (node) node.textContent = text; };
    const repo = this.state.pirateMode ? 'galleon' : 'repository';
    const repos = this.state.pirateMode ? 'galleons' : 'repositories';
    set('[data-global-scope]',`These settings apply to the shared Jira connection across all ${repos}. The header ${repo} stays unchanged.`);
    set('[data-token-status]',this.snapshot ? `API token: ${this.snapshot.tokenSet ? 'set' : 'not set'}.` : 'API token status unavailable.');
    set('[data-source-status]',this.snapshot ? this.snapshot.sourceConfigured ? 'A Jira source is configured. Manage its live settings in Source settings.' : `No Jira source is configured. Initial Jira setup is ${this.snapshot.bootstrapEnabled ? 'enabled' : 'disabled'}. Configure the initial Jira connection and restart Helmsman to provision a source; saving a token alone does not create one.` : 'Initial source setup status unavailable.');
    set('[data-conflict]',this.snapshot && this.revision !== this.snapshot.revision && this.token ? 'Settings changed since this token draft began. Its original revision is retained. Use the latest revision explicitly to rebase this draft.' : '');
    set('[data-status]',this.error); const header = this.state.headerRepo === undefined ? this.state.repo : this.state.headerRepo; const link = this.container.querySelector<HTMLAnchorElement>('[data-source-settings]'); if (link) link.href = '/source-settings' + (header ? `?repo=${encodeURIComponent(header)}` : '');
    this.input.disabled = !this.active(); const disabled = !this.active() || this.busy;
    for (const button of this.container.querySelectorAll<HTMLButtonElement>('button')) button.disabled = disabled;
    const save = this.container.querySelector<HTMLButtonElement>('[data-save]'); if (save) save.disabled ||= !this.readReady || !this.revision || !this.token.trim() || this.token.length > schema.fields.token.maxLength;
    const rebase = this.container.querySelector<HTMLButtonElement>('[data-rebase]'); if (rebase) rebase.disabled ||= !this.readReady || !this.snapshot || !this.token || this.revision === this.snapshot.revision;
    const discard = this.container.querySelector<HTMLButtonElement>('[data-discard]'); if (discard) discard.disabled ||= !this.token;
  }
}
const panel: PluginPanelModule = {mount(container,context) { if (context.services.jiraSettings?.version !== 1) throw new Error('Jira settings require version 1 public settings services.'); return new JiraSettingsPanel(container,context); }};
export default panel;
