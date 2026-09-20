import { afterEach, expect, it, vi } from 'vitest';
import { createHostPageServices } from './host-services';
import type { UsageQuery, UsageSnapshot } from './usage';

afterEach(() => vi.unstubAllGlobals());
const query: UsageQuery = { version: 1, repo: 'org/a', from: '2026-09-01T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z' };
const snapshot = (): UsageSnapshot => ({ version: 1, currency: 'USD', repo: query.repo, window: { from: query.from, to: query.to },
  runs: [{ runId: 'run_1', repo: 'org/a', status: 'succeeded', startedAt: query.from, endedAt: query.to, reportedCostUsd: null }],
  records: [{ runId: 'run_1', attempt: 1, eventId: 'event_1', provider: 'codex', model: 'unknown', inputTokens: 100,
    cachedInputTokens: 0, outputTokens: 10, totalTokens: 110, costUsd: null }],
  reported: { observedCostUsd: null, knownCostUsd: null, runsWithKnownCost: 0, runsWithoutUsage: 0,
    inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, totalTokens: 110 } });

it('queries versioned usage with exact scope and retains unknown measured spend', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(snapshot()));
  vi.stubGlobal('fetch', fetch);
  const services = createHostPageServices(new AbortController().signal);
  expect(await services.usage.query(query)).toEqual(snapshot());
  const url = new URL(fetch.mock.calls[0]?.[0] as string, 'http://localhost');
  expect(url.pathname).toBe('/api/usage/v1');
  expect(Object.fromEntries(url.searchParams)).toEqual({ version: '1', repo: query.repo, from: query.from, to: query.to });
});

it.each([
  (data: UsageSnapshot) => { data.runs[0]!.repo = 'org/b'; },
  (data: UsageSnapshot) => { data.records[0]!.runId = 'unrelated'; },
  (data: UsageSnapshot) => { data.reported.totalTokens = -1; },
  (data: UsageSnapshot) => { data.window.from = query.to; },
  (data: UsageSnapshot) => { data.records.push({ ...data.records[0]! }); },
  (data: UsageSnapshot) => { data.records[0]!.attempt = 0; },
])('rejects malformed or mismatched scope/usage responses', async change => {
  const data = snapshot(); change(data);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(data)));
  await expect(createHostPageServices(new AbortController().signal).usage.query(query)).rejects.toThrow('Usage response was invalid');
});

it('accepts equivalent UTC instants normalized by the host', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(snapshot())));
  const input = { ...query, from: query.from.replace('.000Z', 'Z'), to: query.to.replace('.000Z', 'Z') };
  expect(await createHostPageServices(new AbortController().signal).usage.query(input)).toEqual(snapshot());
});

it('propagates plugin lifetime cancellation to active host service calls', async () => {
  const lifetime = new AbortController();
  let observed: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
    observed = init.signal ?? undefined;
    observed?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  })));
  const pending = createHostPageServices(lifetime.signal).usage.query(query);
  lifetime.abort();
  await expect(pending).rejects.toThrow('Cancelled');
  expect(observed?.aborted).toBe(true);
});

it('keeps missing pricing distinct from zero or malformed estimates', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(null))
    .mockResolvedValueOnce(Response.json({ error: 'Selected pricing provider is disabled' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ version: 1, currency: 'USD', estimatedUnreportedCostUsd: 0 }));
  vi.stubGlobal('fetch', fetch);
  const pricing = createHostPageServices(new AbortController().signal).pricing;
  expect(await pricing.estimate(query)).toBeNull();
  await expect(pricing.estimate(query)).rejects.toThrow('Selected pricing provider is disabled');
  await expect(pricing.estimate(query)).rejects.toThrow('Pricing response was invalid');
});

it.each(['duplicate', 'wrong-sum', 'wrong-count', 'zero-attempt', 'overflow'])('rejects %s pricing details before rendering', async flaw => {
  const row = { runId: 'run_1', attempt: 1, eventId: 'event_1', estimatedCostUsd: 2 };
  const result = { version: 1, currency: 'USD', provenance: { source: 'test rates', rateVersion: '1', asOf: '2026-09-20' },
    estimatedUnreportedCostUsd: 2, estimatedUsageEvents: 1, unreportedUsageEvents: 1, records: [row] };
  if (flaw === 'duplicate') { result.records.push({ ...row }); result.unreportedUsageEvents = 2; result.estimatedUsageEvents = 2; result.estimatedUnreportedCostUsd = 4; }
  if (flaw === 'wrong-sum') row.estimatedCostUsd = 999;
  if (flaw === 'wrong-count') result.estimatedUsageEvents = 0;
  if (flaw === 'zero-attempt') row.attempt = 0;
  if (flaw === 'overflow') {
    row.estimatedCostUsd = 1e308; result.records.push({ ...row, eventId: 'event_2' });
    result.estimatedUsageEvents = 2; result.unreportedUsageEvents = 2; result.estimatedUnreportedCostUsd = 1e308;
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(result)));
  await expect(createHostPageServices(new AbortController().signal).pricing.estimate(query)).rejects.toThrow('Pricing response was invalid');
});
