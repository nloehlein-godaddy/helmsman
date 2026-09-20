import { afterEach, describe, expect, it, vi } from 'vitest';
import alternative from '../../../examples/plugins/costs-summary/page';
import type { PluginPageInstance, PluginPageServices, PricingEstimate, UsageSnapshot } from '@helmsman/plugin-sdk';

const usages = (repo = 'org/a', observedCostUsd: number | null = 2): UsageSnapshot => ({
  version: 1, repo, currency: 'USD', window: { from: '2026-01-01', to: '2026-01-30' }, runs: [],
  records: ['one', 'two'].map(eventId => ({ runId: 'run', attempt: 1, eventId, provider: 'example', model: null,
    inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, costUsd: null })),
  reported: { observedCostUsd, knownCostUsd: observedCostUsd, runsWithKnownCost: 0, runsWithoutUsage: 0,
    inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null },
});
const price: PricingEstimate = { version: 1, currency: 'USD', estimatedUnreportedCostUsd: 3,
  estimatedUsageEvents: 1, unreportedUsageEvents: 2, provenance: { source: 'Independent policy', rateVersion: 'v1', asOf: '2026-01-01' } };
const instances: PluginPageInstance[] = [];
afterEach(() => { instances.splice(0).forEach(instance => instance.dispose()); document.body.replaceChildren(); });

async function mount(options: { query?: PluginPageServices['usage']['query']; estimate?: PluginPageServices['pricing']['estimate'] } = {}) {
  const services: PluginPageServices = { version: 1,
    usage: { query: vi.fn(options.query ?? (async () => usages())) },
    pricing: { estimate: vi.fn(options.estimate ?? (async () => price)) },
    outcomes: { summary: vi.fn(), assessment: vi.fn() },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const controller = new AbortController();
  const state = { repo: 'org/a', themeId: 'default', pirateMode: false, visible: true, pane: null };
  const instance = await alternative.mount(container, { state, services, signal: controller.signal, navigate() {}, onDispose() {} });
  instances.push(instance);
  return { services, container, instance, state, controller };
}

describe('independent Costs sample', () => {
  it('reads only public usage/pricing and renders estimates separately with provenance', async () => {
    const { services, container, instance } = await mount();
    await instance.refresh?.();
    expect(container.querySelector('[data-recorded-usage]')?.textContent).toContain('Reported spend: $2.0000 USD');
    expect(container.querySelector('[data-estimated-usage]')?.textContent).toContain('Unreported usage estimate: $3.0000 USD');
    expect(container.querySelector('[data-estimated-usage]')?.textContent).toContain('Independent policy · v1 · 2026-01-01');
    expect(services.outcomes.summary).not.toHaveBeenCalled();
    expect(services.outcomes.assessment).not.toHaveBeenCalled();
  });

  it.each(['missing', 'failed'] as const)('keeps measured spend when pricing is %s', async state => {
    const { container, instance } = await mount({ estimate: async () => {
      if (state === 'failed') throw new Error('Unavailable');
      return null;
    } });
    await instance.refresh?.();
    expect(container.querySelector('[data-recorded-usage]')?.textContent).toContain('$2.0000');
    expect(container.querySelector('[data-estimated-usage]')?.textContent).toContain('Estimate: Unknown');
    expect(container.querySelector('[data-estimated-usage]')?.textContent).not.toContain('$0');
  });

  it('aborts old scope reads and ignores late completions after scope change or disposal', async () => {
    let resolve!: (usage: UsageSnapshot) => void;
    let aborted: AbortSignal | undefined;
    const pending = new Promise<UsageSnapshot>(done => { resolve = done; });
    const { container, instance, state, controller } = await mount({ query: async (input, signal) => {
      if (input.repo === 'org/a') { aborted = signal; return pending; }
      return usages('org/b', 8);
    } });
    await instance.update({ ...state, repo: 'org/b', pirateMode: true });
    await instance.refresh?.();
    expect(aborted?.aborted).toBe(true);
    expect(container.textContent).toContain('Galleon: org/b');
    expect(container.querySelector('[data-recorded-usage]')?.textContent).toContain('$8.0000');
    controller.abort();
    const before = container.innerHTML;
    resolve(usages('org/a', 999));
    await Promise.resolve();
    await Promise.resolve();
    expect(container.innerHTML).toBe(before);
  });

  it('does not read data while hidden and refreshes on visibility restoration', async () => {
    const { services, instance, state } = await mount();
    await instance.refresh?.();
    vi.mocked(services.usage.query).mockClear();
    await instance.update({ ...state, visible: false });
    await instance.refresh?.();
    expect(services.usage.query).not.toHaveBeenCalled();
    await instance.update(state);
    await instance.refresh?.();
    expect(services.usage.query).toHaveBeenCalledOnce();
  });

  it('does not attach aggregate pricing from a changed usage snapshot', async () => {
    const { container, instance } = await mount({ estimate: async () => ({ ...price, unreportedUsageEvents: 3 }) });
    await instance.refresh?.();
    expect(container.querySelector('[data-recorded-usage]')?.textContent).toContain('$2.0000');
    expect(container.querySelector('[data-estimated-usage]')?.textContent).toContain('Estimate: Unknown');
  });
});
