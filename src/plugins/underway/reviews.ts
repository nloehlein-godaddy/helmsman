import type { CommunicationCommandPendingV1, CommunicationCommandReceiptV1, CommunicationDestinationV1, PluginPanelContext, PluginPanelState, PullRequestReadItemV1, TaskContextSnapshotV1 } from '@helmsman/plugin-sdk';

type Target = Pick<NonNullable<TaskContextSnapshotV1['pullRequest']>, 'repo' | 'number'>;
const identity = (value: { repo: string; number: number }) => `${value.repo}#${value.number}`;
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string) => { const node = document.createElement(tag); node.textContent = text; return node; };
function destination(value: unknown): value is CommunicationDestinationV1 {
  return !!value && typeof value === 'object' && ['providerId', 'artifactHash', 'workspace', 'channel', 'mention', 'connectionId'].every(key => typeof (value as Record<string, unknown>)[key] === 'string');
}
function validReceipt(value: unknown): value is CommunicationCommandReceiptV1 {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CommunicationCommandReceiptV1>;
  return row.version === 1 && typeof row.requestId === 'string' && typeof row.input?.repo === 'string' && Number.isSafeInteger(row.input?.number)
    && destination(row.input?.expectedDestination) && ['succeeded', 'rejected', 'pending', 'recovery-required'].includes(row.status ?? '')
    && (row.status !== 'succeeded' || !!row.result && row.result.repo === row.input?.repo && row.result.number === row.input?.number && destination(row.result.destination));
}
function permalink(value: unknown): string | null {
  try { if (typeof value !== 'string') return null; const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname.endsWith('.slack.com') && /^\/archives\/[A-Z0-9]+\/p\d+$/.test(url.pathname) ? url.href : null; } catch { return null; }
}

