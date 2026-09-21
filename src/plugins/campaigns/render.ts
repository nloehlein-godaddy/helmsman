import type { CampaignDetail, CampaignList, CampaignPreview } from '@helmsman/plugin-sdk';
import { esc } from './state.js';
export interface CampaignsViewState {
  pirateMode: boolean;
  repo: string | null;
  list: CampaignList;
  detail: CampaignDetail | null;
  preview: CampaignPreview | null;
  busy: boolean;
  error: string | null;
  name: string;
  phaseName: string;
  concurrency: string;
  workflowRef: string;
  imports: Record<string, { format: string; content: string }>;
  confirming: { phaseId: string; action: 'finish' | 'stop' } | null;
}

const phaseActionLabels: Record<string, string> = { start: 'Start phase', pause: 'Pause new tasks', resume: 'Resume phase', finish: 'Finish phase…', stop: 'Stop all tasks…' };
const phaseHelp: Record<string, string> = { draft: 'Import and confirm tasks, then start this phase when earlier phases are finished.', running: 'Queued tasks start as capacity becomes available. Pausing keeps active tasks running.', paused: 'No new tasks will start. Active tasks can finish; resume when ready.', completed: 'All tasks have finished. You can retry failed tasks before moving on.', finished: 'Queued tasks were cancelled. Any active tasks can finish.', stopped: 'This phase is closed. Queued tasks were cancelled and active tasks were asked to stop.' };
const label = (value: string): string => value.replaceAll('-', ' ').replace(/^./, letter => letter.toUpperCase());
export function renderCampaigns(state: CampaignsViewState): string {
  const term = (value: string) => value === 'repository' ? state.pirateMode ? 'Galleon' : 'Repository' : value === 'repositories' ? state.pirateMode ? 'Galleons' : 'Repositories' : state.pirateMode ? 'Voyage' : 'Run';
  const selected = state.detail?.campaign;
  const disabled = state.busy ? ' disabled' : '';
  const preview = state.preview;
  const list = state.list?.campaigns ?? [];
  const workflows = state.list?.workflows ?? [];
  return `<div class="campaign-page"><h2>Campaigns</h2><p>Run a batch of tasks in stages: create a campaign, add a phase, then import and preview its tasks. Each ${term('repository').toLowerCase()} runs one coding task at a time.</p>
    ${state.error ? `<p class="campaign-error" role="alert">${esc(state.error)}</p>` : ''}
    ${state.busy ? '<p role="status">Updating campaigns…</p>' : ''}
    <div class="campaign-layout"><section class="panel campaign-panel"><h2>New campaign</h2>
      ${!state.repo ? `<p>Select a ${term('repository').toLowerCase()} in the header to create a campaign.</p>` : `<p>${esc(state.repo)}</p>`}
      <form data-campaign-create><fieldset${state.busy || !state.repo || !workflows.length ? ' disabled' : ''}>
        <label>Campaign name<input name="name" required maxlength="120" value="${esc(state.name)}"></label>
        <details class="campaign-settings"><summary>Execution settings</summary><div><label>Task workflow<select name="workflowRef">${workflows.map(workflow => `<option value="${esc(workflow.ref)}"${workflow.ref === state.workflowRef ? ' selected' : ''}>${esc(workflow.name)}</option>`).join('')}</select></label>
        <label>Maximum active tasks<input name="concurrency" type="number" min="1" max="20" required value="${esc(state.concurrency)}"></label><p class="campaign-hint">Tasks in different ${term('repositories').toLowerCase()} can run together, up to this limit. Each ${term('repository').toLowerCase()} still runs one coding task at a time.</p></div></details>
        <button class="campaign-primary" type="submit">Create campaign</button></fieldset></form>
      <h2>Saved campaigns</h2><button type="button" data-campaign-refresh${disabled}>Refresh</button>
      <ul class="campaign-list">${list.map(campaign => `<li><button type="button" data-campaign-select="${esc(campaign.id)}" aria-pressed="${campaign.id === selected?.id}"${disabled}>${esc(campaign.name)}</button><small>${esc(campaign.repo)}</small></li>`).join('') || `<li class="campaign-hint">${state.error ? 'Campaigns could not be loaded. Try Refresh.' : 'No campaigns yet. Create one to organize a batch of tasks.'}</li>`}</ul></section>
      <section class="campaign-detail" aria-busy="${state.busy}">${selected ? `<h2>${esc(selected.name)}</h2><p>Up to ${selected.concurrency} active task${selected.concurrency === 1 ? '' : 's'} across this campaign.</p><details class="campaign-settings"><summary>Workflow details</summary><p>${esc(selected.workflowRef)}</p></details>
      <form data-campaign-phase-create="${esc(selected.id)}"><fieldset${disabled}><label>New phase<input name="phaseName" required maxlength="120" value="${esc(state.phaseName)}" placeholder="For example, a small pilot"></label><button type="submit">Add phase</button></fieldset></form>
      ${(state.detail?.phases ?? []).map(({ phase, tasks }) => {
        const editable = phase.state === 'draft' || phase.state === 'paused';
        const draft = state.imports[phase.id] ?? { format: 'jsonl', content: '' };
        const controls = phase.state === 'draft' ? ['start', 'finish', 'stop'] : phase.state === 'running' ? ['pause', 'finish', 'stop'] : phase.state === 'paused' ? ['resume', 'finish', 'stop'] : [];
        return `<section class="panel campaign-panel"><h3>${phase.position + 1}. ${esc(phase.name)} <span class="campaign-state">${esc(label(phase.state))}</span></h3>
          <p class="campaign-hint">${esc(phaseHelp[phase.state] ?? '')}</p><div class="campaign-actions">${controls.map(action => `<button type="button" class="${['start', 'resume'].includes(action) ? 'campaign-primary' : action === 'stop' ? 'campaign-destructive' : ''}" data-campaign-action="${action}" data-phase-id="${esc(phase.id)}"${state.busy || action === 'start' && !tasks.length ? ' disabled' : ''}>${phaseActionLabels[action] ?? label(action)}</button>`).join('')}</div>
          ${state.confirming?.phaseId === phase.id ? `<div class="campaign-confirm" role="status"><p>${state.confirming.action === 'stop' ? 'Stop active tasks and cancel all queued tasks in this phase.' : 'Cancel queued tasks and let active tasks finish.'}</p><button type="button" data-campaign-confirm-action${disabled}>${state.confirming.action === 'stop' ? 'Stop all tasks' : 'Cancel queued tasks and finish'}</button><button type="button" data-campaign-dismiss${disabled}>Keep phase unchanged</button></div>` : ''}
          ${editable ? `<form data-campaign-import="${esc(phase.id)}"><fieldset${disabled}><label>Import format<select name="format" data-phase-id="${esc(phase.id)}"><option value="jsonl"${draft.format === 'jsonl' ? ' selected' : ''}>JSONL</option><option value="csv"${draft.format === 'csv' ? ' selected' : ''}>CSV</option></select></label>
            <label>Upload a file<input type="file" accept=".csv,.jsonl,.ndjson,text/csv,application/json" data-campaign-file="${esc(phase.id)}"></label>
            <label>Task data<textarea name="content" data-phase-id="${esc(phase.id)}" rows="5" required maxlength="1000000" placeholder='{"task":"Describe one concrete task"}'>${esc(draft.content)}</textarea></label>
            <details class="campaign-settings"><summary>File format and limits</summary><p class="campaign-hint">Up to 200 tasks / 1 MB. JSONL: one JSON object per line. CSV: a header row followed by one task per row. Include task or ticketId; key, title, and repo are optional. An explicit repo sends that task to a different ${term('repository').toLowerCase()}; check each destination in the preview.</p></details><button class="campaign-primary" type="submit">Preview tasks</button></fieldset></form>` : ''}
          ${preview?.phaseId === phase.id ? `<div class="campaign-preview"><h4>Review imported tasks</h4><p>${preview.records.length} unique records · ${preview.duplicateCount} duplicates will be skipped.</p><ol>${preview.records.map(record => `<li><strong>${esc(record.repo)}</strong> · ${esc(record.task ?? record.ticketId ?? '')}</li>`).join('')}</ol><p>Confirming queues these tasks. Start or resume the phase to launch them.</p><button type="button" data-campaign-confirm-import="${esc(preview.id)}"${disabled}>Add tasks to phase</button><button type="button" data-campaign-dismiss-preview${disabled}>Discard preview</button></div>` : ''}
          <div class="campaign-table-wrap" role="region" aria-label="Phase tasks" tabindex="0"><table><thead><tr><th>Task</th><th>${term('repository')}</th><th>State</th><th>Attempt</th><th>Action</th></tr></thead><tbody>${tasks.map(task => `<tr><td>${esc(task.record.title ?? task.record.ticketId ?? task.record.task ?? '')}${task.error ? `<small class="campaign-error">${esc(task.error)}</small>` : ''}</td><td>${esc(task.record.repo)}</td><td>${esc(label(task.state))}</td><td>${task.attempt}</td><td>${['running', 'succeeded', 'failed'].includes(task.state) ? `<button type="button" data-campaign-open-run="${esc(task.runId)}" data-run-repo="${esc(task.record.repo)}">Open ${term('run').toLowerCase()}</button>` : ''}${task.state === 'failed' && !['finished', 'stopped'].includes(phase.state) ? `<button type="button" data-campaign-retry="${esc(task.id)}"${disabled}>Retry failed task</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">No tasks imported yet.</td></tr>'}</tbody></table></div></section>`;
      }).join('') || '<p class="empty-note">Add your first phase above, then import the tasks it should run.</p>'}` : '<p class="empty-note">Create a campaign or select a saved one to organize its tasks. Creating a campaign does not start any work.</p>'}</section></div></div>`;
}

