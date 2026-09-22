export const DEFAULT_SLACK_MCP_URL = 'https://mcp-slack.goarena.gdcorp.tools/mcp';
const PROTOCOL = '2025-03-26';
const MAX_RESPONSE = 2 * 1024 * 1024;

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function slackConfiguration(env: Readonly<Record<string, string | undefined>>): { url: string; token: string } {
  const url = env.SLACK_MCP_URL ?? DEFAULT_SLACK_MCP_URL;
  if (![DEFAULT_SLACK_MCP_URL, 'https://mcp-slack-test.goarena.gdcorp.tools/mcp'].includes(url)) throw new Error('SLACK_MCP_URL must be the production or test GoDaddy Slack MCP endpoint.');
  const token = env.SLACK_MCP_TOKEN;
  if (!token || token.length > 16_384 || /[^\x21-\x7e]/.test(token)) throw new Error('Configure SLACK_MCP_TOKEN with a Slack user OAuth token; a GoCaaS API key cannot authenticate Slack MCP.');
  return { url, token };
}

async function responseMessage(response: Response, id: number): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Slack MCP returned an empty response.');
  const sse = response.headers.get('content-type')?.split(';')[0]?.trim() === 'text/event-stream';
  const decoder = new TextDecoder();
  let received = 0;
  let pending = '';
  const envelope = (text: string) => {
    let value: Record<string, unknown> | null;
    try { value = record(JSON.parse(text)); } catch { throw new Error('Slack MCP returned invalid JSON.'); }
    if (value?.jsonrpc !== '2.0') throw new Error('Slack MCP returned an invalid protocol envelope.');
    if (value.id !== id) return null;
    if (value.error) throw new Error('Slack MCP rejected the request.');
    const result = record(value.result);
    if (!result) throw new Error('Slack MCP returned an invalid result.');
    return result;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      received += value?.byteLength ?? 0;
      if (received > MAX_RESPONSE) throw new Error('Slack MCP response exceeds the size limit.');
      pending += decoder.decode(value, { stream: !done });
      if (sse) {
        pending = pending.replace(/\r\n/g, '\n');
        let end: number;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, end); pending = pending.slice(end + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (data) { const result = envelope(data); if (result) return result; }
        }
      }
      if (done) break;
    }
    if (!sse) { const result = envelope(pending); if (result) return result; }
    throw new Error('Slack MCP did not return the requested response.');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export class SlackMcpClient {
  private id = 0;
  private initialized = false;
  private readonly config: { url: string; token: string };
  private readonly fetcher: typeof fetch;
  private readonly signal: AbortSignal;
  constructor(config: { url: string; token: string }, fetcher: typeof fetch, signal: AbortSignal) { this.config = config; this.fetcher = fetcher; this.signal = signal; }

  private async request(method: string, params: unknown, notification = false): Promise<Record<string, unknown> | null> {
    this.signal.throwIfAborted();
    const id = ++this.id;
    try {
      const response = await this.fetcher(this.config.url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]),
        headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL },
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Slack MCP returned HTTP ${response.status}.`); }
      if (notification) { await response.body?.cancel(); return null; }
      return await responseMessage(response, id);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Slack MCP ')) throw error;
      throw new Error('Slack MCP request failed or timed out.');
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const result = await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'helmsman-slack-companion', version: '0.1.0' } });
    if (result?.protocolVersion !== PROTOCOL || !record(result.capabilities)?.tools) throw new Error('Slack MCP did not negotiate the supported tools protocol.');
    await this.request('notifications/initialized', {}, true);
    this.initialized = true;
  }

  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.initialized) throw new Error('Slack MCP must be initialized before calling tools.');
    const result = await this.request('tools/call', { name, arguments: args });
    if (result?.isError) throw new Error('Slack MCP tool failed. Check token permissions and workspace configuration.');
    const content = result?.content;
    if (!Array.isArray(content) || content.length !== 1 || record(content[0])?.type !== 'text' || typeof record(content[0])?.text !== 'string') throw new Error('Slack MCP returned an invalid tool response.');
    let value: Record<string, unknown> | null;
    try { value = record(JSON.parse(content[0].text)); } catch { throw new Error('Slack MCP returned invalid tool JSON.'); }
    if (!value) throw new Error('Slack MCP returned an invalid tool result.');
    if (value.error) throw new Error('Slack MCP tool failed. Check token permissions and workspace configuration.');
    return value;
  }
}
