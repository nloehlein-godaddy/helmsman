import type { PluginPanelState, PostmortemEventV1, PostmortemMessageV1, PostmortemPatchV1, PostmortemProviderV1, PostmortemServiceV1, PostmortemSnapshotV1 } from '@helmsman/plugin-sdk';

export interface PostmortemTarget { readonly repo: string; readonly runId: string }
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
const option = (value: string, label: string) => { const item = node('option', label); item.value = value; return item; };
const MODELS: Record<PostmortemProviderV1, readonly string[]> = { codex: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra'], 'claude-code': ['opus', 'sonnet'] };
const COMPOSER_BLOCKED = new Set(['starting', 'busy', 'capped']);
const STOPPABLE = new Set(['starting', 'busy', 'ready']);
const sameTarget = (a: PostmortemTarget | null, b: PostmortemTarget | null) => a?.repo === b?.repo && a?.runId === b?.runId;

export function postmortemStatusText(snapshot: PostmortemSnapshotV1 | null): string {
  if (!snapshot) return '';
  const { session, activity } = snapshot;
  if (session.status === 'starting') return 'starting…';
  if (session.status === 'busy') return activity === 'resuming' ? 'resuming…' : 'thinking…';
  if (session.status === 'error') return `error: ${session.error ?? 'unknown'}`;
  return session.status;
}

export class PostmortemChat {
  readonly element = node('section');
  private readonly service: PostmortemServiceV1 | undefined;
  private readonly provider = node('select');
  private readonly model = node('select');
  private readonly effort = node('select');
  private readonly editor = node('textarea');
  private target: PostmortemTarget | null = null;
  private snapshot: PostmortemSnapshotV1 | null = null;
  private activity: AbortSignal | null = null;
  private controller = new AbortController();
  private opened = false;
  private busy = false;
  private error = '';
  private notice = '';
  private clientId: string | null = null;
  constructor(service: PostmortemServiceV1 | undefined) {
    this.service = service;
    this.element.className = 'run-postmortem'; this.element.hidden = true;
    this.provider.setAttribute('aria-label', 'Post-mortem agent'); this.model.setAttribute('aria-label', 'Post-mortem model'); this.effort.setAttribute('aria-label', 'Post-mortem reasoning effort');
    this.provider.append(option('', "Run's provider"), option('codex', 'Codex'), option('claude-code', 'Claude Code'));
    this.effort.append(option('high', 'High effort'), option('medium', 'Medium effort'), option('low', 'Low effort'));
    this.provider.addEventListener('change', () => this.models()); this.models();
    this.editor.maxLength = 8000; this.editor.rows = 3; this.editor.setAttribute('aria-label', 'Message to the post-mortem agent');
    this.editor.addEventListener('input', () => { this.clientId = null; this.draw(); });
  }
  open(target: PostmortemTarget) {
    if (!sameTarget(target, this.target)) { this.reset(); this.target = target; }
    this.opened = true; this.draw();
  }
  update(state: PluginPanelState, target: PostmortemTarget | null) {
    const current = state.visible && state.activity.active && !state.activity.signal.aborted ? target : null;
    if (sameTarget(current, this.target) && this.activity === state.activity.signal) return;
    this.activity?.removeEventListener('abort', this.dispose);
    this.reset(); this.activity = state.activity.signal; this.activity.addEventListener('abort', this.dispose, { once: true });
    this.target = current; this.draw();
  }
  dispose = () => { this.controller.abort(); this.activity?.removeEventListener('abort', this.dispose); };
  private reset() {
    this.controller.abort(); this.controller = new AbortController();
    this.snapshot = null; this.opened = false; this.busy = false; this.error = ''; this.notice = ''; this.clientId = null; this.editor.value = '';
  }
  private models() {
    const provider = this.provider.value as PostmortemProviderV1 | '';
    this.model.replaceChildren(option('', 'Provider default'), ...(provider ? MODELS[provider].map(model => option(model, model)) : []));
  }
  private async start(fresh: boolean) {
    const service = this.service; const target = this.target; const signal = this.controller.signal;
    if (!service || !target || this.busy) return;
    this.busy = true; this.error = ''; this.draw();
    const result = await service.start({ ...target, ...(this.provider.value ? { provider: this.provider.value as PostmortemProviderV1 } : {}),
      ...(this.model.value ? { model: this.model.value } : {}), effort: this.effort.value, ...(fresh ? { fresh: true } : {}) }, signal).catch(() => null);
    if (signal.aborted) return;
    this.busy = false;
    if (result?.status === 'available') { this.apply({ type: 'snapshot', snapshot: result.value }); this.watch(result.value.session.id); }
    else this.error = result?.message ?? 'Post-mortem service is unreachable.';
    this.draw();
  }
  private watch(sessionId: string) {
    this.controller.abort(); this.controller = new AbortController();
    const service = this.service; const target = this.target; const signal = this.controller.signal;
    if (!service || !target) return;
    const loop = async () => {
      while (!signal.aborted) {
        await service.watch({ repo: target.repo, sessionId }, event => { if (!signal.aborted) this.apply(event); }, signal).catch(() => undefined);
        if (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 2000));
      }
    };
    void loop();
  }
  private apply(event: PostmortemEventV1) {
    const current = this.snapshot;
    if (event.type === 'snapshot') this.snapshot = event.snapshot;
    else if (!current) return;
    else if (event.type === 'message') this.snapshot = { ...current, messages: [...current.messages.filter(message => message.id !== event.message.id), event.message].sort((a, b) => a.id - b.id) };
    else if (event.type === 'status') this.snapshot = { ...current, session: event.session, activity: event.activity };
    else this.snapshot = { ...current, patches: event.patches };
    this.draw();
  }
  private async send() {
    const service = this.service; const target = this.target; const snapshot = this.snapshot; const signal = this.controller.signal;
    const text = this.editor.value;
    if (!service || !target || !snapshot || this.busy || !text.trim()) return;
    this.clientId ??= crypto.randomUUID();
    this.busy = true; this.error = ''; this.draw();
    const result = await service.send({ repo: target.repo, sessionId: snapshot.session.id, clientId: this.clientId, text }, signal).catch(() => null);
    if (signal.aborted) return;
    this.busy = false;
    if (result?.status === 'available') { this.editor.value = ''; this.clientId = null; this.apply({ type: 'snapshot', snapshot: result.value }); }
    else this.error = result?.message ?? 'Post-mortem service is unreachable.';
    this.draw();
  }
  private async stop() {
    const service = this.service; const target = this.target; const snapshot = this.snapshot; const signal = this.controller.signal;
    if (!service || !target || !snapshot || this.busy) return;
    this.busy = true; this.error = ''; this.draw();
    try {
      const result = await service.stop({ repo: target.repo, sessionId: snapshot.session.id }, signal).catch(() => null);
      if (signal.aborted) return;
      if (result?.status === 'available') this.apply({ type: 'snapshot', snapshot: result.value }); else this.error = result?.message ?? 'Post-mortem service is unreachable.';
    } finally {
      if (!signal.aborted) { this.busy = false; this.draw(); }
    }
  }
  private copy(text: string) {
    const signal = this.controller.signal;
    if (!navigator.clipboard?.writeText) { this.notice = 'Clipboard unavailable.'; this.draw(); return; }
    void navigator.clipboard.writeText(text).then(() => { if (!signal.aborted) { this.notice = 'Copied.'; this.draw(); } }, () => { if (!signal.aborted) { this.notice = 'Clipboard unavailable.'; this.draw(); } });
  }
  private button(text: string, action: () => void, disabled = false) {
    const item = node('button', text); item.type = 'button'; item.disabled = disabled; item.addEventListener('click', action); return item;
  }
  private message(message: PostmortemMessageV1) {
    const row = node('article'); row.dataset.messageId = String(message.id); row.dataset.role = message.role; row.dataset.kind = message.kind;
    row.append(node('small', `${message.role} · ${message.kind}`), node('p', message.text)); return row;
  }
  private patch(patch: PostmortemPatchV1) {
    const row = node('article'); row.dataset.patch = patch.file;
    const badge = node('span', patch.valid ? 'valid' : `invalid: ${patch.reason ?? 'unknown'}`); badge.dataset.valid = String(patch.valid);
    row.append(node('p', `${patch.file} · ${patch.repo} · ${patch.baseSha ? patch.baseSha.slice(0, 12) : 'no base'}`), badge, ...(patch.summary ? [node('p', patch.summary)] : []),
      this.button('Copy path', () => this.copy(patch.path)), this.button('Copy git apply', () => { if (patch.applyCommand) this.copy(patch.applyCommand); }, !patch.applyCommand));
    return row;
  }
  private draw() {
    this.element.hidden = !this.service || !this.target || !this.opened;
    const snapshot = this.snapshot; const status = snapshot?.session.status;
    const children: HTMLElement[] = [node('style', '.plugin-run-viewer .run-postmortem textarea{font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);border-radius:var(--radius,4px);padding:6px 10px;display:block;width:100%;box-sizing:border-box;min-height:5em}.plugin-run-viewer .run-postmortem article{border-top:1px solid var(--line);padding-block:.5rem;overflow-wrap:anywhere}.plugin-run-viewer .run-postmortem article p{white-space:pre-wrap}.plugin-run-viewer .run-postmortem [data-valid=false]{color:var(--bad)}'),
      node('h3', 'Failure post-mortem')];
    if (this.error) { const alert = node('p', this.error); alert.setAttribute('role', 'alert'); children.push(alert); }
    if (this.notice) { const notice = node('p', this.notice); notice.setAttribute('role', 'status'); children.push(notice); }
    if (!snapshot) {
      const setup = node('div'); setup.className = 'run-tools';
      setup.append(this.provider, this.model, this.effort, this.button('Start post-mortem', () => { void this.start(false); }, this.busy));
      children.push(setup);
    } else {
      const line = node('p', postmortemStatusText(snapshot)); line.setAttribute('role', 'status'); children.push(line);
      const transcript = node('div'); transcript.append(...snapshot.messages.map(message => this.message(message))); children.push(transcript);
      if (snapshot.patches.length) { const patches = node('div'); patches.append(node('h4', 'Proposed patches'), ...snapshot.patches.map(patch => this.patch(patch))); children.push(patches); }
      this.editor.disabled = this.busy || COMPOSER_BLOCKED.has(status ?? '');
      const tools = node('div'); tools.className = 'run-tools';
      tools.append(this.button('Send', () => { void this.send(); }, this.editor.disabled || !this.editor.value.trim()),
        this.button('Stop', () => { void this.stop(); }, this.busy || !STOPPABLE.has(status ?? '')));
      if (status === 'capped' || status === 'error') tools.append(this.button('Start new post-mortem', () => { void this.start(true); }, this.busy));
      children.push(this.editor, tools);
    }
    this.element.replaceChildren(...children);
  }
}
