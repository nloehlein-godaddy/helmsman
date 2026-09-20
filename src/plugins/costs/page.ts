import { OUTCOME_WINDOWS, type AssessmentInput, type OutcomeWindow } from '../../data/outcomeClient';
import { ASSESSMENT_STATES, TASK_OUTCOMES, type OutcomeAssessment, type OutcomeSummary } from '../../data/outcomes';
import type { PluginPageContext, PluginPageInstance, PluginPageModule, PluginPageState } from '../sdk';
import { renderCostsContent } from './render';

export interface CostsPageServices {
  read(repo: string | null, days: OutcomeWindow, signal: AbortSignal): Promise<OutcomeSummary>;
  save(runId: string, input: AssessmentInput, signal: AbortSignal): Promise<OutcomeAssessment>;
  runHref(repo: string | null, runId: string): string;
}

interface Draft { fields: Record<string, string>; revision: number; }

export function createCostsPageModule(services: CostsPageServices): PluginPageModule {
  return { mount: (container, context) => new CostsPage(container, context, services) };
}

class CostsPage implements PluginPageInstance {
  private readonly container: HTMLElement;
  private readonly context: PluginPageContext;
  private readonly services: CostsPageServices;
  private state: PluginPageState;
  private days: OutcomeWindow = 30;
  private summary: OutcomeSummary | null = null;
  private error: string | null = null;
  private disposed = false;
  private generation = 0;
  private read: { controller: AbortController; promise: Promise<void> } | null = null;
  private saves = new Map<string, AbortController>();
  private drafts = new Map<string | null, Map<string, Draft>>();
  private errors = new Map<string, string>();

  constructor(container: HTMLElement, context: PluginPageContext, services: CostsPageServices) {
    this.container = container;
    this.context = context;
    this.services = services;
    this.state = context.state;
    context.onDispose(() => this.dispose());
    context.signal.addEventListener('abort', this.onAbort, { once: true });
    if (context.signal.aborted) { this.dispose(); return; }
    container.addEventListener('input', this.onInput);
    container.addEventListener('change', this.onChange);
    container.addEventListener('submit', this.onSubmit);
    container.addEventListener('click', this.onClick);
    this.draw();
    void this.refresh();
  }

  private onAbort = (): void => this.dispose();
  private scopedDrafts(): Map<string, Draft> {
    let drafts = this.drafts.get(this.state.repo);
    if (!drafts) { drafts = new Map(); this.drafts.set(this.state.repo, drafts); }
    return drafts;
  }

  private capture(form: HTMLFormElement): Draft | null {
    const runId = form.dataset.outcomeAssessment;
    if (!runId) return null;
    const drafts = this.scopedDrafts();
    const fields = Object.fromEntries(Array.from(new FormData(form), ([key, value]) => [key, String(value)]));
    const previous = drafts.get(runId);
    const changed = !previous || Object.entries(fields).some(([key, value]) => previous.fields[key] !== value);
    const draft = { fields, revision: (previous?.revision ?? 0) + (changed ? 1 : 0) };
    drafts.set(runId, draft);
    return draft;
  }

