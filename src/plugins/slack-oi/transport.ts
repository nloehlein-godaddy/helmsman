import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const DEFAULT_SLACK_OI_URL = 'https://caas.open-webui.godaddy.com';
export const SLACK_OI_MODEL = 'godaddy-slack-companion';
export const SLACK_OI_TOOL_ID = 'server:mcp:fb83f675-3afd-44ca-bd4b-0db75b50a4bc';
const MAX_RESPONSE = 2 * 1024 * 1024;
const ALLOWED_TOOLS = new Set(['get_channel_info', 'list_channels', 'search_messages', 'get_thread_replies', 'send_message']);

export interface SlackOiConfiguration { url: string; token: string; authMode: 'bearer' | 'sso-jwt'; oauthSessionId: string }

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validateConfiguration(config: SlackOiConfiguration): SlackOiConfiguration {
  if (![DEFAULT_SLACK_OI_URL, 'https://caas.open-webui.test-gdcorp.tools'].includes(config.url)) throw new Error('Slack OI URL must be the production or test GoDaddy OI endpoint.');
  if (!config.token || config.token.length > 16_384 || /[^\x21-\x7e]/.test(config.token)) throw new Error('Slack OI requires SLACK_OI_TOKEN or a private SLACK_OI_TOKEN_FILE containing your OI credential.');
  if (!['bearer', 'sso-jwt'].includes(config.authMode)) throw new Error('Slack OI auth mode must be bearer or sso-jwt.');
  if (typeof config.oauthSessionId !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/.test(config.oauthSessionId)) throw new Error('Slack OI requires SLACK_OI_OAUTH_SESSION_ID for the OI session authorized to use Slack.');
  return { ...config };
}

