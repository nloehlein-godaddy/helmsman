import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlackOAuth, SLACK_USER_SCOPES, usesSlackOAuth } from './oauth.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const userGrant = (extra: Record<string, unknown> = {}) => ({ access_token: 'xoxp-user-token', token_type: 'user', scope: SLACK_USER_SCOPES.join(','), ...extra });

function fixture(options: { grant?: Record<string, unknown>; handler?: (endpoint: string, values: URLSearchParams) => unknown | Promise<unknown> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'helmsman-slack-oauth-')); directories.push(directory);
  let now = 1_800_000_000_000;
  const env = { SLACK_OAUTH_CLIENT_ID: '123.456', SLACK_OAUTH_CLIENT_SECRET: 'private-client-secret', SLACK_OAUTH_REDIRECT_URI: 'https://helmsman.example/api/communication-connection/callback', SLACK_CLIENT_ID: 'T123', SLACK_OAUTH_TOKEN_FILE: join(directory, 'credential.json') };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const endpoint = String(url).split('/').at(-1)!;
    const values = new URLSearchParams(String(init?.body));
    const custom = await options.handler?.(endpoint, values);
    const data = custom ?? (endpoint === 'auth.test' ? { ok: true, team_id: 'T123', user_id: 'U123' }
      : values.get('grant_type') === 'refresh_token' ? { ok: true, ...userGrant({ access_token: 'xoxp-rotated', refresh_token: 'refresh-rotated', expires_in: 7200 }) }
        : { ok: true, team: { id: 'T123' }, authed_user: { id: 'U123', ...userGrant(options.grant) } });
    return Response.json(data);
  });
  const oauth = createSlackOAuth({ env, fetch: fetcher, now: () => now });
  const complete = async (beforeCommit: () => void = () => {}) => {
    const begun = await oauth.begin(signal());
    await oauth.complete(new URLSearchParams({ state: begun.state, code: 'oauth-code' }), begun.state, signal(), beforeCommit);
    return begun;
  };
  return { oauth, env, fetcher, complete, advance(ms: number) { now += ms; } };
}

