import { getPrStatus, getPrDiff, submitReview, type PrStatusView } from './data/pr';
import { requestSlackReview, SlackReviewRequestError, type SlackReviewResult } from './data/slackReview';
import { launchRun, type LaunchResult } from './data/agents';
import { POLL_MS } from './data/live';
import { term } from './logic/terminology';
import type { PrViewState } from './render';
import type { PrFileDiff } from './types';

export interface PrIdentity { repo: string; number: number; }
export interface PrTarget extends PrIdentity { panel: HTMLElement; }
interface Read<T> { controller: AbortController; owners: Set<object>; promise: Promise<T | null>; }
interface Entry { status: PrStatusView | null; diff: PrFileDiff[] | null; statusAt: number; diffAt: number; statusRead?: Read<PrStatusView>; statusRefresh?: Promise<PrStatusView | null>; diffRead?: Read<PrFileDiff[]>; }
interface SlackRequest { requestId: string; pending: boolean; error?: string; result?: SlackReviewResult; }
interface ReviewRequest { requestId: string; pending: boolean; error?: string; }
const key = (identity: PrIdentity) => JSON.stringify([identity.repo, identity.number]);
const fields = ['pr-review-body', 'pr-rerun-feedback', 'pr-model', 'pr-effort'] as const;
type Field = typeof fields[number];
export interface PrFocus { identity: string; occurrence: number; field: Field; start: number | null; end: number | null; }
const bindings = new WeakMap<HTMLElement, PrCompatibilitySession>();
export function bindPrCompatibilitySession(root: HTMLElement, session: PrCompatibilitySession): () => void {
  bindings.set(root, session); return () => { if (bindings.get(root) === session) bindings.delete(root); };
}
export function findPrCompatibilitySession(container: HTMLElement): PrCompatibilitySession | null {
  for (let node: HTMLElement | null = container; node; node = node.parentElement) { const session = bindings.get(node); if (session) return session; }
  return null;
}
export function prTarget(button: HTMLElement): PrTarget | null {
  const panel = button.closest<HTMLElement>('.pr-panel'); const repo = panel?.dataset.prRepo; const number = Number(panel?.dataset.prNumber);
  return panel && repo && Number.isSafeInteger(number) && number > 0 ? { panel, repo, number } : null;
}
export class PrCompatibilitySession {
  view: PrViewState = { repo: null, number: null, pr: null, diff: null, loading: false };
  private viewVersion = 0;
  private disposed = false;
  private readonly owners = new Set<object>();
  private readonly entries = new Map<string, Entry>();
  private readonly drafts = new Map<string, Partial<Record<Field, string>>>();
  private readonly reviews = new Map<string, ReviewRequest>();
  private readonly reviewErrors = new Map<string, string>();
  private readonly slack = new Map<string, SlackRequest>();
  private readonly launches = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly observed = new WeakMap<Element, string>();
  private readonly environment: { repos?: () => readonly string[]; headerRepo?: () => string | null; slackEnabled?: () => boolean };
  constructor(environment: PrCompatibilitySession['environment'] = {}) { this.environment = environment; }
  canLaunch(repo: string): boolean { return this.environment.repos?.().includes(repo) ?? false; }
  headerRepo(): string | null { return this.environment.headerRepo?.() ?? null; }
  slackEnabled(): boolean { return this.environment.slackEnabled?.() ?? false; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify() { if (!this.disposed) for (const listener of [...this.listeners]) listener(); }
  active(owner: object): boolean { return !this.disposed && this.owners.has(owner); }
  setActive(owner: object, active: boolean): void {
    if (this.disposed) return;
    if (active) { this.owners.add(owner); return; }
    this.owners.delete(owner);
    for (const entry of this.entries.values()) for (const name of ['statusRead', 'diffRead'] as const) {
      const read = entry[name]; if (!read) continue;
      read.owners.delete(owner);
      if (!read.owners.size) { read.controller.abort(); delete entry[name]; }
    }
  }
  dispose(): void { for (const owner of [...this.owners]) this.setActive(owner, false); this.disposed = true; this.listeners.clear(); }
  select(repo: string | null, number: number | null): void {
    ++this.viewVersion;
    const entry = repo && number ? this.entries.get(key({ repo, number })) : null;
    this.view = { repo, number, pr: entry?.status ?? null, diff: entry?.diff ?? null, loading: false };
  }
  private entry(identity: PrIdentity): Entry {
    const id = key(identity); let entry = this.entries.get(id);
    if (!entry) { entry = { status: null, diff: null, statusAt: -Infinity, diffAt: -Infinity }; this.entries.set(id, entry); }
    return entry;
  }
  status(identity: PrIdentity): PrStatusView | null { return this.entries.get(key(identity))?.status ?? null; }
  diff(identity: PrIdentity): PrFileDiff[] | null { return this.entries.get(key(identity))?.diff ?? null; }
  async readStatus(owner: object, identity: PrIdentity, force = false): Promise<PrStatusView | null> {
    const entry = this.entry(identity); if (!this.active(owner)) return entry.status;
    if (entry.statusRead) {
      entry.statusRead.owners.add(owner);
      if (!force) return entry.statusRead.promise;
      if (!entry.statusRefresh) {
        const pending = entry.statusRead;
        entry.statusRefresh = pending.promise.then(() => {
          if (pending.controller.signal.aborted) return entry.status;
          const nextOwner = [...pending.owners].find(candidate => this.active(candidate));
          return nextOwner ? this.readStatus(nextOwner, identity, true) : entry.status;
        }).finally(() => { delete entry.statusRefresh; });
      }
      return entry.statusRefresh;
    }
    if (!force && Date.now() - entry.statusAt < POLL_MS) return entry.status;
    const controller = new AbortController();
    const read: Read<PrStatusView> = { controller, owners: new Set([owner]), promise: Promise.resolve(null) };
    entry.statusRead = read;
    read.promise = getPrStatus(identity.repo, identity.number, controller.signal).then(status => {
      if (entry.statusRead !== read || controller.signal.aborted || this.disposed) return null;
      entry.status = status; entry.statusAt = status ? Date.now() : -Infinity;
      if (this.view.repo === identity.repo && this.view.number === identity.number) this.view = { ...this.view, pr: status };
      this.notify(); return status;
    }).finally(() => { if (entry.statusRead === read) delete entry.statusRead; });
    return read.promise;
  }
  async readDiff(owner: object, identity: PrIdentity, force = false): Promise<PrFileDiff[] | null> {
    const entry = this.entry(identity); if (!this.active(owner)) return entry.diff;
    if (entry.diffRead) { entry.diffRead.owners.add(owner); return entry.diffRead.promise; }
    if (!force && Date.now() - entry.diffAt < POLL_MS) return entry.diff;
    const controller = new AbortController();
    const read: Read<PrFileDiff[]> = { controller, owners: new Set([owner]), promise: Promise.resolve(null) };
    entry.diffRead = read;
    read.promise = getPrDiff(identity.repo, identity.number, controller.signal).then(diff => {
      if (entry.diffRead !== read || controller.signal.aborted || this.disposed) return null;
      entry.diff = diff; entry.diffAt = diff ? Date.now() : -Infinity; this.notify(); return diff;
    }).finally(() => { if (entry.diffRead === read) delete entry.diffRead; });
    return read.promise;
  }
  async loadView(owner: object, identity: PrIdentity): Promise<void> {
    this.select(identity.repo, identity.number); const version = this.viewVersion;
    this.view = { ...this.view, loading: true };
    const [pr, diff] = await Promise.all([this.readStatus(owner, identity), this.readDiff(owner, identity)]);
    if (version === this.viewVersion && this.active(owner)) this.view = { ...identity, pr, diff, loading: false };
  }
  capture(root: ParentNode): PrFocus | null {
    let focus: PrFocus | null = null;
    const occurrences = new Map<string, number>();
    for (const panel of root.querySelectorAll<HTMLElement>('.pr-panel[data-pr-repo]')) {
      const target = prTarget(panel); if (!target) continue;
      const id = key(target); const draft = this.drafts.get(id) ?? {};
      const occurrence = occurrences.get(id) ?? 0; occurrences.set(id, occurrence + 1);
      for (const field of fields) {
        const control = panel.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`.${field}`); if (!control) continue;
        const observed = this.observed.get(control);
        if (draft[field] === undefined || observed !== undefined && observed !== control.value) draft[field] = control.value;
        this.observed.set(control, control.value);
        if (document.activeElement === control) focus = { identity: id, occurrence, field, start: control instanceof HTMLTextAreaElement ? control.selectionStart : null, end: control instanceof HTMLTextAreaElement ? control.selectionEnd : null };
      }
      this.drafts.set(id, draft);
    }
    return focus;
  }
  restore(root: ParentNode, focus: PrFocus | null = null): void {
    const occurrences = new Map<string, number>();
    for (const panel of root.querySelectorAll<HTMLElement>('.pr-panel[data-pr-repo]')) {
      const target = prTarget(panel); if (!target) continue;
      const id = key(target); const draft = this.drafts.get(id);
      const occurrence = occurrences.get(id) ?? 0; occurrences.set(id, occurrence + 1);
      for (const field of fields) {
        const control = panel.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`.${field}`); if (!control) continue;
        if (draft?.[field] !== undefined) control.value = draft[field];
        this.observed.set(control, control.value);
        if (focus?.identity === id && focus.occurrence === occurrence && focus.field === field) { control.focus({ preventScroll: true }); if (control instanceof HTMLTextAreaElement) control.setSelectionRange(focus.start, focus.end); }
      }
      panel.querySelectorAll('.pr-review-error').forEach(value => value.remove());
      const error = this.reviewErrors.get(id);
      if (error) { const node = document.createElement('div'); node.className = 'pr-review-error'; node.textContent = error; panel.querySelector('.pr-review')?.append(node); }
    }
  }
  async review(owner: object, target: PrTarget, event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'): Promise<boolean> {
    if (!this.active(owner)) return false;
    this.capture(target.panel.parentElement ?? target.panel);
    const body = target.panel.querySelector<HTMLTextAreaElement>('.pr-review-body')?.value ?? '';
    if (event !== 'APPROVE' && !body.trim()) return false;
    const head = target.panel.dataset.prHeadSha; const id = JSON.stringify([target.repo, target.number, event, body, head]);
    const previous = this.reviews.get(id); if (previous?.pending) return false;
    const request = previous ?? { requestId: crypto.randomUUID(), pending: false }; request.pending = true; this.reviews.set(id, request);
    const result = await submitReview(target.repo, target.number, event, body, request.requestId, head); request.pending = false;
    if (!result.ok) { this.reviewErrors.set(key(target), result.error ?? term('reviewFailed')); this.notify(); return false; }
    this.reviews.delete(id); this.reviewErrors.delete(key(target));
    const entry = this.entry(target);
    const interested = new Set([owner, ...(entry.statusRead?.owners ?? [])]);
    entry.statusRead?.controller.abort(); delete entry.statusRead; entry.statusAt = -Infinity;
    await Promise.all([...interested].filter(candidate => this.active(candidate)).map(candidate => this.readStatus(candidate, target)));
    this.notify(); return true;
  }
  async launch(owner: object, target: PrTarget, mode: 'review' | 'rerun'): Promise<{ result?: LaunchResult; error?: string } | null> {
    if (!this.active(owner)) return null;
    this.capture(target.panel.parentElement ?? target.panel);
    const feedback = target.panel.querySelector<HTMLTextAreaElement>('.pr-rerun-feedback')?.value ?? '';
    if (mode === 'rerun' && !feedback.trim()) return null;
    const model = target.panel.querySelector<HTMLSelectElement>('.pr-model')?.value;
    const effort = target.panel.querySelector<HTMLSelectElement>('.pr-effort')?.value;
    const id = JSON.stringify([target.repo, target.number, mode, feedback, model, effort]); if (this.launches.has(id)) return null;
    this.launches.add(id);
    try {
      const result = await launchRun({ mode, repo: target.repo, prNumber: target.number, ...(mode === 'rerun' ? { feedback } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      return { result };
    } catch (error) { return { error: error instanceof Error ? error.message : term(mode === 'rerun' ? 'relaunchFailed' : 'reviewFailed') }; }
    finally { this.launches.delete(id); this.notify(); }
  }
  async requestSlack(owner: object, identity: PrIdentity): Promise<void> {
    if (!this.active(owner)) return;
    const id = key(identity); const previous = this.slack.get(id); if (previous?.pending || previous?.result) return;
    const state: SlackRequest = { requestId: previous?.requestId || crypto.randomUUID(), pending: true }; this.slack.set(id, state); this.notify();
    try { state.result = await requestSlackReview(identity.repo, identity.number, state.requestId); }
    catch (error) { state.error = error instanceof Error ? error.message : 'Slack request failed. Check the channel before retrying.'; if (error instanceof SlackReviewRequestError && !error.uncertain) state.requestId = ''; }
    finally { state.pending = false; this.notify(); }
  }
  paintSlack(root: ParentNode, enabled: boolean): void {
    for (const control of root.querySelectorAll<HTMLElement>('[data-slack-review-control]')) {
      const repo = control.dataset.repo; const number = Number(control.dataset.number); if (!repo || !Number.isSafeInteger(number) || number < 1) continue;
      const state = this.slack.get(key({ repo, number })); const button = control.querySelector<HTMLButtonElement>('[data-slack-review-request]'); const status = control.querySelector<HTMLElement>('.slack-review-result'); if (!button || !status) continue;
      button.disabled = !enabled || Boolean(state?.pending || state?.result); button.title = enabled ? '' : 'Enable Slack integration in Config to request a review.';
      button.textContent = state?.pending ? 'Sending…' : state?.result ? term('reviewRequested') : term('requestSlackReview');
      status.classList.toggle('is-error', Boolean(state?.error)); status.setAttribute('role', state?.error ? 'alert' : 'status'); status.replaceChildren();
      if (state?.error) status.textContent = state.error;
      else if (state?.result) {
        status.textContent = `Sent to #${state.result.channel.replace(/^#/, '')}. `;
        if (state.result.permalink) { const link = document.createElement('a'); link.href = state.result.permalink; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'View message ↗'; status.append(link); }
      }
    }
  }
}
