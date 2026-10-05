import type { PluginPanelState, RunInstructionPendingV1, RunInstructionQueryV1, RunInstructionServiceV1, RunInstructionSnapshotV1 } from '@helmsman/plugin-sdk';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
export class RunInstructions {
  readonly element = node('section');
  private readonly editor = node('textarea');
  private readonly targets = node('select');
  private readonly send = node('button', 'Send instruction');
  private readonly status = node('p');
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
    this.targets.setAttribute('aria-label', 'Active agent'); this.send.type = 'button'; this.status.setAttribute('role', 'status');
    this.editor.addEventListener('input', () => this.controls()); this.targets.addEventListener('change', () => this.controls());
    this.send.addEventListener('click', () => { void this.submit(); });
    const title = node('h3', 'Live instructions'); const label = node('label', 'Instruction'); label.append(this.editor);
    this.element.append(node('style', '.plugin-run-viewer .run-instructions textarea{font:inherit;color:var(--text);background-color:var(--control-bg,var(--face-hi));border:1px solid var(--control-border,var(--line-strong));border-radius:var(--radius,4px);padding:6px 10px;display:block;width:100%;box-sizing:border-box;min-height:5em}.plugin-run-viewer .run-instructions article{border-top:1px solid var(--line);padding-block:.5rem;overflow-wrap:anywhere}'), title, this.targets, label, this.send, this.status, this.history);
  }
  update(state: PluginPanelState, query: RunInstructionQueryV1 | null) {
    const current = state.visible && state.activity.active && !state.activity.signal.aborted ? query : null;
    if (JSON.stringify(current) === JSON.stringify(this.query) && this.activity === state.activity.signal) return;
    if (this.query) this.drafts.set(JSON.stringify(this.query), this.editor.value);
    this.dispose(); this.controller = new AbortController(); this.activity = state.activity.signal;
    this.activity.addEventListener('abort', this.dispose, { once: true });
    this.query = current; this.snapshot = null; this.pending = []; this.loaded = false; this.busy = false;
    this.editor.value = current ? this.drafts.get(JSON.stringify(current)) ?? '' : '';
    this.element.hidden = !current || !this.service; this.status.textContent = ''; this.draw();
    if (current && this.service) void this.refresh();
  }
  dispose = () => {
    this.controller.abort(); this.send.disabled = true; this.editor.disabled = true; if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.activity?.removeEventListener('abort', this.dispose);
  };
  private controls() {
    const blocked = this.pending.some(entry => entry.command.expectedAttempt === this.query?.expectedAttempt && entry.command.targetId === this.targets.value);
    this.send.disabled = this.controller.signal.aborted || this.busy || !this.loaded || !this.snapshot?.available || !this.targets.value || !this.editor.value.trim() || blocked;
    this.editor.disabled = this.busy; this.targets.disabled = this.busy || !this.snapshot?.available;
  }
  private async refresh() {
    const service = this.service; const query = this.query; const signal = this.controller.signal;
    if (!service || !query || signal.aborted) return;
    try {
      const [snapshot, pending] = await Promise.all([service.read(query, signal), service.pending()]);
      signal.throwIfAborted();
      this.snapshot = snapshot.status === 'available' ? snapshot.value : null;
      const relevant = pending.filter(entry => entry.command.repo === query.repo && entry.command.runId === query.runId);
      await Promise.all(relevant.filter(entry => !entry.receipt || ['sending', 'unknown'].includes(entry.receipt.status))
        .map(entry => service.receipt({ repo: query.repo, requestId: entry.command.requestId }, signal)));
      const refreshed = await service.pending(); signal.throwIfAborted();
      this.pending = refreshed.filter(entry => entry.command.repo === query.repo && entry.command.runId === query.runId);
      this.loaded = true; this.status.textContent = snapshot.status === 'available' ? snapshot.value.reason ?? '' : 'Live instructions are unavailable. Saved requests are retained.';
      this.draw();
    } catch { if (!signal.aborted) { this.loaded = false; this.status.textContent = 'Could not load instruction receipts. Sending is disabled until they can be checked.'; this.controls(); } }
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
      else this.status.textContent = 'Delivery is unconfirmed. Check the saved request before sending again.';
      await this.refresh();
    } catch { if (!signal.aborted) { this.loaded = false; this.status.textContent = 'Delivery is unconfirmed. Check the saved request before sending again.'; } }
    finally { if (!signal.aborted) { this.busy = false; this.controls(); } }
  }
  private draw() {
    const selected = this.targets.value; const targets = this.snapshot?.targets ?? [];
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
      const check = node('button', 'Check delivery'); check.type = 'button'; check.addEventListener('click', () => { void this.refresh(); }); row.append(check);
      if (receipt && ['delivered', 'failed', 'rejected'].includes(receipt.status)) {
        const dismiss = node('button', 'Dismiss receipt'); dismiss.type = 'button';
        dismiss.addEventListener('click', () => {
          const signal = this.controller.signal;
          void this.service?.acknowledge({ repo: entry.command.repo, requestId: entry.command.requestId }, signal).then(() => { if (!signal.aborted) void this.refresh(); })
            .catch(() => { if (!signal.aborted) this.status.textContent = 'Could not dismiss the saved receipt.'; });
        }); row.append(dismiss);
      }
      if (!receipt) {
        const retry = node('button', 'Recover saved request'); retry.type = 'button';
        retry.addEventListener('click', () => {
          const signal = this.controller.signal;
          void this.service?.retry({ repo: entry.command.repo, requestId: entry.command.requestId }, signal).then(() => { if (!signal.aborted) void this.refresh(); })
            .catch(() => { if (!signal.aborted) this.status.textContent = 'Delivery remains unconfirmed.'; });
        }); row.append(retry);
      }
      return row;
    });
    this.history.replaceChildren(...rows); this.controls();
  }
}
