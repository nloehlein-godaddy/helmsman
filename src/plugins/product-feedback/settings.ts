import type { FeedbackSettingsServiceV1, FeedbackSettingsSnapshotV1, PluginJson, PluginPageModule } from '@helmsman/plugin-sdk';
import { esc, message, Storage, styles } from './util.js';
interface SettingsDraft { version: 1; revision: string; selected: string | null; values: Record<string, Record<string, PluginJson>>; }
const page: PluginPageModule = { mount(container, context) {
  const service: FeedbackSettingsServiceV1 | undefined = context.services?.feedbackSettings;
  if (service?.version !== 1 || !context.contributionId) throw new Error('Feedback settings require the public settings service.');
  let state = context.state; let disposed = false; let busy = false; let generation = 0; let error = ''; let notice = ''; let ready = false;
  let snapshot: FeedbackSettingsSnapshotV1 | null = null; let draft: SettingsDraft | null = null; let storage: Storage | null = null;
  let destinationReady = false; let controller = new AbortController();
  const active = () => !disposed && state.visible && !context.signal.aborted;
  function saveDraft() { if (!storage || !draft) throw new Error('Feedback settings draft storage is unavailable'); storage.save(draft); }
  function draw() {
    if (disposed) return;
    const provider = snapshot?.providers.find(item => item.id === draft?.selected);
    container.innerHTML = `<section class="product-feedback"><style>${styles}</style><h1>Feedback settings</h1><p>Choose a tracker and its destination for product feedback. Feedback is disabled by default. Saved tracker settings apply after restarting Helmsman. Existing submissions retain their original destination.</p>
      ${error ? `<p role="alert">${esc(error)}</p>` : ''}${notice ? `<p role="status">${esc(notice)}</p>` : ''}
      <button type="button" data-refresh ${busy ? 'disabled' : ''}>Refresh</button>
      ${draft && snapshot ? `<form><label>Feedback tracker<select name="provider" ${busy ? 'disabled' : ''}><option value="" ${draft.selected === null ? 'selected' : ''}>Disabled</option>${snapshot.providers.map(item => `<option value="${esc(item.id)}" ${item.id === draft?.selected ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}${draft.selected && !provider ? `<option value="${esc(draft.selected)}" selected>Unavailable: ${esc(draft.selected)}</option>` : ''}</select></label>
      ${provider ? Object.entries(provider.fields).map(([key, field]) => { const value = draft?.values[provider.id]?.[key] ?? provider.values[key]; return `<label>${esc(key)}<input data-field="${esc(key)}" ${busy ? 'disabled' : ''} ${field.type === 'boolean' ? `type="checkbox" ${value === true ? 'checked' : ''}` : field.type === 'number' ? `type="number" min="${field.minimum}" max="${field.maximum}" value="${esc(value)}"` : `type="text" maxlength="${field.maxLength}" value="${esc(value)}"`}></label>`; }).join('') : ''}
      ${draft.revision !== snapshot.revision ? '<button type="button" data-rebase>Review draft against latest settings</button>' : ''}<button type="submit" ${!ready || busy || draft.selected !== null && !provider ? 'disabled' : ''}>Save feedback settings</button></form>` : '<p role="status">Loading feedback settings…</p>'}
      ${destinationReady ? `<p><a href="/product-feedback${state.repo ? `?repo=${encodeURIComponent(state.repo)}` : ''}">Send product feedback</a></p>` : '<p>Submission becomes available when an enabled tracker has a configured destination and connection.</p>'}<p><a href="/product-feedback${state.repo ? `?repo=${encodeURIComponent(state.repo)}` : ''}">View saved feedback</a></p></section>`;
    container.querySelector('[data-refresh]')?.addEventListener('click', () => { if (!busy) void read(); });
    container.querySelector<HTMLSelectElement>('[name=provider]')?.addEventListener('change', event => {
      if (!draft || busy) return;
      try { draft = { ...draft, selected: (event.target as HTMLSelectElement).value || null }; saveDraft(); draw(); }
      catch (failure) { ready = false; error = message(failure); draw(); }
    });
    for (const input of container.querySelectorAll<HTMLInputElement>('[data-field]')) input.addEventListener('input', () => {
      const key = input.dataset.field; if (!draft || !provider || !key || busy) return;
      const field = provider.fields[key]; if (!field) return;
      try { draft.values[provider.id] = { ...draft.values[provider.id], [key]: field.type === 'boolean' ? input.checked : field.type === 'number' ? Number(input.value) : input.value }; saveDraft(); }
      catch (failure) { ready = false; error = message(failure); draw(); }
    });
    container.querySelector('[data-rebase]')?.addEventListener('click', () => { if (!draft || !snapshot || busy) return; try { draft = { ...draft, revision: snapshot.revision }; saveDraft(); ready = true; error = ''; notice = 'Review your retained draft, then save to apply it to the latest configuration.'; draw(); } catch (failure) { ready = false; error = message(failure); draw(); } });
    container.querySelector('form')?.addEventListener('submit', event => { event.preventDefault(); void save(); });
  }
  async function read() {
    if (!active() || busy) return; const current = ++generation; ready = false; error = '';
    try {
      storage = new Storage(`helmsman.feedback-settings.v1:${context.contributionId}`); const stored = storage.read();
      const result = await service!.snapshot(controller.signal);
      if (!active() || current !== generation) return;
      if (result.status !== 'available') throw new Error('Feedback settings unavailable. Your settings draft is kept.');
      snapshot = result.value;
      if (stored !== null) {
        const value = stored as Partial<SettingsDraft>;
        if (value.version !== 1 || typeof value.revision !== 'string' || !/^[a-f\d]{64}$/.test(value.revision) || value.selected !== null && typeof value.selected !== 'string' || !value.values || typeof value.values !== 'object' || Array.isArray(value.values)) throw new Error('Saved settings draft is invalid. Its original data is kept.');
        draft = value as SettingsDraft;
        if (draft.revision !== snapshot.revision) error = 'Configuration changed. Your settings draft is kept; reload the latest settings before saving.';
      } else draft = { version: 1, revision: snapshot.revision, selected: snapshot.selected, values: Object.fromEntries(snapshot.providers.map(item => [item.id, { ...item.values }])) };
      for (const item of snapshot.providers) if (!draft.values[item.id]) draft.values[item.id] = { ...item.values };
      saveDraft(); ready = draft.revision === snapshot.revision;
      const destination = await context.services?.feedbackCommands?.destination(controller.signal);
      if (!active() || current !== generation) return; destinationReady = destination?.status === 'available' && destination.value !== null;
    } catch (failure) { if (active() && current === generation) error = message(failure); }
    if (active() && current === generation) draw();
  }
  async function save() {
    if (!active() || !ready || busy || !draft) return; busy = true; error = ''; notice = ''; const current = generation; draw();
    try {
      const result = await service!.save({ version: 1, expectedRevision: draft.revision, selected: draft.selected, values: draft.selected ? draft.values[draft.selected] ?? {} : {} }, controller.signal);
      if (!active() || current !== generation) return;
      if (result.status !== 'available') throw new Error(result.reason === 'conflict' ? 'Feedback settings changed. Refresh before saving; your draft is kept.' : 'Feedback settings were not confirmed saved. Your draft is kept.');
      snapshot = result.value; draft = { version: 1, revision: snapshot.revision, selected: snapshot.selected, values: Object.fromEntries(snapshot.providers.map(item => [item.id, { ...item.values }])) }; saveDraft();
      notice = 'Feedback settings saved. Restart Helmsman to apply tracker changes.'; destinationReady = false;
    } catch (failure) { if (active() && current === generation) error = message(failure); }
    finally { if (active() && current === generation) { busy = false; draw(); } }
  }
  function dispose() { disposed = true; ++generation; controller.abort(); }
  context.onDispose(dispose); context.signal.addEventListener('abort', dispose, { once: true }); if (active()) { draw(); void read(); }
  return { async update(next) { const changed = state.repo !== next.repo || state.visible !== next.visible; state = next; if (changed) { ++generation; controller.abort(); controller = new AbortController(); busy = false; if (active()) await read(); } }, refresh: read, dispose };
} };
export default page;
