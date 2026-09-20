import type { PluginPageModule, PluginPageState, PricingEstimate, UsageSnapshot } from '@helmsman/plugin-sdk';

const format = (amount: number | null): string => amount === null ? 'Unknown' : `$${amount.toFixed(4)}`;

function currentPricing(usage: UsageSnapshot, estimate: PricingEstimate | null): PricingEstimate | null {
  const records = usage.records.filter(record => record.costUsd === null);
  if (!estimate?.records) return estimate?.unreportedUsageEvents === records.length ? estimate : null;
  const key = (record: { runId: string; attempt: number; eventId: string }) => JSON.stringify([record.runId, record.attempt, record.eventId]);
  const amounts = new Map(estimate.records.map(record => [key(record), record.estimatedCostUsd]));
  const priced = records.map(record => amounts.get(key(record))).filter((amount): amount is number => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0);
  return { ...estimate, unreportedUsageEvents: records.length, estimatedUsageEvents: priced.length,
    estimatedUnreportedCostUsd: priced.length ? priced.reduce((sum, amount) => sum + amount, 0) : null };
}

const page: PluginPageModule = {
  mount(container, context) {
    const services = context.services;
    if (!services || services.version !== 1) throw new Error('This page requires version 1 page services.');
    let state = context.state;
    let disposed = false;
    let pending: { controller: AbortController; promise: Promise<void> } | null = null;
    let usage: UsageSnapshot | null = null;
    let pricing: PricingEstimate | null = null;
    let error: string | null = null;
    const style = document.createElement('style');
    style.textContent = '.external-costs-summary{display:grid;gap:16px;padding:20px;color:var(--text,#ddd);font:14px var(--sans,sans-serif)}.external-costs-summary section{padding:16px;border:1px solid var(--line,#555);border-radius:var(--radius,4px)}.external-costs-summary h1,.external-costs-summary h2{margin:0 0 8px}.external-costs-summary p{margin:6px 0}.external-costs-summary button{padding:8px 12px;font:inherit;color:var(--accent,#eeb05d);background:var(--panel,#191b21);border:1px solid var(--line,#555);cursor:pointer}.external-costs-summary [role=alert]{color:var(--bad,#f88)}';
    const root = document.createElement('article');
    root.className = 'external-costs-summary';
    container.replaceChildren(style, root);
    const text = (parent: HTMLElement, tag: string, content: string) => {
      const node = document.createElement(tag);
      node.textContent = content;
      parent.append(node);
      return node;
    };
    const draw = () => {
      if (disposed) return;
      root.replaceChildren();
      text(root, 'h1', 'Independent Costs');
      text(root, 'p', `${state.pirateMode ? 'Galleon' : 'Repository'}: ${state.repo ?? 'All'} · Last 30 days`);
      if (error) text(root, 'p', error).setAttribute('role', 'alert');
      if (pending && !usage) text(root, 'p', 'Loading recorded usage…').setAttribute('role', 'status');
      if (usage) {
        const recorded = document.createElement('section');
        recorded.dataset.recordedUsage = '';
        text(recorded, 'h2', 'Recorded usage');
        text(recorded, 'p', `Reported spend: ${format(usage.reported.observedCostUsd)} USD`);
        text(recorded, 'p', `${usage.records.length} usage records · ${usage.runs.length} runs · ${usage.reported.runsWithKnownCost} fully priced runs`);
        text(recorded, 'p', `Recorded tokens: ${usage.reported.totalTokens ?? 'Unknown'}`);
        root.append(recorded);
        const estimates = document.createElement('section');
        estimates.dataset.estimatedUsage = '';
        text(estimates, 'h2', 'Pricing estimate');
        if (pricing) {
          text(estimates, 'p', `Unreported usage estimate: ${format(pricing.estimatedUnreportedCostUsd)} ${pricing.currency}`);
          text(estimates, 'p', `Coverage: ${pricing.estimatedUsageEvents}/${pricing.unreportedUsageEvents} unpriced records`);
          text(estimates, 'p', `${pricing.provenance.source} · ${pricing.provenance.rateVersion} · ${pricing.provenance.asOf}`);
        } else text(estimates, 'p', 'Pricing provider unavailable. Estimate: Unknown.').setAttribute('role', 'status');
        text(estimates, 'p', 'Estimates do not change recorded spend or budget caps.');
        root.append(estimates);
      }
      const button = text(root, 'button', 'Refresh usage') as HTMLButtonElement;
      button.type = 'button';
      button.disabled = Boolean(pending);
    };
    const cancel = () => { pending?.controller.abort(); pending = null; };
    const refresh = (): Promise<void> => {
      if (disposed || !state.visible) return Promise.resolve();
      if (pending) return pending.promise;
      const controller = new AbortController();
      const to = new Date();
      const query = { version: 1 as const, repo: state.repo, from: new Date(to.getTime() - 30 * 86_400_000).toISOString(), to: to.toISOString() };
      const current = () => !disposed && pending?.controller === controller;
      error = null;
      const promise = Promise.resolve().then(() => Promise.all([
        services.usage.query(query, controller.signal),
        services.pricing.estimate(query, controller.signal).catch(() => null),
      ])).then(([nextUsage, nextPricing]) => {
        if (current()) { usage = nextUsage; pricing = currentPricing(nextUsage, nextPricing); }
      }).catch((reason: unknown) => { if (current()) error = reason instanceof Error ? reason.message : 'Recorded usage is unavailable.'; })
        .finally(() => { if (current()) { pending = null; draw(); } });
      pending = { controller, promise };
      draw();
      return promise;
    };
    const click = (event: MouseEvent) => {
      if (event.target instanceof HTMLButtonElement && root.contains(event.target)) void refresh();
    };
    root.addEventListener('click', click);
    const update = (next: PluginPageState) => {
      if (disposed) return;
      const changed = next.repo !== state.repo;
      const visible = next.visible && !state.visible;
      state = next;
      if (changed) { cancel(); usage = null; pricing = null; error = null; }
      if (!state.visible) cancel();
      draw();
      if (changed || visible) void refresh();
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      cancel();
      root.removeEventListener('click', click);
      context.signal.removeEventListener('abort', dispose);
    };
    context.onDispose(dispose);
    context.signal.addEventListener('abort', dispose, { once: true });
    if (context.signal.aborted) dispose();
    else void refresh();
    return { update, refresh, dispose };
  },
};

export default page;
