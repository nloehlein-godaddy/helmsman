import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createScopedGateway } from './scoped-gateway';

const servers: Array<ReturnType<ReturnType<typeof createScopedGateway>['server']>> = [];
const gateways: Array<ReturnType<typeof createScopedGateway>> = [];
const roots: string[] = [];
const modelUpstream = (credential: string | undefined = 'key') => ({ baseUrl: 'https://caas-gocode-prod.caas-prod.prod.onkatana.net/v1', credential: async () => credential });

async function open(options: Parameters<typeof createScopedGateway>[0]) {
  const gateway = createScopedGateway(options); gateways.push(gateway);
  const server = gateway.server(); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return { gateway, base: `http://127.0.0.1:${address.port}` };
}

async function request(base: string, token: string, path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  gateways.splice(0).forEach(gateway => gateway.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe('scoped gateway', () => {
  it('accepts the pinned Claude CLI beta messages request with scoped credentials and validated beta headers', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"type":"message"}', { headers: { 'content-type': 'application/json' } }));
    const { gateway, base } = await open({ modelUpstream: modelUpstream('host-anthropic-key'), active: () => true, fetcher: fetcher as typeof fetch });
    const cap = gateway.issue('run_1', 60_000);
    const beta = 'claude-code-20250219, interleaved-thinking-2025-05-14';
    const response = await request(base, cap.token, '/anthropic/v1/messages?beta=true', { method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-beta': beta, 'x-api-key': 'guest-key', 'x-extra': 'discard' }, body: '{"model":"claude-sonnet-4-6"}' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 'message' });
    expect(fetcher).toHaveBeenCalledWith('https://caas-gocode-prod.caas-prod.prod.onkatana.net/v1/messages?beta=true', expect.objectContaining({ redirect: 'error',
      headers: { 'x-api-key': 'host-anthropic-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-beta': beta } }));
  });

  it('rejects unapproved Anthropic queries and malformed or oversized beta headers before upstream access', async () => {
    const fetcher = vi.fn();
    const { gateway, base } = await open({ modelUpstream: modelUpstream(), active: () => true, fetcher: fetcher as typeof fetch });
    const cap = gateway.issue('run_1', 60_000);
    for (const suffix of ['?beta=false', '?beta=true&target=evil', '?beta=true&beta=true', '?%62eta=true', '/count_tokens?beta=true']) {
      expect((await request(base, cap.token, `/anthropic/v1/messages${suffix}`, { method: 'POST' })).status).toBe(403);
    }
    for (const beta of ['flag;target=evil', 'flag,,other', 'x'.repeat(129), Array(20).fill('x'.repeat(120)).join(',')]) {
      expect((await request(base, cap.token, '/anthropic/v1/messages?beta=true', { method: 'POST', headers: { 'anthropic-beta': beta } })).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('replaces inbound credentials, fixes the upstream origin, and streams the response', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('first')); controller.enqueue(new TextEncoder().encode(' second')); controller.close(); } }), { status: 201, headers: { 'content-type': 'text/plain' } }));
    const { gateway, base } = await open({ modelUpstream: modelUpstream('actual-key'), active: () => true, fetcher: fetcher as typeof fetch });
    const cap = gateway.issue('run_1', 1_000);
    const response = await request(base, cap.token, '/openai/v1/responses', { method: 'POST', headers: { authorization: 'Bearer attacker', 'x-api-key': 'attacker', 'x-extra': 'discard-me' }, body: '{"model":"gpt"}' });

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('first second');
    expect(fetcher).toHaveBeenCalledWith('https://caas-gocode-prod.caas-prod.prod.onkatana.net/v1/responses', expect.objectContaining({ redirect: 'error', headers: { Authorization: 'Bearer actual-key', 'content-type': 'application/json' } }));
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty('x-extra');
  });

  it.each(['/openai/v1/responses', '/openai/v1/responses/compact', '/anthropic/v1/messages'])('routes %s through GoCaaS with S2S authentication', async path => {
    const fetcher = vi.fn(async () => new Response('ok'));
    const { gateway, base } = await open({ modelUpstream: { ...modelUpstream('fixture-jwt'), authMode: 'sso-jwt' }, active: () => true, fetcher });
    const cap = gateway.issue('run', 60_000);
    expect((await request(base, cap.token, path, { method: 'POST', body: '{}' })).status).toBe(200);
    expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/caas-gocode-prod\.caas-prod\.prod\.onkatana\.net\/v1\//), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'sso-jwt fixture-jwt' }), redirect: 'error',
    }));
  });

  it('rechecks capability revocation while waiting for the GoCaaS credential', async () => {
    const fetcher = vi.fn();
    let release: (value: string) => void = () => undefined;
    let started: () => void = () => undefined;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const { gateway, base } = await open({ modelUpstream: { ...modelUpstream(), credential: () => { started(); return new Promise<string>(resolve => { release = resolve; }); } }, active: () => true, fetcher });
    const cap = gateway.issue('run', 60_000);
    const response = request(base, cap.token, '/openai/v1/responses', { method: 'POST', body: '{}' });
    await waiting;
    gateway.revoke(cap.token);
    release('fixture-key');
    expect((await response).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails at GoCaaS without retrying a vendor endpoint', async () => {
    const fetcher = vi.fn(async () => new Response('Unavailable', { status: 503 }));
    const { gateway, base } = await open({ modelUpstream: modelUpstream(), active: () => true, fetcher });
    const cap = gateway.issue('run', 60_000);
    expect((await request(base, cap.token, '/openai/v1/responses', { method: 'POST', body: '{}' })).status).toBe(503);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('denies invalid, revoked, expired, inactive, and credentialless capabilities without upstream access', async () => {
    let clock = 1_000;
    const fetcher = vi.fn();
    const { gateway, base } = await open({ modelUpstream: modelUpstream(''), active: id => id === 'run_active', now: () => clock, fetcher: fetcher as typeof fetch });
    const active = gateway.issue('run_active', 10);
    const expired = gateway.issue('run_active', 1);
    const inactive = gateway.issue('run_inactive', 10);
    const revoked = gateway.issue('run_active', 10); gateway.revoke(revoked.token); clock += 2;

    for (const token of ['f'.repeat(64), expired.token, inactive.token, revoked.token]) {
      expect((await request(base, token, '/openai/v1/responses', { method: 'POST' })).status).toBe(401);
    }
    expect((await request(base, active.token, '/openai/v1/responses', { method: 'POST' })).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocks GitHub cross-repository, traversal, encoded, and merge reads', async () => {
    const fetcher = vi.fn();
    const { gateway, base } = await open({ modelUpstream: modelUpstream(), githubKey: () => 'github-key', active: () => true, scope: () => ({ repo: 'owner/repo', branch: 'work', readOnly: false }), fetcher: fetcher as typeof fetch });
    const cap = gateway.issue('run_1', 1_000);
    for (const path of ['/github/repos/other/repo/pulls', '/github/repos/owner/repo/contents/../secrets', '/github/repos/owner/repo/contents/%2e%2e/secrets', '/github/repos/owner/repo/pulls/1/merge']) {
      expect((await request(base, cap.token, path)).status).toBe(403);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('permits only an exact SHA push callback for a writable scope', async () => {
    const push = vi.fn(async () => {});
    const { gateway, base } = await open({ modelUpstream: modelUpstream(), active: () => true, scope: () => ({ repo: 'owner/repo', branch: 'work', readOnly: false }), push });
    const cap = gateway.issue('run_1', 1_000);
    const headSha = 'a'.repeat(40);
    expect((await request(base, cap.token, '/git/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ headSha }) })).status).toBe(200);
    expect(push).toHaveBeenCalledWith('run_1', { repo: 'owner/repo', branch: 'work', readOnly: false }, headSha);
    expect((await request(base, cap.token, '/git/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ headSha, extra: true }) })).status).toBe(400);
  });

  it('persists and revokes capabilities across gateway reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scoped-gateway-')); roots.push(root);
    const path = join(root, 'gateway.sqlite');
    const first = createScopedGateway({ path, modelUpstream: modelUpstream(), active: () => true });
    const cap = first.issue('run_1', 1_000); first.close();
    const { gateway, base } = await open({ path, modelUpstream: modelUpstream(), active: () => true, fetcher: (async () => new Response('ok')) as typeof fetch });
    expect((await request(base, cap.token, '/openai/v1/responses', { method: 'POST' })).status).toBe(200);
    gateway.revokeRun('run_1');
    expect((await request(base, cap.token, '/openai/v1/responses', { method: 'POST' })).status).toBe(401);
  });
});

describe('attempt-bound clarification gateway', () => {
  it('forwards channel evidence and rejects stale channels under a reusable run credential', async () => {
    const gate = vi.fn((_runId: string, query: URLSearchParams) => query.get('attempt') === '2' && query.get('channel') === 'current');
    const { gateway, base } = await open({ modelUpstream: modelUpstream(), active: () => true, clarificationReady: () => true, clarificationGate: gate });
    const capability = gateway.issue('run', 1000);
    for (const suffix of ['', '?attempt=1&channel=old', '?attempt=2&channel=old']) {
      expect(await (await request(base, capability.token, `/clarification-gate${suffix}`)).json()).toEqual({ ready: false });
    }
    expect(await (await request(base, capability.token, '/clarification-gate?attempt=2&channel=current')).json()).toEqual({ ready: true });
    expect(gate.mock.calls.every(([runId]) => runId === 'run')).toBe(true);
  });
});

describe('coordinator publication capabilities', () => {
  const approval = { version: 1, kind: 'pre-pr', approved: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), branch: 'agent/run', baseBranch: 'main', round: 1, reviewers: ['codex'], metadata: { stage: 'implement', round: 0 } } };
  it('isolates publication from inference and rechecks gate, scope, expiry, revocation, and active run', async () => {
    let active = true;
    let ready = true;
    let now = 1000;
    let readOnly = false;
    const publication = vi.fn(async () => ({ ok: true as const, prNumber: 12 }));
    const fetcher = vi.fn(async () => new Response('{}'));
    const { gateway, base } = await open({ modelUpstream: modelUpstream(), active: () => active, clarificationReady: () => ready,
      scope: () => ({ repo: 'org/repo', branch: 'agent/run', readOnly }), publication, now: () => now, fetcher: fetcher as typeof fetch });
    const inference = gateway.issue('run', 1000);
    const coordinator = gateway.issuePublication('run', 1000);
    const post = (token: string, value: unknown = approval) => request(base, token, '/publication/v1', { method: 'POST', body: JSON.stringify(value) });
    expect((await post(inference.token)).status).toBe(401);
    expect((await request(base, coordinator.token, '/openai/v1/responses', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await post(coordinator.token)).status).toBe(200);
    expect(publication).toHaveBeenCalledOnce();
    ready = false; expect((await post(coordinator.token)).status).toBe(403); ready = true;
    readOnly = true; expect((await post(coordinator.token)).status).toBe(403); readOnly = false;
    expect((await post(coordinator.token, { ...approval, approved: { ...approval.approved, branch: 'other' } })).status).toBe(403);
    expect((await post(coordinator.token, { ...approval, command: 'arbitrary' })).status).toBe(400);
    active = false; expect((await post(coordinator.token)).status).toBe(401); active = true;
    now = 2001; expect((await post(coordinator.token)).status).toBe(401); now = 1000;
    gateway.revoke(coordinator.token); expect((await post(coordinator.token)).status).toBe(401);
    expect(publication).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
