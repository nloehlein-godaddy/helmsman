import { createHash } from 'node:crypto';
import type { CommunicationProviderContextV1, CommunicationProviderResultV1, CommunicationProviderV1, CommunicationReviewRequestV1 } from '@helmsman/plugin-sdk';
import { record, slackConfiguration, SlackMcpClient } from './transport.js';
import { createSlackOAuth, usesSlackOAuth } from './oauth.js';

const channelId = (value: unknown): value is string => typeof value === 'string' && /^[CG][A-Z\d]{2,31}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{10,}\.\d{1,6}$/.test(value) && Number.isFinite(Number(value));
const unknownResult = (): CommunicationProviderResultV1 => ({ status: 'unknown', reason: 'Slack delivery has no confirmed exact receipt. Inspect Slack before manually retrying; automatic resend is prohibited.', evidence: { code: 'slack-mcp-unconfirmed' } });

function validateRequest(input: { readonly repo: string; readonly number: number }): void {
  if (!input || typeof input.repo !== 'string' || input.repo.length > 256 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[a-z\d_.-]+$/i.test(input.repo) || !Number.isSafeInteger(input.number) || input.number < 1) throw new Error('Invalid Slack review request.');
}

function validateDestination(context: CommunicationProviderContextV1): void {
  const destination = context?.destination;
  if (!destination || !/^[A-Z\d]{3,32}$/.test(destination.workspace) || typeof destination.connectionId !== 'string' || !destination.connectionId || destination.connectionId.length > 4096) throw new Error('Slack MCP connection or workspace changed.');
}

function validateSend(context: CommunicationProviderContextV1): void {
  validateDestination(context);
  if (!channelId(context.destination.channel)) throw new Error('Configure the Slack destination using its channel ID (C… or G…).');
  if (!/^S[A-Z\d]{2,31}$/.test(context.destination.mention)) throw new Error('Configure the Slack user group ID (S…), not its handle; Slack MCP cannot resolve user group handles.');
}

