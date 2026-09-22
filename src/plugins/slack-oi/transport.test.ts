// @vitest-environment node
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SLACK_OI_URL, SLACK_OI_MODEL, SLACK_OI_TOOL_ID, SlackOiClient, slackOiConfiguration } from './transport.js';

const args = { team_id: 'T123', channel_id: 'C123' };
const chatId = '11111111-2222-3333-4444-555555555555';

function fixture(options: {
  enabled?: unknown;
  model?: unknown;
  pending?: (output: Record<string, unknown>[]) => Record<string, unknown>[];
  evidence?: (output: Record<string, unknown>[]) => Record<string, unknown>[];
  result?: unknown;
  loseApproval?: boolean;
  stalePolls?: number;
  authMode?: 'bearer' | 'sso-jwt';
} = {}) {
  const controller = new AbortController();
  const state = { enabled: options.enabled === undefined ? true : options.enabled, userId: 'user', approvalCount: 0, stopped: 0, messageId: '', requestedArgs: args as Record<string, unknown>, name: 'get_channel_info', pollCount: 0 };
  const calls: { path: string; body: Record<string, unknown> | undefined }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    let response: unknown;
    if (path === '/api/v1/auths/') response = { id: state.userId };
    else if (path === '/api/config') response = { features: { enable_tool_permissions: state.enabled } };
    else if (path === '/api/v1/models') response = { data: [options.model ?? { id: SLACK_OI_MODEL, info: { base_model_id: 'base-model', meta: { toolIds: ['basictoolkit', SLACK_OI_TOOL_ID], capabilities: { secure_access: true } } } }] };
    else if (path === '/api/v1/chats/new') {
      state.messageId = body.chat.history.currentId;
      response = { id: chatId };
    } else if (path === '/api/chat/completions') response = { status: true, task_id: 'task' };
    else if (path.endsWith('/resolve')) {
      state.approvalCount++;
      if (options.loseApproval) throw new Error('upstream echoed secret');
      response = { status: true };
    } else if (path.endsWith('/stop')) {
      state.stopped++;
      response = { status: true };
    } else if (path === `/api/v1/chats/${chatId}`) {
      state.pollCount++;
      const completed = state.approvalCount > 0 && state.pollCount > (options.stalePolls ?? 0) + 1;
      let output: Record<string, unknown>[] = [{ type: 'function_call', call_id: 'call', name: `slack_${state.name}`, arguments: JSON.stringify(state.requestedArgs), status: completed ? 'completed' : 'pending' }];
      if (completed) output.push({ type: 'function_call_output', call_id: 'call', status: 'completed', output: [{ type: 'input_text', text: JSON.stringify(options.result ?? { id: 'C123', name: 'reviews' }) }] });
      output = completed ? options.evidence?.(output) ?? output : options.pending?.(output) ?? output;
      const message = { output, meta: { params: { tool_approval_mode: 'ask' } } };
      response = { chat: { params: { tool_approval_mode: 'ask' }, history: { messages: { [state.messageId]: message } } } };
    } else throw new Error(`Unexpected fixture URL ${path}`);
    return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
  });
  const client = new SlackOiClient({ url: DEFAULT_SLACK_OI_URL, token: 'test-oi-token', oauthSessionId: 'test-oi-session', authMode: options.authMode ?? 'bearer' }, fetcher, controller.signal);
  return { client, fetcher, calls, controller, state };
}

