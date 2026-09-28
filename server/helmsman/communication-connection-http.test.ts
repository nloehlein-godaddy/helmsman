import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { CommunicationConnectionProviderV1 } from '../../src/plugins/communication-connection';
import { createCommunicationConnectionHandler } from './communication-connection-http';

const prefix = '/api/communication-connection';
const origin = 'https://helmsman.example.test';
const state = 'a'.repeat(43);
const revision = createHash('sha256').update('selected-provider').digest('hex');
const browserCookie = (value = state) => `helmsman_communication_oauth=${value}`;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  let connected = false; let current = true; let now = 0;
  const persist = vi.fn(() => { connected = true; });
  const provider: CommunicationConnectionProviderV1 = {
    status: vi.fn<CommunicationConnectionProviderV1['status']>(async () => ({ status: connected ? 'connected' : 'disconnected', message: connected ? 'Connected' : 'Disconnected', accountLabel: connected ? 'Fixture account' : null, redirectUri: `${origin}${prefix}/callback` })),
    begin: vi.fn(async () => ({ state, authorizationUrl: `https://slack.com/oauth/v2/authorize?state=${state}` })),
    complete: vi.fn(async (_query, _cookie, _signal, beforeCommit) => { beforeCommit(); persist(); }),
    disconnect: vi.fn(async () => { connected = false; }), check: vi.fn(async () => {}),
  };
  const capture = { providerId: 'example.slack/slack', identity: 'selected-provider', provider, assertCurrent() { if (!current) throw new Error('Provider changed'); } };
  const handler = createCommunicationConnectionHandler({ capture: () => current ? capture : null, now: () => now,
    authorize(caller) { if (caller !== 'example.communication/page') throw new Error('Forbidden'); } });
  async function request(path = '', method = 'GET', headers: IncomingHttpHeaders = {}, body = JSON.stringify({ expectedRevision: revision })) {
    const req = { method, headers: { host: '127.0.0.1:8787', origin, 'content-type': 'application/json', 'x-helmsman-contribution': 'example.communication/page', ...headers },
      async *[Symbol.asyncIterator]() { yield Buffer.from(body); } } as unknown as IncomingMessage;
    const response = { status: 0, headers: {} as Record<string, string>, body: '' };
    const res = { writeHead(status: number, value: Record<string, string>) { response.status = status; response.headers = value; }, end(value?: string) { response.body = value ?? ''; } } as unknown as ServerResponse;
    expect(await handler(req, res, new URL(`${prefix}${path}`, origin))).toBe(true);
    return response;
  }
  return { provider, persist, request, replaceSelection() { current = false; }, expire() { now = 600_001; } };
}

