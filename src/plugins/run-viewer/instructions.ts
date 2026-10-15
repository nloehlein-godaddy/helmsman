import type { PluginPanelState, RunInstructionPendingV1, RunInstructionQueryV1, RunInstructionServiceV1, RunInstructionSnapshotV1 } from '@helmsman/plugin-sdk';
import { icon } from './icons.js';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
export class RunInstructions {
  readonly element = node('section');
  private readonly editor = node('textarea');
  private readonly targets = node('select');
  private readonly send = node('button', 'Send instruction');
  private readonly status = node('p');
  private readonly statusText = node('span');
  private readonly agentField = node('label');
  private readonly editorField = node('label');
  private readonly editorLabel = node('span', 'Instruction');
  private readonly form = node('div');
  private readonly helper = node('p', 'Send a direction to an active agent without restarting the run.');
  private readonly historyHeading = node('h4', 'Saved instructions');
  private readonly history = node('div');
  private query: RunInstructionQueryV1 | null = null;
  private snapshot: RunInstructionSnapshotV1 | null = null;
  private pending: readonly RunInstructionPendingV1[] = [];
  private controller = new AbortController();
  private activity: AbortSignal | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private loaded = false;
  private readonly drafts = new Map<string, string>();
  private readonly service: RunInstructionServiceV1 | undefined;
  constructor(service: RunInstructionServiceV1 | undefined) {
    this.service = service;
    this.element.className = 'run-instructions'; this.element.hidden = !service;
    this.editor.maxLength = 8000; this.editor.rows = 3; this.editor.setAttribute('aria-label', 'Instruction for active agent');
    this.editor.placeholder = 'What should the agent do next?';
    this.targets.setAttribute('aria-label', 'Active agent'); this.send.type = 'button'; this.status.setAttribute('role', 'status');
    this.editor.addEventListener('input', () => this.controls()); this.targets.addEventListener('change', () => this.controls());
    this.send.addEventListener('click', () => { void this.submit(); });
    const header = node('div'); header.className = 'instruction-header'; header.append(icon('chat-circle-text'), node('h3', 'Live instructions'));
    this.helper.className = 'instruction-helper'; this.form.className = 'instruction-form';
    this.agentField.className = 'instruction-agent'; this.agentField.append(node('span', 'Active agent'), this.targets);
    this.editorField.className = 'instruction-editor'; this.editorField.append(this.editorLabel, this.editor);
    this.send.className = 'instruction-send'; this.send.replaceChildren(icon('paper-plane-tilt'), node('span', 'Send instruction'));
    this.status.className = 'instruction-status'; this.history.className = 'instruction-history'; this.historyHeading.className = 'instruction-history-title';
    this.form.append(this.agentField, this.editorField, this.send);
    this.element.append(node('style', `
.plugin-run-viewer .run-instructions{gap:12px;padding:16px;background:var(--panel);border:1px solid var(--line);border-radius:6px}
.plugin-run-viewer .instruction-header{display:flex;align-items:center;gap:8px}
.plugin-run-viewer .instruction-header h3{font-size:16px;margin:0}
.plugin-run-viewer .instruction-helper{color:var(--text-dim);font-size:14px;max-width:65ch}
.plugin-run-viewer .instruction-form{display:grid;grid-template-columns:minmax(160px,220px) minmax(0,1fr);gap:12px;align-items:start}
.plugin-run-viewer .instruction-form label{display:grid;gap:6px;min-width:0;font-size:14px;font-weight:600}
.plugin-run-viewer .instruction-form select{width:100%}
.plugin-run-viewer .instruction-editor textarea{font:16px/1.5 var(--sans,sans-serif);font-weight:400;color:var(--text);background:var(--control-bg,var(--face-hi));border:1px solid var(--control-border,var(--line-strong));border-radius:6px;padding:8px 12px;display:block;width:100%;box-sizing:border-box;min-height:92px;max-height:320px;resize:vertical;caret-color:var(--accent-text,var(--accent))}
.plugin-run-viewer .instruction-editor textarea::placeholder{color:var(--text-dim);opacity:1}
.plugin-run-viewer .instruction-editor textarea::selection{background:var(--accent);color:var(--on-accent)}
.plugin-run-viewer .instruction-form[data-draft-only=true]{grid-template-columns:minmax(0,1fr)}
.plugin-run-viewer .instruction-send{grid-column:2;justify-self:end;display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.plugin-run-viewer .instruction-send:hover:not(:disabled){background:var(--accent);color:var(--on-accent);border-color:var(--accent);filter:brightness(.95)}
.plugin-run-viewer .instruction-status{display:flex;gap:8px;align-items:flex-start;font-size:14px;color:var(--text-dim)}
.plugin-run-viewer .instruction-status[data-tone=error]{color:var(--bad)}
.plugin-run-viewer .instruction-status>.run-icon{flex:none;margin-top:2px}
.plugin-run-viewer .instruction-history-title{font-size:14px;margin:4px 0 0}
.plugin-run-viewer .instruction-history:empty{display:none}
.plugin-run-viewer .instruction-history article{border-top:1px solid var(--line);padding-block:12px;display:grid;gap:6px;overflow-wrap:anywhere}
.plugin-run-viewer .instruction-receipt-actions{display:flex;flex-wrap:wrap;gap:8px}
.plugin-run-viewer .instruction-receipt-actions button{display:inline-flex;align-items:center;gap:6px;font-size:14px}
@media(max-width:600px){.plugin-run-viewer .instruction-form{grid-template-columns:minmax(0,1fr)}.plugin-run-viewer .instruction-send{grid-column:1}.plugin-run-viewer .run-instructions{padding:12px}}
`), header, this.helper, this.status, this.form, this.historyHeading, this.history);
  }
  update(state: PluginPanelState, query: RunInstructionQueryV1 | null) {
    const current = state.visible && state.activity.active && !state.activity.signal.aborted ? query : null;
    if (JSON.stringify(current) === JSON.stringify(this.query) && this.activity === state.activity.signal) return;
    if (this.query) this.drafts.set(JSON.stringify(this.query), this.editor.value);
    this.dispose(); this.controller = new AbortController(); this.activity = state.activity.signal;
    this.activity.addEventListener('abort', this.dispose, { once: true });
    this.query = current; this.snapshot = null; this.pending = []; this.loaded = false; this.busy = false;
    this.editor.value = current ? this.drafts.get(JSON.stringify(current)) ?? '' : '';
    this.element.hidden = !current || !this.service; this.setStatus(current ? 'Checking active agents…' : ''); this.draw();
    if (current && this.service) void this.refresh();
  }
  dispose = () => {
    this.controller.abort(); this.send.disabled = true; this.editor.disabled = true; if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.activity?.removeEventListener('abort', this.dispose);
  };
  private controls() {
    const blocked = this.pending.some(entry => entry.command.expectedAttempt === this.query?.expectedAttempt && entry.command.targetId === this.targets.value);
    this.send.disabled = this.controller.signal.aborted || this.busy || !this.loaded || !this.snapshot?.available || !this.targets.value || !this.editor.value.trim() || blocked;
    this.editor.disabled = this.controller.signal.aborted || this.busy; this.targets.disabled = this.controller.signal.aborted || this.busy || !this.snapshot?.available;
    const available = this.snapshot?.available === true && this.targets.options.length > 0;
    const hasDraft = this.editor.value.length > 0;
    this.agentField.hidden = !available; this.send.hidden = !available; this.editorField.hidden = !available && !hasDraft;
    this.form.hidden = !available && !hasDraft; this.form.dataset.draftOnly = String(!available);
    this.helper.hidden = !available; this.editorLabel.textContent = available ? 'Instruction' : 'Saved draft';
  }
  private setStatus(text: string, tone: 'info' | 'error' = 'info') {
    this.statusText.textContent = text; this.status.hidden = !text; this.status.dataset.tone = tone;
    this.status.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    this.status.replaceChildren(icon(tone === 'error' ? 'warning-circle' : 'info'), this.statusText);
  }
  private async refresh() {
    const service = this.service; const query = this.query; const signal = this.controller.signal;
    if (!service || !query || signal.aborted) return;
    try {
      const [snapshot, pending] = await Promise.all([service.read(query, signal), service.pending()]);
      signal.throwIfAborted();
      this.snapshot = snapshot?.status === 'available' ? snapshot.value : null;
      if (!Array.isArray(pending)) throw new Error('Instruction requests are unavailable');
      const relevant = pending.filter(entry => entry?.command?.repo === query.repo && entry.command.runId === query.runId);
      await Promise.all(relevant.filter(entry => !entry.receipt || ['sending', 'unknown'].includes(entry.receipt.status))
        .map(entry => service.receipt({ repo: query.repo, requestId: entry.command.requestId }, signal)));
      const refreshed = await service.pending(); signal.throwIfAborted();
      if (!Array.isArray(refreshed)) throw new Error('Instruction requests are unavailable');
      this.pending = refreshed.filter(entry => entry?.command?.repo === query.repo && entry.command.runId === query.runId);
      this.loaded = true; this.setStatus(snapshot?.status === 'available' ? snapshot.value?.reason ?? (snapshot.value?.targets?.length ? '' : 'Waiting for an agent that can receive instructions.') : 'Live instructions are unavailable. Saved requests are retained.');
      this.draw();
    } catch { if (!signal.aborted) { this.loaded = false; this.setStatus('Could not load instruction receipts. Sending is disabled until they can be checked.', 'error'); this.controls(); } }
    finally { if (!signal.aborted) { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => { void this.refresh(); }, 2500); } }
  }
  private async submit() {
    const service = this.service; const query = this.query; const snapshot = this.snapshot; const signal = this.controller.signal;
    if (!service || !query || !snapshot?.channelId || this.send.disabled) return;
    const text = this.editor.value; const targetId = this.targets.value;
    this.busy = true; this.controls();
    try {
      const result = await service.submit({ ...query, expectedChannelId: snapshot.channelId, targetId, text }, signal);
      signal.throwIfAborted();
      if (result.status === 'available') { this.editor.value = ''; this.drafts.delete(JSON.stringify(query)); }
      else this.setStatus('Delivery is unconfirmed. Check the saved request before sending again.', 'error');
      await this.refresh();
    } catch { if (!signal.aborted) { this.loaded = false; this.setStatus('Delivery is unconfirmed. Check the saved request before sending again.', 'error'); } }
    finally { if (!signal.aborted) { this.busy = false; this.controls(); } }
  }
  private draw() {
    const selected = this.targets.value; const targets = Array.isArray(this.snapshot?.targets) ? this.snapshot.targets.filter(target => !!target && typeof target.id === 'string' && typeof target.provider === 'string' && typeof target.stage === 'string') : [];
    const signature = JSON.stringify(targets);
    if (this.targets.dataset.signature !== signature) {
      this.targets.replaceChildren(...targets.map(target => { const option = node('option', `${target.provider} · ${target.stage}`); option.value = target.id; return option; }));
      this.targets.dataset.signature = signature;
      if (targets.some(target => target.id === selected)) this.targets.value = selected;
    }
    const rows = this.pending.map(entry => {
      const receipt = entry.receipt; const row = node('article'); row.dataset.instructionRequest = entry.command.requestId;
      row.append(node('p', entry.command.text), node('small', `Attempt ${entry.command.expectedAttempt} · ${receipt?.status ?? 'Delivery unconfirmed'}`));
      if (receipt?.message) row.append(node('p', receipt.message));
      const actions = node('div'); actions.className = 'instruction-receipt-actions';
      const check = node('button'); check.type = 'button'; check.append(icon('arrow-clockwise'), node('span', 'Check delivery')); check.addEventListener('click', () => { void this.refresh(); }); actions.append(check);
      if (receipt && ['delivered', 'failed', 'rejected'].includes(receipt.status)) {
        const dismiss = node('button'); dismiss.type = 'button'; dismiss.append(icon('x'), node('span', 'Dismiss receipt'));
        dismiss.addEventListener('click', () => {
          const signal = this.controller.signal;
          void this.service?.acknowledge({ repo: entry.command.repo, requestId: entry.command.requestId }, signal).then(() => { if (!signal.aborted) void this.refresh(); })
            .catch(() => { if (!signal.aborted) this.setStatus('Could not dismiss the saved receipt.', 'error'); });
        }); actions.append(dismiss);
      }
      if (!receipt) {
        const retry = node('button'); retry.type = 'button'; retry.append(icon('arrow-counter-clockwise'), node('span', 'Recover saved request'));
        retry.addEventListener('click', () => {
          const signal = this.controller.signal;
          void this.service?.retry({ repo: entry.command.repo, requestId: entry.command.requestId }, signal).then(() => { if (!signal.aborted) void this.refresh(); })
            .catch(() => { if (!signal.aborted) this.setStatus('Delivery remains unconfirmed.', 'error'); });
        }); actions.append(retry);
      }
      row.append(actions);
      return row;
    });
    this.historyHeading.hidden = !rows.length; this.history.replaceChildren(...rows); this.controls();
  }
}
