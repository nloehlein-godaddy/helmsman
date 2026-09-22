import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommunicationProviderContextV1, CommunicationReviewRequestV1 } from '@helmsman/plugin-sdk';
import { createSlackOiProvider } from './provider.js';
import { SlackOiClient } from './transport.js';

function fixture(options: { disabled?: boolean; beforeApproval?: () => void; tool?: (name: string, args: Record<string, unknown>) => Record<string, unknown> | undefined } = {}) {
  const env = { SLACK_OI_TOKEN: 'test-oi-token', SLACK_OI_AUTH_MODE: 'bearer', SLACK_OI_OAUTH_SESSION_ID: 'test-oi-oauth-session' };
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const approvals: string[] = [];
  const initialize = vi.spyOn(SlackOiClient.prototype, 'initialize').mockImplementation(async () => {
    if (options.disabled) throw new Error('Slack OI native tool approval is unavailable.');
  });
  vi.spyOn(SlackOiClient.prototype, 'call').mockImplementation(async (name, args, beforeExecute) => {
    calls.push({ name, args });
    if (name === 'send_message') options.beforeApproval?.();
    await beforeExecute?.();
    approvals.push(name);
    return options.tool?.(name, args) ?? (name === 'get_channel_info'
      ? { id: 'C123', name: 'reviews', is_archived: false, context_team_id: 'T123' }
      : { ts: '1789999999.000001', channel: 'C123' });
  });
  const fetcher = vi.fn<typeof fetch>();
  const provider = createSlackOiProvider({ env, fetch: fetcher, now: () => 1790000000000 });
  const destination = { providerId: 'helmsman.slack-oi/slack', artifactHash: 'artifact', workspace: 'T123', channel: 'C123', mention: 'S123', connectionId: provider.connectionIdentity!()! };
  const controller = new AbortController();
  const context: CommunicationProviderContextV1 = { signal: controller.signal, destination, surface: null, watchedChannel: { id: 'C123', name: 'reviews' }, beforeSend: vi.fn(async () => {}), browser: { tree: vi.fn(), focus: vi.fn(), evaluate: vi.fn(), click: vi.fn(), fill: vi.fn(), wait: vi.fn() } };
  const request: CommunicationReviewRequestV1 = { id: 'operation', caller: 'caller', contentHash: 'hash', requestId: 'fb5f88e7-8bc8-488f-8a3d-fcfbb0192203', repo: 'org/repo', number: 1, destination };
  return { provider, context, request, calls, approvals, fetcher, env, initialize, controller };
}

afterEach(() => vi.restoreAllMocks());