function pullRequests(text: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(/https:\/\/github\.com\/([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+)\/pull\/([1-9]\d*)(?=$|[\s<>|/?#.,)\]])/gi)) {
    if (Number.isSafeInteger(Number(match[3]))) urls.add(`https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`);
  }
  return [...urls];
}

function permalink(value: unknown, channel: string, ts: string): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.slack.com') && !url.username && !url.password && !url.port && url.pathname === `/archives/${channel}/p${ts.replace('.', '')}` ? url.href : null;
  } catch { return null; }
}

export function createSlackCompanionProvider(options: {
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  now?: () => number;
} = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const oauth = usesSlackOAuth(env) ? createSlackOAuth({ env, fetch: options.fetch, now }) : null;
  function connectionIdentity(): string | null {
    try {
      const config = slackConfiguration(oauth ? { ...env, SLACK_MCP_TOKEN: 'oauth-managed' } : env);
      const identity = oauth ? oauth.identity() : config.token;
      return identity ? `slack-mcp:${createHash('sha256').update(JSON.stringify([config.url, identity])).digest('hex')}` : null;
    } catch { return null; }
  }
  async function client(context: CommunicationProviderContextV1): Promise<SlackMcpClient> {
    validateDestination(context);
    if (oauth && context.destination.workspace !== env.SLACK_CLIENT_ID) throw new Error('Slack OAuth workspace changed.');
    const config = slackConfiguration(oauth ? { ...env, SLACK_MCP_TOKEN: await oauth.accessToken(context.signal) } : env);
    const identity = connectionIdentity();
    if (!identity) throw new Error('Slack MCP credentials are unavailable.');
    return new SlackMcpClient(config, options.fetch ?? fetch, AbortSignal.any([context.signal, AbortSignal.timeout(60_000)]));
  }
  async function checkChannel(mcp: SlackMcpClient, workspace: string, id: string): Promise<void> {
    const channel = await mcp.call('get_channel_info', { team_id: workspace, channel_id: id });
    if (channel.id !== id || channel.is_archived !== false || channel.is_im === true || channel.is_mpim === true || typeof channel.name !== 'string'
      || (typeof channel.context_team_id === 'string' && channel.context_team_id !== workspace)) throw new Error('Slack channel is unavailable, archived, or belongs to another workspace.');
  }
  const provider: CommunicationProviderV1 = {
    connectionIdentity,
    async prepareReviewRequest(input, context) {
      validateRequest(input); validateSend(context);
      const mcp = await client(context); await mcp.initialize();
      await checkChannel(mcp, context.destination.workspace, context.destination.channel);
      const { workspace, channel, mention, connectionId } = context.destination;
      return { workspace, channel, mention, connectionId };
    },
    async invokeReviewRequest(input: CommunicationReviewRequestV1, context) {
      let dispatched = false;
      try {
        validateRequest(input); validateSend(context);
        if (!/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(input.requestId)
          || !input.destination || ['workspace', 'channel', 'mention', 'connectionId'].some(key => input.destination[key as keyof typeof input.destination] !== context.destination[key as keyof typeof context.destination])) throw new Error('Slack review destination changed.');
        const identity = connectionIdentity();
        const mcp = await client(context); await mcp.initialize();
        await checkChannel(mcp, context.destination.workspace, context.destination.channel);
        const { workspace, channel, mention, connectionId } = context.destination;
        await context.beforeSend();
        context.signal.throwIfAborted();
        if (connectionIdentity() !== identity) throw new Error('Slack MCP credentials changed before delivery.');
        dispatched = true;
        const receipt = await mcp.call('send_message', { team_id: workspace, channel_id: channel, text: `<!subteam^${mention}> Could you review this PR? https://github.com/${input.repo}/pull/${input.number}` });
        if (receipt.channel !== channel || !timestamp(receipt.ts)) return unknownResult();
        return { status: 'acknowledged', receipt: { workspace, channel, mention, connectionId, permalink: `https://app.slack.com/archives/${channel}/p${receipt.ts.replace('.', '')}` } };
      } catch (error) {
        return dispatched ? unknownResult() : { status: 'definitely-not-applied', retryable: false, reason: error instanceof Error ? error.message : 'Slack request validation failed.', evidence: { code: 'slack-mcp-pre-send-failure' } };
      }
    },
    async reconcileReviewRequest() { return unknownResult(); },
    async scanReviewRequests(input, context) {
      const watched = context.watchedChannel;
      if (!watched || !channelId(watched.id)) throw new Error('Configure a valid watched Slack channel ID.');
      const untilMs = now();
      const sinceMs = input?.since === null ? untilMs : timestamp(input?.since) ? Number(input.since) * 1000 : typeof input?.since === 'string' ? Date.parse(input.since) : NaN;
      if (!Number.isFinite(sinceMs) || sinceMs < 0 || sinceMs > untilMs || !Number.isFinite(untilMs)) throw new Error('Invalid Slack scan cursor.');
      const after = new Date(sinceMs - 2 * 86_400_000).toISOString().slice(0, 10);
      const before = new Date(untilMs + 2 * 86_400_000).toISOString().slice(0, 10);
      const query = `in:${watched.id} after:${after} before:${before} github.com`;
      const mcp = await client(context); await mcp.initialize();
      await checkChannel(mcp, context.destination.workspace, watched.id);
      const messages: { channelId: string; ts: string; permalink: string; author: string; prUrls: string[] }[] = [];
      const seen = new Set<string>();
      let expectedTotal: number | undefined;
      let expectedPages: number | undefined;
      let count = 0;
      let complete = true;
      for (let page = 1; page <= 10; page++) {
        const result = await mcp.call('search_messages', { team_id: context.destination.workspace, query, count: 100, page });
        const paging = record(result.paging);
        const pages = paging?.pages;
        const total = paging?.total;
        if (!Array.isArray(result.matches) || typeof pages !== 'number' || !Number.isSafeInteger(pages) || pages < 0 || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0
          || paging?.page !== page || result.matches.length > 100) throw new Error('Slack MCP returned invalid search pagination.');
        if (expectedTotal !== undefined && (total !== expectedTotal || pages !== expectedPages)) complete = false;
        expectedTotal = total; expectedPages = pages;
        count += result.matches.length;
        for (const raw of result.matches) {
          const message = record(raw);
          const ts = message?.ts;
          if (record(message?.channel)?.id !== watched.id || !timestamp(ts) || typeof message?.text !== 'string' || typeof message?.user !== 'string' || !/^[UW][A-Z\d]{2,31}$/.test(message.user)) { complete = false; continue; }
          const link = permalink(message.permalink, watched.id, ts);
          if (!link) { complete = false; continue; }
          if (seen.has(ts)) { complete = false; continue; }
          seen.add(ts);
          if (Number(ts) * 1000 < sinceMs || Number(ts) * 1000 > untilMs) continue;
          const prUrls = pullRequests(message.text);
          if (prUrls.length) messages.push({ channelId: watched.id, ts, permalink: link, author: message.user, prUrls });
        }
        if (page >= pages) return { messages, complete: complete && count === total };
        if (result.matches.length === 0) return { messages, complete: false };
      }
      return { messages, complete: false };
    },
  };
  return { ...provider, ...(oauth ? { connection: { status: oauth.status, begin: oauth.begin, complete: oauth.complete, disconnect: oauth.disconnect, check: oauth.check } } : {}) };
}
