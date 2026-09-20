import { escapeHtml as esc } from './logic/html';
import { commitSourceAdoption, configureSourceSchedule, configureTaskSource, getSourceAdoption, getSourceSchedule, getTaskSources, validateSourceAdoption, type SourceAdoptionOptions, type SourceAdoptionReceipt, type SourceScheduleView, type TaskSourceView } from './data/taskSources';

type Adoption = { options?: SourceAdoptionOptions; candidate: string; actor: string; reason: string; receipt?: SourceAdoptionReceipt };
type Draft = { label: string; desiredEnabled: boolean; allowedRepos: string; settings: string };
const draftOf = (source: TaskSourceView): Draft => ({ label: source.label, desiredEnabled: source.desiredEnabled, allowedRepos: source.allowedRepos.join('\n'), settings: JSON.stringify(source.settings, null, 2) });
const replacementMode = (source: TaskSourceView) => source.identityLevel === 'operator-seeded' && source.providerId === 'helmsman.jira/issues' ? 'refresh' as const : 'adoption' as const;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Task sources are unavailable. Retry when the connection is restored.';

export class TaskSourceSettings {
  private sources: TaskSourceView[] = [];
  private schedule: SourceScheduleView | null = null;
  private drafts = new Map<string, Draft>();
  private scheduleDrafts = new Map<string, string[]>();
  private adoptions = new Map<string, Adoption>();
  private errors = new Map<string, string>();
  private pending = new Set<string>();
  private sequence = 0;
  private loading = false;
  private error: string | null = null;
  private loaded = false;
  private headerRepo: string | null = null;
  private override: string | undefined;
  private repos: string[] = [];
  private readonly changed: () => void;
  constructor(changed: () => void) { this.changed = changed; }
  private get repo(): string | null { return this.override === undefined ? this.headerRepo : this.override || null; }

  async load(headerRepo: string | null, repos: string[]): Promise<void> {
    this.headerRepo = headerRepo; this.repos = repos;
    const sequence = ++this.sequence;
    const repo = this.repo;
    this.loading = true; this.changed();
    const [sources, schedule] = await Promise.allSettled([getTaskSources(repo), repo ? getSourceSchedule(repo) : Promise.resolve(null)]);
    if (sequence !== this.sequence) return;
    this.loading = false;
    if (sources.status === 'fulfilled' && schedule.status === 'fulfilled') {
      this.sources = sources.value; this.schedule = schedule.value; this.loaded = true; this.error = null;
    } else {
      this.error = errorText(sources.status === 'rejected' ? sources.reason : schedule.status === 'rejected' ? schedule.reason : null);
    }
    this.changed();
  }

  render(): string {
    const blocked = this.loading || Boolean(this.error) || !this.loaded;
    const disabled = (extra = false) => blocked || extra ? ' disabled' : '';
    const repo = this.repo;
    const options = [['__header__', `Header: ${this.headerRepo ?? 'all galleons'}`], ['', 'All galleons'], ...this.repos.map(value => [value, value])];
    const selection = this.override ?? '__header__';
    const selected = repo ? this.scheduleDrafts.get(repo) ?? this.schedule?.instanceIds ?? [] : [];
    return `<section class="panel config-panel task-source-settings" data-task-source-settings aria-labelledby="task-source-title">
      <div class="panel-head"><span class="panel-title" id="task-source-title">Task sources</span></div>
      <p class="config-warning">Enable sources independently. Existing voyages keep their recorded source when a source is disabled.</p>
      <label class="interface-field">Source panel galleon<select data-source-scope${this.pending.size ? ' disabled' : ''}>${options.map(([value, label]) => `<option value="${esc(value!)}"${value === selection ? ' selected' : ''}>${esc(label!)}</option>`).join('')}</select></label>
      <p class="config-warning">This selection applies only to this panel. The header galleon stays unchanged.</p>
      ${this.error ? `<p class="degraded-banner" role="alert">${esc(this.error)} Unsaved changes are kept.</p>` : ''}
      ${this.loading ? '<p role="status">Loading task sources…</p>' : ''}
      <button type="button" data-source-reload${this.loading || this.pending.size ? ' disabled' : ''}>Reload sources</button>
      <div class="source-config-list">${this.sources.length ? this.sources.map(source => {
        const draft = this.drafts.get(source.id) ?? draftOf(source);
        const busy = this.pending.has(source.id);
        return `<fieldset class="source-config" data-source-id="${esc(source.id)}"${disabled(busy)}>
          <legend>${esc(source.label)}${source.available ? '' : ' — unavailable'}</legend>
          <p class="config-warning">${esc(source.providerId)} · ${esc(source.identityLevel)}</p>
          <label class="interface-field">Label<input data-source-field="label" value="${esc(draft.label)}" maxlength="240"></label>
          <label><input type="checkbox" data-source-field="desiredEnabled"${draft.desiredEnabled ? ' checked' : ''}> Enabled</label>
          <label class="interface-field">Allowed galleons (one per line)<textarea data-source-field="allowedRepos" rows="3">${esc(draft.allowedRepos)}</textarea></label>
          <details><summary>Advanced source settings</summary><p class="config-warning">Non-secret JSON settings. Configure credentials through the integration settings.</p><label class="interface-field">Settings<textarea data-source-field="settings" rows="6" spellcheck="false">${esc(draft.settings)}</textarea></label></details>
          <button type="button" data-source-save>${busy ? 'Saving…' : 'Save source'}</button>
          ${this.renderAdoption(source)}
          ${this.errors.has(source.id) ? `<p role="alert">${esc(this.errors.get(source.id) ?? '')}</p>` : ''}
        </fieldset>`;
      }).join('') : this.loaded && !this.loading ? '<p class="empty-note">No task sources are configured for this galleon.</p>' : ''}</div>
      <fieldset class="source-config"${disabled(!repo || this.pending.has('schedule'))}><legend>Automatic starts</legend>
        <p class="config-warning">${repo ? `Choose sources for ${esc(repo)}. The automatic-start control still determines whether scheduling runs.` : 'Select a galleon to choose its automatic sources.'}</p>
        ${repo ? this.sources.map(source => `<label class="source-schedule-option"><input type="checkbox" data-source-schedule="${esc(source.id)}"${selected.includes(source.id) ? ' checked' : ''}${!selected.includes(source.id) && (!source.available || !source.desiredEnabled) ? ' disabled' : ''}> ${esc(source.label)}${source.desiredEnabled && source.available ? '' : ' (unavailable for new work)'}</label>`).join('') : ''}
        <button type="button" data-source-schedule-save>Save automatic sources</button>${this.errors.has('schedule') ? `<p role="alert">${esc(this.errors.get('schedule') ?? '')}</p>` : ''}
      </fieldset>
    </section>`;
  }