describe('OI Slack Companion provider', () => {
  it('authorizes at approval and acknowledges only an exact Slack receipt', async () => {
    const f = fixture({ beforeApproval() { expect(f.context.beforeSend).not.toHaveBeenCalled(); } });
    expect(await f.provider.prepareReviewRequest(f.request, f.context)).toMatchObject({ channel: 'C123', mention: 'S123' });
    expect(f.calls).toEqual([]);
    expect(f.initialize).not.toHaveBeenCalled();
    expect(await f.provider.invokeReviewRequest(f.request, f.context)).toMatchObject({ status: 'acknowledged', receipt: { permalink: 'https://app.slack.com/archives/C123/p1789999999000001' } });
    expect(f.context.beforeSend).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(1);
    expect(f.calls.filter(call => call.name === 'send_message')).toEqual([{ name: 'send_message', args: { team_id: 'T123', channel_id: 'C123', text: '<!subteam^S123> Could you review this PR? https://github.com/org/repo/pull/1' } }]);
    expect(f.context.browser.tree).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('fails before tool calls when native approval is disabled', async () => {
    const f = fixture({ disabled: true });
    expect(await f.provider.prepareReviewRequest(f.request, f.context)).toMatchObject({ channel: 'C123' });
    expect(f.initialize).not.toHaveBeenCalled();
    expect(await f.provider.invokeReviewRequest(f.request, f.context)).toMatchObject({ status: 'definitely-not-applied', retryable: false, reason: expect.stringContaining('native tool approval') });
    expect(f.calls).toEqual([]);
    expect(f.context.beforeSend).not.toHaveBeenCalled();
  });

  it.each(['authorization', 'credential', 'oauth-session', 'cancellation'])('prevents approval after %s changes at the fence', async kind => {
    const f = fixture();
    f.context.beforeSend = vi.fn(async () => {
      if (kind === 'authorization') throw new Error('Authorization changed.');
      if (kind === 'credential') f.env.SLACK_OI_TOKEN = 'replacement-oi-token';
      if (kind === 'oauth-session') f.env.SLACK_OI_OAUTH_SESSION_ID = 'replacement-oi-oauth-session';
      if (kind === 'cancellation') f.controller.abort();
    });
    expect(await f.provider.invokeReviewRequest(f.request, f.context)).toMatchObject({ status: 'definitely-not-applied' });
    expect(f.approvals).not.toContain('send_message');
  });

  it.each(['lost-response', 'malformed', 'wrong-channel', 'assistant-prose'])('keeps %s after approval unknown without retrying', async kind => {
    const f = fixture({ tool(name) {
      if (name !== 'send_message') return undefined;
      if (kind === 'lost-response') throw new Error('Network response lost.');
      return kind === 'malformed' ? { ts: null, channel: 'C123' }
        : kind === 'wrong-channel' ? { ts: '1789999999.000001', channel: 'C999' }
          : { content: 'I sent your Slack message.' };
    } });
    expect(await f.provider.invokeReviewRequest(f.request, f.context)).toMatchObject({ status: 'unknown' });
    expect(await f.provider.reconcileReviewRequest(f.request, f.context)).toMatchObject({ status: 'unknown' });
    expect(f.approvals.filter(name => name === 'send_message')).toHaveLength(1);
  });

  it('changes connection identity with OI credentials, OAuth session, or authentication mode', () => {
    const f = fixture();
    const first = f.provider.connectionIdentity!();
    expect(first).toMatch(/^slack-oi:[a-f\d]{64}$/);
    f.env.SLACK_OI_AUTH_MODE = 'sso-jwt';
    expect(f.provider.connectionIdentity!()).not.toBe(first);
    const second = f.provider.connectionIdentity!();
    f.env.SLACK_OI_TOKEN = 'replacement-token';
    expect(f.provider.connectionIdentity!()).not.toBe(second);
    const third = f.provider.connectionIdentity!();
    f.env.SLACK_OI_OAUTH_SESSION_ID = 'replacement-oi-oauth-session';
    expect(f.provider.connectionIdentity!()).not.toBe(third);
    f.env.SLACK_OI_OAUTH_SESSION_ID = '';
    expect(f.provider.connectionIdentity!()).toBeNull();
    expect(createSlackOiProvider({ env: {} }).connectionIdentity!()).toBeNull();
  });

  it('rejects destination changes and channel names before OI requests', async () => {
    const f = fixture();
    expect(await f.provider.invokeReviewRequest({ ...f.request, destination: { ...f.request.destination, channel: 'C999' } }, f.context)).toMatchObject({ status: 'definitely-not-applied' });
    expect(await f.provider.invokeReviewRequest(f.request, { ...f.context, destination: { ...f.context.destination, channel: 'reviews' } })).toMatchObject({ status: 'definitely-not-applied' });
    expect(f.initialize).not.toHaveBeenCalled();
  });

  it('paginates discovery using a fixed query and excludes messages outside the cursor', async () => {
    const f = fixture({ tool(name, args) {
      if (name !== 'search_messages') return undefined;
      const ts = args.page === 1 ? '1789999999.000001' : '1789999998.000001';
      return { paging: { page: args.page, pages: 2, total: 2 }, matches: [{ channel: { id: 'C123' }, ts, user: 'U123', text: '<https://github.com/org/repo/pull/2|PR>', permalink: `https://godaddy.slack.com/archives/C123/p${ts.replace('.', '')}` }] };
    } });
    const result = await f.provider.scanReviewRequests({ since: '1789999998.500000' }, f.context);
    expect(result.complete).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.prUrls).toEqual(['https://github.com/org/repo/pull/2']);
    const calls = f.calls.filter(call => call.name === 'search_messages');
    expect(calls.map(call => call.args.page)).toEqual([1, 2]);
    expect(calls[0]?.args.query).toBe(calls[1]?.args.query);
  });

  it('reports malformed discovery results as incomplete', async () => {
    const f = fixture({ tool(name, args) {
      if (name !== 'search_messages') return undefined;
      return { paging: { page: args.page, pages: 1, total: 1 }, matches: [null] };
    } });
    expect(await f.provider.scanReviewRequests({ since: '1789999990.000000' }, f.context)).toEqual({ complete: false, messages: [] });
  });
});
