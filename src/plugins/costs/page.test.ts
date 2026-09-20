import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCostsPageModule, type CostsPageServices } from './page';
import type { PluginPageInstance, PluginPageState } from '../sdk';
import type { OutcomeAssessment, OutcomeSummary } from '../../data/outcomes';
import { fetchOutcomes, saveOutcomeAssessment } from '../../data/outcomeClient';

const state: PluginPageState = { repo: 'org/a', themeId: 'default', pirateMode: false, visible: true, pane: null };
const assessment: OutcomeAssessment = { runId: 'run_1', state: 'complete', outcome: 'unknown', summary: 'saved', evidence: [], failureStage: null, correctionRounds: null, updatedAt: '' };
const summary = (repo = 'org/a', label = ''): OutcomeSummary => ({ window: { from: '2026-01-01', to: '2026-01-30' }, repo, runs: 2, execution: { succeeded: 2, failed: 0, stopped: 0, running: 0 }, assessments: { complete: 0, partial: 0, failed: 0, 'not-assessed': 2 }, outcomes: { achieved: 0, partial: 0, 'not-achieved': 0, unknown: 2 }, knownCostUsd: null, observedCostUsd: null, runsWithKnownCost: 0, costCoverage: null, averageCostUsd: null, averageDurationMs: null, runsWithDuration: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, linkedPrs: 0, unknownPrs: 0, stalePrs: 0, unavailablePrs: 0, publishedPrs: 0, reviewedPrs: 0, mergedPrs: 0, costPerPublishedPrUsd: null, costPerReviewedPrUsd: null, costPerMergedPrUsd: null, correctionRounds: null, failures: [], daily: [], recentRuns: [1, 2].map(id => ({ runId: `run_${id}${label}`, repo, status: 'succeeded', prNumber: null, startedAt: '', durationMs: null, costUsd: null, observedCostUsd: null, assessment: null })) });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const instances: PluginPageInstance[] = [];
afterEach(() => { instances.splice(0).forEach(instance => instance.dispose()); vi.unstubAllGlobals(); document.body.innerHTML = ''; });
async function mount(overrides: Partial<CostsPageServices> = {}, initial = state) {
  const container = document.createElement('div'); document.body.append(container);
  const services = { read: vi.fn(async () => summary()), save: vi.fn(async () => assessment), runHref: (repo: string | null, run: string) => `/runs?repo=${repo}&run=${run}`, ...overrides };
  const controller = new AbortController();
  const instance = await createCostsPageModule(services).mount(container, { state: initial, signal: controller.signal, navigate: vi.fn(), onDispose: vi.fn() });
  instances.push(instance);
  return { container, services, instance, controller };
}
const form = (root: HTMLElement, id = 'run_1') => root.querySelector<HTMLFormElement>(`[data-outcome-assessment="${id}"]`)!;
function edit(root: HTMLElement, value: string, id = 'run_1') {
  const field = form(root, id).querySelector<HTMLTextAreaElement>('[name="summary"]')!;
  field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); return field;
}
const value = (root: HTMLElement, id = 'run_1') => form(root, id).querySelector<HTMLTextAreaElement>('[name="summary"]')?.value;
const submit = (root: HTMLElement, id = 'run_1') => form(root, id).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

