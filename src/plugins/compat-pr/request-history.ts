import { esc, prIcon, type Identity } from './render.js';
import type { SavedPrResult } from './storage.js';

function renderResult(result: SavedPrResult, selected: Identity): string {
  const accepted = result.kind === 'run' && result.status === 'accepted';
  const published = result.kind === 'review' && result.status === 'succeeded';
  const rejected = result.status === 'rejected';
  const label = accepted ? 'Request accepted' : published ? 'Review submitted' : rejected ? 'Request rejected' : 'Result unavailable';
  const title = result.kind === 'review' ? 'GitHub review' : result.mode === 'review' ? 'Agent review' : result.mode === 'rerun' ? 'PR update' : 'Run request';
  const action = result.event === 'APPROVE' ? 'Approve' : result.event === 'REQUEST_CHANGES' ? 'Request changes' : result.event === 'COMMENT' ? 'Comment' : '';
  const tone = accepted ? 'review' : published ? 'good' : rejected ? 'bad' : 'neutral';
  const date = result.savedAt !== null && Number.isFinite(new Date(result.savedAt).getTime()) ? new Date(result.savedAt).toISOString() : null;
  const ownershipConflict = rejected && result.message?.startsWith('Execution resources remain owned by ');
  const explanation = accepted ? 'Accepted for processing. Open the run for progress and its final result.' : published ? `Submitted to GitHub${result.actor ? ` by ${result.actor}` : ''}.` : ownershipConflict ? 'Another run still owned this branch or workspace when this request was sent.' : rejected ? 'This request was refused. Expand details for the saved reason.' : 'The saved receipt does not report a recognized final result.';
  const details = result.message || result.runId || action ? `<details class="pr-request-evidence" data-pr-disclosure="${esc(`${selected.repo}:${selected.number}:request-evidence:${result.id}`)}"><summary>${prIcon('caretRight')}Request details</summary>${result.message ? `<p>${esc(result.message)}</p>` : ''}${action ? `<p>Review action: ${esc(action)}</p>` : ''}${result.runId ? `<p>Run ID: <code>${esc(result.runId)}</code></p>` : ''}</details>` : '';
  return `<li class="pr-saved-result"><div class="pr-request-row"><strong>${prIcon(result.kind === 'review' ? 'review' : 'agent')}${title}</strong><span class="pr-request-status" data-tone="${tone}">${prIcon(accepted ? 'queued' : published ? 'good' : rejected ? 'bad' : 'clock')}${label}</span>${date ? `<time datetime="${date}" title="${date}">${esc(new Date(date).toLocaleString())}</time>` : '<span class="pr-request-date">Date unavailable</span>'}</div><p class="pr-request-explanation">${esc(explanation)}</p>${accepted && result.runId ? `<button class="pr-request-open" data-run="${esc(result.runId)}" data-history-entry="${esc(result.id)}" data-repo="${esc(selected.repo)}">${prIcon('inspect')}Open run</button>` : ''}${details}</li>`;
}

export function renderRequestHistory(results: SavedPrResult[], selected: Identity): string {
  if (!results.length) return '';
  return `<details class="pr-subpanel pr-request-history" data-pr-disclosure="${esc(`${selected.repo}:${selected.number}:request-history`)}"><summary>${prIcon('caretRight')}<span>${prIcon('history')}Request history</span><span class="pr-list-count">${results.length}</span></summary><div class="pr-request-body"><p class="empty-note">Saved acknowledgments for this PR in this browser. These describe requests, not current run status or review recommendations.</p><ul class="pr-request-list">${results.map(result => renderResult(result, selected)).join('')}</ul></div></details>`;
}
