import type { GithubSettingsSnapshotV1, GithubSettingsValuesV1, PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState } from '@helmsman/plugin-sdk';
import { DraftStorage, fromSnapshot, message, normalized, sameValues, schema, validSnapshot, valuesReady, type Draft } from './state.js';
import { styles } from './styles.js';

class GithubSettingsPanel implements PluginPanelInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private readonly storage: DraftStorage;
  private state: PluginPanelState;
  private snapshot: GithubSettingsSnapshotV1 | null = null;
  private draft: Draft | null = null;
  private unsupported = false;
  private busy = false;
  private readReady = false;
  private disposed = false;
  private generation = 0;
  private readController: AbortController | null = null;
  private saveController: AbortController | null = null;
  private error = '';
  private saved = false;
  private storageError = '';
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state; this.storage = new DraftStorage(context.contributionId,context.state.instanceId);
    try { this.draft = this.storage.read(); } catch (error) { this.unsupported = true; this.storageError = message(error,'Saved GitHub settings draft is unavailable. Original data is kept.'); }
    container.innerHTML = `<section class="plugin-github-settings"><style>${styles}</style><h2>Global GitHub settings</h2><p data-global-scope></p><p data-token-status></p><p data-watch-help></p><div class="settings-tools"><button type="button" data-refresh title="Reload saved settings while keeping your edits">Refresh settings</button></div><form><label><span data-repo-label></span><input data-setting="defaultRepo" maxlength="${schema.fields.defaultRepo.maxLength}" placeholder="owner/name" autocomplete="off"></label><label><span data-author-label></span><input data-setting="author" maxlength="${schema.fields.author.maxLength}" autocomplete="off"></label><label><span data-watch-label></span><select data-setting="reviewWatchEnabled"><option value="false">Disabled</option><option value="true">Enabled</option></select></label><p class="settings-note" data-auto-save>Edits are saved locally as you type. Select Save GitHub settings to apply them.</p><p role="alert" data-conflict></p><button type="button" data-rebase hidden>Keep my changes</button><p role="alert" data-storage-error></p><p role="status" data-status></p><div class="settings-tools"><button type="submit" data-save>Save GitHub settings</button><button type="button" data-discard hidden>Discard changes</button><button type="button" data-save-draft hidden>Retry saving draft</button></div></form></section>`;
    container.addEventListener('input',this.edit); container.addEventListener('change',this.edit); container.addEventListener('click',this.click); container.addEventListener('submit',this.submit);
    context.onDispose(this.dispose); context.signal.addEventListener('abort',this.dispose,{once:true}); this.state.activity.signal.addEventListener('abort',this.cancel,{once:true});
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private cancel = () => { ++this.generation; this.readController?.abort(); this.saveController?.abort(); this.readReady = false; };
  dispose = () => { if (this.disposed) return; this.disposed = true; this.cancel(); this.container.removeEventListener('input',this.edit); this.container.removeEventListener('change',this.edit); this.container.removeEventListener('click',this.click); this.container.removeEventListener('submit',this.submit); this.context.signal.removeEventListener('abort',this.dispose); this.state.activity.signal.removeEventListener('abort',this.cancel); this.container.replaceChildren(); };
  update(next: PluginPanelState) { if (this.disposed) return; const changed = this.state.activity !== next.activity || this.state.visible !== next.visible; this.state.activity.signal.removeEventListener('abort',this.cancel); this.state = next; next.activity.signal.addEventListener('abort',this.cancel,{once:true}); if (changed) { this.cancel(); void this.refresh(); } this.draw(); }
  refresh = async () => {
    if (!this.active() || this.busy) return; ++this.generation; this.readController?.abort(); const generation = this.generation; const controller = new AbortController(); this.readController = controller; this.readReady = false; this.draw();
    try { const result = await this.context.services.githubSettings!.snapshot({version:1,scope:'global'},controller.signal); if (!this.active(generation)) return; if (result?.status !== 'available' || !validSnapshot(result.value)) throw new Error('GitHub settings unavailable. Existing edits and original revision are kept.'); this.snapshot = result.value; if (!this.draft && !this.unsupported) this.draft = fromSnapshot(result.value); this.readReady = true; this.error = ''; this.saved = false; }
    catch (error) { if (this.active(generation)) this.error = message(error,'GitHub settings unavailable. Existing edits are kept.'); }
    finally { if (this.active(generation)) this.draw(); }
  };
  private persist() { if (!this.draft || this.unsupported) return false; try { this.storage.save(this.draft); this.storageError = ''; return true; } catch (error) { this.storageError = message(error,'GitHub settings draft could not be saved. Keep this page open.'); return false; } }
  private edit = (event: Event) => {
    const input = event.target; if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement) || !this.active() || !this.draft || this.unsupported) return;
    const key = input.dataset.setting; if (key === 'defaultRepo' || key === 'author') this.draft = {...this.draft,values:{...this.draft.values,[key]:input.value}};
    else return;
    this.persist(); this.draw();
  };
  private click = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null; if (!button || button.disabled || !this.active()) return; event.stopPropagation();
    const hadFocus = document.activeElement === button;
    if (button.hasAttribute('data-refresh')) void (this.context.refresh?.() ?? this.refresh());
    else if (button.hasAttribute('data-save-draft')) { this.persist(); this.draw(); this.focusAfterHiddenAction(button,'[data-save]',hadFocus); }
    else if (button.hasAttribute('data-rebase') && this.snapshot && this.draft && !this.unsupported) { this.draft = {...this.draft,revision:this.snapshot.revision}; this.persist(); this.error = 'Your changes now use the latest revision. Select Save GitHub settings to apply them.'; this.saved = false; this.draw(); this.focusAfterHiddenAction(button,'[data-save]',hadFocus); }
    else if (button.hasAttribute('data-discard') && this.snapshot && !this.unsupported) { this.draft = fromSnapshot(this.snapshot); this.persist(); this.error = ''; this.saved = false; this.draw(); this.focusAfterHiddenAction(button,'[data-setting="defaultRepo"]',hadFocus); }
  };
  private focusAfterHiddenAction(button: HTMLButtonElement, selector: string, hadFocus: boolean) {
    if (!hadFocus || !button.hidden) return;
    for (const candidate of [selector,'[data-setting="defaultRepo"]','[data-refresh]']) {
      const target = this.container.querySelector<HTMLInputElement | HTMLButtonElement>(candidate);
      if (target && !target.disabled && !target.hidden) { target.focus(); return; }
    }
  }
  private submit = (event: Event) => { event.preventDefault(); event.stopPropagation(); void this.save(); };
  private async save() {
    if (!this.active() || this.busy || !this.readReady || !this.draft || this.unsupported || !valuesReady(this.draft.values) || !this.persist()) { this.draw(); return; }
    const submitted = this.draft; const values = normalized({...submitted.values,reviewWatchEnabled:this.snapshot?.values.reviewWatchEnabled ?? submitted.values.reviewWatchEnabled}); const generation = ++this.generation; this.readController?.abort(); this.busy = true; this.error = ''; this.saved = false; const controller = new AbortController(); this.saveController = controller; const signal = AbortSignal.any([controller.signal,this.context.signal,this.state.activity.signal]); this.draw();
    try { const result = await this.context.services.githubSettings!.save({version:1,scope:'global',namespace:schema.namespace,expectedRevision:submitted.revision,values},signal); if (!this.active(generation) || signal.aborted) return;
      if (result?.status !== 'available' || !validSnapshot(result.value) || !sameValues(result.value.values,values)) { this.readReady = false; this.error = 'Settings save was not confirmed. Your edits and original revision are kept. Refresh settings before explicitly rebasing or discarding edits.'; return; }
      this.snapshot = result.value; if (this.draft.revision === submitted.revision && sameValues(this.draft.values,submitted.values)) { this.draft = fromSnapshot(result.value); this.persist(); }
      this.saved = true; this.error = '';
    } catch (error) { this.readReady = false; if (!this.disposed) this.error = message(error,'Settings save was not confirmed. Existing edits and original revision are kept. No automatic retry will occur.'); }
    finally { this.busy = false; this.saveController = null; if (!this.disposed) { this.draw(); if (this.active() && generation !== this.generation) void this.refresh(); } }
  }
  private draw() {
    if (this.disposed) return; const set = (selector: string, text: string) => { const node = this.container.querySelector(selector); if (node) node.textContent = text; };
    const repo = this.state.pirateMode ? 'galleon' : 'repository';
    const repos = this.state.pirateMode ? 'galleons' : 'repositories';
    const review = this.state.pirateMode ? 'inspection' : 'review';
    set('[data-global-scope]',`These settings apply across all ${repos}. Saving the default ${repo} does not change the header ${repo}.`);
    set('[data-repo-label]',this.state.pirateMode ? 'Default galleon' : schema.fields.defaultRepo.label);
    set('[data-author-label]',this.state.pirateMode ? 'Bounty author' : schema.fields.author.label);
    set('[data-watch-label]',this.state.pirateMode ? 'Watch GitHub inspection requests' : schema.fields.reviewWatchEnabled.label);
    set('[data-watch-help]',`Automatic ${review} status is read-only here. Configure the selected github-review trigger in plugin settings; restart after changing its settings.`);
    set('[data-token-status]',this.snapshot ? `GitHub credential: ${this.snapshot.tokenSet ? 'configured' : 'not configured'}. Credentials are managed by the host.` : 'GitHub credential status unavailable.');
    const conflict = !!(this.snapshot && this.draft && this.draft.revision !== this.snapshot.revision);
    const changed = !!(this.snapshot && this.draft && (conflict || !sameValues(this.draft.values,this.snapshot.values)));
    set('[data-conflict]',conflict ? 'Saved settings changed since these edits began. The original revision is retained. Keep my changes uses the latest revision; select Save GitHub settings afterward to apply them.' : '');
    set('[data-status]',this.saved ? `Global GitHub settings saved. The header ${repo} is unchanged.` : this.error); set('[data-storage-error]',this.storageError);
    const note = this.container.querySelector<HTMLElement>('[data-auto-save]'); if (note) note.hidden = this.unsupported || !!this.storageError || !this.draft;
    for (const input of this.container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]')) { const key = input.dataset.setting as keyof GithubSettingsValuesV1; const value = key === 'reviewWatchEnabled' ? this.snapshot?.values.reviewWatchEnabled : this.draft?.values[key]; const text = value === undefined ? '' : String(value); if (input.value !== text) input.value = text; input.disabled = key === 'reviewWatchEnabled' || !this.active() || this.unsupported || !this.draft; }
    const disabled = !this.active() || this.busy; for (const button of this.container.querySelectorAll<HTMLButtonElement>('button')) button.disabled = disabled;
    const save = this.container.querySelector<HTMLButtonElement>('[data-save]'); if (save) { save.textContent = this.busy ? 'Saving GitHub settings…' : 'Save GitHub settings'; save.disabled ||= this.unsupported || !this.readReady || !this.draft || !!this.storageError || !valuesReady(this.draft.values); }
    for (const button of this.container.querySelectorAll<HTMLButtonElement>('[data-discard],[data-rebase]')) button.disabled ||= this.unsupported || !this.readReady || !this.snapshot;
    const rebase = this.container.querySelector<HTMLButtonElement>('[data-rebase]'); if (rebase) { rebase.hidden = !conflict || this.unsupported; rebase.disabled ||= !this.draft; }
    const discard = this.container.querySelector<HTMLButtonElement>('[data-discard]'); if (discard) { discard.hidden = !changed || this.unsupported; discard.textContent = conflict ? 'Use saved settings' : 'Discard changes'; }
    const draft = this.container.querySelector<HTMLButtonElement>('[data-save-draft]'); if (draft) { draft.hidden = !this.storageError || this.unsupported; draft.disabled ||= this.unsupported || !this.draft; }
  }
}
const panel: PluginPanelModule = {mount(container,context) { if (context.services.githubSettings?.version !== 1) throw new Error('GitHub settings require version 1 public settings services.'); return new GithubSettingsPanel(container,context); }};
export default panel;
