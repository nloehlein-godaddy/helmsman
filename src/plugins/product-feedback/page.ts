import type { FeedbackCommandServiceV1, FeedbackDestinationV1, FeedbackPendingV1, PluginPageModule } from '@helmsman/plugin-sdk';
import { draft, esc, message, Storage, styles, type Draft } from './util.js';
const page: PluginPageModule = { mount(container, context) {
  const service: FeedbackCommandServiceV1 | undefined = context.services?.feedbackCommands;
  if (service?.version !== 1 || !context.contributionId) throw new Error('Feedback requires its public command service and contribution identity.');
  let state = context.state; let disposed = false; let generation = 0; let busy = false; let ready = false; let error = '';
  let selected: FeedbackDestinationV1 | null = null; let saved: Draft | null = null; let storage: Storage | null = null; let pending: readonly FeedbackPendingV1[] = [];
  let controller = new AbortController();
  const active = () => !disposed && state.visible && !context.signal.aborted;
  function draw() {
    if (disposed) return;
    const retained = pending.find(item => item.command.context.repo === state.repo);
    const terminal = retained?.receipt?.status === 'succeeded' || retained?.receipt?.status === 'rejected';
    const matches = selected !== null && selected.revision === saved?.destination?.revision;
    container.innerHTML = `<section class="product-feedback"><style>${styles}</style><h1>Product feedback</h1>
      ${error ? `<p role="alert">${esc(error)}</p>` : ''}
      <button type="button" data-refresh ${busy ? 'disabled' : ''}>Refresh</button>
      ${!ready ? '<p role="status">Loading saved feedback…</p>' : ''}
      ${retained ? `<section aria-label="Saved submission"><h2>${esc(retained.command.title)}</h2><p>Destination: ${esc(retained.command.expectedDestination.label)}</p><pre>${esc(retained.command.body)}</pre><p role="status">${esc(retained.receipt?.status ?? 'Submission result unavailable')}</p>${retained.receipt?.reason ? `<p>${esc(retained.receipt.reason)}</p>` : ''}${retained.receipt?.result ? `<a href="${esc(retained.receipt.result.url)}" target="_blank" rel="noopener noreferrer">Open submitted feedback</a>` : ''}
      ${terminal ? `<button type="button" data-new ${busy ? 'disabled' : ''}>${retained.receipt?.status === 'rejected' ? 'Create revised submission' : 'New feedback'}</button>` : `<p>The original request is retained. Checking it will not create a duplicate.</p><button type="button" data-check ${busy ? 'disabled' : ''}>Check original submission</button>`}</section>` : ''}
      ${!selected ? '<p role="status">Feedback is disabled or unavailable. Your saved draft is kept.</p>' : `<p>Send to <a href="${esc(selected.url)}" target="_blank" rel="noopener noreferrer">${esc(selected.label)}</a></p>`}
      ${saved && !retained && (selected || saved.title || saved.body) ? `<form><label>Title<input name="title" maxlength="256" value="${esc(saved.title)}" ${busy ? 'disabled' : ''}></label><label>Feedback<textarea aria-label="Feedback" name="body" maxlength="10000" ${busy ? 'disabled' : ''}>${esc(saved.body)}</textarea></label>
      ${saved.destination && !matches ? '<p>The destination changed or is unavailable. Your original draft is kept.</p>' : ''}
      ${selected && !matches ? `<button type="button" data-destination ${busy ? 'disabled' : ''}>Use current destination</button>` : ''}
      <button type="submit" ${!ready || busy || !matches || !saved.title.trim() || !saved.body.trim() ? 'disabled' : ''}>Submit feedback</button></form>` : ''}
      <p><a href="/feedback-settings${state.repo ? `?repo=${encodeURIComponent(state.repo)}` : ''}">Feedback settings</a></p></section>`;
    container.querySelector('[data-refresh]')?.addEventListener('click', () => { void (context.refresh?.() ?? refresh()); });
    const form = container.querySelector('form');
    form?.addEventListener('input', () => {
      if (!saved || !storage || busy) return;
      const title = form.querySelector<HTMLInputElement>('[name=title]')?.value ?? saved.title;
      const body = form.querySelector<HTMLTextAreaElement>('[name=body]')?.value ?? saved.body;
      try { const next = { ...saved, title, body }; storage.save(next); saved = next; const submit = form.querySelector<HTMLButtonElement>('[type=submit]'); if (submit) submit.disabled = !ready || !matches || !title.trim() || !body.trim(); }
      catch (failure) { ready = false; error = message(failure); draw(); }
    });
    form?.addEventListener('submit', event => { event.preventDefault(); void perform(async signal => {
      if (!saved?.destination || !storage || !selected || selected.revision !== saved.destination.revision) throw new Error('The feedback destination is unavailable.');
      const existing = await service!.pending(); signal.throwIfAborted();
      if (existing.some(item => item.command.context.repo === state.repo)) throw new Error('Resolve the retained submission before sending another.');
      const result = await service!.submit({ version: 1, draftId: saved.id, title: saved.title, body: saved.body, context: saved.context, expectedDestination: saved.destination }, signal);
      if (result.status !== 'available') throw new Error('Submission result unavailable. Check the retained original request before trying again.');
    }); });
    container.querySelector('[data-destination]')?.addEventListener('click', () => { if (!saved || !storage || !selected) return; try { const next = { ...saved, id: crypto.randomUUID(), context: service!.context(), destination: selected }; storage.save(next); saved = next; error = ''; draw(); } catch (failure) { ready = false; error = message(failure); draw(); } });
    container.querySelector('[data-check]')?.addEventListener('click', () => { if (retained) void perform(async signal => { const result = await service!.retry({ requestId: retained.command.requestId, repo: retained.command.context.repo }, signal); if (result.status !== 'available') throw new Error('The original submission is still unavailable. Its identity is kept.'); }); });
    container.querySelector('[data-new]')?.addEventListener('click', () => { if (!retained || !terminal) return; void perform(async signal => {
      const revised = retained.receipt?.status === 'rejected';
      const next: Draft = { version: 1, id: crypto.randomUUID(), title: revised ? retained.command.title : '', body: revised ? retained.command.body : '', context: service!.context(), destination: selected };
      if (!storage) throw new Error('Draft storage unavailable'); storage.save(next); saved = next;
      await service!.acknowledge({ requestId: retained.command.requestId, repo: retained.command.context.repo }, signal);
    }); });
  }
  async function read() {
    const current = ++generation; ready = false;
    try {
      const metadata = service!.context(); storage = new Storage(`helmsman.product-feedback.v1:${context.contributionId}:${JSON.stringify(metadata.repo)}`);
      const value = storage.read(); saved = value === null ? { version: 1, id: crypto.randomUUID(), title: '', body: '', context: metadata, destination: null } : draft(value, metadata);
      const [destination, retained] = await Promise.all([service!.destination(controller.signal), service!.pending()]);
      if (!active() || current !== generation) return;
      pending = retained; selected = destination.status === 'available' ? destination.value : null;
      if (destination.status !== 'available') error = 'Feedback destination unavailable. Your draft and original submissions are kept.';
      const original = retained.find(item => item.command.context.repo === metadata.repo);
      if (original && value === null) saved = { version: 1, id: original.command.draftId, title: original.command.title, body: original.command.body, context: original.command.context, destination: original.command.expectedDestination };
      if (!saved.destination && selected) saved = { ...saved, destination: selected };
      storage.save(saved); ready = true;
    } catch (failure) { if (active() && current === generation) error = message(failure); }
    if (active() && current === generation) draw();
  }
  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    if (!active() || busy || !ready) return; busy = true; error = ''; const current = generation; draw();
    try { await action(controller.signal); } catch (failure) { if (active() && current === generation) error = message(failure); }
    finally { if (active() && current === generation) { busy = false; await read(); } }
  }
  async function refresh() { if (!active() || busy) return; error = ''; await read(); }
  function dispose() { if (disposed) return; disposed = true; ++generation; controller.abort(); }
  context.onDispose(dispose); context.signal.addEventListener('abort', dispose, { once: true });
  if (active()) { draw(); void read(); }
  return { async update(next) { const changed = state.repo !== next.repo || state.visible !== next.visible; state = next; if (changed) { ++generation; controller.abort(); controller = new AbortController(); busy = false; selected = null; saved = null; pending = []; ready = false; if (active()) { draw(); await read(); } } }, refresh, dispose };
} };
export default page;
