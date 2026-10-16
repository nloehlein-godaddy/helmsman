import type { AgentPromptRoleV1, AgentPromptSettingsSnapshotV1, AgentPromptSettingsServiceV1 } from './agent-prompts.js';
import { DraftStorage, fromRole, maximumTextLength, message, sameDraft, validSnapshot, validText, type Draft, type SavedDrafts } from './agent-prompt-editor-state.js';
import { styles } from './agent-prompt-editor-styles.js';

export interface AgentPromptEditorStateV1 {
  readonly active: boolean;
  readonly pirateMode: boolean;
  readonly signal: AbortSignal;
}
export interface AgentPromptEditorOptionsV1 {
  readonly service: AgentPromptSettingsServiceV1;
  readonly signal: AbortSignal;
  readonly contributionId: string;
  readonly instanceId: string;
  readonly fixedRoleId?: string;
  readonly state: AgentPromptEditorStateV1;
}
export interface AgentPromptEditorV1 {
  update(state: AgentPromptEditorStateV1): void;
  refresh(): Promise<void>;
  dispose(): void;
}

class AgentPromptEditor implements AgentPromptEditorV1 {
  private readonly container: HTMLElement;
  private readonly options: AgentPromptEditorOptionsV1;
  private state: AgentPromptEditorStateV1;
  private readonly storage: DraftStorage;
  private snapshot: AgentPromptSettingsSnapshotV1 | null = null;
  private saved: SavedDrafts = { version: 1, selectedRole: '', drafts: {} };
  private unsupported = false;
  private storageError = '';
  private error = '';
  private notice = '';
  private readReady = false;
  private busy = false;
  private disposed = false;
  private generation = 0;
  private readController: AbortController | null = null;
  private saveController: AbortController | null = null;
  constructor(container: HTMLElement, options: AgentPromptEditorOptionsV1) {
    this.container = container; this.options = options;
    this.state = options.state; this.storage = new DraftStorage(options.contributionId, options.instanceId);
    try { this.saved = this.storage.read() ?? this.saved; }
    catch (error) { this.unsupported = true; this.storageError = message(error, 'Saved prompt drafts are unavailable. Original data is kept.'); }
    if (options.fixedRoleId !== undefined) this.saved.selectedRole = options.fixedRoleId;
    const id = `agent-prompts-${crypto.randomUUID()}`;
    container.innerHTML = `<section class="agent-prompts"><style>${styles}</style><header class="prompt-intro"><h2>Role instructions</h2><p>Global defaults for new agents across all <span data-repos-label></span>. Existing sessions keep their original prompts.</p><p>Helmsman adds task context and reporting requirements to these instructions.</p></header><form><div class="prompt-picker"><label for="${id}-role"${options.fixedRoleId !== undefined ? ' hidden' : ''}>Agent role<select id="${id}-role" data-role></select></label><span class="prompt-source" data-source></span></div><div class="prompt-context"><h3 data-role-title></h3><p data-description></p><p class="prompt-provider" data-provider></p></div><p role="alert" data-conflict></p><div class="prompt-tools"><button type="button" data-rebase hidden>Keep my changes</button></div><label class="prompt-editor" for="${id}-text">Role instructions<textarea id="${id}-text" data-text maxlength="${maximumTextLength}" spellcheck="false" aria-describedby="${id}-draft ${id}-conflict ${id}-storage"></textarea></label><p class="prompt-note" id="${id}-draft" data-draft-note>Edits are saved locally as you type. Select Save prompt to apply them.</p><details class="prompt-default"><summary>Built-in default</summary><pre data-default tabindex="0"></pre></details><p id="${id}-storage" role="alert" data-storage-error></p><p role="alert" data-error></p><p role="status" data-status></p><div class="prompt-tools prompt-actions"><button type="submit" class="primary-action" data-save>Save prompt</button><button type="button" data-restore>Restore default</button><button type="button" data-discard hidden>Discard changes</button><button type="button" data-save-draft hidden>Retry saving draft</button></div></form></section>`;
    const conflict = container.querySelector('[data-conflict]'); if (conflict) conflict.id = `${id}-conflict`;
    container.addEventListener('input', this.edit); container.addEventListener('change', this.change); container.addEventListener('click', this.click); container.addEventListener('submit', this.submit);
    options.signal.addEventListener('abort', this.dispose, { once: true }); this.state.signal.addEventListener('abort', this.cancel, { once: true });
    if (options.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation) { return !this.disposed && !this.options.signal.aborted && this.state.active && !this.state.signal.aborted && generation === this.generation; }
  private role(): AgentPromptRoleV1 | null { return this.snapshot?.roles.find(role => role.id === this.saved.selectedRole) ?? null; }
  private draft(): Draft | null { const role = this.role(); return role ? this.saved.drafts[role.id] ?? null : null; }
  private cancel = () => { ++this.generation; this.readController?.abort(); this.saveController?.abort(); this.readReady = false; };
  dispose = () => {
    if (this.disposed) return; this.disposed = true; this.cancel();
    this.container.removeEventListener('input', this.edit); this.container.removeEventListener('change', this.change); this.container.removeEventListener('click', this.click); this.container.removeEventListener('submit', this.submit);
    this.options.signal.removeEventListener('abort', this.dispose); this.state.signal.removeEventListener('abort', this.cancel); this.container.replaceChildren();
  };
  update(next: AgentPromptEditorStateV1) {
    if (this.disposed) return; const changed = this.state.signal !== next.signal || this.state.active !== next.active;
    this.state.signal.removeEventListener('abort', this.cancel); this.state = next; next.signal.addEventListener('abort', this.cancel, { once: true });
    if (changed) { this.cancel(); void this.refresh(); } this.draw();
  }
  private ensureDraft() {
    const role = this.role(); if (!role || !this.snapshot || this.unsupported || this.saved.drafts[role.id]) return;
    this.saved.drafts[role.id] = fromRole(role, this.snapshot.revision);
  }
  private adoptSnapshot(next: AgentPromptSettingsSnapshotV1) {
    const previous = this.snapshot;
    if (previous && !this.unsupported) {
      for (const role of next.roles) {
        const oldRole = previous.roles.find(item => item.id === role.id); const draft = this.saved.drafts[role.id];
        if (oldRole && draft && sameDraft(draft, fromRole(oldRole, previous.revision))) this.saved.drafts[role.id] = fromRole(role, next.revision);
      }
    }
    this.snapshot = next;
  }
  refresh = async () => {
    if (!this.active() || this.busy) return;
    ++this.generation; this.readController?.abort(); const generation = this.generation; const controller = new AbortController(); this.readController = controller; this.readReady = false; this.draw();
    try {
      const result = await this.options.service.snapshot(AbortSignal.any([controller.signal, this.options.signal, this.state.signal]));
      if (!this.active(generation)) return;
      if (result?.status !== 'available' || !validSnapshot(result.value)) throw new Error('Agent prompts could not be loaded. Existing edits and their original revisions are kept.');
      this.adoptSnapshot(result.value);
      if (this.options.fixedRoleId === undefined && !result.value.roles.some(role => role.id === this.saved.selectedRole)) this.saved.selectedRole = result.value.roles[0]?.id ?? '';
      this.ensureDraft(); this.readReady = true; this.error = ''; this.notice = '';
    } catch (error) { if (this.active(generation)) this.error = message(error, 'Agent prompts could not be loaded. Existing edits are kept.'); }
    finally { if (this.active(generation)) this.draw(); }
  };
  private persist() {
    if (this.unsupported) return false;
    try { this.storage.save(this.saved); this.storageError = ''; return true; }
    catch (error) { this.storageError = message(error, 'Prompt drafts could not be saved locally. Keep this page open.'); return false; }
  }
  private edit = (event: Event) => {
    const input = event.target; const role = this.role(); const draft = this.draft();
    if (!(input instanceof HTMLTextAreaElement) || !input.hasAttribute('data-text') || !this.active() || !role || !draft || this.unsupported) return;
    this.saved.drafts[role.id] = { ...draft, text: input.value }; this.notice = ''; this.persist(); this.draw();
  };
  private change = (event: Event) => {
    const select = event.target;
    if (this.options.fixedRoleId !== undefined || !(select instanceof HTMLSelectElement) || !select.hasAttribute('data-role') || !this.active() || this.busy || !this.snapshot?.roles.some(role => role.id === select.value)) return;
    this.saved.selectedRole = select.value; this.ensureDraft(); this.notice = ''; this.persist(); this.draw();
  };
  private click = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button || button.disabled || !this.active()) return; event.stopPropagation();
    const role = this.role(); const draft = this.draft();
    if (button.hasAttribute('data-save-draft')) { this.persist(); this.draw(); }
    else if (role && draft && this.snapshot && !this.unsupported) {
      if (button.hasAttribute('data-rebase')) { this.saved.drafts[role.id] = { ...draft, revision: this.snapshot.revision }; this.notice = 'Your draft now uses the latest revision. Select Save prompt to apply it.'; }
      else if (button.hasAttribute('data-discard')) { this.saved.drafts[role.id] = fromRole(role, this.snapshot.revision); this.notice = ''; this.error = ''; }
      else if (button.hasAttribute('data-restore')) { this.saved.drafts[role.id] = { ...draft, text: null }; this.notice = 'Built-in default selected. Select Save prompt to remove the custom override.'; }
      else return;
      this.persist(); this.draw();
    }
    if (button.hidden && document.activeElement === button) this.container.querySelector<HTMLButtonElement>('[data-save]')?.focus();
  };
  private submit = (event: Event) => { event.preventDefault(); event.stopPropagation(); void this.save(); };
  private async save() {
    const role = this.role(); const draft = this.draft(); const snapshot = this.snapshot;
    if (!this.active() || this.busy || !this.readReady || !role || !draft || !snapshot || this.unsupported || this.storageError || draft.revision !== snapshot.revision || draft.text !== null && !validText(draft.text) || !this.persist()) return;
    const submitted = { ...draft }; const generation = ++this.generation; this.readController?.abort(); this.busy = true; this.error = ''; this.notice = ''; const controller = new AbortController(); this.saveController = controller;
    const signal = AbortSignal.any([controller.signal, this.options.signal, this.state.signal]); this.draw();
    try {
      const result = await this.options.service.save({ version: 1, expectedRevision: submitted.revision, roleId: role.id, text: submitted.text }, signal);
      if (!this.active(generation) || signal.aborted) return;
      const returnedRole = result?.status === 'available' && validSnapshot(result.value) ? result.value.roles.find(item => item.id === role.id) : null;
      if (result?.status !== 'available' || !validSnapshot(result.value) || !returnedRole || (submitted.text === null ? returnedRole.overridden || returnedRole.text !== returnedRole.defaultText : !returnedRole.overridden || returnedRole.text !== submitted.text)) {
        this.readReady = false; this.error = 'Prompt save was not confirmed. Your edits and original revision are kept. Refresh the page before explicitly rebasing or discarding edits.'; return;
      }
      this.adoptSnapshot(result.value);
      const currentDraft = this.saved.drafts[role.id];
      if (currentDraft && sameDraft(currentDraft, submitted)) { this.saved.drafts[role.id] = fromRole(returnedRole, result.value.revision); this.persist(); }
      this.notice = 'Prompt saved for new agents. Existing sessions keep their original instructions.'; this.error = '';
    } catch (error) { this.readReady = false; if (!this.disposed) this.error = message(error, 'Prompt save was not confirmed. Your edits are kept. No automatic retry will occur.'); }
    finally { this.busy = false; this.saveController = null; if (!this.disposed) { this.draw(); if (this.active() && generation !== this.generation) void this.refresh(); } }
  }
  private draw() {
    if (this.disposed) return;
    const set = (selector: string, text: string) => { const node = this.container.querySelector(selector); if (node) node.textContent = text; };
    const select = this.container.querySelector<HTMLSelectElement>('[data-role]');
    if (select) {
      const roles = this.snapshot?.roles ?? []; const keys = JSON.stringify(roles.map(role => [role.id, role.label]));
      if (select.dataset.keys !== keys) { select.replaceChildren(...roles.map(role => { const option = document.createElement('option'); option.value = role.id; option.textContent = role.label; return option; })); select.dataset.keys = keys; }
      select.value = this.saved.selectedRole; select.disabled = !this.active() || this.busy || !roles.length;
    }
    const role = this.role(); const draft = this.draft(); const conflict = !!(draft && this.snapshot && draft.revision !== this.snapshot.revision);
    const changed = !!(role && draft && (conflict || draft.text !== (role.overridden ? role.text : null)));
    set('[data-repos-label]', this.state.pirateMode ? 'galleons' : 'repositories'); set('[data-role-title]', role?.label ?? (this.options.fixedRoleId !== undefined ? 'Agent role unavailable' : 'Select an agent role')); set('[data-description]', role?.description ?? ''); set('[data-provider]', role ? `Provider: ${role.providerLabel}` : '');
    set('[data-source]', role ? role.overridden ? 'Custom prompt' : 'Built-in default' : ''); set('[data-default]', role?.defaultText ?? '');
    set('[data-conflict]', conflict ? 'Saved prompts changed since this draft began. Refresh keeps your draft. Keep my changes uses the latest revision; Save prompt then applies it.' : '');
    const invalidText = !!draft && draft.text !== null && !validText(draft.text);
    set('[data-storage-error]', this.storageError); set('[data-error]', this.error || (invalidText ? 'Instructions must contain text and fit within 4 KiB, without unsupported control characters.' : '')); set('[data-status]', this.notice || (!this.snapshot ? this.error ? '' : 'Loading agent prompts…' : this.options.fixedRoleId !== undefined && !role ? 'This agent role is unavailable. Its saved draft is kept.' : !this.snapshot.roles.length ? 'No agent roles are available.' : ''));
    const input = this.container.querySelector<HTMLTextAreaElement>('[data-text]');
    if (input) { const text = draft?.text ?? role?.defaultText ?? ''; if (input.value !== text) input.value = text; input.disabled = !this.active() || this.unsupported || !draft; input.setAttribute('aria-invalid', String(draft?.text !== null && !!draft && !validText(draft.text))); }
    const note = this.container.querySelector<HTMLElement>('[data-draft-note]'); if (note) note.hidden = this.unsupported || !!this.storageError || !draft;
    for (const button of this.container.querySelectorAll<HTMLButtonElement>('button')) button.disabled = !this.active() || this.busy;
    const save = this.container.querySelector<HTMLButtonElement>('[data-save]'); if (save) { save.textContent = this.busy ? 'Saving prompt…' : 'Save prompt'; save.disabled ||= this.unsupported || !this.readReady || !draft || !!this.storageError || conflict || !changed || draft.text !== null && !validText(draft.text); }
    const restore = this.container.querySelector<HTMLButtonElement>('[data-restore]'); if (restore) restore.disabled ||= this.unsupported || !draft || draft.text === null;
    const discard = this.container.querySelector<HTMLButtonElement>('[data-discard]'); if (discard) { discard.hidden = !changed || this.unsupported; discard.disabled ||= !this.readReady || !role; discard.textContent = conflict ? 'Use saved prompt' : 'Discard changes'; }
    const rebase = this.container.querySelector<HTMLButtonElement>('[data-rebase]'); if (rebase) { rebase.hidden = !conflict || this.unsupported; rebase.disabled ||= !this.readReady || !draft; }
    const retry = this.container.querySelector<HTMLButtonElement>('[data-save-draft]'); if (retry) { retry.hidden = !this.storageError || this.unsupported; retry.disabled ||= this.unsupported; }
  }
}
export function createAgentPromptEditorV1(container: HTMLElement, options: AgentPromptEditorOptionsV1): AgentPromptEditorV1 {
  if (options.service?.version !== 1) throw new Error('Agent prompts require version 1 public settings services.');
  return new AgentPromptEditor(container, options);
}
