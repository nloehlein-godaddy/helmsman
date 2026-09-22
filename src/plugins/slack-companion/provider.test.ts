import { describe, expect, it, vi } from 'vitest';
import type { CommunicationProviderContextV1, CommunicationReviewRequestV1 } from '@helmsman/plugin-sdk';
import { createSlackCompanionProvider } from './provider.js';
import { DEFAULT_SLACK_MCP_URL, SlackMcpClient } from './transport.js';

function fixture(options: { sse?: boolean; tool?: (name: string, args: Record<string, unknown>) => unknown } = {}) {
  const env = { SLACK_MCP_TOKEN: 'test-slack-user-token' };
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result: unknown = { protocolVersion: '2025-03-26', capabilities: { tools: {} } };
    if (request.method === 'tools/call') {
      calls.push({ name: request.params.name, args: request.params.arguments });
      const value = options.tool?.(request.params.name, request.params.arguments) ?? (request.params.name === 'get_channel_info' ? { id: 'C123', name: 'reviews', is_archived: false, context_team_id: 'T123' } : { ts: '1789999999.000001', channel: 'C123' });
      result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
    return new Response(options.sse ? `event: message\r\ndata: ${body}\r\n\r\n` : body, { headers: { 'Content-Type': options.sse ? 'text/event-stream' : 'application/json' } });
  });
  const provider = createSlackCompanionProvider({ env, fetch: fetcher, now: () => 1790000000000 });
  const destination = { providerId: 'helmsman.slack-companion/slack', artifactHash: 'artifact', workspace: 'T123', channel: 'C123', mention: 'S123', connectionId: provider.connectionIdentity!()! };
  const context: CommunicationProviderContextV1 = { signal: new AbortController().signal, destination, surface: null, watchedChannel: { id: 'C123', name: 'reviews' }, beforeSend: vi.fn(async () => {}), browser: { tree: vi.fn(), focus: vi.fn(), evaluate: vi.fn(), click: vi.fn(), fill: vi.fn(), wait: vi.fn() } };
  const request: CommunicationReviewRequestV1 = { id: 'operation', caller: 'caller', contentHash: 'hash', requestId: 'fb5f88e7-8bc8-488f-8a3d-fcfbb0192203', repo: 'org/repo', number: 1, destination };
  return { provider, context, request, calls, fetcher, env };
}

