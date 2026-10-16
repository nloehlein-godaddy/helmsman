import { createAgentPromptEditorV1 } from '@helmsman/plugin-sdk';
import type { AgentPromptEditorV1, PluginPageModule } from '@helmsman/plugin-sdk';
import { flows, roles, type FlowId, type RoleId } from './content.js';
import { styles } from './styles.js';

const paths = {
  person: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  helm: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v8m0 4v8M2 12h8m4 0h8M5 5l5 5m4 4 5 5M5 19l5-5m4-4 5-5"/>',
  agents: '<circle cx="8" cy="7" r="3"/><path d="M2 21v-3a6 6 0 0 1 12 0v3m2-17a3 3 0 0 1 0 6m2 4a6 6 0 0 1 4 5v2"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
  review: '<path d="M10 3H4v18h16V9l-6-6h-4m4 0v6h6M8 14h8m-8 4h5"/>',
  fix: '<path d="m14 6 4-4a6 6 0 0 1-7 8L3 18a2 2 0 0 0 3 3l8-8a6 6 0 0 0 8-7l-4 4-4-4Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  loop: '<path d="M4 8a8 8 0 1 1 0 9m0-15v6h6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  board: '<path d="M3 3h18v14H3zm9 14v5m-5 0h10M7 12l3-3 3 2 4-5"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 7 7"/>',
  edit: '<path d="m15 4 5 5M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16l-1 4Z"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
} as const;
const icon = (name: keyof typeof paths, className = '') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
const roleIcon = (id: RoleId) => id === 'coding.implement' || id === 'branch.author' ? 'code' : id === 'coding.fix' ? 'fix' : 'review';

const focusedReviewers = '<section class="overview-specialists"><h3>Focused read-only reviewers</h3><ul><li>Logic & state</li><li>Requirements & tests</li><li>UX & accessibility</li><li>External effects</li></ul><p>Applicable checks are delegated. These reviewers report to the lead; they cannot edit, publish, delegate further, or decide the final verdict.</p></section>';