  private onInput = (event: Event): void => {
    const form = event.target instanceof Element ? event.target.closest<HTMLFormElement>('[data-outcome-assessment]') : null;
    if (form) this.capture(form);
  };
  private onChange = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.matches('[data-outcome-days]')) {
      const days = OUTCOME_WINDOWS.find(value => String(value) === target.value);
      if (days !== undefined && days !== this.days) {
        this.days = days;
        this.cancelRead();
        void this.refresh();
      }
    } else this.onInput(event);
  };
  private onSubmit = (event: Event): void => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-outcome-assessment]')) return;
    event.preventDefault();
    void this.save(form);
  };
  private onClick = (event: MouseEvent): void => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a.app-link') : null;
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    this.context.navigate(anchor.getAttribute('href') ?? '');
  };

  update(state: PluginPageState): void {
    if (this.disposed) return;
    const scopeChanged = this.state.repo !== state.repo;
    const becameVisible = !this.state.visible && state.visible;
    const presentationChanged = this.state.themeId !== state.themeId || this.state.pirateMode !== state.pirateMode;
    this.state = state;
    if (scopeChanged) {
      ++this.generation;
      this.cancelRead();
      for (const controller of this.saves.values()) controller.abort();
      this.saves.clear();
      this.errors.clear();
      this.summary = null;
      this.error = null;
      this.draw(false);
    } else if (presentationChanged) this.draw();
    if (!state.visible) this.cancelRead();
    else if (scopeChanged || becameVisible) void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.disposed || !this.state.visible) return Promise.resolve();
    if (this.read) return this.read.promise;
    const controller = new AbortController();
    const generation = this.generation;
    const current = () => !this.disposed && generation === this.generation && this.read?.controller === controller;
    this.error = null;
    const promise = Promise.resolve().then(() => {
      if (!current()) return;
      return this.services.read(this.state.repo, this.days, controller.signal);
    }).then(summary => {
      if (current() && summary) this.summary = summary;
    }).catch((error: unknown) => {
      if (current()) this.error = error instanceof Error ? error.message : 'Could not load outcomes.';
    }).finally(() => {
      if (!current()) return;
      this.read = null;
      this.draw();
    });
    this.read = { controller, promise };
    this.draw();
    return promise;
  }

  private cancelRead(): void {
    this.read?.controller.abort();
    this.read = null;
  }

  private async save(form: HTMLFormElement): Promise<void> {
    const runId = form.dataset.outcomeAssessment;
    if (this.disposed || !runId || !/^[a-z\d_-]{1,128}$/i.test(runId) || this.saves.has(runId)) return;
    const draft = this.capture(form);
    if (!draft) return;
    const fields = draft.fields;
    const state = ASSESSMENT_STATES.find(value => value === fields.state);
    const outcome = TASK_OUTCOMES.find(value => value === fields.outcome);
    if (!state || !outcome) return;
    const correctionRaw = fields.correctionRounds?.trim() ?? '';
    const correctionRounds = correctionRaw === '' ? null : Number(correctionRaw);
    if (correctionRounds !== null && (!Number.isSafeInteger(correctionRounds) || correctionRounds < 0)) {
      this.errors.set(runId, 'Correction rounds must be a whole non-negative number.');
      this.draw();
      return;
    }
    const controller = new AbortController();
    const generation = this.generation;
    const current = () => !this.disposed && generation === this.generation && this.saves.get(runId) === controller;
    this.saves.set(runId, controller);
    this.errors.delete(runId);
    this.draw();
    let saved = false;
    try {
      const assessment = await this.services.save(runId, {
        state, outcome, correctionRounds,
        summary: fields.summary?.trim() ?? '',
        evidence: fields.evidence?.split('\n').map(value => value.trim()).filter(Boolean) ?? [],
        failureStage: fields.failureStage?.trim() || null,
      }, controller.signal);
      if (!current()) return;
      if (this.scopedDrafts().get(runId)?.revision === draft.revision) this.scopedDrafts().delete(runId);
      if (this.summary) this.summary = { ...this.summary, recentRuns: this.summary.recentRuns.map(run => run?.runId === runId ? { ...run, assessment } : run) };
      this.cancelRead();
      saved = true;
    } catch (error: unknown) {
      if (!current()) return;
      this.errors.set(runId, error instanceof Error ? error.message : 'Could not save assessment.');
    } finally {
      if (current()) {
        this.saves.delete(runId);
        this.draw();
        if (saved) void this.refresh();
      }
    }
  }

  private draw(preserve = true): void {
    if (this.disposed) return;
    const active = document.activeElement;
    const control = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement || active instanceof HTMLButtonElement ? active : null;
    const focused = preserve && control && this.container.contains(control) ? {
      run: control.closest<HTMLFormElement>('[data-outcome-assessment]')?.dataset.outcomeAssessment,
      name: control.name,
      tag: control.tagName,
      days: control.matches('[data-outcome-days]'),
      selection: control instanceof HTMLTextAreaElement || control instanceof HTMLInputElement && control.type === 'text' ? [control.selectionStart, control.selectionEnd] as const : null,
    } : null;
    const open = new Set<string>();
    if (preserve) for (const form of this.container.querySelectorAll<HTMLFormElement>('[data-outcome-assessment]')) {
      const id = form.dataset.outcomeAssessment;
      if (form.closest('details')?.open) open.add(`${id}:main`);
      if (form.querySelector('details')?.open) open.add(`${id}:extra`);
    }
    const scroll = this.container.scrollTop;
    const parentScroll = this.container.parentElement?.scrollTop;
    this.container.innerHTML = renderCostsContent({ summary: this.summary, days: this.days, loading: Boolean(this.read), error: this.error, savingRunId: null, savingRunIds: new Set(this.saves.keys()) }, runId => this.services.runHref(this.state.repo, runId));
    for (const form of this.container.querySelectorAll<HTMLFormElement>('[data-outcome-assessment]')) {
      const id = form.dataset.outcomeAssessment;
      if (!id) continue;
      const details = form.closest('details');
      if (details) details.open = open.has(`${id}:main`);
      const extra = form.querySelector('details');
      if (extra) extra.open = open.has(`${id}:extra`);
      const draft = this.scopedDrafts().get(id);
      for (const field of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input, select, textarea, button')) {
        const value = draft?.fields[field.name];
        if (value !== undefined) field.value = value;
        if (focused && focused.run === id && focused.name === field.name && focused.tag === field.tagName) {
          field.focus({ preventScroll: true });
          if (focused.selection && (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) field.setSelectionRange(...focused.selection);
        }
      }
      const error = form.querySelector('.outcome-save-error');
      if (error) error.textContent = this.errors.get(id) ?? '';
    }
    if (focused?.days) this.container.querySelector<HTMLElement>('[data-outcome-days]')?.focus({ preventScroll: true });
    this.container.scrollTop = scroll;
    if (parentScroll !== undefined && this.container.parentElement) this.container.parentElement.scrollTop = parentScroll;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    this.cancelRead();
    for (const controller of this.saves.values()) controller.abort();
    this.saves.clear();
    this.context.signal.removeEventListener('abort', this.onAbort);
    this.container.removeEventListener('input', this.onInput);
    this.container.removeEventListener('change', this.onChange);
    this.container.removeEventListener('submit', this.onSubmit);
    this.container.removeEventListener('click', this.onClick);
  }
}
