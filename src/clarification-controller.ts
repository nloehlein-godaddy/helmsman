import type { ClarificationReadItemV1, ClarificationReadServiceV1 } from './plugins/clarification-read';
import type { ClarificationCommandPendingV1, ClarificationCommandReceiptV1, ClarificationCommandServiceV1 } from './plugins/clarification-command';
import type { SuggestedContactAdminContactV1, SuggestedContactAdminPendingV1, SuggestedContactAdminReceiptV1, SuggestedContactAdminServiceV1 } from './plugins/suggested-contact-admin';
import { createHostClarificationReadService } from './plugins/clarification-read-service';
import { createHostClarificationCommandService } from './plugins/clarification-command-service';
import { createHostSuggestedContactAdminService } from './plugins/suggested-contact-admin-service';
import { clarificationDraftKey, createClarificationDraftStore, emptyClarificationDrafts, type ClarificationDraftStore } from './clarification-drafts';
import { renderClarifications } from './renderClarifications';

export interface ClarificationViewServices {
  clarifications: ClarificationReadServiceV1; clarificationCommands: ClarificationCommandServiceV1; suggestedContacts: SuggestedContactAdminServiceV1;
}
export function mountClarifications(container: HTMLElement, options: {
  repo(): string | null; services?: ClarificationViewServices; signal?: AbortSignal; visible?: boolean; drafts?: ClarificationDraftStore;
}): { refresh(): Promise<void>; setVisible(visible: boolean): void; destroy(): void } {
  const lifetime = new AbortController(); let activity = new AbortController(); let visible = options.visible ?? true; let destroyed = false;
  let scope = options.repo(); let generation = 0; let sequence = 0; let busy = false;
  const hostOptions = { caller: 'helmsman.compat-clarifications/page', scope: () => ({ repo: scope, epoch: generation, active: visible && !destroyed, signal: activity.signal }) };
  const services = options.services ?? { clarifications: createHostClarificationReadService(lifetime.signal, hostOptions), clarificationCommands: createHostClarificationCommandService(lifetime.signal, hostOptions), suggestedContacts: createHostSuggestedContactAdminService(lifetime.signal, hostOptions) };
  const draftStore = options.drafts ?? createClarificationDraftStore(); let drafts = emptyClarificationDrafts(); let storageError: string | null = null;
  const dirtyAnswers = new Set<string>(); let dirtyContact = false;
  let items: ClarificationReadItemV1[] = []; let contacts: SuggestedContactAdminContactV1[] = [];
  let pending: readonly ClarificationCommandPendingV1[] = []; let contactPending: readonly SuggestedContactAdminPendingV1[] = [];
  let error: string | null = null; let contactError: string | null = null; let notice: string | null = null; let loading = true;
  let questionsCursor: string | null = null; let contactsCursor: string | null = null;
  const message = (error: unknown) => error instanceof Error ? error.message : 'Service unavailable';
  const current = (token: number) => !destroyed && visible && token === generation && scope === options.repo();
  function mergeDrafts(): void {
    const saved = draftStore.read();
    for (const key of dirtyAnswers) saved.answers[key] = drafts.answers[key] ?? '';
    if (dirtyContact) saved.contact = drafts.contact;
    drafts = saved;
  }
  function readDrafts(): void { try { mergeDrafts(); if (!dirtyAnswers.size && !dirtyContact) storageError = null; } catch (error) { storageError = message(error); } }
  readDrafts();
  function paint(): void {
    if (destroyed) return;
    const active = document.activeElement; const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
    const focus = field ? { id: field.closest('form')?.getAttribute('data-answer') ?? null, name: field.name, start: field.selectionStart, end: field.selectionEnd } : null;
    const details = new Map([...container.querySelectorAll('details')].map(item => [item.className, item.open]));
    const unresolved = new Set([...pending, ...contactPending].map(entry => entry.command.requestId));
    const answerDrafts = Object.entries(drafts.answers).map(([key, text]) => { const [repo, runId, id] = JSON.parse(key) as [string, string, string];
      return { key, text, repo, label: `${repo} · ${runId} · ${id}`, protected: pending.some(entry => entry.command.repo === repo && entry.command.runId === runId && entry.command.questionId === id) }; }).filter(draft => scope === null || draft.repo === scope);
    container.innerHTML = renderClarifications(items, contacts, scope, error, { loading, contactError, notice, storageError, pending, contactPending, moreQuestions: questionsCursor !== null, moreContacts: contactsCursor !== null,
      results: drafts.results.filter(result => result.repo === null || scope === null || result.repo === scope).map(result => ({ ...result, protected: unresolved.has(result.requestId) })), drafts: answerDrafts,
      contactDraft: drafts.contact.name || drafts.contact.address ? { text: `${drafts.contact.name} · ${drafts.contact.address}`, protected: contactPending.length > 0 } : null });
    for (const form of container.querySelectorAll<HTMLFormElement>('form')) {
      const question = items.find(item => item.id === form.dataset.answer);
      for (const input of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')) {
        if (question) input.value = drafts.answers[clarificationDraftKey(question)] ?? '';
        else if (input.name === 'enabled' && input instanceof HTMLInputElement) input.checked = drafts.contact.enabled;
        else if (input.name === 'name' || input.name === 'address') input.value = drafts.contact[input.name];
        if (focus && focus.name === input.name && focus.id === (form.dataset.answer ?? null)) {
          input.focus(); if (input instanceof HTMLTextAreaElement && focus.start !== null && focus.end !== null) input.setSelectionRange(focus.start, focus.end);
        }
      }
    }
    container.querySelectorAll('details').forEach(item => { item.open = details.get(item.className) ?? false; });
    container.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy || !visible || button.hasAttribute('data-protected'); });
  }
  function transition(): void { activity.abort(); activity = new AbortController(); generation++; sequence++; busy = false; }
  function persist(form: HTMLFormElement): boolean {
    const data = new FormData(form); const item = items.find(item => item.id === form.dataset.answer);
    try {
      if (item) {
        const value = String(data.get('answer') ?? ''); const key = clarificationDraftKey(item); drafts.answers[key] = value; dirtyAnswers.add(key); draftStore.answer(key, value); dirtyAnswers.delete(key);
      } else if (form.matches('.trusted-contact-form')) {
        drafts.contact = { name: String(data.get('name') ?? ''), address: String(data.get('address') ?? ''), enabled: data.get('enabled') === 'on' }; dirtyContact = true; draftStore.contact(drafts.contact); dirtyContact = false;
      } else return false;
      if (!dirtyAnswers.size && !dirtyContact) storageError = null; return true;
    } catch (error) { storageError = message(error); return false; }
  }
  async function loadPending(token: number): Promise<boolean> {
    const results = await Promise.allSettled([services.clarificationCommands.pending(), services.suggestedContacts.pending()]);
    if (!current(token)) return false;
    if (results[0]?.status === 'fulfilled') pending = results[0].value;
    else if (results[0]?.status === 'rejected') error = `Answer recovery unavailable: ${message(results[0].reason)}`;
    if (results[1]?.status === 'fulfilled') contactPending = results[1].value;
    else if (results[1]?.status === 'rejected') contactError = `Contact recovery unavailable: ${message(results[1].reason)}`;
    return results[0]?.status === 'fulfilled' && results[1]?.status === 'fulfilled';
  }
  async function refresh(): Promise<void> {
    if (destroyed || !visible) return;
    if (options.repo() !== scope) { transition(); scope = options.repo(); items = []; pending = []; error = null; notice = null; questionsCursor = null; loading = true; }
    const token = generation; const request = ++sequence; const signal = activity.signal;
    if (!storageError) readDrafts(); paint();
    await Promise.allSettled([
      (async () => {
        try {
          const result = await services.clarifications.list({ version: 1, repo: scope, runId: null, states: [], limit: 100, cursor: null }, signal);
          if (!current(token) || request !== sequence) return;
          if (result.status === 'available') { items = [...result.value.items]; questionsCursor = result.value.nextCursor; error = null; }
          else error = result.reason;
        } catch (reason) { if (current(token) && request === sequence) error = message(reason); }
        if (current(token) && request === sequence) { loading = false; paint(); }
      })(),
      (async () => {
        try {
          const result = await services.suggestedContacts.list({ version: 1, scope: 'global', limit: 100, cursor: null }, signal);
          if (!current(token) || request !== sequence) return;
          if (result.status === 'available') { contacts = [...result.value.items]; contactsCursor = result.value.nextCursor; contactError = null; }
          else contactError = result.reason;
        } catch (reason) { if (current(token) && request === sequence) contactError = message(reason); }
        if (current(token) && request === sequence) paint();
      })(),
      loadPending(token).then(() => { if (current(token) && request === sequence) paint(); }),
    ]);
  }
  async function accept(receipt: ClarificationCommandReceiptV1 | SuggestedContactAdminReceiptV1, token: number): Promise<void> {
    if (!current(token)) return; const answer = 'questionId' in receipt.input;
    const result = receipt.status === 'succeeded' ? answer ? 'Answer accepted. Worker consumption is not confirmed.' : 'Contact saved. No notification was sent.' : `Submission rejected: ${receipt.reason ?? 'unavailable'}. Your draft is retained.`;
    try {
      if ('questionId' in receipt.input) {
        const key = clarificationDraftKey({ repo: receipt.input.repo, runId: receipt.input.runId, id: receipt.input.questionId });
        if (dirtyAnswers.has(key)) { draftStore.answer(key, drafts.answers[key] ?? ''); dirtyAnswers.delete(key); }
      } else if (dirtyContact) { draftStore.contact(drafts.contact); dirtyContact = false; }
      draftStore.accept(receipt, result); mergeDrafts(); if (!dirtyAnswers.size && !dirtyContact) storageError = null;
    } catch (error) { storageError = message(error); return; }
    notice = result; paint();
    if (answer && 'repo' in receipt.input) await services.clarificationCommands.acknowledge({ repo: receipt.input.repo, requestId: receipt.requestId }, activity.signal);
    else await services.suggestedContacts.acknowledge({ scope: 'global', requestId: receipt.requestId }, activity.signal);
  }
  async function action(work: (token: number) => Promise<void>): Promise<void> {
    if (busy || !current(generation)) return; const token = generation; busy = true; notice = null; paint();
    try { await work(token); }
    catch (error) { if (current(token)) notice = message(error); }
    finally { if (current(token)) { busy = false; await loadPending(token); if (current(token)) paint(); } }
  }
  const submit = (event: Event) => {
    const form = event.target; if (!(form instanceof HTMLFormElement)) return; event.preventDefault();
    if (busy || !current(generation)) return; if (!persist(form)) { paint(); return; }
    const item = items.find(item => item.id === form.dataset.answer); const draft = { ...drafts.contact }; const answer = item ? drafts.answers[clarificationDraftKey(item)] ?? '' : '';
    void action(async token => {
      if (item) {
        if (!item.answerability.available || item.provenance.kind !== 'attempt-channel') throw new Error('This question cannot accept an answer');
        const result = await services.clarificationCommands.submit({ version: 1, repo: item.repo, runId: item.runId, questionId: item.id, expectedAttempt: item.provenance.attempt,
          expectedChannelId: item.provenance.channelId, expectedQuestionRevision: item.revision, answer }, activity.signal);
        if (!current(token)) return; if (result.status === 'unavailable') throw new Error(`Answer outcome unavailable: ${result.reason}. Check unresolved submissions before changing the request.`);
        await accept(result.value, token);
      } else if (form.matches('.trusted-contact-form')) {
        const result = await services.suggestedContacts.submit({ version: 1, scope: 'global', kind: 'create', ...draft }, activity.signal);
        if (!current(token)) return; if (result.status === 'unavailable') throw new Error(`Contact outcome unavailable: ${result.reason}. Check unresolved submissions before changing the request.`);
        await accept(result.value, token);
      }
      if (current(token)) void refresh();
    });
  };
  async function reconcile(kind: string | undefined, requestId: string | undefined, actionName: string | undefined, token: number): Promise<void> {
    if (kind === 'answer') {
      const entry = pending.find(entry => entry.command.requestId === requestId); if (!entry) return; const query = { repo: entry.command.repo, requestId: entry.command.requestId };
      if (actionName === 'acknowledge') { if (entry.receipt) await accept(entry.receipt, token); return; }
      const { requestId: _requestId, ...input } = entry.command;
      const result = actionName === 'retry' ? await services.clarificationCommands.submit(input, activity.signal) : await services.clarificationCommands.receipt(query, activity.signal);
      if (!current(token)) return; if (result.status === 'unavailable') throw new Error(`Original answer outcome unavailable: ${result.reason}`);
      if (result.value) await accept(result.value, token); else notice = 'No receipt is recorded yet. The original request and draft are retained.';
    } else if (kind === 'contact') {
      const entry = contactPending.find(entry => entry.command.requestId === requestId); if (!entry) return;
      if (actionName === 'acknowledge') { if (entry.receipt) await accept(entry.receipt, token); return; }
      const { requestId: _requestId, ...intent } = entry.command; const { id: _id, ...create } = intent;
      const result = actionName === 'retry' ? await services.suggestedContacts.submit(intent.kind === 'create' ? { ...create, kind: 'create' } : intent, activity.signal)
        : await services.suggestedContacts.receipt({ scope: 'global', requestId: entry.command.requestId }, activity.signal);
      if (!current(token)) return; if (result.status === 'unavailable') throw new Error(`Original contact outcome unavailable: ${result.reason}`);
      if (result.value) await accept(result.value, token); else notice = 'No receipt is recorded yet. The original request and draft are retained.';
    }
  }
  const click = (event: Event) => {
    if (!(event.target instanceof Element)) return; const button = event.target.closest<HTMLButtonElement>('button'); if (!button || button.disabled) return;
    if (button.hasAttribute('data-refresh-questions')) { void refresh(); return; }
    const holder = button.closest<HTMLElement>('[data-request]');
    if (holder) { void action(token => reconcile(holder.dataset.pendingKind, holder.dataset.request, button.dataset.pendingAction, token)); return; }
    if (button.hasAttribute('data-remove-draft') || button.hasAttribute('data-remove-contact-draft') || button.hasAttribute('data-remove-result')) {
      void action(async token => {
        if (!await loadPending(token)) throw new Error('Recovery storage is unavailable; saved state cannot be removed');
        if (!current(token)) return;
        if (button.dataset.removeDraft) {
          const key = button.dataset.removeDraft; const [repo, runId, id] = JSON.parse(key) as [string, string, string];
          if (scope !== null && repo !== scope || pending.some(entry => entry.command.repo === repo && entry.command.runId === runId && entry.command.questionId === id)) throw new Error('Resolve this draft’s original submission before discarding it');
          draftStore.removeAnswer(key); dirtyAnswers.delete(key); delete drafts.answers[key];
        } else if (button.hasAttribute('data-remove-contact-draft')) {
          if (contactPending.length) throw new Error('Resolve global contact submissions before discarding their draft');
          draftStore.removeContact(); dirtyContact = false;
        } else if (button.dataset.removeResult) {
          const requestId = button.dataset.removeResult;
          if ([...pending, ...contactPending].some(entry => entry.command.requestId === requestId)) throw new Error('Resolve this submission before dismissing its saved result');
          draftStore.removeResult(requestId);
        }
        readDrafts(); notice = 'Saved browser state removed. Command journals are unchanged.';
      }); return;
    }
    if (button.hasAttribute('data-more-questions') || button.hasAttribute('data-more-contacts')) void action(async token => {
      if (button.hasAttribute('data-more-questions') && questionsCursor) {
        const result = await services.clarifications.list({ version: 1, repo: scope, runId: null, states: [], limit: 100, cursor: questionsCursor }, activity.signal);
        if (!current(token)) return; if (result.status === 'unavailable') throw new Error(result.reason);
        const merged = new Map(items.map(item => [item.id, item])); result.value.items.forEach(item => merged.set(item.id, item)); items = [...merged.values()]; questionsCursor = result.value.nextCursor;
      } else if (contactsCursor) {
        const result = await services.suggestedContacts.list({ version: 1, scope: 'global', limit: 100, cursor: contactsCursor }, activity.signal);
        if (!current(token)) return; if (result.status === 'unavailable') throw new Error(result.reason);
        const merged = new Map(contacts.map(item => [item.id, item])); result.value.items.forEach(item => merged.set(item.id, item)); contacts = [...merged.values()]; contactsCursor = result.value.nextCursor;
      }
    });
  };
  const input = (event: Event) => { if (event.target instanceof Element) { const form = event.target.closest('form'); if (form) persist(form); } };
  function destroy(): void { if (destroyed) return; destroyed = true; transition(); lifetime.abort(); container.removeEventListener('submit', submit); container.removeEventListener('click', click); container.removeEventListener('input', input); options.signal?.removeEventListener('abort', destroy); }
  options.signal?.addEventListener('abort', destroy, { once: true });
  container.addEventListener('submit', submit); container.addEventListener('click', click); container.addEventListener('input', input);
  if (options.signal?.aborted) destroy(); else { paint(); void refresh(); }
  return { refresh, setVisible(next) { if (visible === next || destroyed) return; visible = next; transition(); paint(); }, destroy };
}
