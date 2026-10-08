import type { PluginPanelState, WhiteboardServiceV1, WhiteboardSnapshotV1, WhiteboardTargetV1 } from '@helmsman/plugin-sdk';

const sameTarget = (a: WhiteboardTargetV1, b: WhiteboardTargetV1) => a?.repo === b.repo && (a.kind === 'run' && b.kind === 'run' ? a.runId === b.runId && a.expectedAttempt === b.expectedAttempt : a.kind === 'pull-request' && b.kind === 'pull-request' && a.number === b.number && a.baseSha === b.baseSha && a.headSha === b.headSha);

export class WhiteboardCompanion {
  readonly element = document.createElement('div');
  private readonly action = document.createElement('button');
  private readonly status = document.createElement('span');
  private target: WhiteboardTargetV1 | null = null;
  private snapshot: WhiteboardSnapshotV1 | null = null;
  private activity: AbortSignal | null = null;
  private controller = new AbortController();
  private key = '';
  private busy = false;
  private message = '';
  private uncertain = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly service: WhiteboardServiceV1 | undefined;
  constructor(service: WhiteboardServiceV1 | undefined) {
    this.service = service;
    this.element.className = 'whiteboard-companion run-tools pr-review-actions';
    this.action.type = 'button'; this.status.setAttribute('role', 'status');
    this.action.addEventListener('click', () => { void this.perform(this.uncertain ? 'read' : this.snapshot?.status === 'ready' ? 'open' : 'explain'); });
    this.element.append(this.action, this.status); this.draw();
  }
  update(state: PluginPanelState, target: WhiteboardTargetV1 | null) {
    const current = state.visible && state.activity.active && !state.activity.signal.aborted ? target : null;
    const key = JSON.stringify(current);
    if (this.key === key && this.activity === state.activity.signal) return;
    this.activity?.removeEventListener('abort', this.cancel);
    this.cancel(); this.controller = new AbortController(); this.activity = state.activity.signal;
    this.activity.addEventListener('abort', this.cancel, { once: true });
    this.target = current; this.key = key; this.snapshot = null; this.message = ''; this.busy = false; this.uncertain = false; this.draw();
    if (current && this.service) void this.perform('read');
  }
  private cancel = () => { this.controller.abort(); if (this.timer) clearTimeout(this.timer); this.timer = null; this.action.disabled = true; };
  dispose = () => { this.cancel(); this.activity?.removeEventListener('abort', this.cancel); };
  private async perform(method: 'read' | 'explain' | 'open') {
    const target = this.target; const service = this.service; const signal = this.controller.signal;
    if (!target || !service || signal.aborted || this.busy) return;
    this.busy = true; this.message = ''; this.draw();
    try {
      const result = await service[method](target, signal);
      if (signal.aborted) return;
      if (result?.status === 'available') { if (!sameTarget(result.value.target, target)) throw new Error('Whiteboard target changed'); this.uncertain = false; this.snapshot = result.value; this.message = result.value.message ?? ''; }
      else { this.message = result?.message ?? 'Whiteboard is unavailable. Try again.'; if (method !== 'read' && (!result || result.code === 0)) this.uncertain = true; }
    } catch { if (!signal.aborted) { this.uncertain = method !== 'read'; this.message = method === 'read' ? 'Whiteboard is unavailable. Try again.' : 'Whiteboard outcome is unknown. Check status before retrying.'; } }
    finally { if (!signal.aborted) { this.busy = false; this.draw(); if (this.snapshot?.status === 'creating') this.timer = setTimeout(() => { this.timer = null; void this.perform('read'); }, 2000); } }
  }
  private draw() {
    this.element.hidden = !this.target;
    this.action.textContent = this.uncertain ? 'Check Whiteboard status' : this.snapshot?.status === 'ready' ? 'Open in Whiteboard' : 'Explain in Whiteboard';
    this.action.disabled = !this.service || this.busy || this.controller.signal.aborted || this.snapshot?.status === 'creating' || this.snapshot?.status === 'recovery-required';
    this.status.textContent = !this.service ? 'Whiteboard is not available.' : this.busy ? 'Checking Whiteboard…' : this.message || (this.snapshot?.status === 'creating' ? 'Whiteboard explanation is being created.' : this.snapshot?.status === 'failed' ? 'Whiteboard explanation failed. Try again.' : this.snapshot?.status === 'recovery-required' ? 'Whiteboard outcome is unknown. Recovery is required before retrying.' : '');
  }
}