describe('Slack OI guarded transport', () => {
  it.each([false, null, 'true', 1])('requires explicit enabled native approvals (%s)', async enabled => {
    const f = fixture({ enabled });
    await expect(f.client.initialize()).rejects.toThrow('native tool approvals');
    expect(f.calls.map(call => call.path)).toEqual(['/api/v1/auths/', '/api/config']);
  });

  it.each([
    { id: SLACK_OI_MODEL, info: { base_model_id: 'base', meta: { toolIds: ['different-tool'] } } },
    { id: SLACK_OI_MODEL, pipeline: {}, info: { base_model_id: 'base', meta: { toolIds: [SLACK_OI_TOOL_ID] } } },
    { id: SLACK_OI_MODEL, info: { base_model_id: '', meta: { toolIds: [SLACK_OI_TOOL_ID] } } },
  ])('rejects an incompatible Companion without creating chats', async model => {
    const f = fixture({ model });
    await expect(f.client.initialize()).rejects.toThrow('verified native Slack');
    expect(f.calls.some(call => call.path.endsWith('/new'))).toBe(false);
  });

  it('requires Secure Data Mode support before creating a chat', async () => {
    const f = fixture({ model: { id: SLACK_OI_MODEL, info: { base_model_id: 'base', meta: { toolIds: [SLACK_OI_TOOL_ID], capabilities: { secure_access: false } } } } });
    await expect(f.client.initialize()).rejects.toThrow('Secure Data Mode');
    expect(f.calls.some(call => call.path.endsWith('/new'))).toBe(false);
  });

  it.each(['bearer', 'sso-jwt'] as const)('approves exact tool evidence once with %s authentication', async authMode => {
    const f = fixture({ authMode });
    await f.client.initialize();
    await expect(f.client.call('get_channel_info', args)).resolves.toEqual({ id: 'C123', name: 'reviews' });
    expect(f.state.approvalCount).toBe(1);
    expect(f.state.stopped).toBe(1);
    const completion = f.calls.find(call => call.path === '/api/chat/completions')?.body;
    expect(completion).toMatchObject({ stream: true, sdm_mode: true, tool_ids: [SLACK_OI_TOOL_ID], params: { function_calling: 'native', tool_approval_mode: 'ask' } });
    expect(f.fetcher.mock.calls.every(([, init]) => init?.redirect === 'error' && (init.headers as Record<string, string>).Cookie === 'oauth_session_id=test-oi-session' && (init.headers as Record<string, string>).Authorization === `${authMode === 'bearer' ? 'Bearer' : 'sso-jwt'} test-oi-token`)).toBe(true);
  });

  it('accepts reordered object keys without allowing changed values', async () => {
    const f = fixture({ pending: output => [{ ...output[0], arguments: JSON.stringify({ channel_id: 'C123', team_id: 'T123' }) }] });
    await f.client.initialize();
    await expect(f.client.call('get_channel_info', args)).resolves.toMatchObject({ id: 'C123' });
  });

  it.each(['name', 'arguments', 'extra', 'unapproved-result'])('stops %s evidence before approving', async kind => {
    const f = fixture({ pending: output => {
      if (kind === 'name') return [{ ...output[0], name: 'slack_send_message' }];
      if (kind === 'arguments') return [{ ...output[0], arguments: JSON.stringify({ ...args, channel_id: 'C999' }) }];
      if (kind === 'extra') return [...output, { ...output[0], call_id: 'extra' }];
      return [...output, { type: 'function_call_output', call_id: 'call', status: 'completed', output: [{ type: 'input_text', text: '{}' }] }];
    } });
    await f.client.initialize();
    await expect(f.client.call('get_channel_info', args)).rejects.toThrow('Slack OI');
    expect(f.state.approvalCount).toBe(0);
    expect(f.state.stopped).toBe(1);
  });

  it('rechecks readiness before every operation', async () => {
    const f = fixture();
    await f.client.initialize();
    f.state.enabled = false;
    await expect(f.client.call('get_channel_info', args)).rejects.toThrow('native tool approvals');
    expect(f.calls.some(call => call.path.endsWith('/new'))).toBe(false);
  });

  it('rejects a changed authenticated account', async () => {
    const f = fixture();
    await f.client.initialize();
    f.state.userId = 'different-user';
    await expect(f.client.call('get_channel_info', args)).rejects.toThrow('authentication is unavailable or changed');
    expect(f.calls.some(call => call.path.endsWith('/new'))).toBe(false);
  });

  it('calls the send fence only immediately before approval', async () => {
    const f = fixture();
    f.state.name = 'send_message';
    f.state.requestedArgs = { ...args, text: 'Review this PR' };
    await f.client.initialize();
    const fence = vi.fn(async () => { expect(f.state.approvalCount).toBe(0); expect(f.calls.at(-1)?.path).toBe('/api/v1/models'); });
    await f.client.call('send_message', f.state.requestedArgs, fence);
    expect(fence).toHaveBeenCalledTimes(1);
    expect(f.state.approvalCount).toBe(1);
  });

  it.each(['fence', 'cancel'])('does not approve after %s rejects dispatch', async kind => {
    const f = fixture();
    await f.client.initialize();
    await expect(f.client.call('get_channel_info', args, async () => {
      if (kind === 'cancel') f.controller.abort();
      else throw new Error('sensitive fence detail');
    })).rejects.toThrow('Slack OI');
    expect(f.state.approvalCount).toBe(0);
    expect(f.state.stopped).toBe(1);
    const stop = f.fetcher.mock.calls.find(([url]) => String(url).endsWith('/stop'));
    expect(stop?.[1]?.signal?.aborted).toBe(false);
  });

  it('never retries an approval with an uncertain response', async () => {
    const f = fixture({ loseApproval: true });
    await f.client.initialize();
    await expect(f.client.call('get_channel_info', args)).rejects.toThrow('Slack OI request failed');
    expect(f.state.approvalCount).toBe(1);
    expect(f.state.stopped).toBe(1);
  });

  it('waits through stale pending snapshots without approving twice', async () => {
    const f = fixture({ stalePolls: 1 });
    await f.client.initialize();
    await expect(f.client.call('get_channel_info', args)).resolves.toMatchObject({ id: 'C123' });
    expect(f.state.approvalCount).toBe(1);
  });

  it('waits for pending approval while the tool name and arguments are still streaming', async () => {
    let polls = 0;
    const f = fixture({ pending: output => ++polls === 1 ? [{ ...output[0], status: 'in_progress', name: 'slack_get', arguments: '{"team_id":' }] : output });
    await f.client.initialize();
    await expect(f.client.call('get_channel_info', args)).resolves.toMatchObject({ id: 'C123' });
    expect(f.state.approvalCount).toBe(1);
    expect(f.state.pollCount).toBe(3);
  });

  it.each(['wrong-call', 'failed-result', 'invalid-json'])('rejects %s after dispatch instead of trusting prose', async kind => {
    const f = fixture({ evidence: output => {
      const result = { ...output[1] };
      if (kind === 'wrong-call') result.call_id = 'wrong';
      if (kind === 'failed-result') result.error = true;
      if (kind === 'invalid-json') result.output = [{ type: 'input_text', text: 'The message was sent successfully.' }];
      return [output[0]!, result];
    } });
    await f.client.initialize();
    await expect(f.client.call('get_channel_info', args)).rejects.toThrow('Slack OI');
    expect(f.state.approvalCount).toBe(1);
    expect(f.state.stopped).toBe(1);
  });

  it('bounds responses and sanitizes upstream errors', async () => {
    for (const response of [new Response('x'.repeat(2 * 1024 * 1024 + 1)), new Response('private details', { status: 401 })]) {
      const client = new SlackOiClient({ url: DEFAULT_SLACK_OI_URL, token: 'test-token', oauthSessionId: 'test-oi-session', authMode: 'bearer' }, vi.fn(async () => response), new AbortController().signal);
      await expect(client.initialize()).rejects.toThrow(/^Slack OI /);
    }
  });
});

