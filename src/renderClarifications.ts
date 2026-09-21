import type { ClarificationReadItemV1 as Clarification } from './plugins/clarification-read';
import type { SuggestedContactAdminContactV1 as TrustedContact } from './plugins/suggested-contact-admin';
import type { ClarificationCommandPendingV1 } from './plugins/clarification-command';
import type { SuggestedContactAdminPendingV1 } from './plugins/suggested-contact-admin';
export { mountClarifications } from './clarification-controller';
import { escapeHtml as esc } from './logic/html';
import { routeHref } from './logic/routes';
import { RUN_VIEWER_PAGE_SLOT } from './plugins/page-slots';
import { term } from './logic/terminology';
import './clarifications.css';

export interface QuestionViewState {
  storageError?: string | null;
  pending?: readonly ClarificationCommandPendingV1[];
  contactPending?: readonly SuggestedContactAdminPendingV1[];
  moreQuestions?: boolean;
  moreContacts?: boolean;
  results?: readonly { requestId: string; message: string; protected: boolean }[];
  drafts?: readonly { key: string; label: string; text: string; protected: boolean }[];
  contactDraft?: { text: string; protected: boolean } | null;
  loading?: boolean;
  contactError?: string | null;
  notice?: string | null;
}

function deadline(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `<span>Answer by <time datetime="${esc(value)}">${esc(date.toLocaleString())}</time></span>`;
}

function questionCard(item: Clarification, contacts: TrustedContact[], scope: string | null): string {
  const pending = item.answerability.available && item.state === 'pending';
  const owner = contacts.find(contact => contact.id === item.contactId);
  const state = item.state === 'answered' ? 'Answered' : item.state === 'timed-out' ? 'Deadline passed' : item.state === 'cancelled' ? 'Closed' : item.required ? 'Answer required' : 'Optional answer';
  return `<article class="clarification-card" data-question="${esc(item.id)}">
    <div class="clarification-meta"><span class="clarification-state">${state}</span><span>${esc(item.repo)}</span><a class="app-link" href="${esc(routeHref({ view: 'plugin', pluginSlot: RUN_VIEWER_PAGE_SLOT, repo: scope, runRepo: item.repo, run: item.runId }))}">View ${term('run').toLowerCase()} ${esc(item.runId)}</a></div>
    <h3>${esc(item.prompt)}</h3>
    ${item.blocksPublication ? '<p class="clarification-help">This required question remains a publication blocker until answered.</p>' : ''}
    ${pending ? `<p class="clarification-help">${item.required ? 'The agent needs your answer before it can finish or publish its work.' : 'Answer if you have useful context. This question does not block completion.'}</p>
      <div class="clarification-meta">${deadline(item.timeoutAt)}${owner ? `<span>Suggested respondent: ${esc(owner.name)}</span>` : ''}</div>
      <form data-answer="${esc(item.id)}"><label>Your answer<textarea name="answer" required maxlength="4000" rows="3"></textarea></label><div class="clarification-actions"><button type="submit">Accept answer</button><span class="clarification-form-error" role="alert"></span></div></form>`
      : `${item.answer ? `<p class="clarification-answer"><strong>Your answer</strong>${esc(item.answer)}</p>` : `<p class="clarification-help">${item.state === 'pending' && !item.answerability.available ? `Answer unavailable: ${item.answerability.reason}.` : item.state === 'timed-out' ? 'The deadline passed without an answer. Open the run to check its status.' : 'This question is closed and no longer accepts answers.'}</p>`}`}
  </article>`;
}

