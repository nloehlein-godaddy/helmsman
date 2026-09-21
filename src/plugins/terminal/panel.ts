import type { PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState, TerminalControlInputV1, TerminalControlOperationV1, TerminalControlReceiptV1, TerminalPendingV1, TerminalSnapshotV1, TerminalTabV1, TerminalTargetV1 } from '@helmsman/plugin-sdk';
import { mapKeyEvent } from './keys.js';
import { emptyState, errorMessage, sameTarget, surfaceKey, TerminalStorage, validInput, validReceipt, validSurface, validTarget, type DraftState } from './state.js';
import { styles } from './styles.js';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
const navKeys = [['up','↑'],['down','↓'],['left','←'],['right','→'],['tab','Tab'],['escape','Esc']] as const;
const MAX_QUEUE = 32;
interface QueuedControl { input: TerminalControlInputV1; epoch: number; draft?: string; }
function validTab(value: unknown): value is TerminalTabV1 {
  if (!value || typeof value !== 'object') return false; const tab = value as TerminalTabV1;
  return validTarget(tab.target) && typeof tab.title === 'string' && typeof tab.workspaceTitle === 'string' && typeof tab.type === 'string' && typeof tab.selected === 'boolean' && Array.isArray(tab.actions) && tab.actions.every(action => action && typeof action.id === 'string' && typeof action.label === 'string');
}
function validPending(value: unknown): value is readonly TerminalPendingV1[] { return Array.isArray(value) && value.length <= 256 && value.every(item => item && validInput(item.command) && typeof item.command.requestId === 'string' && (item.receipt === null || validReceipt(item.receipt) && item.receipt.requestId === item.command.requestId && JSON.stringify(item.receipt.input) === JSON.stringify({ version: item.command.version, target: item.command.target, operation: item.command.operation }))); }