describe('Slack Companion', () => {
  it.each([false, true])('negotiates MCP, uses bearer credentials, and acknowledges exact receipts (SSE %s)', async sse => {
    const f = fixture({ sse });
    expect(await f.provider.prepareReviewRequest(f.request, f.context)).toEqual(expect.objectContaining({ channel: 'C123', mention: 'S123' }));
    expect(await f.provider.invokeReviewRequest(f.request, f.context)).toMatchObject({ status: 'acknowledged', receipt: { permalink: 'https://app.slack.com/archives/C123/p1789999999000001' } });
    expect(f.context.beforeSend).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.name === 'send_message')).toEqual([{ name: 'send_message', args: { team_id: 'T123', channel_id: 'C123', text: '<!subteam^S123> Could you review this PR? https://github.com/org/repo/pull/1' } }]);
    expect(f.fetcher.mock.calls.every(([url, init]) => url === DEFAULT_SLACK_MCP_URL && init?.redirect === 'error' && (init.headers as Record<string, string>).Authorization === 'Bearer test-slack-user-token')).toBe(true);
    expect(f.context.browser.tree).not.toHaveBeenCalled();
  });

  it('does not send after authorization fails or the credential changes', async () => {
    const f = fixture();
    f.context.beforeSend = vi.fn(async () => { f.env.SLACK_MCP_TOKEN = 'changed-token'; });
    expect(await f.provider.invokeReviewRequest(f.request, f.context)).toMatchObject({ status: 'definitely-not-applied' });
    expect(f.calls.some(call => call.name === 'send_message')).toBe(false);
    expect(f.provider.connectionIdentity!()).not.toBe(f.request.destination.connectionId);
  });

  it.each(['exception', 'malformed', 'wrong-channel', 'slack-error'])('keeps post-dispatch %s ambiguous without retry', async kind => {
    const f = fixture({ tool(name) {
      if (name !== 'send_message') return undefined;
      if (kind === 'exception') throw new Error('network response lost');
      return kind === 'malformed' ? { ts: null, channel: 'C123' } : kind === 'wrong-channel' ? { ts: '1789999999.000001', channel: 'C999' } : { error: 'ratelimited' };
    } });
    expect(await f.provider.invokeReviewRequest(f.request, f.context)).toMatchObject({ status: 'unknown' });
    expect(await f.provider.reconcileReviewRequest(f.request, f.context)).toMatchObject({ status: 'unknown' });
    expect(f.calls.filter(call => call.name === 'send_message')).toHaveLength(1);
  });

  it('rejects missing credentials, unsafe endpoints, handles, and channel names before writes', async () => {
    expect(createSlackCompanionProvider({ env: {} }).connectionIdentity!()).toBeNull();
    expect(createSlackCompanionProvider({ env: { SLACK_MCP_TOKEN: 'token', SLACK_MCP_URL: 'https://evil.example/mcp' } }).connectionIdentity!()).toBeNull();
    const f = fixture();
    for (const change of [{ channel: 'reviews' }, { mention: 'reviewers' }]) {
      const context = { ...f.context, destination: { ...f.context.destination, ...change } };
      expect(await f.provider.invokeReviewRequest({ ...f.request, destination: context.destination }, context)).toMatchObject({ status: 'definitely-not-applied' });
    }
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('includes threaded search matches and paginates a fixed query, filtering the cursor', async () => {
    const f = fixture({ tool(name, args) {
      if (name !== 'search_messages') return undefined;
      const ts = args.page === 1 ? '1789999999.000001' : '1789999998.000001';
      return { paging: { page: args.page, pages: 2, total: 2 }, matches: [{ channel: { id: 'C123' }, ts, thread_ts: '1789990000.000000', user: 'U123', text: '<https://github.com/org/repo/pull/2|PR> and https://github.com/org/repo/pull/3', permalink: `https://godaddy.slack.com/archives/C123/p${ts.replace('.', '')}` }] };
    } });
    const result = await f.provider.scanReviewRequests({ since: '1789999998.500000' }, f.context);
    expect(result.complete).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.prUrls).toEqual(['https://github.com/org/repo/pull/2', 'https://github.com/org/repo/pull/3']);
    const calls = f.calls.filter(call => call.name === 'search_messages');
    expect(calls.map(call => call.args.page)).toEqual([1, 2]);
    expect(calls[0]?.args.query).toBe(calls[1]?.args.query);
  });

  it.each(['bad-message', 'duplicates', 'changed-total', 'page-cap'])('reports incomplete scans for %s', async kind => {
    const f = fixture({ tool(name, args) {
      if (name !== 'search_messages') return undefined;
      return { paging: { page: args.page, pages: kind === 'page-cap' ? 11 : 2, total: kind === 'changed-total' && args.page === 2 ? 3 : kind === 'page-cap' ? 11 : 2 }, matches: [{ channel: { id: kind === 'bad-message' ? 'C999' : 'C123' }, ts: '1789999999.000001', user: 'U123', text: 'https://github.com/org/repo/pull/2', permalink: 'https://godaddy.slack.com/archives/C123/p1789999999000001' }] };
    } });
    expect((await f.provider.scanReviewRequests({ since: '1789999990.000000' }, f.context)).complete).toBe(false);
    expect(f.calls.filter(call => call.name === 'search_messages').length).toBeLessThanOrEqual(10);
  });

  it('rejects malformed protocol envelopes and bounds responses', async () => {
    for (const body of [JSON.stringify({ id: 1, result: {} }), ' '.repeat(2 * 1024 * 1024 + 1)]) {
      const mcp = new SlackMcpClient({ url: DEFAULT_SLACK_MCP_URL, token: 'token' }, vi.fn(async () => new Response(body)), new AbortController().signal);
      await expect(mcp.initialize()).rejects.toThrow('Slack MCP');
    }
  });
});