it('connects the selected provider with browser-bound one-use state and keeps credentials out of responses', async () => {
  const f = fixture(); const started = await f.request('/start', 'POST');
  expect(started.status).toBe(200);
  expect(JSON.parse(started.body)).toEqual({ version: 1, authorizationUrl: `https://slack.com/oauth/v2/authorize?state=${state}` });
  expect(started.headers['Set-Cookie']).toBe(`${browserCookie()}; Path=${prefix}; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  const result = await f.request(`/callback?state=${state}&code=private-code`, 'GET', { cookie: browserCookie(), 'x-helmsman-contribution': undefined });
  expect(result.status).toBe(303); expect(result.headers.Location).toBe('/communication?connection=connected');
  expect(result.headers['Set-Cookie']).toBeUndefined(); expect(result.body).toBe(''); expect(f.persist).toHaveBeenCalledOnce();
  const status = await f.request();
  expect(JSON.parse(status.body)).toEqual({ version: 1, providerId: 'example.slack/slack', revision, status: 'connected', message: 'Connected', accountLabel: 'Fixture account', redirectUri: `${origin}${prefix}/callback` });
  expect(status.body).not.toContain('private-code');
  const replay = await f.request(`/callback?state=${state}&code=private-code`, 'GET', { cookie: browserCookie() });
  expect(replay.headers.Location).toBe('/communication?connection=error'); expect(f.provider.complete).toHaveBeenCalledOnce();
});

it.each([
  { origin: 'https://attacker.example' },
  { 'sec-fetch-site': 'cross-site' },
  { 'content-type': 'text/plain' },
  { 'x-helmsman-contribution': undefined },
  { 'x-helmsman-contribution': 'untrusted/page' },
])('rejects untrusted authorization starts before invoking the provider: %j', async headers => {
  const f = fixture(); const response = await f.request('/start', 'POST', headers);
  expect(response.status).toBe(403); expect(f.provider.begin).not.toHaveBeenCalled(); expect(response.headers['Set-Cookie']).toBeUndefined();
});

it.each([undefined, 'http://127.0.0.1:8787'])('requires the configured HTTPS origin to start authorization: %s', async requestOrigin => {
  const f = fixture(); expect((await f.request('/start', 'POST', { origin: requestOrigin })).status).toBe(409); expect(f.provider.begin).not.toHaveBeenCalled();
});

it.each(['missing-cookie', 'wrong-cookie', 'duplicate-state', 'expired'] as const)('rejects %s callbacks without committing credentials', async scenario => {
  const f = fixture(); await f.request('/start', 'POST');
  if (scenario === 'expired') f.expire();
  const query = `/callback?state=${state}${scenario === 'duplicate-state' ? `&state=${state}` : ''}&code=private-code`;
  const result = await f.request(query, 'GET', { cookie: scenario === 'missing-cookie' ? undefined : browserCookie(scenario === 'wrong-cookie' ? 'b'.repeat(43) : state) });
  expect(result.headers.Location).toBe('/communication?connection=error'); expect(result.headers['Set-Cookie']).toBeUndefined(); expect(f.provider.complete).not.toHaveBeenCalled();
});

it.each(['selection', 'disconnect', 'new-start'] as const)('fences credential persistence when %s supersedes a deferred callback', async change => {
  const f = fixture(); const exchange = deferred();
  vi.mocked(f.provider.complete).mockImplementation(async (_query, _cookie, _signal, beforeCommit) => { await exchange.promise; beforeCommit(); f.persist(); });
  await f.request('/start', 'POST');
  const callback = f.request(`/callback?state=${state}&code=private-code`, 'GET', { cookie: browserCookie() });
  await vi.waitFor(() => expect(f.provider.complete).toHaveBeenCalledOnce());
  if (change === 'selection') f.replaceSelection();
  else if (change === 'disconnect') {
    const response = await f.request('/disconnect', 'POST'); expect(response.status).toBe(200); expect(response.headers['Set-Cookie']).toBeUndefined();
  } else {
    vi.mocked(f.provider.begin).mockResolvedValue({ state: 'b'.repeat(43), authorizationUrl: `https://slack.com/oauth/v2/authorize?state=${'b'.repeat(43)}` });
    expect((await f.request('/start', 'POST')).headers['Set-Cookie']).toContain(browserCookie('b'.repeat(43)));
  }
  exchange.resolve();
  const result = await callback;
  expect(result.headers.Location).toBe('/communication?connection=error'); expect(result.headers['Set-Cookie']).toBeUndefined(); expect(f.persist).not.toHaveBeenCalled();
  if (change === 'new-start') {
    const fresh = await f.request(`/callback?state=${'b'.repeat(43)}&code=new-code`, 'GET', { cookie: browserCookie('b'.repeat(43)) });
    expect(fresh.headers.Location).toBe('/communication?connection=connected'); expect(f.persist).toHaveBeenCalledOnce();
  }
});

it('does not issue state from a start that finishes after disconnect', async () => {
  const f = fixture(); const beginning = deferred();
  vi.mocked(f.provider.begin).mockImplementation(async () => { await beginning.promise; return { state, authorizationUrl: `https://slack.com/oauth/v2/authorize?state=${state}` }; });
  const started = f.request('/start', 'POST'); await vi.waitFor(() => expect(f.provider.begin).toHaveBeenCalledOnce());
  await f.request('/disconnect', 'POST'); beginning.resolve();
  const result = await started; expect(result.status).toBe(503); expect(result.headers['Set-Cookie']).toBeUndefined();
});

it.each(['/start', '/disconnect', '/check'])('rejects a stale displayed provider revision for %s', async action => {
  const f = fixture(); const result = await f.request(action, 'POST', {}, JSON.stringify({ expectedRevision: 'b'.repeat(64) }));
  expect(result.status).toBe(409); expect(f.provider.begin).not.toHaveBeenCalled(); expect(f.provider.disconnect).not.toHaveBeenCalled(); expect(f.provider.check).not.toHaveBeenCalled();
});