export function slackOiConfiguration(env: Readonly<Record<string, string | undefined>>): SlackOiConfiguration {
  let token = env.SLACK_OI_TOKEN;
  if (token && env.SLACK_OI_TOKEN_FILE) throw new Error('Slack OI requires only one of SLACK_OI_TOKEN or SLACK_OI_TOKEN_FILE.');
  if (!token && env.SLACK_OI_TOKEN_FILE) {
    const path = env.SLACK_OI_TOKEN_FILE;
    if (!isAbsolute(path)) throw new Error('Slack OI token file must have an absolute path.');
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 16_386 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('invalid file');
      token = readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
    } catch { throw new Error('Slack OI token file must be a private, readable regular file owned by the current user (mode 0600).'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return validateConfiguration({ url: env.SLACK_OI_URL ?? DEFAULT_SLACK_OI_URL, token: token ?? '', authMode: (env.SLACK_OI_AUTH_MODE ?? 'bearer') as SlackOiConfiguration['authMode'], oauthSessionId: env.SLACK_OI_OAUTH_SESSION_ID ?? '' });
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Slack OI returned an empty response.');
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      bytes += value?.byteLength ?? 0;
      if (bytes > MAX_RESPONSE) throw new Error('Slack OI response exceeds the size limit.');
      text += decoder.decode(value, { stream: !done });
      if (done) break;
    }
    try { return JSON.parse(text); } catch { throw new Error('Slack OI returned invalid JSON.'); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function argumentsMatch(value: unknown, args: Record<string, unknown>): boolean {
  if (typeof value !== 'string') return false;
  try { return isDeepStrictEqual(JSON.parse(value), args); } catch { return false; }
}

async function pollDelay(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('Slack OI request cancelled or timed out.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 400);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class SlackOiClient {
  private readonly config: SlackOiConfiguration;
  private readonly fetcher: typeof fetch;
  private readonly signal: AbortSignal;
  private userId: string | null = null;
  private initialized = false;

  constructor(config: SlackOiConfiguration, fetcher: typeof fetch, signal: AbortSignal) {
    this.config = validateConfiguration(config);
    this.fetcher = fetcher;
    this.signal = signal;
  }

  private async request(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    signal.throwIfAborted();
    try {
      const response = await this.fetcher(`${this.config.url}${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
        headers: { Authorization: `${this.config.authMode === 'bearer' ? 'Bearer' : 'sso-jwt'} ${this.config.token}`, Cookie: `oauth_session_id=${this.config.oauthSessionId}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Slack OI returned HTTP ${response.status}. Check OI authentication and access.`); }
      return await readJson(response);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Slack OI ')) throw error;
      throw new Error('Slack OI request failed or timed out.');
    }
  }

  private async readiness(signal: AbortSignal): Promise<void> {
    const auth = record(await this.request('/api/v1/auths/', signal));
    if (typeof auth?.id !== 'string' || !auth.id || (this.userId !== null && auth.id !== this.userId)) throw new Error('Slack OI authentication is unavailable or changed. Reconnect the OI account.');
    const configuration = record(await this.request('/api/config', signal));
    if (record(configuration?.features)?.enable_tool_permissions !== true) throw new Error('Slack OI requires native tool approvals, which this OI environment has not enabled. No Slack tools were requested.');
    const modelsResponse = await this.request('/api/v1/models', signal);
    const models = Array.isArray(modelsResponse) ? modelsResponse : record(modelsResponse)?.data;
    const model = Array.isArray(models) ? models.map(record).find(item => item?.id === SLACK_OI_MODEL) : null;
    const info = record(model?.info);
    const meta = record(info?.meta);
    if (!model || model.pipeline || model.pipe || info?.pipeline || info?.pipe || typeof info?.base_model_id !== 'string' || !info.base_model_id || !Array.isArray(meta?.toolIds) || !meta.toolIds.includes(SLACK_OI_TOOL_ID) || (Array.isArray(meta.external_mcps) && meta.external_mcps.length > 0)) throw new Error('Slack OI Companion does not expose the verified native Slack tool configuration.');
    if (record(meta.capabilities)?.secure_access !== true) throw new Error('Slack OI Companion must support Secure Data Mode for Slack tools.');
    this.userId = auth.id;
  }

  async initialize(): Promise<void> {
    await this.readiness(AbortSignal.any([this.signal, AbortSignal.timeout(20_000)]));
    this.initialized = true;
  }

  async call(name: string, args: Record<string, unknown>, beforeExecute?: () => Promise<void>): Promise<Record<string, unknown>> {
    if (!this.initialized) throw new Error('Slack OI must be initialized before calling tools.');
    if (!ALLOWED_TOOLS.has(name) || !record(args) || typeof args.team_id !== 'string' || !args.team_id || (name === 'send_message' && !beforeExecute)) throw new Error('Slack OI tool request is unsupported or missing its execution authorization.');
    let expectedArgs: Record<string, unknown>;
    try {
      expectedArgs = JSON.parse(JSON.stringify(args));
      if (!isDeepStrictEqual(expectedArgs, args)) throw new Error('invalid arguments');
    } catch { throw new Error('Slack OI tool arguments must be JSON values.'); }
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(90_000)]);
    let chatId: string | null = null;
    let approvedCallId: string | null = null;
    try {
      await this.readiness(signal);
      const parentId = randomUUID();
      const messageId = randomUUID();
      const sessionId = randomUUID();
      const functionName = `slack_${name}`;
      const prompt = `Invoke exactly one tool, ${functionName}, with exactly these JSON arguments: ${JSON.stringify(expectedArgs)}. Do not invoke any other tool or change arguments. Do not perform follow-up actions. The caller will verify and approve the tool call.`;
      const params = { function_calling: 'native', tool_approval_mode: 'ask', stream_response: true };
      const parent = { id: parentId, parentId: null, childrenIds: [messageId], role: 'user', content: prompt, timestamp: Math.floor(Date.now() / 1000) };
      const assistant = { id: messageId, parentId, childrenIds: [], role: 'assistant', content: '', model: SLACK_OI_MODEL, done: false };
      const created = record(await this.request('/api/v1/chats/new', signal, { chat: { title: 'Helmsman Slack operation', models: [SLACK_OI_MODEL], params, messages: [parent, assistant], history: { SDM_Mode: true, currentId: messageId, messages: { [parentId]: parent, [messageId]: assistant } } } }));
      if (typeof created?.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(created.id)) throw new Error('Slack OI did not create a valid operation chat.');
      chatId = created.id;
      const started = record(await this.request('/api/chat/completions', signal, { model: SLACK_OI_MODEL, stream: true, sdm_mode: true, session_id: sessionId, chat_id: chatId, id: messageId, parent_id: parentId, parent_message: parent, messages: [{ role: 'user', content: prompt }], params, tool_ids: [SLACK_OI_TOOL_ID], features: {}, background_tasks: { title_generation: false, tags_generation: false, follow_up_generation: false } }));
      if (started?.status !== true || typeof started.task_id !== 'string') throw new Error('Slack OI did not start an approval-gated task.');
      while (true) {
        const response = record(await this.request(`/api/v1/chats/${chatId}`, signal));
        const chat = record(response?.chat);
        const history = record(chat?.history);
        const message = record(record(history?.messages)?.[messageId]);
        if (!message) throw new Error('Slack OI operation message is unavailable.');
        if (message.error) throw new Error('Slack OI operation failed. Check Companion authorization in OI.');
        const output = message.output;
        if (output !== undefined && !Array.isArray(output)) throw new Error('Slack OI returned invalid tool evidence.');
        const items = (Array.isArray(output) ? output : []).map(record);
        if (items.some(item => item === null)) throw new Error('Slack OI returned invalid tool evidence.');
        const calls = items.filter(item => item?.type === 'function_call');
        const results = items.filter(item => item?.type === 'function_call_output');
        if (calls.length > 1 || results.length > 1) throw new Error('Slack OI proposed additional tool calls; the operation was stopped.');
        const call = calls[0];
        const settledCall = call && (call.status === 'pending' || approvedCallId !== null || results.length > 0);
        if (settledCall && (call.name !== functionName || !argumentsMatch(call.arguments, expectedArgs) || (approvedCallId !== null && call.call_id !== approvedCallId))) throw new Error('Slack OI proposed a different tool or arguments; the operation was stopped.');
        if (results.length) {
          const result = results[0];
          if (!approvedCallId || call?.call_id !== approvedCallId || result?.call_id !== approvedCallId || result.status !== 'completed' || result.error || call.status !== 'completed') throw new Error('Slack OI returned an unverified or failed tool execution.');
          const parts = result.output;
          const part = Array.isArray(parts) && parts.length === 1 ? record(parts[0]) : null;
          if (part?.type !== 'input_text' || typeof part.text !== 'string') throw new Error('Slack OI returned invalid tool output.');
          let value: Record<string, unknown> | null;
          try { value = record(JSON.parse(part.text)); } catch { throw new Error('Slack OI returned invalid tool JSON.'); }
          if (!value || value.error || value.ok === false) throw new Error('Slack OI tool failed. Check Companion authorization and workspace configuration.');
          return value;
        }
        if (call?.status === 'pending' && !approvedCallId) {
          if (typeof call.call_id !== 'string' || !call.call_id || call.approved === true || record(record(message.meta)?.params)?.tool_approval_mode !== 'ask' || record(chat?.params)?.tool_approval_mode !== 'ask') throw new Error('Slack OI did not preserve the required tool approval policy.');
          await this.readiness(signal);
          await beforeExecute?.();
          signal.throwIfAborted();
          approvedCallId = call.call_id;
          const resolution = record(await this.request(`/api/v1/chats/${chatId}/messages/${messageId}/resolve`, signal, { call_id: approvedCallId, action: 'approve' }));
          if (resolution?.status !== true) throw new Error('Slack OI tool approval outcome is uncertain; it will not be retried.');
        } else if (call && !approvedCallId && !['in_progress', 'queued', 'completed'].includes(String(call.status))) {
          throw new Error('Slack OI returned an unexpected tool execution state.');
        }
        if (message.done === true) throw new Error('Slack OI completed without verified tool output.');
        await pollDelay(signal);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Slack OI ')) throw error;
      throw new Error('Slack OI operation failed, was cancelled, or timed out.');
    } finally {
      if (chatId) await this.request(`/api/tasks/chat/${chatId}/stop`, AbortSignal.timeout(3_000), {}).catch(() => undefined);
    }
  }
}
