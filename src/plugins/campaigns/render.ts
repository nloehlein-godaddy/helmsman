import type { CampaignDetail, CampaignList, CampaignPreview } from '@helmsman/plugin-sdk';
import { esc } from './state.js';
export interface CampaignsViewState {
  pirateMode: boolean;
  composed?: boolean;
  listLoaded?: boolean;
  scopeOverride?: boolean;
  scopeAvailable?: boolean;
  storageError?: boolean;
  unsupported?: boolean;
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

const glyphs = { campaign: '\ue466', phase: '\ue244', import: '\ue4c0', preview: '\ue220', start: '\ue3d2', pause: '\ue39e', resume: '\ue3d2', finish: '\ue184', stop: '\ue46c', refresh: '\ue094', save: '\ue248', tasks: '\ueadc', queued: '\ue19a', succeeded: '\ue184', failed: '\ue4e2', retry: '\ue036' } as const;
const icon = (name: keyof typeof glyphs) => `<span class="campaign-icon" aria-hidden="true">${glyphs[name]}</span>`;
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
  return `<div class="campaign-page">${state.composed ? '' : '<h2>Campaigns</h2>'}<p class="campaign-intro">Campaigns group tasks into ordered phases. Preview and import a phase’s tasks, then start it when ready. Each ${term('repository').toLowerCase()} runs one coding task at a time.</p><p class="campaign-error" role="alert" data-storage-error></p>
    ${state.error ? `<p class="campaign-error" role="alert">${esc(state.error)}</p>` : ''}
    ${state.busy ? '<p role="status">Updating campaigns…</p>' : ''}
    <div class="campaign-layout"><aside class="campaign-sidebar"><section class="campaign-create campaign-panel"><h3>${icon('campaign')}Create campaign</h3>
      ${!state.repo ? `<p class="campaign-hint">${state.scopeOverride && state.scopeAvailable ? `Use selected ${term('repository').toLowerCase()} to create a campaign.` : `Select a ${term('repository').toLowerCase()} in the header to create a campaign.`}</p>` : !workflows.length && state.listLoaded !== false && !state.error ? '<p class="campaign-hint">No task workflow is available in this scope.</p>' : ''}
      <form data-campaign-create><fieldset${state.busy || !state.repo || !workflows.length ? ' disabled' : ''}>
        <label>Campaign name<input name="name" required maxlength="120" value="${esc(state.name)}"></label>
        <details class="campaign-settings"><summary>Execution settings</summary><div><label>Task workflow<select name="workflowRef">${workflows.map(workflow => `<option value="${esc(workflow.ref)}"${workflow.ref === state.workflowRef ? ' selected' : ''}>${esc(workflow.name)}</option>`).join('')}</select></label>
        <label>Active task limit<input name="concurrency" type="number" min="1" max="20" required value="${esc(state.concurrency)}"></label><p class="campaign-hint">Tasks in different ${term('repositories').toLowerCase()} can run together, up to this limit. Each ${term('repository').toLowerCase()} still runs one coding task at a time.</p></div></details>
        <button class="campaign-primary" type="submit">${icon('campaign')}Create campaign</button><p class="campaign-hint">Creating a campaign does not start tasks.</p></fieldset></form><div class="campaign-drafts"><small data-draft-status>${state.unsupported ? 'Saved drafts are unavailable.' : state.storageError ? 'Drafts need saving.' : 'Drafts save locally as you type.'}</small><button type="button" class="campaign-icon-button" data-save-draft aria-label="Retry saving drafts" title="Retry saving drafts"${state.storageError ? '' : ' hidden'}${state.unsupported ? ' disabled' : ''}>${icon('save')}</button></div></section>
      <section class="campaign-saved campaign-panel"><div class="campaign-section-heading"><h3>${icon('campaign')}Saved campaigns</h3>${state.composed ? '' : `<button type="button" data-campaign-refresh${disabled}>${icon('refresh')}Refresh</button>`}</div><div class="campaign-scope">${state.scopeOverride && state.scopeAvailable ? `<button type="button" data-scope-inherit>Use selected ${term('repository').toLowerCase()}</button>` : ''}${state.scopeAvailable && state.repo !== null ? '<button type="button" data-scope-all>Show all campaigns</button>' : ''}${state.repo === null ? '<small>All campaigns</small>' : ''}</div>
      <ul class="campaign-list">${list.map(campaign => `<li><button type="button" data-campaign-select="${esc(campaign.id)}" aria-pressed="${campaign.id === selected?.id}"${disabled}>${esc(campaign.name)}</button>${state.repo === campaign.repo ? '' : `<small>${esc(campaign.repo)}</small>`}</li>`).join('') || `<li class="campaign-hint">${state.error ? 'Campaigns could not be loaded. Try Refresh.' : 'No campaigns yet. Create one to organize a batch of tasks.'}</li>`}</ul></section></aside>
      <section class="campaign-detail" aria-busy="${state.busy}">${selected ? `<div class="campaign-detail-heading"><h2>${icon('campaign')}${esc(selected.name)}</h2><p class="campaign-hint">Up to ${selected.concurrency} active task${selected.concurrency === 1 ? '' : 's'} across this campaign.</p></div><details class="campaign-settings"><summary>Workflow details</summary><p>${esc(selected.workflowRef)}</p></details>
      <form class="campaign-add-phase" data-campaign-phase-create="${esc(selected.id)}"><fieldset${disabled}><label>New phase<input name="phaseName" required maxlength="120" value="${esc(state.phaseName)}" placeholder="For example, a small pilot"></label><button type="submit">${icon('phase')}Add phase</button></fieldset></form>
      ${(state.detail?.phases ?? []).map(({ phase, tasks }) => {
        const editable = phase.state === 'draft' || phase.state === 'paused';
        const draft = state.imports[phase.id] ?? { format: 'jsonl', content: '' };
        const controls = phase.state === 'draft' ? ['start', 'finish', 'stop'] : phase.state === 'running' ? ['pause', 'finish', 'stop'] : phase.state === 'paused' ? ['resume', 'finish', 'stop'] : [];
        return `<section class="campaign-phase campaign-panel"><div class="campaign-phase-heading"><h3>${icon('phase')}${phase.position + 1}. ${esc(phase.name)}</h3><span class="campaign-state" data-state="${esc(phase.state)}">${esc(label(phase.state))}</span></div>
          <p class="campaign-hint">${esc(phaseHelp[phase.state] ?? '')}</p><div class="campaign-actions">${controls.map(action => `<button type="button" class="${['start', 'resume'].includes(action) ? 'campaign-primary' : action === 'stop' ? 'campaign-destructive' : ''}" data-campaign-action="${action}" data-phase-id="${esc(phase.id)}"${state.busy || action === 'start' && !tasks.length ? ' disabled' : ''}>${icon(action as 'start' | 'pause' | 'resume' | 'finish' | 'stop')}${phaseActionLabels[action] ?? label(action)}</button>`).join('')}</div>
          ${state.confirming?.phaseId === phase.id ? `<div class="campaign-confirm" role="status"><p>${state.confirming.action === 'stop' ? 'Stop active tasks and cancel all queued tasks in this phase.' : 'Cancel queued tasks and let active tasks finish.'}</p><button type="button" data-campaign-confirm-action${disabled}>${state.confirming.action === 'stop' ? 'Stop all tasks' : 'Cancel queued tasks and finish'}</button><button type="button" data-campaign-dismiss${disabled}>Keep phase unchanged</button></div>` : ''}
          ${editable ? `<form class="campaign-import" data-campaign-import="${esc(phase.id)}"><h4>${icon('import')}Import tasks</h4><fieldset${disabled}><label>Import format<select name="format" data-phase-id="${esc(phase.id)}"><option value="jsonl"${draft.format === 'jsonl' ? ' selected' : ''}>JSONL</option><option value="csv"${draft.format === 'csv' ? ' selected' : ''}>CSV</option></select></label>
            <label>Upload a file<input type="file" accept=".csv,.jsonl,.ndjson,text/csv,application/json" data-campaign-file="${esc(phase.id)}"></label>
            <label>Task data<textarea name="content" data-phase-id="${esc(phase.id)}" rows="5" required maxlength="1000000" placeholder='{"task":"Describe one concrete task"}'>${esc(draft.content)}</textarea></label>
            <details class="campaign-settings"><summary>File format and limits</summary><p class="campaign-hint">Up to 200 tasks / 1 MB. JSONL: one JSON object per line. CSV: a header row followed by one task per row. Include task or ticketId; key, title, and repo are optional. An explicit repo sends that task to a different ${term('repository').toLowerCase()}; check each destination in the preview.</p></details><button class="campaign-primary" type="submit">${icon('preview')}Preview tasks</button></fieldset></form>` : ''}
          ${preview?.phaseId === phase.id ? `<div class="campaign-preview"><h4>${icon('preview')}Check tasks before importing</h4><p>${preview.records.length} unique records · ${preview.duplicateCount} duplicates will be skipped.</p><ol>${preview.records.map(record => `<li><strong>${esc(record.repo)}</strong> · ${esc(record.task ?? record.ticketId ?? '')}</li>`).join('')}</ol><p>Confirming queues these tasks. Start or resume the phase to launch them.</p><button type="button" data-campaign-confirm-import="${esc(preview.id)}"${disabled}>${icon('import')}Import tasks</button><button type="button" data-campaign-dismiss-preview${disabled}>Discard preview</button></div>` : ''}
          <h4 class="campaign-tasks-heading">${icon('tasks')}Phase tasks <span class="campaign-state">${tasks.length}</span></h4><div class="campaign-table-wrap" role="region" aria-label="Phase tasks" tabindex="0"><table role="table" aria-label="${esc(phase.name)} tasks"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Task</th><th scope="col" role="columnheader">${term('repository')}</th><th scope="col" role="columnheader">State</th><th scope="col" role="columnheader">Attempt</th><th scope="col" role="columnheader">Action</th></tr></thead><tbody role="rowgroup">${tasks.map(task => `<tr role="row"><td role="cell" class="campaign-task-title">${esc(task.record.title ?? task.record.ticketId ?? task.record.task ?? '')}${task.error ? `<small class="campaign-error">${esc(task.error)}</small>` : ''}</td><td role="cell" class="campaign-task-repo" data-label="${term('repository')}">${esc(task.record.repo)}</td><td role="cell" data-label="State"><span class="campaign-task-state" data-state="${esc(task.state)}">${icon(task.state === 'running' ? 'start' : task.state === 'succeeded' ? 'succeeded' : task.state === 'failed' ? 'failed' : task.state === 'queued' || task.state === 'claiming' ? 'queued' : 'stop')}${esc(label(task.state))}</span></td><td role="cell" data-label="Attempt">${task.attempt}</td><td role="cell" class="campaign-task-actions" data-label="Action">${['running', 'succeeded', 'failed'].includes(task.state) ? `<button type="button" data-campaign-open-run="${esc(task.runId)}" data-run-repo="${esc(task.record.repo)}">${icon('start')}Open ${term('run').toLowerCase()}</button>` : ''}${task.state === 'failed' && !['finished', 'stopped'].includes(phase.state) ? `<button type="button" data-campaign-retry="${esc(task.id)}"${disabled}>${icon('retry')}Retry failed task</button>` : ''}</td></tr>`).join('') || '<tr role="row"><td role="cell" class="campaign-task-empty" colspan="5">No tasks imported yet.</td></tr>'}</tbody></table></div></section>`;
      }).join('') || '<p class="empty-note">Add your first phase above, then import the tasks it should run.</p>'}` : '<div class="campaign-empty"><h3>Build a batch in phases</h3><p>Create a campaign, then add a phase for your first group of tasks.</p><p class="campaign-hint">Preview checks the task data. Import adds queued tasks. Start phase launches queued tasks.</p></div>'}</section></div></div>`;
}

