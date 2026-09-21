import { afterEach, expect, it, vi } from 'vitest';
import { mountClarifications, renderClarifications } from './renderClarifications';
import type { ClarificationViewServices } from './clarification-controller';
import { clarificationDraftKey, createClarificationDraftStore } from './clarification-drafts';
import type { ClarificationReadItemV1, ClarificationReadResultV1 } from './plugins/clarification-read';
import type { ClarificationCommandPendingV1, ClarificationCommandReceiptV1, ClarificationCommandV1 } from './plugins/clarification-command';
import type { SuggestedContactAdminPendingV1 } from './plugins/suggested-contact-admin';
import { setPirateMode } from './logic/terminology';

const uuid = '00000000-0000-4000-8000-000000000001';
const time = '2026-09-19T00:00:00Z';
const controllers: ReturnType<typeof mountClarifications>[] = [];
function question(patch: Partial<ClarificationReadItemV1> = {}): ClarificationReadItemV1 {
  return { version: 1, id: 'question-1', runId: 'run-1', repo: 'org/app', revision: 1, prompt: 'Should the existing API stay available?', required: true, owner: 'local', contactId: null,
    state: 'pending', answer: null, createdAt: time, timeoutAt: null, answeredAt: null, provenance: { kind: 'attempt-channel', attempt: 1, channelId: uuid }, currentAttempt: 1,
    blocksPublication: true, answerability: { available: true, reason: null }, ...patch };
}
function accepted(command: ClarificationCommandV1): ClarificationCommandReceiptV1 {
  const { requestId, ...input } = command;
  return { version: 1, requestId, input, status: 'succeeded', result: { questionId: command.questionId, revision: command.expectedQuestionRevision + 1, answer: command.answer, answeredAt: time }, reason: null };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const data = { questions: [question()], pending: [] as ClarificationCommandPendingV1[], contactPending: [] as SuggestedContactAdminPendingV1[] };
  const services = {
    clarifications: { version: 1, list: vi.fn<ClarificationViewServices['clarifications']['list']>(async input => ({ status: 'available', value: { version: 1, repo: input.repo, items: data.questions, nextCursor: null, total: data.questions.length, observedAt: time } })), load: vi.fn() },
    clarificationCommands: { version: 1, pending: vi.fn(async () => data.pending), receipt: vi.fn(), acknowledge: vi.fn(async query => { data.pending = data.pending.filter(entry => entry.command.requestId !== query.requestId); }),
      submit: vi.fn<ClarificationViewServices['clarificationCommands']['submit']>(async input => {
        const command = { ...input, requestId: uuid }; const receipt = accepted(command); data.pending = [{ command, receipt }];
        data.questions = data.questions.map(item => item.id === input.questionId ? { ...item, state: 'answered', answer: input.answer.trim(), answeredAt: time, blocksPublication: false, answerability: { available: false, reason: 'not-pending' } } : item);
        return { status: 'available', value: receipt };
      }) },
    suggestedContacts: { version: 1, list: vi.fn<ClarificationViewServices['suggestedContacts']['list']>(async () => ({ status: 'available', value: { version: 1, scope: 'global', items: [], nextCursor: null, observedAt: time } })), load: vi.fn(), submit: vi.fn(), receipt: vi.fn(), pending: vi.fn(async () => data.contactPending), acknowledge: vi.fn() },
  } satisfies ClarificationViewServices;
  function mount(options: Partial<Parameters<typeof mountClarifications>[1]> = {}) {
    const container = document.createElement('main'); document.body.append(container);
    const controller = mountClarifications(container, { repo: () => 'org/app', services, ...options }); controllers.push(controller); return { container, controller };
  }
  return { data, services, mount };
}
function form(container: HTMLElement): HTMLFormElement { const form = container.querySelector<HTMLFormElement>('form[data-answer]'); if (!form) throw new Error('Missing answer form'); return form; }
function draft(container: HTMLElement, text: string): void { const input = form(container).querySelector('textarea')!; input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); }
function submit(container: HTMLElement): void { form(container).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
const ready = (container: HTMLElement) => vi.waitFor(() => expect(container.querySelector('form[data-answer]')).not.toBeNull());
afterEach(() => { controllers.splice(0).forEach(controller => controller.destroy()); document.body.innerHTML = ''; localStorage.clear(); vi.restoreAllMocks(); setPirateMode(true); });

it.each([true, false])('renders scoped questions without requiring contacts in pirate mode %s', pirate => {
  setPirateMode(pirate); document.body.innerHTML = renderClarifications([question()], [], 'org/app', null);
  expect(document.querySelector('h1')?.textContent).toBe('Agent Questions'); expect(document.querySelector('.clarification-create')).toBeNull();
  expect(document.querySelector('.clarification-help a')?.getAttribute('href')).toBe('/helm?repo=org%2Fapp&pane=newrun');
  expect(document.querySelector<HTMLDetailsElement>('[data-contact-settings]')?.open).toBe(false);
  expect(form(document.body).querySelector('button')?.textContent).toBe('Accept answer');
});
it('shows unknown/prior obligations read-only, collapses history and escapes untrusted text', () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  document.body.innerHTML = renderClarifications([question({ prompt: unsafe }), question({ id: 'unknown', provenance: { kind: 'legacy-unproven', attempt: null, channelId: null }, answerability: { available: false, reason: 'provenance-unknown' } }),
    question({ id: 'prior', currentAttempt: 2, answerability: { available: false, reason: 'different-attempt' } }), question({ id: 'answered', state: 'answered', answer: '<script>bad()</script>', answerability: { available: false, reason: 'not-pending' } })], [], null, null);
  expect(document.querySelectorAll('form[data-answer]')).toHaveLength(1); expect(document.body.textContent).toContain('provenance-unknown'); expect(document.body.textContent).toContain('publication blocker');
  expect(document.querySelector('img,script')).toBeNull(); expect(document.body.textContent).toContain(unsafe);
  expect(document.querySelector<HTMLDetailsElement>('.clarification-history')?.open).toBe(false);
  const url = new URL(document.querySelector<HTMLAnchorElement>('.clarification-card a')!.href);
  expect(url.pathname).toBe('/run-viewer'); expect(url.searchParams.get('repo')).toBeNull(); expect(url.searchParams.get('runRepo')).toBe('org/app');
});
it('renders questions and permits answers while global contact reads remain stalled', async () => {
  const f = fixture(); f.services.suggestedContacts.list.mockReturnValue(new Promise(() => {})); const { container } = f.mount(); await ready(container);
  draft(container, 'Yes'); submit(container); await vi.waitFor(() => expect(f.services.clarificationCommands.acknowledge).toHaveBeenCalled());
  expect(container.textContent).toContain('Answer accepted'); expect(container.textContent).toContain('Worker consumption is not confirmed');
});
it('submits exact observed question fences, persists result before acknowledgment and moves answered rows to history', async () => {
  const f = fixture(); const store = createClarificationDraftStore(); const ack = f.services.clarificationCommands.acknowledge.getMockImplementation()!;
  f.services.clarificationCommands.acknowledge.mockImplementation(async query => { expect(store.read().results[0]?.requestId).toBe(query.requestId); expect(store.read().answers[clarificationDraftKey(question())]).toBe('Yes'); await ack(query); });
  const { container } = f.mount(); await ready(container); draft(container, 'Yes'); submit(container);
  await vi.waitFor(() => expect(f.services.clarificationCommands.acknowledge).toHaveBeenCalled());
  expect(f.services.clarificationCommands.submit).toHaveBeenCalledWith({ version: 1, repo: 'org/app', runId: 'run-1', questionId: 'question-1', expectedAttempt: 1, expectedChannelId: uuid, expectedQuestionRevision: 1, answer: 'Yes' }, expect.any(AbortSignal));
  await vi.waitFor(() => expect(container.querySelector('form[data-answer]')).toBeNull()); expect(container.querySelector('.clarification-history')?.textContent).toContain('Yes');
});
it('restores unsent drafts across refresh, scope revisits and unmount without automatic submission', async () => {
  const f = fixture(); let repo = 'org/app'; const first = f.mount({ repo: () => repo }); await ready(first.container); draft(first.container, 'Unsent draft');
  await first.controller.refresh(); expect(form(first.container).querySelector('textarea')?.value).toBe('Unsent draft');
  repo = 'org/other'; f.data.questions = [question({ repo, id: 'other' })]; await first.controller.refresh(); expect(form(first.container).querySelector('textarea')?.value).toBe('');
  repo = 'org/app'; f.data.questions = [question()]; await first.controller.refresh(); expect(form(first.container).querySelector('textarea')?.value).toBe('Unsent draft');
  first.controller.destroy(); const second = f.mount(); await ready(second.container); expect(form(second.container).querySelector('textarea')?.value).toBe('Unsent draft'); expect(f.services.clarificationCommands.submit).not.toHaveBeenCalled();
});
it('retains changed drafts while explicitly retrying an original unresolved command', async () => {
  const f = fixture(); const command: ClarificationCommandV1 = { version: 1, requestId: uuid, repo: 'org/app', runId: 'run-1', questionId: 'question-1', expectedAttempt: 1, expectedChannelId: uuid, expectedQuestionRevision: 1, answer: 'Original answer' };
  f.data.pending = [{ command, receipt: null }]; const { container, controller } = f.mount(); await ready(container); await controller.refresh(); draft(container, 'Edited unsent answer');
  expect(f.services.clarificationCommands.submit).not.toHaveBeenCalled(); container.querySelector<HTMLButtonElement>('[data-pending-action="retry"]')!.click();
  await vi.waitFor(() => expect(f.services.clarificationCommands.submit).toHaveBeenCalled()); const { requestId: _id, ...input } = command;
  expect(f.services.clarificationCommands.submit).toHaveBeenCalledWith(input, expect.any(AbortSignal));
  expect(createClarificationDraftStore().read().answers[clarificationDraftKey(question())]).toBe('Edited unsent answer');
});
it('keeps unknown outcomes pending and checking a missing receipt never resubmits or acknowledges', async () => {
  const f = fixture(); f.services.clarificationCommands.submit.mockImplementation(async input => { f.data.pending = [{ command: { ...input, requestId: uuid }, receipt: null }]; return { status: 'unavailable', reason: 'connection-failed' }; });
  f.services.clarificationCommands.receipt.mockResolvedValue({ status: 'available', value: null }); const { container, controller } = f.mount(); await ready(container); draft(container, 'Original'); submit(container);
  await vi.waitFor(() => expect(container.querySelector('[data-pending-action="check"]')).not.toBeNull()); await controller.refresh();
  expect(f.services.clarificationCommands.submit).toHaveBeenCalledTimes(1); container.querySelector<HTMLButtonElement>('[data-pending-action="check"]')!.click();
  await vi.waitFor(() => expect(container.textContent).toContain('No receipt is recorded')); expect(f.services.clarificationCommands.submit).toHaveBeenCalledTimes(1); expect(f.services.clarificationCommands.acknowledge).not.toHaveBeenCalled();
});
it('does not acknowledge accepted work when saving its result fails', async () => {
  const f = fixture(); const base = createClarificationDraftStore(); const { container } = f.mount({ drafts: { ...base, accept() { throw new Error('Result quota'); } } }); await ready(container); draft(container, 'Yes'); submit(container);
  await vi.waitFor(() => expect(container.textContent).toContain('Result quota')); expect(f.services.clarificationCommands.acknowledge).not.toHaveBeenCalled();
  expect(container.querySelector('[data-pending-action="acknowledge"]')).not.toBeNull(); expect(base.read().answers[clarificationDraftKey(question())]).toBe('Yes');
});
it('preserves a newer unsaved draft when the original response arrives and waits for its durable save before acknowledgment', async () => {
  const f = fixture(); const base = createClarificationDraftStore(); let rejectNewDraft = true;
  const wait = deferred<ClarificationReadResultV1<ClarificationCommandReceiptV1>>(); f.services.clarificationCommands.submit.mockReturnValue(wait.promise);
  const { container } = f.mount({ drafts: { ...base, answer(key, value) { if (value === 'New unsent draft' && rejectNewDraft) throw new Error('Draft quota'); base.answer(key, value); } } });
  await ready(container); draft(container, 'Original answer'); submit(container); draft(container, 'New unsent draft');
  const input = f.services.clarificationCommands.submit.mock.calls[0]![0]; const command = { ...input, requestId: uuid }; const receipt = accepted(command);
  f.data.pending = [{ command, receipt }]; wait.resolve({ status: 'available', value: receipt });
  await vi.waitFor(() => expect(container.textContent).toContain('Draft quota'));
  expect(form(container).querySelector('textarea')?.value).toBe('New unsent draft'); expect(f.services.clarificationCommands.acknowledge).not.toHaveBeenCalled();
  expect(base.read().answers[clarificationDraftKey(question())]).toBe('Original answer');
  rejectNewDraft = false; container.querySelector<HTMLButtonElement>('[data-pending-action="acknowledge"]')!.click();
  await vi.waitFor(() => expect(f.services.clarificationCommands.acknowledge).toHaveBeenCalledOnce());
  expect(base.read().answers[clarificationDraftKey(question())]).toBe('New unsent draft');
});
it('does not send while draft storage is inaccessible and keeps entered text visible', async () => {
  const f = fixture(); const base = createClarificationDraftStore(); const { container } = f.mount({ drafts: { ...base, answer() { throw new Error('Draft quota'); } } }); await ready(container); draft(container, 'Unsent'); submit(container);
  expect(container.textContent).toContain('Draft quota'); expect(form(container).querySelector('textarea')?.value).toBe('Unsent'); expect(f.services.clarificationCommands.submit).not.toHaveBeenCalled();
});
it('ignores a stale submission when scope changes and does not clear or acknowledge the newer draft', async () => {
  const f = fixture(); const wait = deferred<ClarificationReadResultV1<ClarificationCommandReceiptV1>>(); f.services.clarificationCommands.submit.mockReturnValue(wait.promise);
  let repo = 'org/app'; const { container, controller } = f.mount({ repo: () => repo }); await ready(container); draft(container, 'Previous answer'); submit(container);
  repo = 'org/other'; f.data.questions = [question({ repo, id: 'other', prompt: 'Current question' })]; await controller.refresh(); draft(container, 'Current draft');
  const input = f.services.clarificationCommands.submit.mock.calls[0]![0]; wait.resolve({ status: 'available', value: accepted({ ...input, requestId: uuid }) }); await Promise.resolve(); await Promise.resolve();
  expect(container.textContent).toContain('Current question'); expect(form(container).querySelector('textarea')?.value).toBe('Current draft'); expect(f.services.clarificationCommands.acknowledge).not.toHaveBeenCalled();
});
it('stops hidden work and ignores responses after destruction', async () => {
  const f = fixture(); const { container, controller } = f.mount({ visible: false }); expect(f.services.clarifications.list).not.toHaveBeenCalled();
  controller.setVisible(true); await controller.refresh(); await ready(container);
  const before = f.services.clarifications.list.mock.calls.length; controller.setVisible(false); await controller.refresh(); expect(f.services.clarifications.list).toHaveBeenCalledTimes(before);
  controller.destroy(); container.innerHTML = '<p>Another page</p>'; await controller.refresh(); expect(container.innerHTML).toBe('<p>Another page</p>');
});
it('uses opaque continuation for explicit load more and preserves existing drafts', async () => {
  const f = fixture(); f.services.clarifications.list.mockImplementation(async query => ({ status: 'available', value: { version: 1, repo: query.repo, items: query.cursor ? [question({ id: 'second', prompt: 'Second question' })] : [question()], nextCursor: query.cursor ? null : 'next', total: 2, observedAt: time } }));
  const { container } = f.mount(); await ready(container); draft(container, 'Draft'); container.querySelector<HTMLButtonElement>('[data-more-questions]')!.click();
  await vi.waitFor(() => expect(container.textContent).toContain('Second question')); expect(form(container).querySelector('textarea')?.value).toBe('Draft'); expect(container.querySelector('[data-more-questions]')).toBeNull();
});
it('recovers from the saved-state record cap through explicit result dismissal without deleting pending commands', async () => {
  const f = fixture(); const base = createClarificationDraftStore(); base.answer(clarificationDraftKey(question()), 'Yes');
  for (let index = 0; index < 1023; index++) {
    const requestId = `00000000-0000-4000-8000-${(index + 1000).toString(16).padStart(12, '0')}`;
    localStorage.setItem(`helmsman.compat-clarifications.drafts.v2:result:${requestId}`, JSON.stringify({ requestId, repo: 'org/app', message: 'Earlier accepted answer' }));
  }
  const { container } = f.mount(); await ready(container); submit(container);
  await vi.waitFor(() => expect(container.textContent).toContain('Saved clarification state is full'));
  expect(f.services.clarificationCommands.acknowledge).not.toHaveBeenCalled();
  container.querySelector<HTMLButtonElement>('[data-remove-result]')!.click();
  await vi.waitFor(() => expect(container.textContent).toContain('Saved browser state removed'));
  expect(f.data.pending).toHaveLength(1); container.querySelector<HTMLButtonElement>('[data-pending-action="acknowledge"]')!.click();
  await vi.waitFor(() => expect(f.services.clarificationCommands.acknowledge).toHaveBeenCalledOnce());
  expect(base.read().results.some(result => result.requestId === uuid)).toBe(true);
});
it('protects unresolved drafts from cleanup and refuses cleanup when journal reads fail', async () => {
  const f = fixture(); const base = createClarificationDraftStore(); const key = clarificationDraftKey(question()); base.answer(key, 'Saved draft');
  const { container, controller } = f.mount(); await ready(container); await controller.refresh();
  f.services.clarificationCommands.pending.mockRejectedValueOnce(new Error('Journal unavailable'));
  container.querySelector<HTMLButtonElement>('[data-remove-draft]')!.click();
  await vi.waitFor(() => expect(container.textContent).toContain('saved state cannot be removed'));
  expect(base.read().answers[key]).toBe('Saved draft');
  f.data.pending = [{ command: { version: 1, requestId: uuid, repo: 'org/app', runId: 'run-1', questionId: 'question-1', expectedAttempt: 1, expectedChannelId: uuid, expectedQuestionRevision: 1, answer: 'Original' }, receipt: null }];
  await controller.refresh(); expect(container.querySelector<HTMLButtonElement>('[data-remove-draft]')?.disabled).toBe(true);
  expect(f.data.pending).toHaveLength(1);
});
it.each([
  ['answer', 'same-tab'], ['answer', 'other-tab'], ['answer', 'unsaved'],
  ['contact', 'same-tab'], ['contact', 'other-tab'], ['contact', 'unsaved'],
] as const)('retains newer %s edits from %s while cleanup checks journals', async (kind, writer) => {
  const f = fixture(); const base = createClarificationDraftStore(); const key = clarificationDraftKey(question());
  base.answer(key, 'Original'); base.contact({ name: 'Original', address: 'account', enabled: true });
  const { container, controller } = f.mount(writer === 'unsaved' ? { drafts: { ...base,
    answer(key, value) { if (value === 'Newer edit') throw new Error('Draft quota'); base.answer(key, value); },
    contact(value) { if (value.name === 'Newer edit') throw new Error('Draft quota'); base.contact(value); },
  } } : {}); await controller.refresh(); await ready(container);
  const wait = deferred<ClarificationCommandPendingV1[]>(); f.services.clarificationCommands.pending.mockReturnValueOnce(wait.promise);
  container.querySelector<HTMLButtonElement>(kind === 'answer' ? '[data-remove-draft]' : '[data-remove-contact-draft]')!.click();
  if (writer === 'other-tab') {
    const other = createClarificationDraftStore();
    if (kind === 'answer') other.answer(key, 'Newer edit');
    else other.contact({ name: 'Newer edit', address: 'account', enabled: true });
  } else if (kind === 'answer') draft(container, 'Newer edit');
  else {
    const input = container.querySelector<HTMLInputElement>('.trusted-contact-form [name="name"]')!;
    input.value = 'Newer edit'; input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  wait.resolve([]);
  await vi.waitFor(() => expect(container.textContent).toContain('Saved draft changed'));
  expect(kind === 'answer' ? base.read().answers[key] : base.read().contact.name).toBe(writer === 'unsaved' ? 'Original' : 'Newer edit');
  if (writer !== 'other-tab') expect(container.querySelector<HTMLInputElement | HTMLTextAreaElement>(kind === 'answer' ? 'textarea' : '.trusted-contact-form [name="name"]')?.value).toBe('Newer edit');
  expect(f.services.clarificationCommands.acknowledge).not.toHaveBeenCalled();
});
it.each(['answer', 'contact'] as const)('discards only a preexisting unsaved %s edit and retains newer persisted content for review', async kind => {
  const f = fixture(); const base = createClarificationDraftStore(); const key = clarificationDraftKey(question());
  base.answer(key, 'Original'); base.contact({ name: 'Original', address: 'account', enabled: true });
  const { container, controller } = f.mount({ drafts: { ...base,
    answer(key, value) { if (value === 'Unsent local edit') throw new Error('Draft quota'); base.answer(key, value); },
    contact(value) { if (value.name === 'Unsent local edit') throw new Error('Draft quota'); base.contact(value); },
  } }); await controller.refresh(); await ready(container);
  const selector = kind === 'answer' ? 'textarea' : '.trusted-contact-form [name="name"]';
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  input.value = 'Unsent local edit'; input.dispatchEvent(new Event('input', { bubbles: true }));
  const other = createClarificationDraftStore();
  if (kind === 'answer') other.answer(key, 'Other tab saved edit');
  else other.contact({ name: 'Other tab saved edit', address: 'account', enabled: true });
  const cleanup = kind === 'answer' ? '[data-remove-draft]' : '[data-remove-contact-draft]';
  container.querySelector<HTMLButtonElement>(cleanup)!.click();
  await vi.waitFor(() => expect(container.textContent).toContain('Unsent local draft discarded'));
  expect(kind === 'answer' ? base.read().answers[key] : base.read().contact.name).toBe('Other tab saved edit');
  expect(container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value).toBe('Other tab saved edit');
  container.querySelector<HTMLButtonElement>(cleanup)!.click();
  await vi.waitFor(() => expect(container.textContent).toContain('Saved browser state removed'));
  expect(kind === 'answer' ? base.read().answers[key] : base.read().contact.name).toBe(kind === 'answer' ? undefined : '');
  expect(f.services.clarificationCommands.acknowledge).not.toHaveBeenCalled();
});
