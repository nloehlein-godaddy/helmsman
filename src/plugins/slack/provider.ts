import type { CommunicationProviderContextV1, CommunicationProviderResultV1, CommunicationProviderV1, CommunicationReviewRequestV1 } from '@helmsman/plugin-sdk';
import { createSlackBrowserReader, type SlackBrowserTransport } from './browser.js';
import { createSlackBrowserReviewSender } from './browser-review.js';
import { SlackReviewError } from './review-request.js';

const text = (value: unknown, maximum = 2048): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const unknown = (reason: string): CommunicationProviderResultV1 => ({ status: 'unknown', reason, evidence: { code: 'slack-browser-unconfirmed' } });

function configured(context: CommunicationProviderContextV1) {
  const destination = context.destination;
  if (!destination || !/^[A-Z0-9]{3,32}$/.test(destination.workspace) || !/^(?:[CG][A-Z\d]{2,31}|[a-z\d_-]{1,80})$/.test(destination.channel)
    || !/^[a-z\d_-]{1,80}$/.test(destination.mention) || !text(destination.connectionId, 4096)) throw new Error('Slack destination or browser surface is invalid.');
  return { clientId: destination.workspace, ...(text(context.surface, 512) ? { surface: context.surface } : {}) };
}

function scanConfig(context: CommunicationProviderContextV1) {
  const watched = context.watchedChannel;
  if (!/^[A-Z0-9]{3,32}$/.test(context.destination.workspace) || !watched || !/^[CG][A-Z\d]{2,31}$/.test(watched.id) || !/^[a-z\d_-]{1,80}$/.test(watched.name)) throw new Error('Slack watched channel is invalid.');
  return { clientId: context.destination.workspace, channelId: watched.id, channelName: watched.name, ...(text(context.surface, 512) ? { surface: context.surface } : {}) };
}

function transport(context: CommunicationProviderContextV1): SlackBrowserTransport {
  return async args => {
    context.signal.throwIfAborted();
    if (args[0] === '--id-format' && args[2] === 'tree') return JSON.stringify(await context.browser.tree());
    if (args[0] === 'rpc' && args[1] === 'surface.focus' && typeof args[2] === 'string') {
      const parsed = JSON.parse(args[2]) as { surface_id?: unknown };
      if (!text(parsed?.surface_id, 512)) throw new Error('Invalid Slack focus request.');
      await context.browser.focus({ surface: parsed.surface_id }); return '';
    }
    if (args[0] !== 'browser' || !text(args[1], 512) || !text(args[2], 32)) throw new Error('Unsupported Slack browser request.');
    if (args[2] === 'eval' && typeof args[3] === 'string') return JSON.stringify(await context.browser.evaluate({ surface: args[1], script: args[3] }));
    if (args[2] === 'click' && typeof args[3] === 'string') { await context.browser.click({ surface: args[1], selector: args[3] }); return ''; }
    if (args[2] === 'fill' && typeof args[3] === 'string' && typeof args[4] === 'string') { await context.browser.fill({ surface: args[1], selector: args[3], value: args[4] }); return ''; }
    if (args[2] === 'wait' && args[3] === '--selector' && typeof args[4] === 'string' && args[5] === '--timeout-ms' && /^\d+$/.test(String(args[6]))) { await context.browser.wait({ surface: args[1], selector: args[4], timeoutMs: Number(args[6]) }); return ''; }
    throw new Error('Unsupported Slack browser request.');
  };
}

function requestId(input: CommunicationReviewRequestV1): string {
  const id = input.requestId;
  if (!/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(id)) throw new Error('Slack request ID must be a UUID.');
  return id;
}

export const slackCommunicationProvider: CommunicationProviderV1 = {
  async prepareReviewRequest(input, context) {
    if (!input || !text(input.repo, 256) || !positive(input.number)) throw new Error('Invalid Slack review request.');
    configured(context);
    return { workspace: context.destination.workspace, channel: context.destination.channel, mention: context.destination.mention, connectionId: context.destination.connectionId };
  },
  async invokeReviewRequest(input, context) {
    try {
      if (!input || !text(input.repo, 256) || !positive(input.number)) throw new Error('Invalid Slack review request.');
      const config = configured(context);
      const sent = await createSlackBrowserReviewSender(config, transport(context), { beforeSend: () => context.beforeSend() }).send({ repo: input.repo, prNumber: input.number, requestId: requestId(input), channel: input.destination.channel, mention: input.destination.mention });
      return { status: 'acknowledged', receipt: { workspace: input.destination.workspace, channel: input.destination.channel, mention: input.destination.mention, connectionId: input.destination.connectionId, permalink: sent.permalink } };
    } catch (error) {
      if (error instanceof SlackReviewError && !error.uncertain) return { status: 'definitely-not-applied', retryable: false, reason: error.message, evidence: { code: 'slack-pre-send-failure' } };
      return unknown(error instanceof Error ? error.message : 'Slack delivery could not be confirmed.');
    }
  },
  async reconcileReviewRequest(input, context) {
    if (!input || !text(input.id, 256) || !text(input.contentHash, 256) || !text(input.requestId, 256)) return unknown('Slack reconciliation request is invalid.');
    try { configured(context); return unknown('Slack has no durable exact receipt for this request; automatic resend is prohibited.'); }
    catch (error) { return unknown(error instanceof Error ? error.message : 'Slack reconciliation is unavailable.'); }
  },
  async scanReviewRequests(input, context) {
    const scan = await createSlackBrowserReader(scanConfig(context), transport(context)).scan({ since: input?.since ?? null });
    return { messages: scan.messages, complete: scan.complete };
  },
};