describe('Slack Companion optional OAuth', () => {
  it('requires explicit app configuration, HTTPS callback, and minimal user scopes', async () => {
    expect(usesSlackOAuth({ SLACK_MCP_TOKEN: 'token' })).toBe(false);
    expect(usesSlackOAuth({ SLACK_OAUTH_CLIENT_ID: '' })).toBe(false);
    expect(usesSlackOAuth({ SLACK_OAUTH_CLIENT_ID: '123' })).toBe(true);
    const f = fixture();
    const begun = await f.oauth.begin(signal());
    const url = new URL(begun.authorizationUrl);
    expect(url.origin).toBe('https://slack.com');
    expect(url.searchParams.get('user_scope')).toBe('channels:read,chat:write,search:read');
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.has('client_secret')).toBe(false);
    expect(readFileSync(f.env.SLACK_OAUTH_TOKEN_FILE, 'utf8')).not.toContain(begun.state);
    f.env.SLACK_OAUTH_REDIRECT_URI = 'http://localhost/api/communication-connection/callback';
    expect(await f.oauth.status(signal())).toMatchObject({ status: 'setup-required' });
    await expect(f.oauth.begin(signal())).rejects.toThrow('Configure');
  });

  it('validates user identity and persists private credentials with stable grant identity', async () => {
    const f = fixture(); const beforeCommit = vi.fn(); await f.complete(beforeCommit);
    expect(beforeCommit).toHaveBeenCalledTimes(1);
    expect(await f.oauth.status(signal())).toMatchObject({ status: 'connected', accountLabel: 'U123 · T123' });
    expect(lstatSync(f.env.SLACK_OAUTH_TOKEN_FILE).mode & 0o777).toBe(0o600);
    const restarted = createSlackOAuth({ env: f.env, fetch: f.fetcher });
    expect(restarted.identity()).toBe(f.oauth.identity());
    expect(await restarted.accessToken(signal())).toBe('xoxp-user-token');
    expect(f.fetcher.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
    await f.oauth.check(signal());
    expect(f.fetcher.mock.calls.every(([url]) => String(url).endsWith('/auth.test') || String(url).endsWith('/oauth.v2.access'))).toBe(true);
  });

  it('consumes successful and failed states once and rejects mismatched cookies', async () => {
    const f = fixture(); const begun = await f.oauth.begin(signal());
    const query = new URLSearchParams({ state: begun.state, code: 'code' });
    await expect(f.oauth.complete(query, 'wrong-cookie', signal(), () => {})).rejects.toThrow('could not be verified');
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.oauth.complete(query, begun.state, signal(), () => {});
    await expect(f.oauth.complete(query, begun.state, signal(), () => {})).rejects.toThrow('could not be verified');
    const failed = await f.oauth.begin(signal());
    await expect(f.oauth.complete(new URLSearchParams({ state: failed.state, error: 'access_denied' }), failed.state, signal(), () => {})).rejects.toThrow('authorization failed');
    await expect(f.oauth.complete(new URLSearchParams({ state: failed.state, code: 'code' }), failed.state, signal(), () => {})).rejects.toThrow('could not be verified');
  });

  it('expires states and keeps credentials unavailable after a denied host commit fence', async () => {
    const f = fixture(); const begun = await f.oauth.begin(signal()); f.advance(10 * 60_000);
    await expect(f.oauth.complete(new URLSearchParams({ state: begun.state, code: 'code' }), begun.state, signal(), () => {})).rejects.toThrow('could not be verified');
    await expect(f.complete(() => { throw new Error('Provider disabled.'); })).rejects.toThrow('authorization failed');
    expect(f.oauth.identity()).toBeNull();
  });

  it.each(['workspace', 'user', 'bot', 'scopes'])('rejects a grant with invalid %s', async kind => {
    const f = fixture({ grant: kind === 'scopes' ? { scope: 'chat:write' } : undefined, handler(endpoint) {
      if (endpoint !== 'auth.test') return;
      return { ok: true, team_id: kind === 'workspace' ? 'T999' : 'T123', user_id: kind === 'user' ? 'U999' : 'U123', ...(kind === 'bot' ? { bot_id: 'B123' } : {}) };
    } });
    await expect(f.complete()).rejects.toThrow('authorization failed');
    expect(f.oauth.identity()).toBeNull();
    expect(await f.oauth.status(signal())).toMatchObject({ status: 'error' });
  });

  it('refreshes once for concurrent callers and keeps the same connection identity', async () => {
    const f = fixture({ grant: { refresh_token: 'refresh-original', expires_in: 120 } }); await f.complete();
    const identity = f.oauth.identity(); f.advance(90_000);
    expect(await Promise.all([f.oauth.accessToken(signal()), f.oauth.accessToken(signal())])).toEqual(['xoxp-rotated', 'xoxp-rotated']);
    expect(f.fetcher.mock.calls.filter(([, init]) => String(init?.body).includes('grant_type=refresh_token'))).toHaveLength(1);
    expect(f.oauth.identity()).toBe(identity);
    expect(readFileSync(f.env.SLACK_OAUTH_TOKEN_FILE, 'utf8')).not.toContain('refresh-original');
  });

  it('status restores an expired grant only after refresh and subject verification', async () => {
    const f = fixture({ grant: { refresh_token: 'refresh-original', expires_in: 120 } }); await f.complete();
    const identity = f.oauth.identity(); f.advance(121_000); expect(f.oauth.identity()).toBeNull();
    expect(await f.oauth.status(signal())).toMatchObject({ status: 'connected' }); expect(f.oauth.identity()).toBe(identity);
  });

  it('fails closed when refresh changes the authenticated Slack user', async () => {
    let authCalls = 0;
    const f = fixture({ grant: { refresh_token: 'refresh-original', expires_in: 120 }, handler(endpoint) {
      if (endpoint === 'auth.test') return { ok: true, team_id: 'T123', user_id: ++authCalls === 1 ? 'U123' : 'U999' };
    } });
    await f.complete(); f.advance(90_000);
    await expect(f.oauth.accessToken(signal())).rejects.toThrow('could not be refreshed');
    expect(f.oauth.identity()).toBeNull();
  });

  it.each(['disconnect', 'begin', 'settings'])('fences an in-flight exchange after %s', async kind => {
    let release!: (value: unknown) => void;
    const f = fixture({ handler(endpoint) { if (endpoint === 'oauth.v2.access') return new Promise(resolve => { release = resolve; }); } });
    const begun = await f.oauth.begin(signal());
    const completing = f.oauth.complete(new URLSearchParams({ state: begun.state, code: 'code' }), begun.state, signal(), () => {});
    const failed = expect(completing).rejects.toThrow('authorization failed');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (kind === 'disconnect') await f.oauth.disconnect(signal());
    if (kind === 'begin') await f.oauth.begin(signal());
    if (kind === 'settings') f.env.SLACK_CLIENT_ID = 'T999';
    release({ ok: true, team: { id: 'T123' }, authed_user: { id: 'U123', ...userGrant() } });
    await failed; expect(f.oauth.identity()).toBeNull();
    if (kind === 'disconnect') expect(await f.oauth.status(signal())).toMatchObject({ status: 'disconnected' });
  });

  it('does not restore credentials when a pending refresh completes after disconnect', async () => {
    let release!: (value: unknown) => void;
    const f = fixture({ grant: { refresh_token: 'refresh-original', expires_in: 120 }, handler(endpoint, values) {
      if (endpoint === 'oauth.v2.access' && values.get('grant_type') === 'refresh_token') return new Promise(resolve => { release = resolve; });
    } });
    await f.complete(); f.advance(90_000);
    const refresh = f.oauth.accessToken(signal()); const failed = expect(refresh).rejects.toThrow('could not be refreshed');
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); await f.oauth.disconnect(signal());
    release({ ok: true, ...userGrant({ access_token: 'rotated', refresh_token: 'refresh-next', expires_in: 7200 }) });
    await failed; expect(f.oauth.identity()).toBeNull(); expect(await f.oauth.status(signal())).toMatchObject({ status: 'disconnected' });
  });

  it.each(['symlink', 'permissions', 'malformed'])('rejects %s credential files without exposing content', async kind => {
    const f = fixture();
    if (kind === 'symlink') { const target = join(dirname(f.env.SLACK_OAUTH_TOKEN_FILE), 'target'); writeFileSync(target, 'secret', { mode: 0o600 }); symlinkSync(target, f.env.SLACK_OAUTH_TOKEN_FILE); }
    else { await f.complete(); if (kind === 'permissions') chmodSync(f.env.SLACK_OAUTH_TOKEN_FILE, 0o644); else writeFileSync(f.env.SLACK_OAUTH_TOKEN_FILE, '{secret}'); }
    expect(f.oauth.identity()).toBeNull();
    expect(await f.oauth.status(signal())).toMatchObject({ status: 'error', message: expect.stringContaining('private regular file') });
    await expect(f.oauth.begin(signal())).rejects.toThrow('private regular file');
  });
});
