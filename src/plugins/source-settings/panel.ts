import type { PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, SourceAdminInputV1, SourceAdminPendingV1, SourceAdminSnapshotV1, SourceAdminServiceV1, SourceAdminSourceV1, SourceAdminValidationV1 } from '@helmsman/plugin-sdk';
import { configuration, consumeResult, emptyState, rawValues, readState, sameTarget, saveValue, type ConfigDraft, type SavedState } from './state.js';
import { styles } from './styles.js';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; }
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function reconcileConfiguration(draft: ConfigDraft, source: SourceAdminSourceV1): ConfigDraft {
  const baseline = rawValues(source); const values = structuredClone(draft.values);
  for (const key of ['label', 'enabled', 'allowed'] as const) if (equal(draft.values[key], draft.baseline[key])) Object.assign(values, { [key]: baseline[key] });
  values.fields = { ...baseline.fields };
  for (const key of new Set([...Object.keys(draft.baseline.fields), ...Object.keys(draft.values.fields)])) {
    if (!equal(draft.values.fields[key], draft.baseline.fields[key])) {
      if (Object.hasOwn(draft.values.fields, key)) values.fields[key] = draft.values.fields[key]!; else delete values.fields[key];
    }
  }
  return { target: source.target, values, baseline };
}
class Administration implements PluginPanelInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  private readonly automaticOnly: boolean;
  private readonly service: SourceAdminServiceV1;
  private state: PluginPanelState;
  private saved: SavedState;
  private unsupported: boolean;
  private snapshot: SourceAdminSnapshotV1 | null = null;
  private pending: readonly SourceAdminPendingV1[] = [];
  private pendingReady = false;
  private validation: SourceAdminValidationV1 | null = null;
  private busy = false;
  private disposed = false;
  private generation = 0;
  private dirty = false;
  private revision = 0;
  private snapshots = new Set<string>();
  private queue: Promise<boolean> = Promise.resolve(true);
  private error = '';
  private saveError = '';
  private readonly message = node('p');
  private readonly saveMessage = node('p');
  constructor(container: HTMLElement, context: PluginPanelContext, automaticOnly: boolean) {
    if (context.services.sourceAdmin?.version !== 1) throw new Error('Source administration service is unavailable.');
    this.container = container; this.context = context; this.automaticOnly = automaticOnly; this.service = context.services.sourceAdmin;
    this.state = context.state; const saved = readState(this.state.savedState); this.unsupported = !saved; this.saved = saved ?? emptyState();
    this.message.setAttribute('role', 'alert'); this.saveMessage.setAttribute('role', 'status');
    context.onDispose(this.dispose); context.signal.addEventListener('abort', this.dispose, { once: true });
    this.state.activity.signal.addEventListener('abort', this.suspend, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private suspend = () => { ++this.generation; this.busy = false; this.validation = null; this.pendingReady = false; this.snapshot = null; };
  dispose = () => { if (this.disposed) return; this.disposed = true; this.suspend(); this.state.activity.signal.removeEventListener('abort', this.suspend); this.context.signal.removeEventListener('abort', this.dispose); this.container.replaceChildren(); };
  update(next: PluginPanelState) {
    if (this.disposed) return;
    const changed = next.activity.epoch !== this.state.activity.epoch || next.repo !== this.state.repo || next.visible !== this.state.visible;
    if (!this.dirty && !equal(next.savedState, this.state.savedState) && !this.snapshots.has(JSON.stringify(next.savedState))) {
      const saved = readState(next.savedState); this.unsupported = !saved; if (saved) this.saved = saved;
    }
    this.state.activity.signal.removeEventListener('abort', this.suspend); this.state = next; next.activity.signal.addEventListener('abort', this.suspend, { once: true });
    if (changed) { this.suspend(); this.pending = []; } this.draw(); if (changed && this.active()) void this.refresh();
  }
  private change() { if (this.unsupported) return; this.dirty = true; ++this.revision; void this.save(); }
  private save(): Promise<boolean> {
    if (this.unsupported || this.disposed) return Promise.resolve(false);
    let value; try { value = saveValue(this.saved); } catch (error) { this.saveError = error instanceof Error ? error.message : 'Settings could not be saved.'; this.saveMessage.textContent = this.saveError; return Promise.resolve(false); }
    const revision = this.revision; this.snapshots.add(JSON.stringify(value)); if (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.values().next().value!);
    this.queue = this.queue.catch(() => false).then(async () => {
      if (this.disposed || revision !== this.revision) return false;
      try { await this.context.saveState(value); if (revision === this.revision) { this.dirty = false; this.saveError = ''; } return true; }
      catch { this.saveError = 'Drafts could not be saved. Your edits are kept; save them before submitting.'; return false; }
      finally { this.saveMessage.textContent = this.saveError; }
    }); return this.queue;
  }
  async refresh() {
    if (!this.active() || this.unsupported || this.busy) return;
    const generation = ++this.generation; this.busy = true; this.error = ''; if (!this.snapshot) this.draw();
    try {
      const [snapshot, pending] = await Promise.all([this.service.snapshot(this.state.activity.signal), this.service.pending()]);
      if (!this.active(generation)) return;
      this.pending = pending; this.pendingReady = true;
      const retained = this.saved.consumed.filter(id => pending.some(entry => entry.command.requestId === id));
      if (retained.length !== this.saved.consumed.length) { this.saved.consumed = retained; this.change(); }
      if (snapshot.status === 'available') this.snapshot = snapshot.value; else { this.snapshot = null; this.error = `Source settings unavailable: ${snapshot.reason}.`; }
    } catch { if (this.active(generation)) { this.error = 'Source settings or saved requests are unavailable. Refresh to retry.'; this.pendingReady = false; } }
    finally { if (this.active(generation)) { this.busy = false; this.draw(); } }
  }
  private async act(action: () => Promise<void>) {
    if (!this.active() || this.busy || this.unsupported) return;
    const generation = this.generation; this.busy = true; this.error = ''; this.draw();
    try { await action(); } catch (error) { if (this.active(generation)) this.error = error instanceof Error ? error.message : 'The request could not be completed. Check its saved outcome before retrying.'; }
    finally {
      if (this.active(generation)) {
        try { this.pending = await this.service.pending(); this.pendingReady = true; } catch { this.pendingReady = false; }
        if (this.active(generation)) { this.busy = false; this.draw(); }
      }
    }
  }
  private async submit(input: SourceAdminInputV1) {
    const generation = this.generation;
    if (!this.pendingReady || !await this.save() || !this.active(generation)) return;
    const result = await this.service.submit(input, this.state.activity.signal);
    if (!this.active(generation)) return;
    if (result.status === 'unavailable') this.error = `Request outcome unavailable: ${result.reason}. Check the saved request; do not create another intent.`;
    const snapshot = await this.service.snapshot(this.state.activity.signal);
    if (this.active(generation) && snapshot.status === 'available') this.snapshot = snapshot.value;
  }
  private button(label: string, action: () => void, disabled = false) { const value = node('button', label); value.type = 'button'; value.disabled = disabled || this.busy || this.unsupported || !this.active(); value.addEventListener('click', () => { if (!value.disabled) action(); }); return value; }
  private text(label: string, value: string, change: (value: string) => void, multiline = false, max = 64000) {
    const wrapper = node('label', label); const input = multiline ? node('textarea') : node('input'); input.setAttribute('aria-label', label); input.value = value; input.maxLength = max; input.dataset.focus = label; input.disabled = this.busy || this.unsupported;
    input.addEventListener('input', () => { if (!input.disabled) { change(input.value); this.change(); } }); wrapper.append(input); return wrapper;
  }
  private toggle(label: string, checked: boolean, change: (value: boolean) => void) {
    const wrapper = node('label'); wrapper.className = 'admin-toggle'; const input = node('input'); input.type = 'checkbox'; input.setAttribute('aria-label', label); input.checked = checked; input.disabled = this.busy || this.unsupported; input.dataset.focus = label;
    input.addEventListener('change', () => { if (!input.disabled) { change(input.checked); this.change(); } }); wrapper.append(input, document.createTextNode(label)); return wrapper;
  }
  private blocked(kind: SourceAdminInputV1['kind'], identity: string) {
    return !this.pendingReady || this.pending.some(entry => entry.command.kind === kind && (kind === 'configure' && entry.command.kind === 'configure' ? entry.command.target.instanceId === identity : entry.command.repo === identity));
  }
  private draw() {
    if (this.disposed) return;
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset.focus; const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd] : null;
    const root = node('div'); root.className = 'plugin-source-settings'; root.append(node('style', styles));
    const tools = node('div'); tools.className = 'source-settings-tools'; tools.append(this.button('Refresh source settings', () => { void this.refresh(); }), this.button('Save settings drafts', () => { void this.save(); }));
    root.append(tools); this.message.textContent = this.error; this.saveMessage.textContent = this.saveError; root.append(this.message, this.saveMessage);
    if (this.unsupported) root.append(node('p', 'This saved settings version is unsupported. Its drafts have been kept; use a compatible panel version.'));
    else if (!this.snapshot) root.append(node('p', this.busy ? 'Loading source settings…' : 'Source settings are unavailable.'));
    else {
      const scope = node('select'); scope.setAttribute('aria-label', 'Administration galleon'); scope.disabled = this.busy;
      const all = node('option', 'All galleons'); all.value = ''; scope.append(all);
      for (const repo of this.snapshot.repos) { const option = node('option', repo); option.value = repo; scope.append(option); }
      scope.value = this.state.activity.repo ?? ''; scope.addEventListener('change', () => { if (!scope.disabled) void this.context.setScope?.(scope.value ? { kind: 'galleon', repo: scope.value } : { kind: 'all' }); }); tools.append(scope);
      if (!this.automaticOnly) this.drawSource(root);
      this.drawAutomatic(root);
    }
    this.drawPending(root); this.container.replaceChildren(root);
    if (focusKey) {
      const replacement = Array.from(root.querySelectorAll<HTMLElement>('[data-focus]')).find(value => value.dataset.focus === focusKey); replacement?.focus({ preventScroll: true });
      if (selection && (replacement instanceof HTMLInputElement && replacement.type !== 'checkbox' || replacement instanceof HTMLTextAreaElement)) { try { replacement.setSelectionRange(selection[0], selection[1]); } catch {} }
    }
  }
  private drawSource(root: HTMLElement) {
    const sources = this.snapshot?.sources ?? []; const picker = node('select'); picker.setAttribute('aria-label', 'Source instance'); picker.disabled = this.busy;
    picker.append(node('option', 'Choose a source instance')); picker.options[0]!.value = '';
    for (const source of sources) { const option = node('option', `${source.label} · ${source.target.instanceId}${source.current ? '' : ' (retired)'}`); option.value = source.target.instanceId; picker.append(option); }
    picker.value = this.saved.selected ?? ''; picker.addEventListener('change', () => { if (!picker.disabled) { this.saved.selected = picker.value || null; this.validation = null; this.change(); this.draw(); } }); root.append(picker);
    const source = sources.find(value => value.target.instanceId === this.saved.selected); if (!source) return;
    let draft = this.saved.configurations.find(value => value.target.instanceId === source.target.instanceId);
    if (!draft) { const values = rawValues(source); draft = { target: source.target, values, baseline: structuredClone(values) }; this.saved.configurations.push(draft); }
    const selected = draft; const section = node('section'); section.append(node('h2', 'Source-wide configuration'), node('p', 'Changes apply to this source instance across every allowed galleon. Automatic selection and the running scheduler are managed separately.'), node('small', `${source.providerId} · ${source.identityLevel} · ${source.available ? 'Available' : 'Unavailable'}`));
    section.append(this.text('Source label', selected.values.label, value => { selected.values.label = value; }, false, 240), this.toggle('Source enabled', selected.values.enabled, value => { selected.values.enabled = value; }), this.text('Allowed galleons (one owner/project per line)', selected.values.allowed, value => { selected.values.allowed = value; }, true, 128 * 1024));
    for (const [key, field] of Object.entries(source.settingsFields)) {
      const explicit = Object.hasOwn(selected.values.fields, key); const raw = selected.values.fields[key];
      const wrapper = field.schema.type === 'boolean' ? this.toggle(field.label, typeof raw === 'boolean' ? raw : field.schema.default, value => { selected.values.fields[key] = value; })
        : this.text(field.label, typeof raw === 'string' ? raw : '', value => { selected.values.fields[key] = value; }, field.schema.type === 'string-list' || field.schema.type === 'string-map');
      const input = wrapper.querySelector('input,textarea'); if (input instanceof HTMLInputElement && input.type === 'checkbox') input.indeterminate = !explicit;
      wrapper.append(node('small', `Provider default: ${JSON.stringify(field.schema.default)}${explicit ? '' : ' (in use)'}`), this.button(`Use provider default for ${field.label}`, () => { delete selected.values.fields[key]; this.change(); this.draw(); }, !explicit)); section.append(wrapper);
    }
    for (const key of Object.keys(selected.values.fields).filter(key => !Object.hasOwn(source.settingsFields, key))) {
      const retained = node('div'); retained.append(node('p', `The current provider does not expose a schema for ${key}. Its draft value is retained.`), node('pre', String(selected.values.fields[key])), this.button(`Discard unsupported setting draft ${key}`, () => { delete selected.values.fields[key]; this.change(); this.draw(); })); section.append(retained);
    }
    const stale = !sameTarget(selected.target, source.target);
    if (stale) section.append(node('p', 'The source revision changed. Reconcile to keep your edits and update untouched fields.'), this.button('Reconcile configuration', () => { this.saved.configurations = this.saved.configurations.map(value => value === selected ? reconcileConfiguration(selected, source) : value); this.validation = null; this.change(); this.draw(); }, this.blocked('configure', source.target.instanceId)));
    section.append(this.button('Apply source configuration', () => { void this.act(async () => { await this.submit({ version: 1, repo: this.state.activity.repo, kind: 'configure', target: selected.target, changes: configuration(selected, source) }); }); }, stale || !source.current || this.blocked('configure', source.target.instanceId))); root.append(section); this.drawReplacement(root, source);
  }
  private drawAutomatic(root: HTMLElement) {
    const section = node('section'); section.append(node('h2', 'Automatic starts')); root.append(section);
    const repo = this.state.activity.repo; if (!repo) { section.append(node('p', 'Choose a galleon to select its task sources and control automatic starts.')); return; }
    const schedule = this.snapshot?.schedules.find(value => value.repo === repo); const runtime = this.snapshot?.runtimes.find(value => value.repo === repo);
    if (!schedule || !runtime) { section.append(node('p', 'The current schedule and runtime are unavailable.')); return; }
    let draft = this.saved.schedules.find(value => value.repo === repo); if (!draft) { draft = { repo, revision: schedule.revision, instances: [...schedule.instanceIds], baseline: [...schedule.instanceIds] }; this.saved.schedules.push(draft); }
    const selected = draft; section.append(node('p', `Selected sources are saved for ${repo}. Enabling automatic starts affects the current server process only.`));
    const candidates = this.snapshot?.sources.filter(value => value.current && value.allowedRepos.includes(repo)) ?? [];
    for (const source of candidates) section.append(this.toggle(`Schedule ${source.label} (${source.target.instanceId})`, selected.instances.includes(source.target.instanceId), checked => {
      selected.instances = checked ? [...new Set([...selected.instances, source.target.instanceId])] : selected.instances.filter(value => value !== source.target.instanceId);
    }));
    for (const id of selected.instances.filter(id => !candidates.some(source => source.target.instanceId === id))) section.append(this.toggle(`Unavailable scheduled source ${id}`, true, checked => {
      if (!checked) selected.instances = selected.instances.filter(value => value !== id);
    }));
    const stale = selected.revision !== schedule.revision;
    if (stale) section.append(node('p', 'The saved source selection changed. Reconcile before applying your selection.'), this.button('Reconcile source selection', () => {
      const added = selected.instances.filter(id => !selected.baseline.includes(id)); const removed = selected.baseline.filter(id => !selected.instances.includes(id));
      selected.instances = [...new Set([...schedule.instanceIds.filter(id => !removed.includes(id)), ...added])]; selected.baseline = [...schedule.instanceIds]; selected.revision = schedule.revision; this.change(); this.draw();
    }, this.blocked('schedule', repo)));
    section.append(this.button('Save automatic source selection', () => { void this.act(() => this.submit({ version: 1, kind: 'schedule', repo, expectedRevision: selected.revision, instanceIds: [...selected.instances] })); }, stale || this.blocked('schedule', repo)));
    section.append(node('p', `Current process automatic starts: ${runtime.enabled ? 'enabled' : 'disabled'}.`), this.button(runtime.enabled ? 'Disable automatic starts' : 'Enable automatic starts', () => { void this.act(() => this.submit({ version: 1, kind: 'runtime', repo, epoch: runtime.epoch, expectedRevision: runtime.revision, enabled: !runtime.enabled })); }, this.blocked('runtime', repo)));
  }
  private drawReplacement(root: HTMLElement, source: SourceAdminSourceV1) {
    const repo = this.state.activity.repo; const section = node('section'); section.append(node('h2', 'Replace source implementation')); root.append(section);
    if (!repo) { section.append(node('p', 'Choose a galleon before validating a replacement.')); return; }
    if (!source.current || !source.replacements.length) { section.append(node('p', 'No installed compatible replacement is available.')); return; }
    let draft = this.saved.replacements.find(value => value.target.instanceId === source.target.instanceId);
    if (!draft) { draft = { target: source.target, candidate: '', actor: '', reason: '' }; this.saved.replacements.push(draft); }
    const selected = draft; const stale = !sameTarget(selected.target, source.target);
    if (stale) section.append(node('p', 'The source changed. Your replacement draft is kept; reconcile it before validating again.'), this.button('Reconcile replacement draft', () => { selected.target = source.target; this.validation = null; this.change(); this.draw(); }));
    const picker = node('select'); picker.setAttribute('aria-label', 'Replacement candidate'); picker.disabled = this.busy;
    const empty = node('option', 'Choose an installed replacement'); empty.value = ''; picker.append(empty);
    for (const candidate of source.replacements) { const option = node('option', `${candidate.mode} · ${candidate.providerId} · ${candidate.artifactHash}`); option.value = JSON.stringify(candidate); picker.append(option); }
    picker.value = selected.candidate; picker.addEventListener('change', () => { if (!picker.disabled) { selected.candidate = picker.value; this.validation = null; this.change(); this.draw(); } });
    section.append(picker, this.text('Replacement actor', selected.actor, value => { selected.actor = value; this.validation = null; }, false, 240), this.text('Replacement reason', selected.reason, value => { selected.reason = value; this.validation = null; }, true, 2048));
    const candidate = source.replacements.find(value => JSON.stringify(value) === selected.candidate); const blocked = this.blocked('replace', repo);
    section.append(this.button('Validate replacement', () => { void this.act(async () => {
      if (!candidate || !selected.actor.trim() || !selected.reason.trim()) throw new Error('Select a replacement and enter an actor and reason.');
      const generation = this.generation; if (!await this.save() || !this.active(generation)) return;
      const result = await this.service.validateReplacement({ repo, target: source.target, ...candidate, actor: selected.actor.trim(), reason: selected.reason.trim() }, this.state.activity.signal);
      if (this.active(generation)) { if (result.status === 'available') this.validation = result.value; else throw new Error(`Replacement validation unavailable: ${result.reason}.`); }
    }); }, stale || !candidate || blocked));
    const valid = !stale && this.validation && sameTarget(this.validation.target, source.target) && this.validation.actor === selected.actor.trim() && this.validation.reason === selected.reason.trim() && candidate && this.validation.artifactHash === candidate.artifactHash && this.validation.providerId === candidate.providerId && this.validation.mode === candidate.mode;
    if (valid) { section.append(node('p', `Validated replacement ${this.validation!.instanceId}. Applying it changes the source implementation.`)); section.append(this.button('Apply validated replacement', () => { const validation = this.validation; if (validation) void this.act(async () => { await this.submit({ version: 1, kind: 'replace', repo, validation }); this.validation = null; }); }, blocked)); }
  }
  private drawPending(root: HTMLElement) {
    for (const entry of this.pending.filter(value => !this.automaticOnly || value.command.kind === 'schedule' || value.command.kind === 'runtime')) {
      const section = node('section'); section.className = 'admin-request'; const receipt = entry.receipt; section.append(node('h3', `Saved ${entry.command.kind} request`), node('small', `${entry.command.requestId} · ${entry.command.repo ?? 'All galleons'}`));
      if (receipt) {
        section.append(node('p', `${receipt.status}${receipt.message ? `: ${receipt.message}` : ''}`));
        if (entry.command.kind === 'runtime') section.append(node('p', receipt.status === 'expired' ? 'The previous process ended. Its outcome is unknown. Review the current process before making a new request.' : 'This is a historical receipt. Current process state is shown above; this receipt does not enable the current process.'));
        section.append(this.button('Accept outcome and dismiss', () => { void this.act(async () => {
          const generation = this.generation; const next = consumeResult(this.saved, entry); this.saved = next; this.dirty = true; ++this.revision;
          if (!await this.save() || !this.active(generation)) return;
          await this.service.acknowledge({ requestId: entry.command.requestId, repo: entry.command.repo });
          if (this.active(generation)) { this.saved.consumed = this.saved.consumed.filter(id => id !== entry.command.requestId); this.change(); await this.save(); }
        }); }));
      } else {
        section.append(node('p', 'Outcome unknown. Keep the original request identity until its outcome is known.'), this.button('Check saved request', () => { void this.act(async () => {
          const generation = this.generation; const result = await this.service.receipt({ requestId: entry.command.requestId, repo: entry.command.repo }, this.state.activity.signal);
          if (this.active(generation)) { if (result.status === 'unavailable') throw new Error(`Receipt unavailable: ${result.reason}.`); if (!result.value) this.error = 'No terminal receipt yet. The original request is retained.'; }
        }); }), this.button('Retry original settings request', () => { const { requestId: _requestId, ...input } = entry.command; void this.act(() => this.submit(input)); }));
      }
      root.append(section);
    }
  }
}
export function mountAdministration(container: HTMLElement, context: PluginPanelContext, automaticOnly = false): PluginPanelInstance { return new Administration(container, context, automaticOnly); }
const panel: PluginPanelModule = { mount: mountAdministration };
export default panel;
