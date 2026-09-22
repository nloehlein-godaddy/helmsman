import type { CommunicationSettingsSnapshotV1, CommunicationSettingsValuesV1, PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState } from '@helmsman/plugin-sdk';
import { esc, message, Storage } from './util.js';
import { styles } from './styles.js';
interface Draft { version: 1; revision: string; values: CommunicationSettingsValuesV1; }
const fields: readonly [keyof CommunicationSettingsValuesV1, string][] = [['enabled', 'Slack integration'], ['watchEnabled', 'Automatic reviews from Slack'], ['clientId', 'Slack workspace ID'], ['channelId', 'Watched channel ID'], ['channelName', 'Watched channel name'], ['browserSurface', 'Browser surface (legacy browser provider only)'], ['reviewChannel', 'Review request channel'], ['reviewMention', 'Review group ID (Companion) or handle (browser)']];
function validDraft(value: unknown): value is Draft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const draft = value as Partial<Draft>;
  return draft.version === 1 && typeof draft.revision === 'string' && !!draft.values && typeof draft.values === 'object' && !Array.isArray(draft.values) && Object.keys(value).every(key => ['version', 'revision', 'values'].includes(key)) && Object.keys(draft.values).length === fields.length && fields.every(([key]) => typeof draft.values?.[key] === (key === 'enabled' || key === 'watchEnabled' ? 'boolean' : 'string'));
}
class SettingsPanel implements PluginPanelInstance {
  private state: PluginPanelState;
  private readonly storage: Storage;
  private draft: Draft | null = null;
  private snapshot: CommunicationSettingsSnapshotV1 | null = null;
  private error = '';
  private storageError = '';
  private unsupported = false;
  private busy = false;
  private disposed = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state; this.storage = new Storage(context.contributionId);
    try { const saved = this.storage.read('settings-draft'); if (saved !== null && !validDraft(saved)) throw new Error('Stored settings draft uses an unsupported format. Its original data is kept.'); this.draft = saved; }
    catch (error) { this.unsupported = true; this.storageError = message(error, 'Stored settings draft is unavailable.'); }
    container.addEventListener('input', this.input); container.addEventListener('change', this.input); container.addEventListener('click', this.click);
    context.onDispose(this.dispose); context.signal.addEventListener('abort', this.dispose, { once: true }); this.state.activity.signal.addEventListener('abort', this.cancel, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && this.generation === generation; }
  private cancel = () => { ++this.generation; this.controller?.abort(); this.controller = null; };
  dispose = () => { if (this.disposed) return; this.disposed = true; this.cancel(); this.container.removeEventListener('input', this.input); this.container.removeEventListener('change', this.input); this.container.removeEventListener('click', this.click); this.context.signal.removeEventListener('abort', this.dispose); this.state.activity.signal.removeEventListener('abort', this.cancel); };
  update(next: PluginPanelState) { const changed = this.state.activity !== next.activity || this.state.visible !== next.visible; this.state.activity.signal.removeEventListener('abort', this.cancel); this.state = next; next.activity.signal.addEventListener('abort', this.cancel, { once: true }); if (changed) { this.cancel(); void this.refresh(); } this.draw(); }
  refresh = async () => {
    if (!this.active() || this.busy) return; this.cancel(); const generation = this.generation; const controller = new AbortController(); this.controller = controller;
    try { const result = await this.context.services.communication!.settings(controller.signal); if (!this.active(generation)) return;
      if (result?.status !== 'available' || !validDraft({ version: 1, revision: result.value?.revision, values: result.value?.values })) throw new Error('Communication settings unavailable. Existing edits are kept.');
      this.snapshot = result.value; if (!this.draft && !this.unsupported) this.draft = { version: 1, revision: result.value.revision, values: { ...result.value.values } }; this.error = '';
    } catch (error) { if (this.active(generation)) this.error = message(error, 'Communication settings unavailable.'); }
    finally { if (this.active(generation)) this.draw(); }
  };
  private persist() { if (!this.draft || this.unsupported) return false; try { this.storage.save('settings-draft', this.draft); this.storageError = ''; return true; } catch (error) { this.storageError = message(error, 'Settings draft could not be saved. Keep this page open.'); return false; } }
  private input = (event: Event) => {
    if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) || !this.draft || this.busy || this.unsupported) return;
    const key = event.target.dataset.setting as keyof CommunicationSettingsValuesV1 | undefined; if (!key || key === 'watchEnabled' || !fields.some(([field]) => field === key)) return;
    this.draft = { ...this.draft, values: { ...this.draft.values, [key]: key === 'enabled' ? event.target.value === 'true' : event.target.value } }; this.persist(); this.paintSafety();
  };
  private click = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null; if (!button || button.disabled || !this.active()) return; event.stopPropagation();
    if (button.matches('[data-save-settings]')) void this.save();
    else if (button.matches('[data-refresh]')) void this.refresh();
    else if (button.matches('[data-save-draft]')) { this.persist(); this.paintSafety(); }
    else if (button.matches('[data-reload-settings]') && this.snapshot && !this.unsupported) { this.draft = { version: 1, revision: this.snapshot.revision, values: { ...this.snapshot.values } }; this.persist(); this.error = ''; this.draw(); }
  };
  private async save() {
    if (!this.draft || this.unsupported || this.busy || !this.persist()) { this.paintSafety(); return; }
    const input = { expectedRevision: this.draft.revision, values: { ...this.draft.values, watchEnabled: this.snapshot?.values.watchEnabled ?? this.draft.values.watchEnabled } }; this.busy = true; this.error = ''; this.draw();
    try { const result = await this.context.services.communication!.saveSettings(input, this.state.activity.signal);
      if (result?.status !== 'available' || !validDraft({ version: 1, revision: result.value?.revision, values: result.value?.values })) throw new Error(`Settings were not saved${result?.status === 'unavailable' ? `: ${result.reason}` : ''}. Your edits are kept. Refresh to inspect the latest settings.`);
      this.snapshot = result.value; this.draft = { version: 1, revision: result.value.revision, values: { ...result.value.values } }; this.persist(); this.error = 'Settings saved. No message was sent.';
    } catch (error) { this.error = message(error, 'Settings result unavailable. Your edits are kept.'); }
    finally { this.busy = false; this.draw(); }
  }
  private paintSafety() { const disabled = !this.active() || this.busy || this.unsupported; this.container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]').forEach(input => { input.disabled = input.dataset.setting === 'watchEnabled' || disabled; }); const save = this.container.querySelector<HTMLButtonElement>('[data-save-settings]'); if (save) save.disabled = disabled || !this.draft || Boolean(this.storageError); const error = this.container.querySelector('[data-storage-error]'); if (error) error.textContent = this.storageError; }
  private draw() {
    if (this.disposed) return; const focus = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement.dataset.setting : undefined; const selection = document.activeElement instanceof HTMLInputElement ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] as const : null;
    const draft = this.draft ? { ...this.draft, values: { ...this.draft.values, watchEnabled: this.snapshot?.values.watchEnabled ?? this.draft.values.watchEnabled } } : null;
    this.container.innerHTML = `<section class="plugin-communication communication-settings"><style>${styles}</style><h2>Communication settings</h2><p>Uses the selected Slack provider. The default Companion connects directly to Slack; configure its credential in the server environment. Browser surface applies only to the legacy browser provider. Companion review requests require a channel ID beginning with C or G and a user group ID beginning with S. Saving settings never sends a message. Turning Slack off preserves saved destinations and admitted requests. Automatic review status is read-only here; configure the selected slack-review trigger in plugin settings and restart after changing its settings.</p><div class="communication-tools"><button data-refresh>Refresh settings</button><button data-reload-settings${!this.snapshot || this.unsupported ? ' disabled' : ''}>Discard edits and use latest settings</button></div>${this.error ? `<p role="status">${esc(this.error)}</p>` : ''}<p role="alert" data-storage-error>${esc(this.storageError)}</p>${draft ? fields.map(([key, title]) => `<label>${esc(title)}${key === 'enabled' || key === 'watchEnabled' ? `<select${key === 'watchEnabled' ? ' disabled' : ''} data-setting="${key}" aria-label="${esc(title)}"><option value="true"${draft.values[key] ? ' selected' : ''}>Enabled</option><option value="false"${!draft.values[key] ? ' selected' : ''}>Disabled</option></select>` : `<input data-setting="${key}" aria-label="${esc(title)}" maxlength="2048" value="${esc(draft.values[key])}">`}</label>`).join('') : '<p>Settings unavailable.</p>'}${this.snapshot && draft && this.snapshot.revision !== draft.revision ? '<p role="alert">Settings changed since these edits began. Your original revision and edits are retained; saving will check that revision.</p>' : ''}<div class="communication-tools"><button data-save-settings>Save settings</button><button data-save-draft>Save draft</button></div></section>`;
    if (focus) { const input = [...this.container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]')].find(input => input.dataset.setting === focus); input?.focus({ preventScroll: true }); if (selection && input instanceof HTMLInputElement) input.setSelectionRange(...selection); } this.paintSafety();
  }
}
const panel: PluginPanelModule = { mount(container, context) { if (context.services.communication?.version !== 1) throw new Error('Settings require version 1 communication services.'); return new SettingsPanel(container, context); } };
export default panel;