describe('Costs page lifecycle', () => {
  it('shows an initial malformed read as a recoverable error without an unhandled rejection', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...summary(), window: null })));
    vi.stubGlobal('fetch', fetchMock);
    const { container, instance } = await mount({ read: fetchOutcomes });
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('Outcomes response was invalid.'));
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(summary())));
    await instance.refresh?.();
    expect(container.querySelector('[data-outcome-assessment="run_1"]')).not.toBeNull();
  });

  it('preserves the last good page and drafts when a refresh contains malformed nested assessments', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(summary())));
    vi.stubGlobal('fetch', fetchMock);
    const { container, instance } = await mount({ read: fetchOutcomes });
    await instance.refresh?.();
    edit(container, 'Keep this unsaved draft');
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ...summary(), recentRuns: [
      { ...summary().recentRuns[0], assessment: { ...assessment, evidence: 'unexpected' } },
    ] })));
    await instance.refresh?.();
    expect(container.querySelector('.outcome-inline-error')?.textContent).toBe('Outcomes response was invalid.');
    expect(value(container)).toBe('Keep this unsaved draft');
    expect(form(container, 'run_2')).not.toBeNull();
  });

  it.each([
    { ...assessment, evidence: 'unexpected' },
    { ...assessment, runId: 'another_run' },
  ])('retains drafts when the API returns an invalid successful assessment: %j', async invalid => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ assessment: { ...invalid, updatedAt: '2026-09-20T12:00:00Z' } }))));
    const { container, instance } = await mount({ save: saveOutcomeAssessment });
    await instance.refresh?.(); edit(container, 'Keep the submitted draft'); edit(container, 'Keep the other draft', 'run_2');
    submit(container);
    await vi.waitFor(() => expect(form(container).querySelector('[role="alert"]')?.textContent).toBe('Assessment response was invalid.'));
    expect(value(container)).toBe('Keep the submitted draft'); expect(value(container, 'run_2')).toBe('Keep the other draft');
    expect(form(container).querySelector('button')?.disabled).toBe(false);
    await instance.refresh?.(); expect(value(container)).toBe('Keep the submitted draft');
  });

  it('retains both drafts and form state after a failed save', async () => {
    const pending = deferred<OutcomeAssessment>();
    const { container, instance } = await mount({ save: () => pending.promise }); await instance.refresh?.();
    const field = edit(container, 'first draft'); edit(container, 'other draft', 'run_2');
    form(container).closest('details')!.open = true; form(container).querySelector('details')!.open = true;
    field.focus(); field.setSelectionRange(2, 4); container.scrollTop = 123;
    submit(container);
    expect(value(container)).toBe('first draft'); expect(value(container, 'run_2')).toBe('other draft');
    pending.reject(new Error('Save unavailable'));
    await vi.waitFor(() => expect(container.textContent).toContain('Save unavailable'));
    expect(value(container)).toBe('first draft'); expect(value(container, 'run_2')).toBe('other draft');
    expect(form(container).closest('details')?.open).toBe(true); expect(form(container).querySelector('details')?.open).toBe(true);
    expect(document.activeElement).toBe(form(container).querySelector('[name="summary"]'));
    expect((document.activeElement as HTMLTextAreaElement).selectionStart).toBe(2); expect(container.scrollTop).toBe(123);
  });

  it('keeps newer edits and other run drafts when a save completes', async () => {
    const pending = deferred<OutcomeAssessment>();
    const { container, instance } = await mount({ save: () => pending.promise }); await instance.refresh?.();
    edit(container, 'submitted'); edit(container, 'other', 'run_2'); submit(container); edit(container, 'newer');
    pending.resolve(assessment);
    await vi.waitFor(() => expect(form(container).querySelector('button')?.disabled).toBe(false));
    expect(value(container)).toBe('newer'); expect(value(container, 'run_2')).toBe('other');
    await instance.refresh?.(); expect(value(container)).toBe('newer');
  });

  it('refreshes and changes period while editing without losing drafts', async () => {
    const read = vi.fn(async (_repo: string | null, days: number) => ({ ...summary(), runs: days }));
    const { container, instance } = await mount({ read }); await instance.refresh?.(); edit(container, 'keep');
    const select = container.querySelector<HTMLSelectElement>('[data-outcome-days]')!; select.value = '90'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await instance.refresh?.(); expect(read).toHaveBeenLastCalledWith('org/a', 90, expect.any(AbortSignal));
    expect(container.querySelector('.outcome-stat b')?.textContent).toBe('90'); expect(value(container)).toBe('keep');
    await instance.refresh?.(); expect(read).toHaveBeenCalledTimes(3);
  });

  it('isolates drafts by scope and ignores a late rejected write', async () => {
    const pending = deferred<OutcomeAssessment>(); let writeSignal: AbortSignal | undefined;
    const { container, instance } = await mount({ read: async repo => summary(repo ?? ''), save: (_id, _input, signal) => { writeSignal = signal; return pending.promise; } });
    await instance.refresh?.(); edit(container, 'scope A'); submit(container);
    await instance.update({ ...state, repo: 'org/b' }); await instance.refresh?.();
    expect(writeSignal?.aborted).toBe(true); expect(value(container)).toBe(''); edit(container, 'scope B');
    pending.reject(new Error('old failure')); await Promise.resolve(); await Promise.resolve();
    expect(container.textContent).not.toContain('old failure'); expect(value(container)).toBe('scope B');
    await instance.update(state); await instance.refresh?.(); expect(value(container)).toBe('scope A');
  });

  it('coalesces refreshes and aborts stale reads on scope change', async () => {
    const pending = deferred<OutcomeSummary>(); let readSignal: AbortSignal | undefined;
    const read = vi.fn((repo: string | null, _days: number, signal: AbortSignal) => { if (repo === 'org/a') { readSignal = signal; return pending.promise; } return Promise.resolve(summary('org/b', '_b')); });
    const { container, instance } = await mount({ read });
    const first = instance.refresh?.(); const second = instance.refresh?.(); expect(first).toBe(second);
    await instance.update({ ...state, repo: 'org/b' }); await instance.refresh?.(); expect(readSignal?.aborted).toBe(true);
    pending.resolve(summary('org/a', '_old')); await first;
    expect(container.textContent).toContain('run_1_b'); expect(container.textContent).not.toContain('run_1_old');
  });

  it('aborts read and write work on disposal and cannot redraw after completion', async () => {
    const pending = deferred<OutcomeAssessment>(); const readPending = deferred<OutcomeSummary>(); let writeSignal: AbortSignal | undefined; let readSignal: AbortSignal | undefined;
    const read = vi.fn(async () => summary());
    const { container, instance, controller } = await mount({ read, save: (_id, _input, signal) => { writeSignal = signal; return pending.promise; } });
    await instance.refresh?.(); edit(container, 'draft'); submit(container);
    read.mockImplementationOnce((_repo?: string | null, _days?: number, signal?: AbortSignal) => { readSignal = signal; return readPending.promise; });
    const loading = instance.refresh?.(); await Promise.resolve(); controller.abort();
    expect(writeSignal?.aborted).toBe(true); expect(readSignal?.aborted).toBe(true);
    container.textContent = 'replacement'; pending.reject(new Error('late')); readPending.resolve(summary()); await loading; await Promise.resolve();
    expect(container.textContent).toBe('replacement');
  });

  it('does not poll while hidden and resumes on visibility update', async () => {
    const { services, instance } = await mount({}, { ...state, visible: false }); await instance.refresh?.(); expect(services.read).not.toHaveBeenCalled();
    await instance.update(state); await instance.refresh?.(); expect(services.read).toHaveBeenCalledTimes(1);
    await instance.update({ ...state, visible: false }); await instance.refresh?.(); expect(services.read).toHaveBeenCalledTimes(1);
  });
});
