// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { openPersistence } from './persistence';
import { openExecutionStore } from './execution-store';
import { createExecutionPolicyService } from './execution-policy-service';
import { handleExecutionPolicyApi } from './execution-policy-routes';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });
function fixture() {
  const persistence = openPersistence(':memory:'); cleanups.push(() => persistence.close()); openExecutionStore(persistence, Date.now, { preferSchema: 2 });
  let ready = true;
  const service = createExecutionPolicyService({ persistence, repos: () => ['org/a', 'org/b'], authorize: caller => { if (caller !== 'example.settings/panel') throw new Error('unauthorized'); },
    safetyReady: () => ready, limits: () => ({ globalMaxConcurrentRuns: 4, perRunCostCapUsd: 2.5, activeRuns: 1 }) });
  return { persistence, service, setReady: (value: boolean) => { ready = value; } };
}
const caller = 'example.settings/panel';
const command = { version: 1 as const, repo: 'org/a', requestId: 'request-1', expectedRevision: 0, maxConcurrentRuns: 2 };
it('shows the exact scoped limits and applies each durable request once', () => {
  const f = fixture();
  expect(f.service.read(caller, { version: 1, repo: 'org/a' }, 'org/a')).toMatchObject({ policy: { revision: 0, maxConcurrentRuns: 1 },
    limits: { globalMaxConcurrentRuns: 4, perRunCostCapUsd: 2.5, activeRuns: 1 }, readiness: { currentVersion: 2, ready: true } });
  const receipt = f.service.set(caller, command, 'org/a'); expect(receipt.revision).toBe(1);
  f.service.set(caller, { ...command, requestId: 'request-2', expectedRevision: 1, maxConcurrentRuns: 3 }, 'org/a');
  expect(f.service.set(caller, command, 'org/a')).toEqual(receipt);
  expect(f.service.read(caller, { version: 1, repo: 'org/a' }, 'org/a').policy.maxConcurrentRuns).toBe(3);
  expect(() => f.service.set(caller, { ...command, maxConcurrentRuns: 4 }, 'org/a')).toThrow('different content');
  expect(() => f.service.set(caller, { ...command, requestId: 'stale' }, 'org/a')).toThrow('refresh');
});
it('gates exposure and writes on backend safety, configured galleons and current panel scope', () => {
  const f = fixture(); f.setReady(false);
  expect(() => f.service.read(caller, { version: 1, repo: 'org/a' }, null)).toThrow('service-unavailable');
  expect(() => f.service.set(caller, command, 'org/a')).toThrow('service-unavailable');
  f.setReady(true);
  expect(() => f.service.set(caller, command, 'org/b')).toThrow('not-found');
  expect(() => f.service.set('other.settings/panel', command, 'org/a')).toThrow('unauthorized');
  expect(() => f.service.set(caller, { ...command, repo: 'org/missing' }, null)).toThrow('not-found');
  expect(f.service.read(caller, { version: 1, repo: 'org/a' }, 'org/a').policy.revision).toBe(0);
});
it('validates API envelopes before applying CAS and reports conflicts distinctly', () => {
  const f = fixture(); const base = { method: 'POST', path: '/api/execution-policy', query: new URLSearchParams(), caller, service: f.service, body: { command, scopeRepo: 'org/a' } };
  expect(handleExecutionPolicyApi({ ...base, caller: undefined })?.status).toBe(403);
  expect(handleExecutionPolicyApi({ ...base, body: { ...base.body, unsafe: true } })?.status).toBe(400);
  expect(handleExecutionPolicyApi(base)?.status).toBe(200);
  expect(handleExecutionPolicyApi({ ...base, body: { command: { ...command, requestId: 'stale' }, scopeRepo: 'org/a' } })).toEqual({ status: 409, json: { reason: 'conflict' } });
});