  bind(panel: HTMLElement | null): void {
    if (!panel) return;
    panel.addEventListener('input', event => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      const id = target.closest<HTMLElement>('[data-source-id]')?.dataset.sourceId;
      const source = this.sources.find(value => value.id === id);
      const key = target.dataset.sourceField;
      if (source && key) {
        const draft = this.drafts.get(source.id) ?? draftOf(source);
        if (key === 'desiredEnabled' && target instanceof HTMLInputElement) draft.desiredEnabled = target.checked;
        else if (key === 'label' || key === 'allowedRepos' || key === 'settings') draft[key] = target.value;
        this.drafts.set(source.id, draft);
      }
      const adoptionField = target.dataset.sourceAdoptionField;
      if (source && (adoptionField === 'actor' || adoptionField === 'reason')) {
        const adoption = this.adoptions.get(source.id);
        if (adoption) { adoption[adoptionField] = target.value; delete adoption.receipt; }
      }
      if (target.dataset.sourceSchedule && this.repo) this.scheduleDrafts.set(this.repo, [...panel.querySelectorAll<HTMLInputElement>('[data-source-schedule]:checked')].map(input => input.dataset.sourceSchedule!).filter(Boolean));
    });
    panel.addEventListener('change', event => {
      const target = event.target;
      if (target instanceof HTMLSelectElement && target.matches('[data-source-candidate]')) {
        const id = target.closest<HTMLElement>('[data-source-id]')?.dataset.sourceId;
        const adoption = id ? this.adoptions.get(id) : undefined;
        if (adoption) { adoption.candidate = target.value; delete adoption.receipt; this.changed(); }
      }
      if (target instanceof HTMLSelectElement && target.matches('[data-source-scope]')) {
        this.override = target.value === '__header__' ? undefined : target.value;
        void this.load(this.headerRepo, this.repos);
      }
    });
    panel.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-source-reload]')) void this.load(this.headerRepo, this.repos);
      const save = target?.closest('[data-source-save]');
      if (save) void this.save(save.closest<HTMLElement>('[data-source-id]')?.dataset.sourceId);
      const adoption = target?.closest<HTMLElement>('[data-source-adoption]');
      if (adoption) void this.adopt(adoption.closest<HTMLElement>('[data-source-id]')?.dataset.sourceId, adoption.dataset.sourceAdoption);
      if (target?.closest('[data-source-schedule-save]')) void this.saveSchedule();
    });
  }

  private renderAdoption(source: TaskSourceView): string {
    const adoption = this.adoptions.get(source.id);
    const refresh = replacementMode(source) === 'refresh';
    const allowed = (source.identityLevel === 'verified' || refresh) && Boolean(this.repo);
    return `<details class="source-adoption"${adoption ? ' open' : ''}><summary>${refresh ? 'Update provider version' : 'Replace source provider'}</summary>
      <p class="config-warning">${refresh ? 'Update this Jira provider while preserving its recorded connection and task identity. This does not verify or merge source identity.' : 'Keep existing task identity while selecting a compatible provider.'} Existing voyages retain their original provider. Validate the change before applying it. After replacement, select the new instance under Automatic starts.</p>
      ${allowed ? `<button type="button" data-source-adoption="options">${refresh ? 'Find provider updates' : 'Find compatible providers'}</button>` : '<p class="config-warning">Select a galleon and a source with verified identity to validate a replacement.</p>'}
      ${adoption?.options ? `<label class="interface-field">Replacement provider<select data-source-candidate><option value="">Choose a provider</option>${adoption.options.candidates.map((candidate, index) => `<option value="${index}"${String(index) === adoption.candidate ? ' selected' : ''}>${esc(candidate.providerId)} · ${esc(candidate.artifactHash.slice(0, 12))}</option>`).join('')}</select></label>
        <label class="interface-field">Operator<input data-source-adoption-field="actor" value="${esc(adoption.actor)}" maxlength="240"></label>
        <label class="interface-field">Reason<input data-source-adoption-field="reason" value="${esc(adoption.reason)}" maxlength="2048"></label>
        <button type="button" data-source-adoption="validate"${allowed && adoption.candidate !== '' ? '' : ' disabled'}>Validate replacement</button>
        ${adoption.receipt ? `<p role="status">Replacement validated for this source revision.</p><button type="button" data-source-adoption="commit">${refresh ? 'Apply validated update' : 'Adopt validated replacement'}</button>` : ''}` : ''}
    </details>`;
  }

  private async adopt(id: string | undefined, action: string | undefined): Promise<void> {
    const source = this.sources.find(value => value.id === id); const repo = this.repo;
    if (!source || !repo || source.identityLevel !== 'verified' && replacementMode(source) !== 'refresh' || this.pending.has(source.id) || this.loading || this.error) return;
    const adoption = this.adoptions.get(source.id) ?? { candidate: '', actor: '', reason: '' };
    this.adoptions.set(source.id, adoption); this.pending.add(source.id); this.errors.delete(source.id); this.changed();
    try {
      if (action === 'options') {
        const options = await getSourceAdoption(source.sourceId, replacementMode(source));
        if (options.currentInstanceId !== source.id) throw new Error('Use the currently selected source instance to replace its provider.');
        adoption.options = options; adoption.candidate = ''; delete adoption.receipt;
      }
      else if (action === 'validate') {
        delete adoption.receipt;
        const candidate = adoption.options?.candidates[Number(adoption.candidate)];
        if (adoption.candidate === '' || !candidate || !adoption.options || !adoption.actor.trim() || !adoption.reason.trim()) throw new Error('Choose a provider and enter the operator and reason.');
        adoption.receipt = await validateSourceAdoption({ sourceId: source.sourceId, sourceRevision: adoption.options.sourceRevision, ...candidate, repo, actor: adoption.actor.trim(), reason: adoption.reason.trim() }, replacementMode(source));
      } else if (action === 'commit') {
        if (!adoption.receipt) throw new Error('Validate the replacement first.');
        await commitSourceAdoption(adoption.receipt, replacementMode(source)); this.adoptions.delete(source.id);
        await this.load(this.headerRepo, this.repos);
      }
    } catch (error) { this.errors.set(source.id, errorText(error)); }
    finally { this.pending.delete(source.id); this.changed(); }
  }

  private async save(id: string | undefined): Promise<void> {
    const source = this.sources.find(value => value.id === id);
    if (!source || this.pending.has(source.id) || this.loading || this.error) return;
    const draft = { ...(this.drafts.get(source.id) ?? draftOf(source)) };
    this.errors.delete(source.id); this.pending.add(source.id); this.changed();
    try {
      const settings: unknown = JSON.parse(draft.settings);
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Settings must be a JSON object.');
      const allowedRepos = [...new Set(draft.allowedRepos.split(/[\n,]/).map(value => value.trim()).filter(Boolean))];
      await configureTaskSource(source, { label: draft.label.trim(), desiredEnabled: draft.desiredEnabled, allowedRepos, settings: settings as Record<string, unknown> });
      this.drafts.delete(source.id);
      await this.load(this.headerRepo, this.repos);
    } catch (error) { this.errors.set(source.id, errorText(error)); }
    finally { this.pending.delete(source.id); this.changed(); }
  }

  private async saveSchedule(): Promise<void> {
    const repo = this.repo; const schedule = this.schedule;
    if (!repo || !schedule || schedule.repo !== repo || this.pending.has('schedule') || this.loading || this.error) return;
    this.pending.add('schedule'); this.errors.delete('schedule'); this.changed();
    try {
      await configureSourceSchedule(schedule, this.scheduleDrafts.get(repo) ?? schedule.instanceIds);
      this.scheduleDrafts.delete(repo); await this.load(this.headerRepo, this.repos);
    } catch (error) { this.errors.set('schedule', errorText(error)); }
    finally { this.pending.delete('schedule'); this.changed(); }
  }
}