describe('Slack OI credentials', () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it('accepts private owned credential files and rejects exposed files or symlinks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'helmsman-oi-token-'));
    directories.push(directory);
    const file = join(directory, 'token');
    writeFileSync(file, 'private-test-token\n', { mode: 0o600 });
    expect(slackOiConfiguration({ SLACK_OI_TOKEN_FILE: file, SLACK_OI_OAUTH_SESSION_ID: 'test-oi-session' })).toEqual({ url: DEFAULT_SLACK_OI_URL, token: 'private-test-token', authMode: 'bearer', oauthSessionId: 'test-oi-session' });
    const link = join(directory, 'link');
    symlinkSync(file, link);
    expect(() => slackOiConfiguration({ SLACK_OI_TOKEN_FILE: link })).toThrow('private');
    chmodSync(file, 0o644);
    expect(() => slackOiConfiguration({ SLACK_OI_TOKEN_FILE: file, SLACK_OI_OAUTH_SESSION_ID: 'test-oi-session' })).toThrow('private');
  });

  it('rejects credential ambiguity, malformed tokens, and unapproved endpoints', () => {
    for (const env of [
      { SLACK_OI_TOKEN: 'token', SLACK_OI_TOKEN_FILE: '/tmp/token' },
      { SLACK_OI_TOKEN_FILE: 'relative' },
      { SLACK_OI_TOKEN: 'token\nsecret' },
      { SLACK_OI_TOKEN: 'token', SLACK_OI_URL: 'https://evil.example' },
      { SLACK_OI_TOKEN: 'token', SLACK_OI_AUTH_MODE: 'api-key' },
      { GOCAAS_API_KEY: 'not-an-oi-token' },
    ]) expect(() => slackOiConfiguration(env)).toThrow('Slack OI');
  });

  it.each(['', 'session; another=cookie', 'session\r\nOther: value', 'x'.repeat(513)])('rejects missing or unsafe OAuth session context (%s)', oauthSessionId => {
    expect(() => slackOiConfiguration({ SLACK_OI_TOKEN: 'token', SLACK_OI_OAUTH_SESSION_ID: oauthSessionId })).toThrow('SLACK_OI_OAUTH_SESSION_ID');
  });
});