export function renderClarifications(items: Clarification[], contacts: TrustedContact[], repo: string | null, error: string | null, state: QuestionViewState = {}): string {
  const pending = items.filter(item => item.state === 'pending');
  const history = items.filter(item => item.state !== 'pending');
  return `<div class="clarification-page">
    <header class="clarification-heading"><div><h1>${term('clarifications')}</h1><p>When an agent needs a decision from you, its question appears here. An accepted answer is saved for the agent; worker consumption is not confirmed.</p></div><button type="button" data-refresh-questions>Refresh questions</button></header>
    <p class="clarification-help">This page is for answering agents. To give an agent a new task, <a class="app-link" href="${esc(routeHref({ view: 'dashboard', repo, pane: 'newrun' }))}">start a ${term('run').toLowerCase()}</a>.</p>
    ${state.storageError ? `<p role="alert" class="clarification-error">Draft or result storage unavailable: ${esc(state.storageError)}. Unresolved requests are retained.</p>` : ''}
    ${pendingRows(state)}
    ${state.notice ? `<p role="status" class="clarification-notice">${esc(state.notice)}</p>` : ''}
    ${error ? `<p role="alert" class="clarification-error">Could not refresh questions. ${esc(error)} Use “Refresh questions” to try again.</p>` : ''}
    <section class="clarification-list" aria-labelledby="pending-questions"><div class="clarification-section-heading"><h2 id="pending-questions">Questions awaiting your answer${pending.length ? ` (${pending.length})` : ''}</h2><span class="clarification-meta">${esc(repo ?? term('allRepositories'))}</span></div>
      ${pending.map(item => questionCard(item, contacts, repo)).join('') || (state.loading ? '<p role="status">Loading questions…</p>' : error ? '<p class="clarification-help">Questions could not be loaded.</p>' : `<div class="clarification-empty"><h3>${state.moreQuestions ? 'No pending questions in the loaded page' : 'No pending questions in this scope'}</h3><p>Questions from agents in this scope will appear here. No contact setup is needed.</p></div>`)}
    </section>
    ${history.length ? `<details class="clarification-history"><summary>Answered and closed questions (${history.length})</summary>${history.map(item => questionCard(item, contacts, repo)).join('')}</details>` : ''}
    ${state.results?.length || state.drafts?.length || state.contactDraft ? `<details class="clarification-saved"><summary>Saved drafts and results</summary><p>Free browser storage by explicitly discarding drafts or dismissing saved results. Items associated with unresolved submissions remain protected.</p>
      ${(state.drafts ?? []).map(draft => `<article><p><strong>${esc(draft.label)}</strong> · ${esc(draft.text.slice(0, 120))}</p><button type="button" data-remove-draft="${esc(draft.key)}" ${draft.protected ? 'data-protected disabled' : ''}>Discard this saved draft</button></article>`).join('')}
      ${state.contactDraft ? `<article><p><strong>Global contact draft</strong> · ${esc(state.contactDraft.text.slice(0, 120))}</p><button type="button" data-remove-contact-draft ${state.contactDraft.protected ? 'data-protected disabled' : ''}>Discard global contact draft</button></article>` : ''}
      ${(state.results ?? []).map(result => `<article><p>${esc(result.message)}</p><button type="button" data-remove-result="${esc(result.requestId)}" ${result.protected ? 'data-protected disabled' : ''}>Dismiss saved result</button></article>`).join('')}
    </details>` : ''}
    ${state.moreQuestions ? '<button type="button" data-more-questions>Load more questions</button>' : ''}
    <details class="clarification-settings" data-contact-settings><summary>Optional contact settings</summary><h2>Suggested respondents · Global</h2><p>You can answer questions without adding contacts. These entries help assign a question to a person, such as the Jira assignee or reporter. Helmsman does not message or notify them.</p>
      ${state.contactError ? `<p role="alert" class="clarification-error">Contacts could not be loaded. You can still answer questions. ${esc(state.contactError)}</p>` : ''}
      <form class="trusted-contact-form"><label>Name<input name="name" required maxlength="160" autocomplete="name"></label><label>Jira account ID or address<input name="address" required maxlength="320"><span class="clarification-help">Use a Jira account ID to match an assignee or reporter automatically.</span></label><label><input name="enabled" type="checkbox" checked> Available as a suggested respondent</label><div class="clarification-actions"><button type="submit">Save contact</button><span class="clarification-form-error" role="alert"></span></div></form>
      ${state.moreContacts ? '<button type="button" data-more-contacts>Load more contacts</button>' : ''}
      <ul class="clarification-contacts">${contacts.map(contact => `<li><strong>${esc(contact.name)}</strong> · ${esc(contact.address)} · ${contact.enabled ? 'available' : 'disabled'}</li>`).join('') || '<li>No contacts added. You can answer questions yourself.</li>'}</ul>
    </details>
  </div>`;
}


function pendingRows(state: QuestionViewState): string {
  const answers = (state.pending ?? []).map(entry => ({ id: entry.command.requestId, kind: 'answer', label: `Answer for ${entry.command.questionId}`, receipt: entry.receipt, preview: entry.command.answer }));
  const contacts = (state.contactPending ?? []).map(entry => ({ id: entry.command.requestId, kind: 'contact', label: `Contact ${entry.command.name}`, receipt: entry.receipt, preview: entry.command.address }));
  const entries = [...answers, ...contacts];
  return entries.length ? `<section class="clarification-pending"><h2>Unresolved submissions</h2><p>Keep editing drafts separately. Checking a receipt does not submit again; retry uses the original saved input.</p>${entries.map(entry => `<article class="clarification-card"><h3>${esc(entry.label)}</h3><p>${esc(entry.preview)}</p><p>${entry.receipt ? entry.receipt.status === 'succeeded' ? 'Durably accepted. Save this result to finish.' : `Rejected: ${esc(entry.receipt.reason ?? 'unavailable')}. Save this result before submitting changed input.` : 'The outcome is unknown. The original request is retained.'}</p><div class="clarification-actions" data-pending-kind="${entry.kind}" data-request="${esc(entry.id)}">${entry.receipt ? '<button type="button" data-pending-action="acknowledge">Save result</button>' : '<button type="button" data-pending-action="check">Check receipt</button><button type="button" data-pending-action="retry">Retry original submission</button>'}</div></article>`).join('')}</section>` : '';
}