export class UnderwayReviews {
  private readonly context: PluginPanelContext;
  private readonly redraw: () => void;
  private state: PluginPanelState;
  private generation = 0;
  private controller = new AbortController();
  private ready = false;
  private busy = false;
  private destination: CommunicationDestinationV1 | null = null;
  private eligible = new Set<string>();
  private entries: readonly CommunicationCommandPendingV1[] = [];
  private history: CommunicationCommandReceiptV1[] = [];
  private prepared = new Set<string>();
  private message = '';
  private storageError = false;
  constructor(context: PluginPanelContext, redraw: () => void) { this.context = context; this.state = context.state; this.redraw = redraw; }
  cancel(state = this.state) { ++this.generation; this.controller.abort(); this.controller = new AbortController(); this.state = state; this.ready = false; this.busy = false; this.destination = null; this.eligible.clear(); this.entries = []; this.history = []; this.prepared.clear(); this.message = ''; this.storageError = false; }
  private active(generation = this.generation) { return generation === this.generation && !this.controller.signal.aborted && !this.context.signal.aborted && this.state.visible && this.state.activity.active && !this.state.activity.signal.aborted; }
  private supported() { return this.context.services.communication?.version === 1 && this.context.services.communicationCommands?.version === 1 && this.context.services.pullRequests?.version === 1; }
  private storageKey() { const id = this.context.contributionId; if (!id || !/^[a-z\d][a-z\d._-]*\/[a-z\d][a-z\d._-]*$/i.test(id)) throw new Error('Contribution identity unavailable'); return `helmsman.underway.reviews.v1:${id}`; }
  private readHistory() {
    const raw = localStorage.getItem(this.storageKey());
    if (raw !== null && raw.length > 100_000) throw new Error('Saved review history unavailable');
    const history: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(history) || history.some(value => !validReceipt(value) || !['succeeded', 'rejected'].includes(value.status))) throw new Error('Saved review history unavailable');
    this.history = history;
  }
  private async readEntries(generation: number) {
    const entries = await this.context.services.communicationCommands!.pending();
    if (!this.active(generation)) return;
    if (!Array.isArray(entries) || entries.some(entry => !entry?.command || typeof entry.command.repo !== 'string' || !Number.isSafeInteger(entry.command.number) || typeof entry.command.requestId !== 'string' || !destination(entry.command.expectedDestination) || entry.receipt !== null && (!validReceipt(entry.receipt) || entry.receipt.requestId !== entry.command.requestId || identity(entry.receipt.input) !== identity(entry.command)))) throw new Error('Saved requests unavailable');
    this.entries = entries;
  }
  async refresh(state: PluginPanelState, selectedRepo: string | null = state.repo) {
    this.cancel(state); this.message = ''; this.storageError = false;
    if (!this.active() || !this.supported() || state.repo !== null && selectedRepo !== state.repo) return;
    const generation = this.generation; const signal = AbortSignal.any([this.controller.signal, this.context.signal, state.activity.signal]);
    try {
      try { this.readHistory(); } catch { this.storageError = true; throw new Error('Saved review history is unavailable. Original data is kept.'); }
      const results = await Promise.allSettled([
        this.context.services.communication!.settings(signal),
        this.context.services.pullRequests!.list({ version: 1, repo: selectedRepo, kind: 'authored-recent', limit: 100 }, signal),
        this.readEntries(generation),
      ]);
      if (!this.active(generation)) return;
      const [settings, prs, journal] = results;
      if (journal.status === 'rejected') throw new Error('Saved review requests are unavailable. Refresh before sending.');
      if (settings.status === 'fulfilled' && settings.value?.status === 'available' && settings.value.value?.values?.enabled && destination(settings.value.value.destination)) this.destination = settings.value.value.destination;
      if (prs.status === 'fulfilled' && prs.value?.status === 'available' && prs.value.value?.kind === 'authored-recent' && prs.value.value.repo === selectedRepo && ['complete', 'partial'].includes(prs.value.value.quality) && Array.isArray(prs.value.value.items)) this.eligible = new Set(prs.value.value.items.filter((pr: PullRequestReadItemV1) => pr?.status === 'open' && pr.draft === false && (selectedRepo === null || pr.repo === selectedRepo)).map(identity));
      this.ready = true;
    } catch (error) { if (this.active(generation)) { this.ready = false; this.message = error instanceof Error ? error.message : 'Review requests unavailable.'; } }
    if (this.active(generation)) this.redraw();
  }
  private retained(target: Target) { return this.entries.filter(entry => identity(entry.command) === identity(target)); }
  private past(target: Target) { return this.history.filter(receipt => identity(receipt.input) === identity(target)); }
  private canSend(target: Target) { return this.active() && this.ready && !this.busy && !this.storageError && !!this.destination && this.eligible.has(identity(target)) && !this.retained(target).length && (!this.past(target).length || this.prepared.has(identity(target))); }
  private async operation(action: (generation: number, signal: AbortSignal) => Promise<void>) {
    if (!this.active() || this.busy || !this.ready) return;
    const generation = this.generation; const signal = AbortSignal.any([this.controller.signal, this.context.signal, this.state.activity.signal]);
    this.busy = true; this.message = ''; this.redraw();
    try { await action(generation, signal); }
    catch (error) { if (this.active(generation)) this.message = error instanceof Error ? error.message : 'Review result unavailable. Check the original receipt before retrying.'; }
    finally {
      if (this.active(generation)) {
        try { await this.readEntries(generation); } catch { if (this.active(generation)) { this.ready = false; this.message = 'Saved review requests are unavailable. Refresh before sending.'; } }
        if (this.active(generation)) { this.busy = false; this.redraw(); }
      }
    }
  }
  private async send(target: Target) {
    if (!this.canSend(target) || !this.destination) return;
    const input = { version: 1 as const, repo: target.repo, number: target.number, expectedDestination: { ...this.destination } };
    await this.operation(async (generation, signal) => {
      await this.readEntries(generation);
      if (!this.active(generation) || this.retained(target).length) return;
      this.prepared.delete(identity(target));
      const result = await this.context.services.communicationCommands!.submit(input, signal);
      if (!this.active(generation)) return;
      if (result?.status !== 'available' || !validReceipt(result.value) || identity(result.value.input) !== identity(target)) throw new Error('Review result unavailable. Check the original receipt before retrying.');
      this.message = result.value.reason ?? `Review request ${result.value.status}.`;
    });
  }
  private async reconcile(entry: CommunicationCommandPendingV1, retry: boolean) {
    if (!this.entries.includes(entry) || retry && entry.receipt?.status === 'recovery-required') return;
    await this.operation(async (generation, signal) => {
      const service = this.context.services.communicationCommands!; const query = { repo: entry.command.repo, requestId: entry.command.requestId };
      const result = retry ? await service.retry(query, signal) : await service.receipt(query, signal);
      if (!this.active(generation)) return;
      if (result?.status !== 'available' || !validReceipt(result.value) || result.value.requestId !== query.requestId || identity(result.value.input) !== identity(entry.command)) throw new Error('Original receipt unavailable. Its request identity is kept.');
      this.message = result.value.reason ?? `Review request ${result.value.status}.`;
    });
  }
  private async prepare(target: Target, prepareNext = true) {
    if (prepareNext && !this.eligible.has(identity(target)) || this.storageError || this.retained(target).some(entry => !entry.receipt || !['succeeded', 'rejected'].includes(entry.receipt.status))) return;
    await this.operation(async (generation, signal) => {
      await this.readEntries(generation);
      if (!this.active(generation)) return;
      const retained = this.retained(target);
      if (retained.some(entry => !entry.receipt || !['succeeded', 'rejected'].includes(entry.receipt.status))) return;
      try {
        this.readHistory();
        const history = [...this.history];
        for (const entry of retained) if (entry.receipt && !history.some(value => value.requestId === entry.command.requestId)) history.push(entry.receipt);
        const raw = JSON.stringify(history); if (raw.length > 100_000) throw new Error('History full');
        localStorage.setItem(this.storageKey(), raw); this.history = history;
      } catch { this.storageError = true; throw new Error('Review history could not be saved. Original requests are kept.'); }
      for (const entry of retained) { if (!this.active(generation)) return; await this.context.services.communicationCommands!.acknowledge({ repo: entry.command.repo, requestId: entry.command.requestId }, signal); }
      if (this.active(generation)) { if (prepareNext) this.prepared.add(identity(target)); this.message = prepareNext ? 'Ready for another review request. Choose Request review in Slack to send.' : 'Review result archived. Delivery history is kept.'; }
    });
  }
  appendAction(row: HTMLElement, target: Target, focus: string) {
    if (!this.supported()) return;
    const generation = this.generation;
    const entries = this.retained(target); const past = this.past(target);
    const button = element('button', 'Request review in Slack'); button.type = 'button'; button.dataset.underwayFocus = focus; button.disabled = !this.canSend(target);
    button.title = !this.eligible.has(identity(target)) ? 'Requires a confirmed open, authored, non-draft pull request.' : !this.destination ? 'Configure an enabled Slack review destination.' : `Send to ${this.destination.workspace} · #${this.destination.channel.replace(/^#/, '')}`;
    button.addEventListener('click', () => { if (this.active(generation)) void this.send(target); }); row.append(button);
    if (this.destination) row.append(element('small', `Slack: ${this.destination.workspace} · #${this.destination.channel.replace(/^#/, '')}${this.destination.mention ? ` · ${this.destination.mention}` : ''}`));
    if ((entries.length || past.length) && entries.every(entry => entry.receipt && ['succeeded', 'rejected'].includes(entry.receipt.status)) && !this.prepared.has(identity(target))) {
      const prepare = element('button', 'Prepare another review request'); prepare.type = 'button'; prepare.dataset.underwayFocus = `${focus}:prepare`; prepare.disabled = !this.active() || !this.ready || this.busy || this.storageError || !this.eligible.has(identity(target)); prepare.addEventListener('click', () => { if (this.active(generation)) void this.prepare(target); }); row.append(prepare);
    }
  }
  appendEvidence(page: HTMLElement) {
    if (!this.supported() || !this.active()) return;
    if (this.message) { const note = element('p', this.message); note.setAttribute('role', 'status'); page.append(note); }
    const visible = (repo: string) => this.state.repo === null || this.state.repo === repo;
    const receipts = new Set(this.entries.map(entry => entry.command.requestId));
    for (const entry of this.entries.filter(entry => visible(entry.command.repo))) {
      const box = this.evidence(entry.command.repo, entry.command.number, entry.receipt);
      box.append(element('small', `Original destination: ${entry.command.expectedDestination.workspace} · #${entry.command.expectedDestination.channel.replace(/^#/, '')} · ${entry.command.expectedDestination.mention}`));
      if (!entry.receipt || entry.receipt.status === 'pending') {
        for (const retry of [false, true]) { const button = element('button', retry ? 'Retry original review request' : 'Check review receipt'); button.type = 'button'; button.dataset.underwayFocus = `review:${entry.command.requestId}:${retry}`; button.disabled = this.busy || !this.ready; button.addEventListener('click', () => { void this.reconcile(entry, retry); }); box.append(button); }
      } else if (entry.receipt.status === 'recovery-required') { const link = element('a', 'Open Recovery'); link.href = '/recovery'; box.append(link); }
      if (entry.receipt?.status === 'succeeded' || entry.receipt?.status === 'rejected') {
        const archive = element('button', 'Archive review result'); archive.type = 'button'; archive.dataset.underwayFocus = `review:${entry.command.requestId}:archive`; archive.disabled = this.busy || !this.ready || this.storageError; archive.addEventListener('click', () => { void this.prepare(entry.command, false); }); box.append(archive);
      }
      page.append(box);
    }
    for (const receipt of this.history.filter(receipt => visible(receipt.input.repo) && !receipts.has(receipt.requestId))) page.append(this.evidence(receipt.input.repo, receipt.input.number, receipt));
  }
  private evidence(repo: string, number: number, receipt: CommunicationCommandReceiptV1 | null) {
    const box = element('section', ''); box.append(element('h3', `${repo} #${number} · Slack review`));
    const note = element('p', receipt?.status === 'succeeded' ? `Review requested in #${receipt.result?.destination.channel ?? ''}.` : receipt?.reason ?? `Review request ${receipt?.status ?? 'uncertain'}.`); note.setAttribute('role', 'status'); box.append(note);
    const url = permalink(receipt?.result?.permalink); if (url) { const link = element('a', 'View Slack message'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; box.append(link); }
    return box;
  }
}
