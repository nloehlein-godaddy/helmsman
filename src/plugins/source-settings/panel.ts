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
  private disclosures = new Set<string>();
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
    let value; try { value = saveValue(this.saved); } catch (error) { this.saveError = error instanceof Error ? error.message : 'Settings could not be saved.'; this.updateSaveRecovery(); return Promise.resolve(false); }
    const revision = this.revision; this.snapshots.add(JSON.stringify(value)); if (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.values().next().value!);
    this.queue = this.queue.catch(() => false).then(async () => {
      if (this.disposed || revision !== this.revision) return false;
      try { await this.context.saveState(value); if (revision === this.revision) { this.dirty = false; this.saveError = ''; } return true; }
      catch { this.saveError = 'Drafts could not be saved. Your edits are kept; save them before submitting.'; return false; }
      finally { this.updateSaveRecovery(); }
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
    if (result.status === 'unavailable') this.error = `Request outcome unavailable: ${result.reason}. Check the saved request before making another change.`;
    const snapshot = await this.service.snapshot(this.state.activity.signal);
    if (this.active(generation) && snapshot.status === 'available') this.snapshot = snapshot.value;
  }
  private async retry(entry: SourceAdminPendingV1) {
    const generation = this.generation;
    if (!this.service.retry) throw new Error('Retrying the original settings request is unavailable. Check its result instead.');
    if (!this.pendingReady || !await this.save() || !this.active(generation)) return;
    const result = await this.service.retry({ repo: entry.command.repo, requestId: entry.command.requestId }, this.state.activity.signal);
    if (!this.active(generation)) return;
    if (result.status === 'unavailable') this.error = `Original request unavailable: ${result.reason}. Your settings draft is retained.`;
    const snapshot = await this.service.snapshot(this.state.activity.signal);
    if (this.active(generation) && snapshot.status === 'available') this.snapshot = snapshot.value;
  }
  private updateSaveRecovery() { this.saveMessage.textContent = this.saveError; const retry = this.container.querySelector<HTMLButtonElement>('[data-retry-drafts]'); if (!retry) return; const restoreFocus = !this.saveError && document.activeElement === retry; retry.hidden = !this.saveError; retry.disabled = retry.hidden || this.busy || this.unsupported || !this.active(); if (restoreFocus) this.container.querySelector<HTMLButtonElement>('[data-refresh-source]')?.focus({ preventScroll: true }); }
  private button(label: string, action: () => void, disabled = false, primary = false) { const value = node('button', label); value.type = 'button'; value.disabled = disabled || this.busy || this.unsupported || !this.active(); if (primary) value.className = 'primary-action'; value.addEventListener('click', () => { if (!value.disabled) action(); }); return value; }
  private help(control: HTMLElement, label: string, text: string): HTMLElement {
    const hint = node('small', text); hint.className = 'admin-help'; hint.id = `source-help-${encodeURIComponent(JSON.stringify([this.state.instanceId, label]))}`;
    control.setAttribute('aria-describedby', hint.id); return hint;
  }
  private actions(...buttons: HTMLButtonElement[]): HTMLElement {
    const row = node('div'); row.className = 'admin-actions'; row.append(...buttons); return row;
  }
  private disclosure(key: string, title: string): { details: HTMLDetailsElement; body: HTMLElement } {
    const details = node('details'); details.className = 'admin-details'; details.dataset.disclosure = key; details.open = this.disclosures.has(key);
    const summary = node('summary', title); summary.dataset.focus = key; const body = node('div'); body.className = 'admin-details-body'; details.append(summary, body);
    details.addEventListener('toggle', () => { if (details.isConnected) { if (details.open) this.disclosures.add(key); else this.disclosures.delete(key); } });
    return { details, body };
  }
  private text(label: string, value: string, change: (value: string) => void, multiline = false, max = 64000, hint = '') {
    const wrapper = node('div'); wrapper.className = 'admin-field'; const labelNode = node('label', label); const input = multiline ? node('textarea') : node('input'); input.setAttribute('aria-label', label); input.value = value; input.maxLength = max; input.dataset.focus = label; input.disabled = this.busy || this.unsupported;
    input.addEventListener('input', () => { if (!input.disabled) { change(input.value); this.change(); } }); labelNode.append(input); wrapper.append(labelNode); if (hint) wrapper.append(this.help(input, label, hint)); return wrapper;
  }
  private toggle(label: string, checked: boolean, change: (value: boolean) => void, hint = '') {
    const wrapper = node('label'); wrapper.className = 'admin-toggle'; const input = node('input'); input.type = 'checkbox'; input.setAttribute('aria-label', label); input.checked = checked; input.disabled = this.busy || this.unsupported; input.dataset.focus = label;
    input.addEventListener('change', () => { if (!input.disabled) { change(input.checked); this.change(); } }); wrapper.append(input, document.createTextNode(label));
    if (!hint) return wrapper; const field = node('div'); field.className = 'admin-field'; field.append(wrapper, this.help(input, label, hint)); return field;
  }
  private blocked(kind: SourceAdminInputV1['kind'], identity: string) {
    return !this.pendingReady || this.pending.some(entry => entry.command.kind === kind && (kind === 'configure' && entry.command.kind === 'configure' ? entry.command.target.instanceId === identity : entry.command.repo === identity));
  }
  private draw() {
    if (this.disposed) return;
    for (const details of this.container.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')) {
      const key = details.dataset.disclosure; if (!key) continue; if (details.open) this.disclosures.add(key); else this.disclosures.delete(key);
    }
    const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset.focus; const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd] : null;
    const root = node('div'); root.className = 'plugin-source-settings'; root.append(node('style', styles));
    const tools = node('div'); tools.className = 'source-settings-tools'; const refresh = this.button('Refresh settings', () => { void (this.context.refresh?.() ?? this.refresh()); }); refresh.dataset.refreshSource = ''; const retry = this.button('Retry draft save', () => { void this.save(); }, !this.saveError); retry.dataset.retryDrafts = ''; retry.hidden = !this.saveError; tools.append(refresh, retry);
    root.append(tools, node('p', 'Edits are saved as drafts automatically. Use each section’s Save button to apply its changes.')); this.message.textContent = this.error; this.saveMessage.textContent = this.saveError; root.append(this.message, this.saveMessage);
    if (this.unsupported) root.append(node('p', 'This saved settings version is unsupported. Its drafts have been kept; use a compatible panel version.'));
    else if (!this.snapshot) root.append(node('p', this.busy ? 'Loading source settings…' : 'Source settings are unavailable.'));
    else {
      const scope = node('select'); scope.setAttribute('aria-label', 'Panel galleon'); scope.dataset.focus = 'scope'; scope.disabled = this.busy;
      const all = node('option', 'All galleons'); all.value = ''; scope.append(all);
      for (const repo of this.snapshot.repos) { const option = node('option', repo); option.value = repo; scope.append(option); }
      scope.value = this.state.activity.repo ?? ''; scope.addEventListener('change', () => { if (!scope.disabled) void this.context.setScope?.(scope.value ? { kind: 'galleon', repo: scope.value } : { kind: 'all' }); }); const scopeField = node('div'); scopeField.className = 'admin-field'; const scopeLabel = node('label', 'Panel galleon'); scopeLabel.append(scope); scopeField.append(scopeLabel, this.help(scope, 'scope', 'Uses the header selection unless you choose a different galleon here. This changes only this panel.')); root.append(scopeField);
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
    const sources = this.snapshot?.sources ?? []; const picker = node('select'); picker.setAttribute('aria-label', 'Task source'); picker.dataset.focus = 'source-picker'; picker.disabled = this.busy;
    picker.append(node('option', 'Choose a task source')); picker.options[0]!.value = '';
    for (const source of sources) { const option = node('option', `${source.label}${sources.filter(value => value.label === source.label).length > 1 ? ` · ${source.target.instanceId}` : ''}${source.current ? '' : ' (retired)'}`); option.value = source.target.instanceId; picker.append(option); }
    picker.value = this.saved.selected ?? ''; picker.addEventListener('change', () => { if (!picker.disabled) { this.saved.selected = picker.value || null; this.validation = null; this.change(); this.draw(); } }); const sourceField = node('div'); sourceField.className = 'admin-field'; const sourceLabel = node('label', 'Task source'); sourceLabel.append(picker); sourceField.append(sourceLabel, this.help(picker, 'source-picker', 'Choose where tasks come from, such as Jira or Todos.')); root.append(sourceField);
    const source = sources.find(value => value.target.instanceId === this.saved.selected); if (!source) return;
    let draft = this.saved.configurations.find(value => value.target.instanceId === source.target.instanceId);
    if (!draft) { const values = rawValues(source); draft = { target: source.target, values, baseline: structuredClone(values) }; this.saved.configurations.push(draft); }
    const selected = draft; const section = node('section'); section.append(node('h2', 'Source settings'), node('p', 'These settings apply everywhere this source is allowed, including other galleons.'), node('small', source.available ? 'Source available' : 'Source unavailable'));
    section.append(this.text('Source label', selected.values.label, value => { selected.values.label = value; }, false, 240, 'The name shown in task lists and source selectors.'), this.toggle('Source enabled', selected.values.enabled, value => { selected.values.enabled = value; }, 'Make this source available for task lists and new runs. Disabling it keeps its settings and tasks.'), this.text('Allowed galleons', selected.values.allowed, value => { selected.values.allowed = value; }, true, 128 * 1024, 'Enter owner/project, one per line. Only these galleons can use this source. Removing one keeps its tasks.'));
    for (const [key, field] of Object.entries(source.settingsFields)) {
      const explicit = Object.hasOwn(selected.values.fields, key); const raw = selected.values.fields[key];
      const fieldControl = field.schema.type === 'boolean' ? this.toggle(field.label, typeof raw === 'boolean' ? raw : field.schema.default, value => { selected.values.fields[key] = value; this.draw(); })
        : this.text(field.label, typeof raw === 'string' ? raw : '', value => { selected.values.fields[key] = value; this.draw(); }, field.schema.type === 'string-list' || field.schema.type === 'string-map');
      const wrapper = node('div'); wrapper.className = 'admin-field'; wrapper.append(fieldControl);
      const input = fieldControl.querySelector('input,textarea'); if (input instanceof HTMLElement) input.dataset.setting = key; if (input instanceof HTMLInputElement && input.type === 'checkbox') input.indeterminate = !explicit;
      const control = input;
      const format = field.schema.type === 'string-list' ? 'Enter a JSON list of text values, such as ["Ready", "In progress"].' : field.schema.type === 'string-map' ? 'Enter a JSON object with text values, such as {"key": "value"}.' : field.schema.type === 'number' ? `Enter a number from ${field.schema.minimum} to ${field.schema.maximum}.` : '';
      if (control instanceof HTMLElement && format) wrapper.append(this.help(control, `setting:${key}`, format));
      const defaults = node('div'); defaults.className = 'admin-default'; defaults.append(node('small', `Default: ${JSON.stringify(field.schema.default)} · ${explicit ? 'Custom value' : 'Using default'}`));
      const reset = this.button('Use default', () => { delete selected.values.fields[key]; this.change(); this.draw(); Array.from(this.container.querySelectorAll<HTMLElement>('[data-setting]')).find(control => control.dataset.setting === key)?.focus({ preventScroll: true }); }, !explicit); reset.setAttribute('aria-label', `Use default for ${field.label}`); reset.title = 'Remove the custom value and use the connector default after saving.'; defaults.append(this.actions(reset)); wrapper.append(defaults); section.append(wrapper);
    }
    for (const key of Object.keys(selected.values.fields).filter(key => !Object.hasOwn(source.settingsFields, key))) {
      const retained = node('div'); retained.append(node('p', `This connector no longer supports ${key}. Your draft value is kept below.`), node('pre', String(selected.values.fields[key])), this.button(`Discard unsupported setting draft ${key}`, () => { delete selected.values.fields[key]; this.change(); this.draw(); })); section.append(retained);
    }
    const technical = this.disclosure(`source-details:${source.target.instanceId}`, 'Source details');
    const facts = node('dl'); facts.className = 'admin-source-details';
    for (const [label, value] of [['Connector', source.providerId], ['Source ID', source.target.sourceId], ['Instance ID', source.target.instanceId], ['Identity', source.identityLevel]]) facts.append(node('dt', label), node('dd', value));
    technical.body.append(facts, node('small', 'Technical identifiers for troubleshooting. Identity describes how the source was verified.')); section.append(technical.details);
    const stale = !sameTarget(selected.target, source.target);
    if (stale) section.append(node('p', 'This source changed elsewhere. Update your draft to keep your edits and refresh fields you haven’t changed.'), this.button('Update settings draft', () => { this.saved.configurations = this.saved.configurations.map(value => value === selected ? reconcileConfiguration(selected, source) : value); this.validation = null; this.change(); this.draw(); }, this.blocked('configure', source.target.instanceId)));
    const saveSource = this.button('Save source settings', () => { void this.act(async () => { await this.submit({ version: 1, repo: this.state.activity.repo, kind: 'configure', target: selected.target, changes: configuration(selected, source) }); }); }, stale || !source.current || this.blocked('configure', source.target.instanceId), true); section.append(this.actions(saveSource), this.help(saveSource, 'save-source', 'Applies this draft to the source. The saved request and its result appear below.')); root.append(section); this.drawReplacement(root, source);
  }
  private drawAutomatic(root: HTMLElement) {
    const section = node('section'); section.append(node('h2', 'Automatic starts')); root.append(section);
    const repo = this.state.activity.repo; if (!repo) { section.append(node('p', 'Choose a galleon to select its task sources and control automatic starts.')); return; }
    const schedule = this.snapshot?.schedules.find(value => value.repo === repo); const runtime = this.snapshot?.runtimes.find(value => value.repo === repo);
    if (!schedule || !runtime) { section.append(node('p', 'Source selection and automatic-start status could not be read. Refresh to retry.')); return; }
    let draft = this.saved.schedules.find(value => value.repo === repo); if (!draft) { draft = { repo, revision: schedule.revision, instances: [...schedule.instanceIds], baseline: [...schedule.instanceIds] }; this.saved.schedules.push(draft); }
    const selected = draft; section.append(node('p', `Choose where automatic starts find tasks for ${repo}. This selection survives restarts.`));
    const candidates = this.snapshot?.sources.filter(value => value.current && value.allowedRepos.includes(repo)) ?? [];
    for (const source of candidates) {
      const label = `Schedule ${source.label}${candidates.filter(value => value.label === source.label).length > 1 ? ` (${source.target.instanceId})` : ''}`;
      const hint = !source.desiredEnabled ? 'This source is disabled. Enable it in Source settings before it can supply new work.' : !source.available ? 'This source is unavailable. Its selection is kept, but it cannot supply new work yet.' : '';
      const choice = this.toggle(label, selected.instances.includes(source.target.instanceId), checked => {
        selected.instances = checked ? [...new Set([...selected.instances, source.target.instanceId])] : selected.instances.filter(value => value !== source.target.instanceId);
      }, hint); const input = choice.querySelector('input'); if (input) input.title = source.target.instanceId; section.append(choice);
    }
    for (const id of selected.instances.filter(id => !candidates.some(source => source.target.instanceId === id))) section.append(this.toggle(`Unavailable scheduled source ${id}`, true, checked => {
      if (!checked) selected.instances = selected.instances.filter(value => value !== id);
    }));
    const stale = selected.revision !== schedule.revision;
    if (stale) section.append(node('p', 'The saved selection changed elsewhere. Update it to combine those changes with your edits.'), this.button('Update selected sources', () => {
      const added = selected.instances.filter(id => !selected.baseline.includes(id)); const removed = selected.baseline.filter(id => !selected.instances.includes(id));
      selected.instances = [...new Set([...schedule.instanceIds.filter(id => !removed.includes(id)), ...added])]; selected.baseline = [...schedule.instanceIds]; selected.revision = schedule.revision; this.change(); this.draw();
    }, this.blocked('schedule', repo)));
    const saveSelection = this.button('Save selected sources', () => { void this.act(() => this.submit({ version: 1, kind: 'schedule', repo, expectedRevision: selected.revision, instanceIds: [...selected.instances] })); }, stale || this.blocked('schedule', repo), true); section.append(this.actions(saveSelection), this.help(saveSelection, 'save-selection', 'Saves this selection without starting work.'));
    const runtimeRow = node('div'); runtimeRow.className = 'admin-runtime';
    const toggleRuntime = this.button(runtime.enabled ? 'Disable automatic starts' : 'Enable automatic starts', () => { void this.act(() => this.submit({ version: 1, kind: 'runtime', repo, epoch: runtime.epoch, expectedRevision: runtime.revision, enabled: !runtime.enabled })); }, this.blocked('runtime', repo));
    runtimeRow.append(node('p', runtime.enabled ? 'Automatic starts: enabled until Helmsman restarts.' : 'Automatic starts: disabled.'), toggleRuntime);
    section.append(runtimeRow, this.help(toggleRuntime, 'runtime', 'Starts new work from the selected sources. Resets when Helmsman restarts. Turning it off keeps existing runs going.'));
  }
  private drawReplacement(root: HTMLElement, source: SourceAdminSourceV1) {
    const repo = this.state.activity.repo; const replacement = this.disclosure(`replacement:${source.target.instanceId}`, 'Replace source implementation'); root.append(replacement.details); const section = replacement.body; section.append(node('p', 'Switch the connector used by this source. Check compatibility first; the check does not apply the replacement.'), node('small', 'After replacement, review the sources selected for automatic starts.'));
    if (!repo) { section.append(node('p', 'Choose a panel galleon before checking a replacement.')); return; }
    if (!source.current || !source.replacements.length) { section.append(node('p', 'No compatible replacement connector is installed.')); return; }
    let draft = this.saved.replacements.find(value => value.target.instanceId === source.target.instanceId);
    if (!draft) { draft = { target: source.target, candidate: '', actor: '', reason: '' }; this.saved.replacements.push(draft); }
    const selected = draft; const stale = !sameTarget(selected.target, source.target);
    if (stale) section.append(node('p', 'This source changed elsewhere. Update your replacement draft, then check compatibility again.'), this.button('Update replacement draft', () => { selected.target = source.target; this.validation = null; this.change(); this.draw(); }));
    const picker = node('select'); picker.setAttribute('aria-label', 'Replacement connector'); picker.dataset.focus = 'replacement-picker'; picker.disabled = this.busy;
    const empty = node('option', 'Choose an installed replacement'); empty.value = ''; picker.append(empty);
    for (const candidate of source.replacements) { const option = node('option', `${candidate.mode === 'refresh' ? 'Update connector version' : 'Switch connector'} · ${candidate.providerId}${source.replacements.filter(value => value.providerId === candidate.providerId && value.mode === candidate.mode).length > 1 ? ` · ${candidate.artifactHash}` : ''}`); option.value = JSON.stringify(candidate); picker.append(option); }
    picker.value = selected.candidate; picker.addEventListener('change', () => { if (!picker.disabled) { selected.candidate = picker.value; this.validation = null; this.change(); this.draw(); } });
    const connectorField = node('div'); connectorField.className = 'admin-field'; const connectorLabel = node('label', 'Replacement connector'); connectorLabel.append(picker); connectorField.append(connectorLabel, this.help(picker, 'replacement-connector', 'Choose an installed connector compatible with this source.'));
    section.append(connectorField, this.text('Changed by', selected.actor, value => { selected.actor = value; this.validation = null; }, false, 240, 'Your name or identifier for the replacement record.'), this.text('Reason for replacement', selected.reason, value => { selected.reason = value; this.validation = null; }, true, 2048, 'Why you are changing this connector. Saved with the replacement record.'));
    const candidate = source.replacements.find(value => JSON.stringify(value) === selected.candidate); const blocked = this.blocked('replace', repo);
    if (candidate) {
      const technical = this.disclosure(`connector-details:${source.target.instanceId}`, 'Connector details');
      const facts = node('dl'); facts.className = 'admin-source-details';
      for (const [label, value] of [['Mode', candidate.mode], ['Connector', candidate.providerId], ['Artifact hash', candidate.artifactHash]]) facts.append(node('dt', label), node('dd', value));
      if (this.validation) facts.append(node('dt', 'Checked instance ID'), node('dd', this.validation.instanceId)); technical.body.append(facts); section.append(technical.details);
    }
    section.append(this.button('Check replacement', () => { void this.act(async () => {
      if (!candidate || !selected.actor.trim() || !selected.reason.trim()) throw new Error('Choose a connector and enter who is making the change and why.');
      const generation = this.generation; if (!await this.save() || !this.active(generation)) return;
      this.validation = null;
      const result = await this.service.validateReplacement({ repo, target: source.target, ...candidate, actor: selected.actor.trim(), reason: selected.reason.trim() }, this.state.activity.signal);
      if (this.active(generation)) {
        if (result?.status === 'available') this.validation = result.value;
        else if (result?.diagnostic === 'jira-credentials-rejected') throw new Error('Jira rejected the configured credentials. Update the token in Config → Jira, then retry validation.');
        else if (result?.diagnostic === 'jira-access-denied') throw new Error('Jira denied access to the configured account. Check its Jira permissions and token scopes, then retry validation.');
        else throw new Error(`Replacement validation unavailable: ${result?.reason ?? 'invalid-response'}.`);
      }
    }); }, stale || !candidate || blocked));
    const valid = !stale && this.validation && sameTarget(this.validation.target, source.target) && this.validation.actor === selected.actor.trim() && this.validation.reason === selected.reason.trim() && candidate && this.validation.artifactHash === candidate.artifactHash && this.validation.providerId === candidate.providerId && this.validation.mode === candidate.mode;
    if (valid) { section.append(node('p', 'Compatibility check passed. Replace source will switch to the checked connector.')); section.append(this.button('Replace source', () => { const validation = this.validation; if (validation) void this.act(async () => { await this.submit({ version: 1, kind: 'replace', repo, validation }); this.validation = null; }); }, blocked)); }
  }
  private drawPending(root: HTMLElement) {
    for (const entry of this.pending.filter(value => !this.automaticOnly || value.command.kind === 'schedule' || value.command.kind === 'runtime')) {
      const section = node('section'); section.className = 'admin-request'; const actions = this.actions(); const receipt = entry.receipt; section.append(node('h3', `Saved ${{ configure: 'source settings', schedule: 'source selection', runtime: 'automatic starts', replace: 'source replacement' }[entry.command.kind]} request`), node('small', entry.command.repo ?? 'All galleons'));
      const technical = this.disclosure(`request:${entry.command.requestId}`, 'Request details'); const facts = node('dl'); facts.className = 'admin-source-details'; facts.append(node('dt', 'Request ID'), node('dd', entry.command.requestId), node('dt', 'Change type'), node('dd', entry.command.kind)); technical.body.append(facts); section.append(technical.details);
      if (receipt) {
        section.append(node('p', `${receipt.status}${receipt.message ? `: ${receipt.message}` : ''}`));
        if (entry.command.kind === 'runtime') section.append(node('p', receipt.status === 'expired' ? 'Helmsman restarted before this result was confirmed. Check the current automatic-start status before making another change.' : 'This result records an earlier request. Current automatic-start status is shown above.'));
        section.append(node('small', 'Accept this result to update the draft and clear this request. Dismissing it does not undo the change.'));
        actions.append(this.button('Accept result and dismiss', () => { void this.act(async () => {
          const generation = this.generation; const next = consumeResult(this.saved, entry); this.saved = next; this.dirty = true; ++this.revision;
          if (!await this.save() || !this.active(generation)) return;
          await this.service.acknowledge({ requestId: entry.command.requestId, repo: entry.command.repo });
          if (this.active(generation)) { this.saved.consumed = this.saved.consumed.filter(id => id !== entry.command.requestId); this.change(); await this.save(); }
        }); }));
      } else {
        section.append(node('p', 'The result is not confirmed. Check it or retry the same request to avoid applying the change twice.')); actions.append(this.button('Check result', () => { void this.act(async () => {
          const generation = this.generation; const result = await this.service.receipt({ requestId: entry.command.requestId, repo: entry.command.repo }, this.state.activity.signal);
          if (this.active(generation)) { if (result.status === 'unavailable') throw new Error(`Receipt unavailable: ${result.reason}.`); if (!result.value) this.error = 'No confirmed result yet. The original request is kept.'; }
        }); }), this.button('Retry same request', () => { void this.act(() => this.retry(entry)); }, !this.service.retry));
      }
      section.append(actions); root.append(section);
    }
  }
}
export function mountAdministration(container: HTMLElement, context: PluginPanelContext, automaticOnly = false): PluginPanelInstance { return new Administration(container, context, automaticOnly); }
const panel: PluginPanelModule = { mount: mountAdministration };
export default panel;
