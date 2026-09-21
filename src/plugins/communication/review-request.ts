import type { CommunicationCommandPendingV1, CommunicationCommandReceiptV1, CommunicationSettingsSnapshotV1, PluginPanelContext, PluginPanelInstance, PluginPanelModule, PluginPanelState } from '@helmsman/plugin-sdk';
import { esc, message, parseTarget, safeSlackUrl, Storage, target, validDestination, type PrTarget } from './util.js';
import { styles } from './styles.js';
function routeTarget(state: PluginPanelState): PrTarget | null {
  if (state.routeState?.version === 1 && state.routeState.value && typeof state.routeState.value === 'object') { const selected = target((state.routeState.value as Record<string, unknown>).target); if (selected) return selected; }
  return state.pullRequest?.version === 1 ? target(state.pullRequest) : null;
}
function receipt(value: unknown): value is CommunicationCommandReceiptV1 { if (!value || typeof value !== 'object') return false; const row = value as Partial<CommunicationCommandReceiptV1>; return row.version === 1 && typeof row.requestId === 'string' && !!target(row.input) && validDestination(row.input?.expectedDestination) && (row.status !== 'succeeded' || !!row.result && !!target(row.result) && validDestination(row.result.destination) && row.result.repo === row.input?.repo && row.result.number === row.input?.number) && ['succeeded', 'rejected', 'pending', 'recovery-required'].includes(row.status ?? ''); }
class ReviewRequestPanel implements PluginPanelInstance {
  private state: PluginPanelState;
  private readonly storage: Storage;
  private selected: PrTarget | null;
  private lookup = '';
  private route: string;
  private localTarget = false;
  private settings: CommunicationSettingsSnapshotV1 | null = null;
  private pending: readonly CommunicationCommandPendingV1[] = [];
  private results: CommunicationCommandReceiptV1[] = [];
  private journalsReady = false;
  private busy = false;
  private error = '';
  private storageError = '';
  private resultsError = '';
  private operation: AbortController | null = null;
  private unsupported = false;
  private disposed = false;
  private generation = 0;
  private controller: AbortController | null = null;
  private readonly container: HTMLElement;
  private readonly context: PluginPanelContext;
  constructor(container: HTMLElement, context: PluginPanelContext) {
    this.container = container; this.context = context; this.state = context.state; this.storage = new Storage(context.contributionId);
    this.selected = routeTarget(this.state); this.route = JSON.stringify(this.selected); const routed = this.selected !== null; let restoredLookup = false;
    try { const saved = this.storage.read('review-target'); if (saved !== null) { if (!saved || typeof saved !== 'object' || (saved as { version?: unknown }).version !== 1 || typeof (saved as { lookup?: unknown }).lookup !== 'string' || Object.keys(saved).some(key => !['version', 'lookup', 'target'].includes(key)) || (saved as { target?: unknown }).target !== null && !target((saved as { target?: unknown }).target)) throw new Error('Saved review-request draft is unavailable. Its original data is kept.'); const draft = saved as { lookup: string; target: unknown }; this.selected ??= target(draft.target); this.lookup = draft.lookup; restoredLookup = true; } }
    catch (error) { this.unsupported = true; this.storageError = message(error, 'Saved review-request draft unavailable.'); }
    if (this.selected && (routed || !restoredLookup)) this.lookup = `${this.selected.repo}#${this.selected.number}`;
    this.readResults(); container.addEventListener('input', this.input); container.addEventListener('keydown', this.keydown); container.addEventListener('click', this.click);
    context.onDispose(this.dispose); context.signal.addEventListener('abort', this.dispose, { once: true }); this.state.activity.signal.addEventListener('abort', this.cancel, { once: true });
    if (context.signal.aborted) this.dispose(); else { this.draw(); void this.refresh(); }
  }
  private active(generation = this.generation) { return !this.disposed && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted && generation === this.generation; }
  private cancel = () => { ++this.generation; this.controller?.abort(); this.controller = null; this.operation?.abort(); };
  dispose = () => { if (this.disposed) return; this.disposed = true; this.cancel(); this.container.removeEventListener('input', this.input); this.container.removeEventListener('keydown', this.keydown); this.container.removeEventListener('click', this.click); this.context.signal.removeEventListener('abort', this.dispose); this.state.activity.signal.removeEventListener('abort', this.cancel); };
  update(next: PluginPanelState) { if (this.disposed) return; const selected = routeTarget(next); const key = JSON.stringify(selected); const changed = this.state.activity !== next.activity || this.state.visible !== next.visible || key !== this.route; this.state.activity.signal.removeEventListener('abort', this.cancel); this.state = next; next.activity.signal.addEventListener('abort', this.cancel, { once: true }); if (key !== this.route) { this.route = key; this.localTarget = false; if (selected) { this.selected = selected; this.lookup = `${selected.repo}#${selected.number}`; } } if (changed) { this.cancel(); void this.refresh(); } this.draw(); }
  private readResults() { try { const values = this.storage.results(); if (values.some(value => !receipt(value))) throw new Error('Saved communication results use an unsupported format. Their original data is kept.'); this.results = values as CommunicationCommandReceiptV1[]; this.resultsError = ''; } catch (error) { this.resultsError = message(error, 'Saved communication results unavailable.'); } }
  private persist() { if (this.unsupported) return false; try { this.storage.save('review-target', { version: 1, lookup: this.lookup, target: this.selected }); this.storageError = ''; return true; } catch (error) { this.storageError = message(error, 'Review-request draft could not be saved.'); return false; } }
  private input = (event: Event) => { if (!(event.target instanceof HTMLInputElement) || !event.target.matches('[data-review-lookup]')) return; this.lookup = event.target.value; this.persist(); this.paintSafety(); };
  private keydown = (event: KeyboardEvent) => { if (event.key === 'Enter' && event.target instanceof Element && event.target.matches('[data-review-lookup]')) { event.preventDefault(); event.stopPropagation(); void this.select(); } };
  private click = (event: MouseEvent) => { if (!(event.target instanceof Element)) return; const link = event.target.closest<HTMLAnchorElement>('a.app-link'); if (link && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); this.context.navigate(link.getAttribute('href') ?? '/communication'); return; } const button = event.target.closest<HTMLButtonElement>('button'); if (!button || button.disabled || !this.active()) return; event.stopPropagation(); if (button.matches('[data-select-pr]')) void this.select(); else if (button.matches('[data-send-review]')) void this.send(); else if (button.matches('[data-refresh]')) void this.refresh(); else if (button.matches('[data-save-draft]')) { this.persist(); this.draw(); } else if (button.dataset.requestId && button.dataset.repo) void this.reconcile(button.dataset.repo, button.dataset.requestId, button.dataset.retry === 'true'); };
  private async select() { const selected = parseTarget(this.lookup); if (!selected) { this.error = 'Enter a GitHub PR URL or owner/name#number.'; this.draw(); return; } this.localTarget = true; this.selected = selected; this.lookup = `${selected.repo}#${selected.number}`; this.persist(); await this.refresh(); }
  private async readPending() { const values = await this.context.services.communicationCommands!.pending(); if (!Array.isArray(values) || values.some(item => !item?.command || !target(item.command) || typeof item.command.requestId !== 'string' || !validDestination(item.command.expectedDestination))) throw new Error('Communication journal unavailable. Existing requests are kept.'); this.pending = values; this.journalsReady = true; }
  refresh = async () => {
    if (!this.active() || this.busy) return;
    const selected = this.localTarget ? this.selected : routeTarget(this.state) ?? this.selected;
    if (selected && this.state.activity.repo !== selected.repo) { try { if (!this.context.setScope) throw new Error('Explicit panel scope is unavailable.'); await this.context.setScope({ kind: 'galleon', repo: selected.repo }); } catch (error) { this.error = message(error, 'Explicit panel scope unavailable.'); this.draw(); } if (this.state.activity.repo !== selected.repo) return; }
    this.cancel(); const generation = this.generation; const controller = new AbortController(); this.controller = controller; this.journalsReady = false;
    const results = await Promise.allSettled([this.context.services.communication!.settings(controller.signal), this.readPending()]); if (!this.active(generation)) return;
    const settings = results[0]; if (settings.status === 'fulfilled' && settings.value?.status === 'available' && settings.value.value?.version === 1 && settings.value.value.values && typeof settings.value.value.values.enabled === 'boolean' && (settings.value.value.destination === null || validDestination(settings.value.value.destination))) { this.settings = settings.value.value; this.error = ''; } else { this.settings = null; this.error = 'Review destination unavailable. Existing requests are kept.'; }
    if (results[1].status === 'rejected') { this.journalsReady = false; this.error = 'Communication journal unavailable. Existing requests are kept.'; }
    this.readResults(); this.draw();
  };
  private currentPending() { return this.pending.some(item => item.command.repo === this.selected?.repo && item.command.number === this.selected.number); }
  private currentResult() { return this.results.find(item => item.status === 'succeeded' && item.input.repo === this.selected?.repo && item.input.number === this.selected.number); }
  private async send() {
    if (!this.selected || !this.settings?.destination || !this.settings.values.enabled || !this.journalsReady || this.busy || this.currentPending() || this.currentResult() || this.resultsError || !this.persist()) return;
    const input = { version: 1 as const, ...this.selected, expectedDestination: { ...this.settings.destination } };
    await this.command(async signal => { await this.readPending(); if (signal.aborted || !this.active()) throw new Error('Request canceled before submission.'); if (this.pending.some(item => item.command.repo === input.repo && item.command.number === input.number)) throw new Error('Reconcile the original request before sending another.'); const result = await this.context.services.communicationCommands!.submit(input, signal); if (result?.status !== 'available') throw new Error('Request result unavailable. Check the retained request before retrying.'); await this.consume(result.value); });
  }
  private async consume(value: CommunicationCommandReceiptV1) {
    if (!receipt(value)) throw new Error('Communication result unavailable. Original request evidence is kept.'); this.error = value.reason ?? `Review request ${value.status}.`;
    if (value.status !== 'succeeded' && value.status !== 'rejected') return;
    this.storage.result(`${value.input.repo}:${value.requestId}`, value); this.readResults();
    await this.context.services.communicationCommands!.acknowledge({ repo: value.input.repo, requestId: value.requestId });
  }
  private async command(action: (signal: AbortSignal) => Promise<void>) { this.operation = new AbortController(); const signal = AbortSignal.any([this.operation.signal, this.context.signal, this.state.activity.signal]); this.busy = true; this.error = ''; this.draw(); try { await action(signal); } catch (error) { this.error = message(error, 'Communication result unavailable. Original request evidence is kept.'); } finally { try { await this.readPending(); } catch { this.journalsReady = false; } this.busy = false; this.operation = null; this.draw(); } }
  private async reconcile(repo: string, requestId: string, retry: boolean) {
    if (this.busy) return; await this.command(async signal => { const original = this.pending.find(item => item.command.repo === repo && item.command.requestId === requestId); if (!original) throw new Error('Original request is no longer retained.'); const service = this.context.services.communicationCommands!; const result = retry ? await service.retry({ repo, requestId }, signal) : await service.receipt({ repo, requestId }, signal); if (result?.status === 'available' && result.value) await this.consume(result.value); else throw new Error('Original receipt unavailable. Its request identity is kept.'); });
  }
  private paintSafety() { const send = this.container.querySelector<HTMLButtonElement>('[data-send-review]'); if (send) send.disabled = !this.active() || this.busy || !this.selected || !this.settings?.values.enabled || !this.settings.destination || !this.journalsReady || Boolean(this.storageError || this.resultsError) || this.currentPending() || Boolean(this.currentResult()); const alert = this.container.querySelector('[data-storage-error]'); if (alert) alert.textContent = [this.storageError, this.resultsError].filter(Boolean).join(' '); }
  private draw() {
    if (this.disposed) return; const focus = document.activeElement instanceof HTMLInputElement && this.container.contains(document.activeElement) ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] as const : null; const destination = this.settings?.destination;
    this.container.innerHTML = `<section class="plugin-communication communication-request"><style>${styles}</style><h2>Request a Slack ${this.state.pirateMode ? 'inspection' : 'review'}</h2><label class="interface-field">PR URL or owner/name#number<input data-review-lookup aria-label="Pull request target" maxlength="2048" value="${esc(this.lookup)}"></label><div class="communication-tools"><button data-select-pr>Load PR</button><button data-refresh>Refresh destination and requests</button></div>${this.selected ? `<p class="communication-target">${esc(this.selected.repo)} #${this.selected.number}</p>` : ''}<p class="communication-destination">${destination ? `Destination: ${esc(destination.workspace)} · #${esc(destination.channel.replace(/^#/, ''))}${destination.mention ? ` · ${esc(destination.mention)}` : ''}` : 'Destination unavailable.'}</p>${this.settings && !this.settings.values.enabled ? '<p>Slack integration is disabled. Existing requests remain available for reconciliation.</p>' : ''}<p role="alert" data-storage-error>${esc([this.storageError, this.resultsError].filter(Boolean).join(' '))}</p>${this.error ? `<p role="status" class="slack-review-result">${esc(this.error)}</p>` : ''}<div class="communication-tools"><button data-send-review>Send review request</button><button data-save-draft>Save draft</button></div><p>Messages are sent only when you choose Send review request or explicitly retry an original request.</p>${this.pending.map(item => `<article><h3>${esc(item.command.repo)} #${item.command.number} · ${esc(item.receipt?.status ?? 'Uncertain result')}</h3><p>Original destination: ${esc(item.command.expectedDestination.workspace)} · #${esc(item.command.expectedDestination.channel)} · ${esc(item.command.expectedDestination.mention)}</p><code>${esc(item.command.requestId)}</code><div class="communication-tools"><button data-repo="${esc(item.command.repo)}" data-request-id="${esc(item.command.requestId)}">Check original receipt</button><button data-repo="${esc(item.command.repo)}" data-request-id="${esc(item.command.requestId)}" data-retry="true">Retry original request</button>${item.receipt?.status === 'recovery-required' ? '<a class="app-link" href="/recovery">Open Core Recovery ↗</a>' : ''}</div></article>`).join('')}${this.results.filter(value => this.state.activity.repo === null || value.input.repo === this.state.activity.repo).map(value => { const link = safeSlackUrl(value.result?.permalink); return `<article class="communication-saved-result"><h3>${esc(value.input.repo)} #${value.input.number} · ${esc(value.status)}</h3><p>${value.status === 'succeeded' ? `Sent to #${esc(value.result?.destination.channel)} · ${esc(value.result?.destination.mention)}` : esc(value.reason)}</p>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">View message ↗</a>` : ''}</article>`; }).join('')}</section>`;
    if (!this.active() || this.busy) this.container.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach(control => { control.disabled = true; }); this.paintSafety(); if (focus) { const input = this.container.querySelector<HTMLInputElement>('[data-review-lookup]'); input?.focus({ preventScroll: true }); input?.setSelectionRange(...focus); }
  }
}
const panel: PluginPanelModule = { mount(container, context) { if (context.services.communication?.version !== 1 || context.services.communicationCommands?.version !== 1) throw new Error('Review requests require version 1 public communication services.'); return new ReviewRequestPanel(container, context); } };
export default panel;
