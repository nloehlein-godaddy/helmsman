// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { openExecutionStore } from './execution-store';
import { openOperationStore } from './operations';
import { openPersistence, type Persistence } from './persistence';
import { createManualReviewEffects, type ManualReviewRequest } from './manual-review-effects';

const databases: Persistence[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
const headSha = 'a'.repeat(40);
const request: ManualReviewRequest = { requestId: '12345678-1234-4123-8123-123456789abc', repo: 'org/repo', prNumber: 12, event: 'APPROVE', body: '' };
function fixture() {
  const persistence = openPersistence(':memory:'); databases.push(persistence);
  const executions = openExecutionStore(persistence);
  const operations = openOperationStore(persistence, executions);
  const config = loadConfig({ GITHUB_TOKEN: 'github-secret', GITHUB_REPO: 'org/repo', GITHUB_PR_AUTHOR: 'actor' });
  const remote = { actor: 'actor', head: headSha, loseReceipt: false, reviews: [] as object[] };
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const review = { id: 12, commit_id: body.commit_id, body: body.body, user: { login: remote.actor }, submitted_at: '2026-09-20T00:00:00Z' };
      remote.reviews.push(review);
      if (remote.loseReceipt) throw new Error('response lost');
      return new Response(JSON.stringify(review));
    }
    return new Response(JSON.stringify(path.endsWith('/user') ? { login: remote.actor }
      : path.includes('/reviews?') ? remote.reviews : { head: { sha: remote.head }, state: 'open', merged: false }));
  }) as unknown as typeof fetch;
  const options = { persistence, operations, currentConfig: () => config, artifact: { pluginId: 'helmsman.legacy-runtime', artifactHash: 'b'.repeat(64), packageVersion: '1.0.0', requires: [] },
    verifyArtifacts: vi.fn(async () => {}), fetcher };
  return { operations, config, executions, remote, options, effects: createManualReviewEffects(options),
    writes: () => vi.mocked(fetcher).mock.calls.filter(([, init]) => init?.method === 'POST') };
}

describe('durable manual reviews', () => {
  it('supports empty approvals, pins actor/SHA/runtime, and keeps repeat request IDs idempotent', async () => {
    const f = fixture();
    expect(await f.effects.submit(request)).toEqual({ ok: true });
    expect(await f.effects.submit(request)).toEqual({ ok: true });
    expect(f.writes()).toHaveLength(1);
    expect(JSON.parse(String(f.writes()[0]?.[1]?.body))).toEqual({ event: 'APPROVE', commit_id: headSha, body: expect.stringMatching(/^<!-- helmsman-operation:/) });
    expect(f.operations.list()[0]).toMatchObject({ origin: { kind: 'manual-review', runId: null, attempt: null }, target: { actor: 'actor', headSha }, payload: { body: '', manual: true } });
    expect(JSON.stringify(f.operations.list())).not.toContain('github-secret');
    expect(f.executions.pins()).toEqual([]);
  });

  it.each(['COMMENT', 'REQUEST_CHANGES'] as const)('preserves %s user text without adding an agent attribution', async event => {
    const f = fixture();
    const body = '  My exact text.\n\n_Helmsman · not reported - not reported_\n';
    expect(await f.effects.submit({ ...request, event, body })).toEqual({ ok: true });
    const sent = JSON.parse(String(f.writes()[0]?.[1]?.body));
    expect(sent.body.startsWith(body)).toBe(true);
    expect(sent.body.slice(body.length)).toMatch(/^\n\n<!-- helmsman-operation:/);
    expect(sent.event).toBe(event);
  });

  it('reconciles a lost receipt on restart and never submits the same action twice', async () => {
    const f = fixture(); f.remote.loseReceipt = true;
    expect(await f.effects.submit(request)).toMatchObject({ ok: false, error: expect.stringContaining('uncertain') });
    expect(await createManualReviewEffects(f.options).submit(request)).toEqual({ ok: true });
    expect(f.writes()).toHaveLength(1);
  });

  it('rejects changed payload under a repeated request ID and never refreshes its SHA', async () => {
    const f = fixture(); f.remote.loseReceipt = true;
    await f.effects.submit(request);
    f.remote.head = 'c'.repeat(40);
    expect(await f.effects.submit({ ...request, body: 'Different' })).toMatchObject({ ok: false, error: expect.stringContaining('different content') });
    expect(await f.effects.submit(request)).toEqual({ ok: true });
    expect(f.operations.list()[0]?.target).toMatchObject({ headSha });
    expect(f.writes()).toHaveLength(1);
  });

  it('retains unresolved targets across connection changes and missing remote receipts', async () => {
    const f = fixture(); f.remote.loseReceipt = true;
    await f.effects.submit(request);
    f.remote.reviews = [];
    f.config.github = { ...f.config.github!, author: 'replacement' };
    expect(await f.effects.submit(request)).toMatchObject({ ok: false });
    f.config.github = { ...f.config.github!, author: 'actor' };
    expect(await f.effects.submit(request)).toMatchObject({ ok: false, error: expect.stringContaining('uncertain') });
    expect(f.writes()).toHaveLength(1);
    expect(f.executions.pins()).toHaveLength(1);
  });

  it('rejects a head that differs from the viewed revision and keeps admitted revisions on retry', async () => {
    const f = fixture();
    expect(await f.effects.submit({ ...request, expectedHeadSha: 'c'.repeat(40) })).toMatchObject({ ok: false });
    expect(f.operations.list()).toEqual([]);
    f.remote.loseReceipt = true;
    expect(await f.effects.submit({ ...request, expectedHeadSha: headSha })).toMatchObject({ ok: false });
    f.remote.head = 'c'.repeat(40);
    expect(await f.effects.submit({ ...request, expectedHeadSha: headSha })).toEqual({ ok: true });
    expect(f.writes()).toHaveLength(1);
  });

  it('rechecks provider admission atomically after remote lookups without blocking retained receipts', async () => {
    const f = fixture();
    let checks = 0;
    const denied = createManualReviewEffects({ ...f.options, assertAdmission: () => { if (++checks > 1) throw new Error('Provider disabled'); } });
    expect(await denied.submit(request)).toMatchObject({ ok: false, error: 'Provider disabled' });
    expect(f.operations.list()).toEqual([]);
    f.remote.loseReceipt = true;
    await f.effects.submit(request);
    const retained = createManualReviewEffects({ ...f.options, assertAdmission: () => { throw new Error('Provider disabled'); } });
    expect(await retained.submit(request)).toEqual({ ok: true });
    expect(f.writes()).toHaveLength(1);
  });

  it('blocks wrong authenticated actors and invalid request identities before enqueueing', async () => {
    const f = fixture(); f.remote.actor = 'wrong-account';
    expect(await f.effects.submit(request)).toMatchObject({ ok: false });
    expect(await f.effects.submit({ ...request, requestId: 'unstable' })).toMatchObject({ ok: false });
    expect(await f.effects.submit({ ...request, event: 'COMMENT', body: '' })).toMatchObject({ ok: false });
    expect(f.operations.list()).toEqual([]);
    expect(f.writes()).toEqual([]);
  });
});