class TerminalPanel implements PluginPanelInstance {
  private state: PluginPanelState;
  private readonly context: PluginPanelContext;
  private readonly container: HTMLElement;
  private readonly storage: TerminalStorage;
  private saved: DraftState = emptyState();
  private unsupported = false;
  private resultsError = '';
  private storageError = '';
  private results: TerminalControlReceiptV1[] = [];
  private snapshot: TerminalSnapshotV1 | null = null;
  private pending: readonly TerminalPendingV1[] = [];
  private journalsReady = false;
  private selectedTarget: TerminalTargetV1 | null = null;
  private disposed = false;
  private generation = 0;
  private controlEpoch = 0;
  private readController: AbortController | null = null;
  private operationController: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  private working = false;
  private capture = false;
  private queue: QueuedControl[] = [];
  private routeKey: string;
  private listError = '';
  private actionError = '';
  private screenError = '';
  private screenText = '';
  private truncated = false;
  private reconciling = false;
  private readonly root = node('section');
  private readonly status = node('p');
  private readonly errors = node('p');
  private readonly scopeText = node('span');
  private readonly list = node('div');
  private readonly listBody = node('div');
  private readonly detailBody = node('div');
  private readonly detailEmpty = node('p');
  private readonly screen = node('pre');
  private readonly preview = node('p');
  private readonly input = node('input');
  private readonly inputLabel = node('span');
  private readonly form = node('form');
  private readonly sendButton = node('button', 'Send + Enter');
  private readonly captureButton = node('button');
  private readonly captureHelp = node('span');
  private readonly keypad = node('div');
  private readonly actions = node('div');
  private readonly recovery = node('div');
  private readonly history = node('details');
  private readonly historyRows = node('div');
  private readonly tabsCollapse = node('button');
  private readonly screenCollapse = node('button');
  private readonly tabsSection = node('section');
  private readonly screenSection = node('section');
  private listSignature = '';
  private actionsSignature = '';

  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state; this.storage = new TerminalStorage(context.contributionId, context.state.instanceId);
    try { this.saved = this.storage.readDraft(); } catch (error) { this.unsupported = true; this.storageError = errorMessage(error, 'Saved terminal state unavailable.'); }
    this.readResults(); const hint = this.state.terminal; if (hint?.version === 1 && validSurface(hint.surface)) this.saved.selected = hint.surface; this.routeKey = JSON.stringify(hint ?? null);
    this.build(); this.revealPane(); this.container.replaceChildren(this.root);
    this.root.addEventListener('click', this.click); this.root.addEventListener('paste', this.paste); this.form.addEventListener('submit', this.submit); this.input.addEventListener('input', this.edit); this.root.addEventListener('keydown', this.keydown);
    context.onDispose(this.dispose); context.signal.addEventListener('abort', this.dispose, { once: true }); this.state.activity.signal.addEventListener('abort', this.cancel, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private button(label: string, attribute: string) { const button = node('button', label); button.type = 'button'; button.setAttribute(attribute, ''); return button; }
  private build() {
    this.root.className = 'plugin-terminal'; this.root.append(node('style', styles), node('h2', 'Terminal'), node('p', 'View and control an existing terminal session. Text and keys are sent directly to the selected tab.'));
    const toolbar = node('div'); toolbar.className = 'terminal-toolbar'; toolbar.append(this.button('Refresh terminals', 'data-refresh'), this.button('Use header scope', 'data-inherit'), this.button('Show all terminals', 'data-all'), this.scopeText, this.button('Save draft', 'data-save-draft')); this.root.append(toolbar);
    this.status.setAttribute('role','status'); this.errors.className = 'terminal-error'; this.errors.setAttribute('role','alert'); this.root.append(this.status, this.errors);
    const columns = node('div'); columns.className = 'terminal-columns'; this.tabsSection.className = this.screenSection.className = 'terminal-column'; this.tabsSection.tabIndex = this.screenSection.tabIndex = -1;
    const tabsHead = node('div'); tabsHead.className = 'terminal-column-head'; this.tabsCollapse.type = 'button'; this.tabsCollapse.dataset.collapse = 'tabs'; tabsHead.append(node('h3','Terminal tabs'), this.tabsCollapse); this.list.className = 'terminal-tabs'; this.listBody.append(this.list); this.tabsSection.append(tabsHead, this.listBody);
    const screenHead = node('div'); screenHead.className = 'terminal-column-head'; this.screenCollapse.type = 'button'; this.screenCollapse.dataset.collapse = 'screen'; screenHead.append(node('h3','Terminal screen'), this.screenCollapse); this.detailEmpty.className = 'terminal-note'; this.screenSection.append(screenHead, this.detailEmpty, this.detailBody);
    const captureRow = node('div'); captureRow.className = 'terminal-capture'; this.captureButton.type = 'button'; this.captureButton.dataset.capture = ''; this.captureHelp.className = 'terminal-capture-help'; this.captureHelp.id = `terminal-capture-${crypto.randomUUID()}`; captureRow.append(this.captureButton,this.captureHelp);
    this.screen.className = 'terminal-screen'; this.screen.tabIndex = 0; this.preview.className = 'terminal-note'; this.keypad.className = 'terminal-keypad';
    for (const [key,label] of navKeys) { const button = node('button',label); button.type = 'button'; button.dataset.key = key; button.setAttribute('aria-label',`Send ${key} key`); this.keypad.append(button); }
    this.form.className = 'terminal-send'; const label = node('label'); this.input.className = 'terminal-input'; this.input.name = 'text'; this.input.autocomplete = 'off'; this.input.maxLength = 64_000; label.append(this.inputLabel,this.input); this.sendButton.type = 'submit'; this.form.append(label,this.sendButton); this.actions.className = 'terminal-actions';
    this.detailBody.append(captureRow,this.screen,this.preview,this.keypad,this.form,this.actions); columns.append(this.tabsSection,this.screenSection); this.root.append(columns,this.recovery);
    this.history.append(node('summary','Saved control history'),this.historyRows); this.root.append(this.history);
  }
  private active(generation = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private inScope(target: TerminalTargetV1) { return this.state.activity.repo === null || target.repo === this.state.activity.repo; }
  private selected() { return this.snapshot?.tabs.find(tab => tab.target.surfaceRef === this.saved.selected && this.inScope(tab.target)) ?? null; }
  private cancelReads() { ++this.generation; this.readController?.abort(); this.readController = null; this.reading = false; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private cancelControls() { ++this.controlEpoch; this.queue = []; this.operationController?.abort(); this.capture = false; }
  private cancel = () => { this.cancelReads(); this.cancelControls(); this.journalsReady = false; this.draw(); };
  dispose = () => { if (this.disposed) return; this.disposed = true; this.cancel(); this.root.removeEventListener('click',this.click); this.root.removeEventListener('paste',this.paste); this.root.removeEventListener('keydown',this.keydown); this.form.removeEventListener('submit',this.submit); this.input.removeEventListener('input',this.edit); this.context.signal.removeEventListener('abort',this.dispose); this.state.activity.signal.removeEventListener('abort',this.cancel); this.container.replaceChildren(); };
  update(next: PluginPanelState) {
    if (this.disposed) return; const previous = this.state; const routeKey = JSON.stringify(next.terminal ?? null); const changed = previous.activity !== next.activity || previous.visible !== next.visible || previous.activity.repo !== next.activity.repo;
    previous.activity.signal.removeEventListener('abort',this.cancel); this.state = next; next.activity.signal.addEventListener('abort',this.cancel,{once:true});
    if (changed) { this.cancel(); if (previous.activity.repo !== next.activity.repo) { this.snapshot = null; this.selectedTarget = null; this.screenText = ''; this.listError = ''; } }
    if (routeKey !== this.routeKey) { this.routeKey = routeKey; this.cancelControls(); this.saved.selected = validSurface(next.terminal?.surface) ? next.terminal.surface : null; this.selectedTarget = null; this.screenText = ''; this.revealPane(); }
    this.draw(); if (changed || routeKey !== JSON.stringify(previous.terminal ?? null)) void this.refresh();
  }
  private revealPane() { const pane = this.state.terminal?.pane; if (pane === 'tabs' || pane === 'screen') { this.saved.collapsed[pane] = false; const section = pane === 'tabs' ? this.tabsSection : this.screenSection; queueMicrotask(() => { if (this.active() && section.isConnected) { section.focus({preventScroll:true}); section.scrollIntoView?.({block:'nearest'}); } }); } }
  private readResults() { try { this.results = this.storage.results(); this.resultsError = ''; } catch (error) { this.resultsError = errorMessage(error,'Saved terminal results unavailable.'); } }
  private persist() { if (this.unsupported) return false; try { this.storage.saveDraft(this.saved); this.storageError = ''; return true; } catch (error) { this.storageError = errorMessage(error,'Terminal draft could not be saved. Keep this page open.'); return false; } }
  private edit = () => { const tab = this.selected(); if (!tab || this.unsupported) return; this.saved.drafts[surfaceKey(tab.target)] = this.input.value; this.persist(); this.paintSafety(); };
  private async loadPending(signal?: AbortSignal) { const values = await this.context.services.terminal!.pending(signal); if (!validPending(values)) throw new Error('Terminal journal unavailable. Existing controls are kept.'); return values; }
  refresh = async () => {
    if (!this.active() || this.reading) return; this.cancelReads(); const generation = this.generation; const controller = new AbortController(); this.readController = controller; this.reading = true;
    try {
      const results = await Promise.allSettled([this.context.services.terminal!.list({version:1,repo:this.state.activity.repo},controller.signal),this.loadPending(controller.signal)]); if (!this.active(generation)) return;
      const list = results[0];
      if (list.status === 'fulfilled' && list.value?.status === 'available' && list.value.value?.version === 1 && list.value.value.repo === this.state.activity.repo && typeof list.value.value.connected === 'boolean' && Array.isArray(list.value.value.tabs) && list.value.value.tabs.every(tab => validTab(tab) && this.inScope(tab.target))) { this.snapshot = list.value.value; this.listError = ''; if (!this.snapshot.connected) this.snapshot = {...this.snapshot,tabs:[]}; }
      else this.listError = 'Terminal tabs could not be refreshed. Retained tabs are shown; controls are disabled until refresh succeeds.';
      const pending = results[1]; if (pending.status === 'fulfilled') { this.pending = pending.value; this.journalsReady = true; } else { this.journalsReady = false; this.actionError = 'Terminal journal unavailable. Existing controls are kept.'; }
      const selected = this.selected(); if (!sameTarget(this.selectedTarget,selected?.target)) { this.cancelControls(); this.selectedTarget = selected?.target ?? null; this.screenText = ''; this.screenError = ''; this.truncated = false; }
      this.readResults(); this.draw();
      if (selected && !this.listError && !this.saved.collapsed.screen) {
        const response = await this.context.services.terminal!.screen({target:selected.target,lines:40},controller.signal); if (!this.active(generation) || !sameTarget(this.selected()?.target,selected.target)) return;
        if (response?.status === 'available' && response.value?.version === 1 && sameTarget(response.value.target,selected.target) && typeof response.value.text === 'string' && typeof response.value.truncated === 'boolean') { this.screenText = response.value.text; this.truncated = response.value.truncated; this.screenError = ''; }
        else { this.screenText = ''; this.screenError = 'Screen unavailable. Refresh to retry.'; }
        this.draw();
      }
    } catch (error) { if (this.active(generation)) { this.screenError = errorMessage(error,'Terminal preview unavailable.'); this.draw(); } }
    finally { if (this.active(generation)) { this.reading = false; this.timer = setTimeout(() => { void this.refresh(); },2_000); } }
  };
  private blocked(target: TerminalTargetV1) { return this.pending.some(item => surfaceKey(item.command.target) === surfaceKey(target)); }
  private canControl() { const tab = this.selected(); return this.active() && !!tab && !this.saved.collapsed.screen && !this.listError && this.snapshot?.connected === true && this.journalsReady && !this.unsupported && !this.storageError && !this.resultsError && !this.reconciling && !this.blocked(tab.target); }
  private enqueue(operation: TerminalControlOperationV1, draft?: string) {
    const tab = this.selected(); if (!tab || !this.canControl()) return false; if (this.queue.length >= MAX_QUEUE) { this.actionError = 'Keyboard queue is full. Wait for the current controls to finish.'; this.draw(); return false; }
    if (!this.persist()) { this.draw(); return false; } this.queue.push({input:{version:1,target:{...tab.target},operation},epoch:this.controlEpoch,...(draft === undefined ? {} : {draft})}); void this.drain(); return true;
  }
  private async drain() {
    if (this.working) return; this.working = true;
    try {
      while (this.queue.length) {
        const queued = this.queue.shift()!; if (!this.active() || queued.epoch !== this.controlEpoch || !sameTarget(this.selected()?.target,queued.input.target)) { this.queue = []; break; }
        const controller = new AbortController(); this.operationController = controller; const signal = AbortSignal.any([controller.signal,this.context.signal,this.state.activity.signal]);
        try {
          this.pending = await this.loadPending(signal); this.journalsReady = true;
          if (signal.aborted || queued.epoch !== this.controlEpoch || !sameTarget(this.selected()?.target,queued.input.target) || this.blocked(queued.input.target)) { this.queue = []; break; }
          const result = await this.context.services.terminal!.control(queued.input,signal);
          if (result?.status !== 'available' || !validReceipt(result.value) || JSON.stringify(result.value.input) !== JSON.stringify(queued.input)) throw new Error('Control outcome is unknown. Check its original receipt before sending more controls.');
          await this.consume(result.value,false);
          if (result.value.status !== 'succeeded') { this.queue = []; this.capture = false; }
          if (result.value.status === 'succeeded' && queued.draft !== undefined && this.saved.drafts[surfaceKey(queued.input.target)] === queued.draft) { this.saved.drafts[surfaceKey(queued.input.target)] = ''; this.persist(); }
        } catch (error) { this.queue = []; this.capture = false; this.actionError = errorMessage(error,'Control outcome unavailable. Check its original receipt.'); }
        finally { try { this.pending = await this.loadPending(); this.journalsReady = true; } catch { this.journalsReady = false; } this.operationController = null; this.draw(); }
      }
    } finally { this.working = false; this.draw(); }
  }
  private async consume(value: TerminalControlReceiptV1, inspected: boolean) {
    this.actionError = value.status === 'succeeded' ? '' : value.reason ?? `Terminal control ${value.status}.`;
    if (value.status === 'pending') return;
    this.storage.result(value); this.readResults();
    if (value.status === 'recovery-required') { if (!inspected) return; this.storage.inspected(value); this.actionError = 'Uncertain delivery history saved. Controls resumed after your inspection; delivery was not confirmed.'; }
    await this.context.services.terminal!.acknowledge({repo:value.input.target.repo,requestId:value.requestId});
  }
  private async reconcile(requestId: string, inspected: boolean) {
    if (!this.active() || this.working || this.reconciling) return; const original = this.pending.find(item => item.command.requestId === requestId); if (!original) return;
    this.reconciling = true; this.cancelControls(); this.draw();
    try { const service = this.context.services.terminal!; if (inspected && typeof service.inspect !== 'function') throw new Error('Terminal inspection is unavailable. The original control remains blocked.'); const query = {repo:original.command.target.repo,requestId}; const result = inspected ? await service.inspect(query,this.state.activity.signal) : await service.receipt(query,this.state.activity.signal); if (result?.status !== 'available' || !result.value || !validReceipt(result.value) || result.value.requestId !== requestId || !sameTarget(result.value.input.target,original.command.target) || JSON.stringify(result.value.input.operation) !== JSON.stringify(original.command.operation)) throw new Error('Original receipt is unavailable. Its request identity is kept.'); await this.consume(result.value,inspected); }
    catch (error) { this.actionError = errorMessage(error,'Original receipt unavailable.'); }
    finally { try { this.pending = await this.loadPending(); this.journalsReady = true; } catch { this.journalsReady = false; } this.reconciling = false; this.draw(); }
  }
  private select(surface: string) {
    if (!this.active() || !this.snapshot?.tabs.some(tab => tab.target.surfaceRef === surface && this.inScope(tab.target))) return;
    this.cancelControls(); this.cancelReads(); this.saved.selected = surface; this.saved.collapsed.screen = false; this.selectedTarget = this.selected()?.target ?? null; this.screenText = ''; this.screenError = ''; this.actionError = ''; this.persist(); this.draw(); void this.refresh();
    const path = window.location.pathname; if (!/^\/(?:terminal|cmux)\/?$/.test(path) && !/^\/plugins\/[^/]+\/[^/]+\/?$/.test(path)) return;
    const header = this.state.headerRepo === undefined ? this.state.repo : this.state.headerRepo; const params = new URLSearchParams(window.location.search); if (header) params.set('repo',header); else params.delete('repo'); params.set('surface',surface); params.set('pane','screen'); params.set('panel',this.state.instanceId); this.context.navigate(`${path}?${params}`);
  }
  private click = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null; if (!button || button.disabled || !this.active()) return; event.stopPropagation();
    if (button.dataset.surface) this.select(button.dataset.surface);
    else if (button.hasAttribute('data-refresh')) void this.refresh();
    else if (button.hasAttribute('data-save-draft')) { this.persist(); this.draw(); }
    else if (button.hasAttribute('data-inherit') || button.hasAttribute('data-all')) { this.cancel(); void this.context.setScope?.({kind:button.hasAttribute('data-all') ? 'all' : 'inherit'}).catch(error => { this.actionError = errorMessage(error,'Terminal scope unavailable.'); this.draw(); }); }
    else if (button.dataset.collapse === 'tabs' || button.dataset.collapse === 'screen') { const pane = button.dataset.collapse; this.saved.collapsed[pane] = !this.saved.collapsed[pane]; if (pane === 'screen' && this.saved.collapsed.screen) this.cancelControls(); this.persist(); this.draw(); if (!this.saved.collapsed[pane]) void this.refresh(); }
    else if (button.hasAttribute('data-capture')) { this.capture = !this.capture; this.draw(); (this.capture ? this.screen : this.captureButton).focus({preventScroll:true}); }
    else if (button.dataset.key) this.enqueue({kind:'key',key:button.dataset.key});
    else if (button.dataset.action) this.enqueue({kind:'action',action:button.dataset.action});
    else if (button.dataset.receipt) void this.reconcile(button.dataset.receipt,button.hasAttribute('data-inspect'));
  };
  private submit = (event: SubmitEvent) => { event.preventDefault(); event.stopPropagation(); if (!this.input.value.trim()) return; this.enqueue({kind:'text',text:this.input.value,enter:true},this.input.value); };
  private keydown = (event: KeyboardEvent) => {
    if (!this.capture || !this.active()) return;
    if (event.key === 'Escape' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); event.stopPropagation(); this.capture = false; this.draw(); this.captureButton.focus({preventScroll:true}); return; }
    if (event.target !== this.screen || event.isComposing) return; const intent = mapKeyEvent(event); if (intent.kind === 'ignore') return;
    if (this.enqueue(intent.kind === 'key' ? {kind:'key',key:intent.token} : {kind:'text',text:intent.text,enter:false})) { event.preventDefault(); event.stopPropagation(); }
  };
  private paste = (event: ClipboardEvent) => {
    if (!this.canControl()) return; const tab = this.selected(); const item = Array.from(event.clipboardData?.items ?? []).find(value => value?.type?.startsWith('image/')); const file = item?.getAsFile(); if (!tab || !file) return;
    event.preventDefault(); event.stopPropagation(); const target = {...tab.target}; const epoch = this.controlEpoch;
    if (!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type) || 4 * Math.ceil(file.size / 3) > 2 * 1024 * 1024) { this.actionError = 'Paste a PNG, JPEG, GIF, or WebP image no larger than 1.5 MiB.'; this.draw(); return; }
    const reader = new FileReader(); reader.onerror = () => { if (epoch === this.controlEpoch && this.active()) { this.actionError = 'Could not read pasted image.'; this.draw(); } }; reader.onload = () => { if (epoch !== this.controlEpoch || !this.active() || !sameTarget(this.selected()?.target,target)) return; const value = typeof reader.result === 'string' ? reader.result : ''; const comma = value.indexOf(','); if (comma < 0) { this.actionError = 'Could not read pasted image.'; this.draw(); return; } this.enqueue({kind:'image',mimeType:file.type,dataBase64:value.slice(comma + 1)}); }; reader.readAsDataURL(file);
  };
  private paintSafety() {
    const enabled = this.canControl(); this.sendButton.disabled = !enabled || this.working || this.queue.length > 0; this.captureButton.disabled = !enabled && !this.capture; this.input.disabled = !this.active() || this.unsupported;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-key],[data-action]')) button.disabled = !enabled;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-receipt]')) button.disabled = !this.active() || this.working || this.reconciling || !!this.resultsError;
    this.errors.textContent = [this.storageError,this.resultsError,this.actionError].filter(Boolean).join(' ');
  }
  private draw() {
    if (this.disposed) return; const tab = this.selected();
    this.scopeText.textContent = `Scope: ${this.state.activity.repo ?? 'All terminals'}`;
    this.status.textContent = this.listError || (!this.snapshot ? 'Loading terminals…' : !this.snapshot.connected ? 'Terminal not connected. Open your configured terminal app, then refresh.' : !this.snapshot.tabs.length ? 'No terminal tabs available in this scope.' : this.snapshot.quality === 'partial' ? 'Terminal results are incomplete.' : '');
    const signature = JSON.stringify([this.snapshot?.tabs,this.saved.selected]); if (signature !== this.listSignature) { this.listSignature = signature; this.list.replaceChildren(); for (const item of this.snapshot?.tabs ?? []) { const button = node('button'); button.type = 'button'; button.className = 'terminal-tab'; button.dataset.surface = item.target.surfaceRef; button.setAttribute('aria-pressed',String(item.target.surfaceRef === this.saved.selected)); button.append(node('span',item.title),node('small',`${item.workspaceTitle} · ${item.type} · ${item.target.repo ?? 'Unattached'}`)); this.list.append(button); } }
    this.listBody.hidden = this.saved.collapsed.tabs; this.detailBody.hidden = this.saved.collapsed.screen || !tab;
    for (const [button,pane,label] of [[this.tabsCollapse,'tabs','Terminal tabs'],[this.screenCollapse,'screen','Terminal screen']] as const) { button.textContent = this.saved.collapsed[pane] ? 'Expand' : 'Collapse'; button.setAttribute('aria-label',`${button.textContent} ${label}`); button.setAttribute('aria-expanded',String(!this.saved.collapsed[pane])); }
    this.detailEmpty.hidden = !!tab || this.saved.collapsed.screen; this.detailEmpty.textContent = this.saved.selected ? 'The selected terminal is unavailable in this scope. Select another tab or explicitly show all terminals.' : 'Select a tab to view its screen.';
    const nextText = this.screenError || this.screenText; if (this.screen.textContent !== nextText) { const scroll = this.screen.scrollTop; this.screen.textContent = nextText; this.screen.scrollTop = scroll; }
    this.screen.setAttribute('aria-label',`Screen output from ${tab?.title ?? 'selected terminal'}`); this.screen.classList.toggle('is-capturing',this.capture); this.captureButton.textContent = this.capture ? 'Stop keyboard control' : 'Control with keyboard'; this.captureButton.setAttribute('aria-pressed',String(this.capture));
    this.captureHelp.textContent = `Keys go directly to ${tab?.title ?? 'the selected tab'} while the screen has focus. Press Shift+Escape to stop keyboard control.`; this.captureHelp.hidden = !this.capture; for (const control of [this.screen,this.captureButton]) { if (this.capture) control.setAttribute('aria-describedby',this.captureHelp.id); else control.removeAttribute('aria-describedby'); }
    this.preview.textContent = this.truncated ? 'Plaintext preview is truncated to the requested screen lines.' : 'Plaintext screen preview · refreshes every 2 seconds.';
    this.inputLabel.textContent = `Send text to ${tab?.title ?? 'selected terminal'}`; const draft = tab ? this.saved.drafts[surfaceKey(tab.target)] ?? '' : ''; if (this.input.value !== draft) this.input.value = draft;
    const actionsKey = JSON.stringify(tab?.actions ?? []); if (actionsKey !== this.actionsSignature) { this.actionsSignature = actionsKey; this.actions.replaceChildren(); for (const action of tab?.actions ?? []) { const button = node('button',action.label); button.type = 'button'; button.dataset.action = action.id; this.actions.append(button); } }
    this.recovery.replaceChildren(); for (const item of this.pending.filter(item => this.inScope(item.command.target))) { const article = node('article'); article.append(node('h3',`${item.command.target.surfaceRef} · ${item.receipt?.status ?? 'Uncertain outcome'}`),node('p',item.receipt?.reason ?? 'An original control requires reconciliation before sending more controls to this surface.'),node('code',item.command.requestId)); const check = this.button('Check original receipt','data-check'); check.dataset.receipt = item.command.requestId; article.append(check); if (item.receipt === null || item.receipt.status === 'recovery-required') { const resume = this.button('Resume controls after inspection','data-inspect'); resume.dataset.receipt = item.command.requestId; article.append(resume,node('p','Inspect the terminal before resuming. Inspection prevents delayed original delivery and never resends the control. Acknowledging uncertainty does not confirm delivery.')); } this.recovery.append(article); }
    this.historyRows.replaceChildren(); for (const result of this.results.filter(item => this.inScope(item.input.target)).slice(-50)) { const row = node('article'); row.append(node('strong',`${result.input.target.surfaceRef} · ${result.status}`),node('p',result.reason ?? (result.status === 'succeeded' ? 'Control confirmed.' : 'Control rejected.')),node('code',result.requestId)); this.historyRows.append(row); }
    this.history.hidden = this.historyRows.childElementCount === 0; this.paintSafety();
  }
}
const panel: PluginPanelModule = { mount(container,context) { if (context.services.terminal?.version !== 1) throw new Error('Terminal requires version 1 public terminal services.'); return new TerminalPanel(container,context); } };
export default panel;
