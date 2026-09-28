import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommunicationProviderContextV1, CommunicationReviewRequestV1 } from '@helmsman/plugin-sdk';
import { createSlackCompanionProvider } from './provider.js';
import { SLACK_USER_SCOPES } from './oauth.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'helmsman-companion-provider-')); directories.push(directory);
  let now = 1_800_000_000_000;
  const env = { SLACK_MCP_TOKEN: 'legacy-token-must-not-be-used', SLACK_OAUTH_CLIENT_ID: '123.456', SLACK_OAUTH_CLIENT_SECRET: 'client-secret', SLACK_OAUTH_REDIRECT_URI: 'https://helmsman.example/api/communication-connection/callback', SLACK_CLIENT_ID: 'T123', SLACK_OAUTH_TOKEN_FILE: join(directory, 'token.json') };
  const tools: string[] = [];
  const tokenHeaders: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/oauth.v2.access')) {
      const refresh = new URLSearchParams(String(init?.body)).get('grant_type') === 'refresh_token';
      const token = { access_token: refresh ? 'oauth-rotated-token' : 'oauth-user-token', refresh_token: 'refresh-token', expires_in: 120, scope: SLACK_USER_SCOPES.join(','), token_type: 'user' };
      return Response.json(refresh ? { ok: true, ...token } : { ok: true, team: { id: 'T123' }, authed_user: { id: 'U123', ...token } });
    }
    if (String(url).endsWith('/auth.test')) return Response.json({ ok: true, team_id: 'T123', user_id: 'U123' });
    tokenHeaders.push(new Headers(init?.headers).get('Authorization') ?? '');
    const request = JSON.parse(String(init?.body));
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } });
    tools.push(request.params.name);
    const result = request.params.name === 'get_channel_info' ? { id: 'C123', name: 'reviews', is_archived: false, context_team_id: 'T123' } : { channel: 'C123', ts: '1800000000.000001' };
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
  });
  const provider = createSlackCompanionProvider({ env, fetch: fetcher, now: () => now });
  async function connect() {
    const begun = await provider.connection!.begin(new AbortController().signal);
    await provider.connection!.complete(new URLSearchParams({ state: begun.state, code: 'code' }), begun.state, new AbortController().signal, () => {});
  }
  function request() {
    const destination = { providerId: 'helmsman.slack-companion/slack', artifactHash: 'artifact', workspace: 'T123', channel: 'C123', mention: 'S123', connectionId: provider.connectionIdentity!()! };
    const context: CommunicationProviderContextV1 = { signal: new AbortController().signal, destination, surface: null, watchedChannel: { id: 'C123', name: 'reviews' }, beforeSend: vi.fn(async () => {}), browser: { tree: vi.fn(), focus: vi.fn(), evaluate: vi.fn(), click: vi.fn(), fill: vi.fn(), wait: vi.fn() } };
    const input: CommunicationReviewRequestV1 = { id: 'operation', caller: 'caller', contentHash: 'hash', requestId: 'fb5f88e7-8bc8-488f-8a3d-fcfbb0192203', repo: 'org/repo', number: 1, destination };
    return { input, context };
  }
  return { provider, env, tools, tokenHeaders, connect, request, advance(ms: number) { now += ms; } };
}

describe('Slack Companion OAuth provider integration', () => {
  it('refreshes before MCP calls without changing the retained connection identity', async () => {
    const f = fixture(); await f.connect(); const { input, context } = f.request();
    f.advance(90_000);
    expect(await f.provider.invokeReviewRequest(input, context)).toMatchObject({ status: 'acknowledged' });
    expect(f.provider.connectionIdentity!()).toBe(input.destination.connectionId);
    expect(f.tokenHeaders.every(header => header === 'Bearer oauth-rotated-token')).toBe(true);
    expect(f.tools).toEqual(['get_channel_info', 'send_message']);
  });

  it('keeps disconnected OAuth unavailable even when a legacy environment token exists', async () => {
    const f = fixture(); expect(f.provider.connectionIdentity!()).toBeNull();
    await f.connect(); const { input, context } = f.request(); await f.provider.connection!.disconnect(context.signal);
    expect(await f.provider.invokeReviewRequest(input, context)).toMatchObject({ status: 'definitely-not-applied' });
    expect(f.provider.connectionIdentity!()).toBeNull(); expect(f.tools).toEqual([]); expect(f.tokenHeaders).toEqual([]);
    expect(await f.provider.connection!.status(context.signal)).toMatchObject({ status: 'disconnected' });
  });

  it('checks without sending and prevents a send after disconnect at the authorization fence', async () => {
    const f = fixture(); await f.connect(); await f.provider.connection!.check(new AbortController().signal); expect(f.tools).toEqual([]);
    const { input, context } = f.request();
    context.beforeSend = () => f.provider.connection!.disconnect(context.signal);
    expect(await f.provider.invokeReviewRequest(input, context)).toMatchObject({ status: 'definitely-not-applied' });
    expect(f.tools).toEqual(['get_channel_info']); expect(f.provider.connectionIdentity!()).toBeNull();
  });

  it('rejects a different workspace before using the OAuth credential', async () => {
    const f = fixture(); await f.connect(); const { input, context } = f.request();
    const changed = { ...context, destination: { ...context.destination, workspace: 'T999' } };
    expect(await f.provider.invokeReviewRequest({ ...input, destination: changed.destination }, changed)).toMatchObject({ status: 'definitely-not-applied' });
    expect(f.tokenHeaders).toEqual([]);
  });

  it('keeps direct token mode available when optional OAuth environment values are empty', () => {
    const provider = createSlackCompanionProvider({ env: { SLACK_MCP_TOKEN: 'legacy-token', SLACK_OAUTH_CLIENT_ID: '', SLACK_OAUTH_TOKEN_FILE: '' } });
    expect(provider.connection).toBeUndefined(); expect(provider.connectionIdentity!()).toMatch(/^slack-mcp:/);
  });
});