const page: PluginPageModule = { mount(container, context) {
  let state = context.state;
  let flow: FlowId = 'coding';
  let selected: RoleId = 'coding.implement';
  let disposed = false;
  let modal: { dialog: HTMLDialogElement; editor: AgentPromptEditorV1; controller: AbortController } | null = null;
  const detailId = `agent-role-${crypto.randomUUID()}`;
  const scope = () => state.repo ? `?repo=${encodeURIComponent(state.repo)}` : '';
  function paintDetail() {
    const detail = container.querySelector<HTMLElement>('[data-role-detail]');
    if (!detail) return;
    const role = roles[selected];
    detail.innerHTML = `<div class="overview-detail-header"><h3>${role.title}</h3><button type="button" class="overview-edit-prompt" data-edit-prompt${context.services?.agentPrompts?.version === 1 ? '' : ' disabled title="Prompt settings are unavailable"'}>${icon('edit')}Edit prompt</button></div><p>${role.job}</p><dl><div><dt>Starts with</dt><dd>${role.input}</dd></div><div><dt>Produces</dt><dd>${role.output}</dd></div><div><dt>What happens next</dt><dd>${role.handoff}</dd></div></dl>`;
    for (const button of container.querySelectorAll<HTMLButtonElement>('[data-role]')) button.setAttribute('aria-pressed', String(button.dataset.role === selected));
  }
  function closePrompt(restoreFocus = true) {
    const current = modal;
    if (!current) return;
    modal = null;
    current.controller.abort(); current.editor.dispose(); current.dialog.close(); current.dialog.remove();
    if (restoreFocus && !disposed && state.visible) container.querySelector<HTMLButtonElement>('[data-edit-prompt]')?.focus({ preventScroll: true });
  }
  function editPrompt() {
    const service = context.services?.agentPrompts;
    if (modal || service?.version !== 1) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'overview-prompt-dialog';
    const titleId = `${detailId}-prompt-title`;
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.innerHTML = `<header class="overview-prompt-header"><h2 id="${titleId}">Edit ${roles[selected].title} prompt</h2><div><button type="button" data-refresh-prompt title="Refresh prompt" aria-label="Refresh prompt">${icon('refresh')}</button><button type="button" data-close-prompt title="Close prompt editor" aria-label="Close prompt editor" autofocus>${icon('close')}</button></div></header><div class="overview-prompt-body" data-prompt-editor></div>`;
    const host = dialog.querySelector<HTMLElement>('[data-prompt-editor]');
    if (!host) return;
    const controller = new AbortController();
    const editor = createAgentPromptEditorV1(host, { service, signal: AbortSignal.any([context.signal, controller.signal]), contributionId: context.contributionId ?? 'helmsman.agents-overview/page', instanceId: 'role-prompt', fixedRoleId: selected, state: { active: state.visible, pirateMode: state.pirateMode, signal: controller.signal } });
    modal = { dialog, editor, controller };
    dialog.querySelector('[data-close-prompt]')?.addEventListener('click', () => closePrompt());
    dialog.querySelector('[data-refresh-prompt]')?.addEventListener('click', () => { void editor.refresh(); });
    dialog.addEventListener('close', () => closePrompt());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePrompt();
    });
    container.append(dialog); dialog.showModal();
  }
  function paintFlow() {
    const map = container.querySelector<HTMLElement>('[data-flow-map]');
    if (!map) return;
    const current = flows[flow];
    const description = container.querySelector('[data-flow-description]');
    if (description) description.textContent = current.description;
    for (const button of container.querySelectorAll<HTMLButtonElement>('[data-flow]')) button.setAttribute('aria-pressed', String(button.dataset.flow === flow));
    map.innerHTML = `<div class="overview-route"><ol class="overview-stages" aria-label="${current.title} roles">${current.stages.map(id => `<li>${id === 'coding.fix' ? '<p class="overview-condition">When changes are requested</p>' : ''}<button type="button" class="overview-role" data-role="${id}" aria-pressed="${id === selected}" aria-controls="${detailId}">${icon(roleIcon(id))}<span><strong>${roles[id].title}</strong><small>${roles[id].summary}</small></span>${icon('chevron', 'overview-chevron')}</button>${id === 'coding.review' || id === 'review.pull-request' ? focusedReviewers : ''}</li>`).join('')}</ol>

      <p class="overview-loop">${icon('loop')}<span>${current.loop}</span></p><p class="overview-outcome">${icon('check')}<strong>${current.outcome}</strong></p></div><section class="overview-role-detail" id="${detailId}" data-role-detail aria-label="Selected agent role" aria-live="polite"></section>`;
    paintDetail();
  }
  function paint() {
    if (disposed) return;
    container.innerHTML = `<article class="agents-overview"><style>${styles}</style>
      <header class="overview-intro"><h1>Agents overview</h1><p>See who directs the work and how agents hand it off in Helmsman’s built-in workflows.</p></header>
      <ol class="overview-layers" aria-label="Agent hierarchy"><li>${icon('person')}<strong>You · operator</strong><p>Set the goal, answer questions, and decide what merges.</p></li><li>${icon('helm')}<strong>Helmsman · coordinator</strong><p>Schedules roles, enforces completion gates, and manages publication.</p></li><li>${icon('agents')}<strong>Agents · role sessions</strong><p>Perform the assigned job. Separate sessions can take the same role.</p></li></ol>
      <section class="overview-workflows" aria-labelledby="${detailId}-workflows"><h2 id="${detailId}-workflows">Follow the work</h2><div class="overview-flow-picker" role="group" aria-label="Workflow">${Object.entries(flows).map(([id, value]) => `<button type="button" data-flow="${id}" aria-pressed="${id === flow}">${value.title}</button>`).join('')}</div><p class="overview-flow-description" data-flow-description></p><div class="overview-map" data-flow-map></div></section>
      <section class="overview-support" aria-labelledby="${detailId}-helpers"><h2 id="${detailId}-helpers">Alongside the workflows</h2><div class="overview-helper">${icon('board')}<h3>Whiteboard explainer</h3><p>Turns a pinned change into an explanation and diagram using the supplied diff and metadata. It helps you understand the change.</p></div><div class="overview-helper">${icon('search')}<h3>Postmortem investigator</h3><p>Diagnoses a recorded run using logs and execution evidence. It can propose patch files for your review, without applying or publishing them.</p></div></section>
      <section class="overview-settings" aria-labelledby="${detailId}-settings"><h2 id="${detailId}-settings">Roles and models are separate choices</h2><p>Agent plugins such as Codex and Claude Code supply the execution engine. The model and reasoning level determine how a session runs; its role determines the job. Enabled workflow plugins can replace or extend this built-in map.</p><p>Role prompt defaults apply to new sessions. Existing sessions keep their captured instructions and settings.</p><nav class="overview-links" aria-label="Agent settings"><a data-overview-link href="/agent-prompts${scope()}">Edit agent prompts</a><a data-overview-link href="/execution-settings${scope()}">Execution settings</a><a data-overview-link href="/config?pane=plugins${state.repo ? `&repo=${encodeURIComponent(state.repo)}` : ''}">Manage plugins</a></nav></section>
    </article>`;
    paintFlow();
  }
  function click(event: MouseEvent) {
    if (!(event.target instanceof Element) || disposed || context.signal.aborted || !state.visible) return;
    const button = event.target.closest<HTMLButtonElement>('button');
    if (button?.hasAttribute('data-edit-prompt') && !button.disabled) editPrompt();
    else if (button?.dataset.flow && Object.hasOwn(flows, button.dataset.flow)) {
      flow = button.dataset.flow as FlowId;
      selected = flows[flow].stages[0] ?? 'coding.implement';
      paintFlow();
    } else if (button?.dataset.role && Object.hasOwn(roles, button.dataset.role)) {
      selected = button.dataset.role as RoleId;
      paintDetail();
    }
    const link = event.target.closest<HTMLAnchorElement>('a[data-overview-link]');
    if (link && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault(); context.navigate(link.getAttribute('href') ?? '/config');
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; closePrompt(false); container.removeEventListener('click', click); context.signal.removeEventListener('abort', dispose); container.replaceChildren();
  }
  container.addEventListener('click', click);
  context.onDispose(dispose); context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose(); else paint();
  return { update(next) { const changed = state.repo !== next.repo; state = next; if (changed || !state.visible) closePrompt(false); else if (modal) modal.editor.update({ active: state.visible, pirateMode: state.pirateMode, signal: modal.controller.signal }); if (changed) paint(); }, dispose };
} };
export default page;
