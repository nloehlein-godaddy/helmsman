import { createHash, randomUUID } from 'node:crypto';
import { isGithubRepo } from '../../pr-lists';
import type { CommunicationReviewTriggerProviderV1 } from '../../../src/plugins/trigger';
import type { ExecutionStore } from '../execution-store';
import { persistenceHash } from '../persistence';
import { parseTriggerProvenanceV1, triggerDependencyPins, type TriggerProvenanceV1 } from '../trigger-provenance';
import { runReviewTrigger, type CommunicationReviewSourceCapture, type SelectedTriggerCapture } from '../trigger-runtime';
import type { ReviewNotificationProposal, SlackHealth, SlackSourceState, SlackStore } from './store';

export interface SlackMessage {
  channelId: string;
  ts: string;
  permalink: string;
  author: string;
  prUrls: string[];
}

export interface SlackSource {
  scan(options: { since: string | null }): Promise<{ messages: SlackMessage[]; complete: boolean }>;
}

export interface SlackWatcherOptions {
  store: SlackStore;
  clientId: string;
  channelId: string;
  channelName: string;
  source: SlackSource;
  allowedRepos: () => readonly string[];
  canLaunch: (repo: string) => boolean;
  getRun: (runId: string) => unknown;
  isRunActive: (runId: string) => boolean;
  launch: (input: { repo: string; prNumber: number; mode: 'review'; runId: string; headSha?: string; workflowRef?: string; trigger?: TriggerProvenanceV1 }) => string;
  now?: () => string;
  intervalMs?: number;
  captureTrigger?: (signal: AbortSignal) => SelectedTriggerCapture<CommunicationReviewTriggerProviderV1> | null;
  captureSource?: (signal: AbortSignal) => CommunicationReviewSourceCapture;
  defaultWorkflowRef?: () => string;
  verifyProposal?: (proposal: ReviewNotificationProposal, trigger: TriggerProvenanceV1) => void | Promise<void>;
  retainPins?: ExecutionStore['retainPins'];
  releaseTriggerPins?: ExecutionStore['releaseTriggerPins'];
}

export interface SlackWatcher {
  poll(): Promise<void>;
  health(): SlackHealth;
}

export function parsePullRequestUrl(value: unknown): { repo: string; prNumber: number; prUrl: string } | null {
  if (typeof value !== 'string' || !/^https:\/\/github\.com\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) return null;
    const match = /^\/([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(url.pathname);
    if (!match) return null;
    const prNumber = Number(match[3]);
    if (!Number.isSafeInteger(prNumber)) return null;
    const repo = `${match[1]}/${match[2]}`.toLowerCase();
    if (!isGithubRepo(repo)) return null;
    return { repo, prNumber, prUrl: `https://github.com/${repo}/pull/${prNumber}` };
  } catch { return null; }
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{10,}\.\d{1,6}$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSlackWatcher(options: SlackWatcherOptions): SlackWatcher {
  const { store } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const intervalMs = options.intervalMs ?? 300_000;
  const key = JSON.stringify([options.clientId, options.channelId]);
  const state: SlackSourceState = store.ensureSource(key, now(), {
    enabled: true, status: 'unavailable', channelName: options.channelName,
    intervalMs, lastSuccessAt: null, error: 'Waiting for first scan',
  });
  state.health = { ...state.health, enabled: true, channelName: options.channelName, intervalMs };
  const activatedTs = Date.parse(state.activatedAt) / 1000;
  let pending: Promise<void> | null = null;

  const communicationRows = (status: 'queued' | 'launched') => store.notificationsByStatus(status).filter(notification => {
    if (!notification.trigger) return notification.sourceKey === key;
    try {
      const metadata = parseTriggerProvenanceV1(notification.trigger).provider.metadata;
      return metadata.kind === 'review-watch' && metadata.source === 'communication';
    }
    catch { return false; }
  });

  async function drainQueue(capture: SelectedTriggerCapture<CommunicationReviewTriggerProviderV1> | null): Promise<void> {
    for (const notification of communicationRows('launched')) {
      const run = notification.runId ? options.getRun(notification.runId) : null;
      if (run && typeof run === 'object' && 'status' in run && run.status === 'failed') {
        store.updateNotification(notification.id, 'failed', now(), 'PR run failed; open the run for details');
      } else if (!run && notification.runId && !options.isRunActive(notification.runId)) {
        store.updateNotification(notification.id, 'queued', now());
      }
      if (run && notification.trigger) {
        try { options.releaseTriggerPins?.({ store: 'review', rowId: notification.id }); } catch { }
      }
    }
    const allowed = new Map(options.allowedRepos().map(repo => [repo.toLowerCase(), repo]));
    for (const notification of communicationRows('queued')) {
      const runId = notification.runId;
      if (!runId) {
        store.updateNotification(notification.id, 'failed', now(), 'Missing persisted run ID');
        continue;
      }
      try {
        const run = options.getRun(runId);
        if (run || options.isRunActive(runId)) {
          const failed = run && typeof run === 'object' && 'status' in run && run.status === 'failed';
          store.updateNotification(notification.id, failed ? 'failed' : 'launched', now(), failed ? 'PR run failed; open the run for details' : null);
          if (notification.trigger && run) {
            try { options.releaseTriggerPins?.({ store: 'review', rowId: notification.id }); } catch { }
          }
          continue;
        }
        let trigger: TriggerProvenanceV1 | undefined;
        if (notification.trigger) {
          if (!capture || !notification.proposal || !options.verifyProposal) continue;
          trigger = parseTriggerProvenanceV1(notification.trigger);
          if (trigger.instanceId !== capture.instanceId || persistenceHash(notification.proposal) !== trigger.proposalHash) {
            store.updateNotification(notification.id, 'blocked', now(), 'Captured review trigger is no longer current');
            try { options.releaseTriggerPins?.({ store: 'review', rowId: notification.id }); } catch { }
            continue;
          }
          try { capture.assertCurrent(); await options.verifyProposal(notification.proposal, trigger); capture.assertCurrent(); }
          catch (error) {
            store.updateNotification(notification.id, 'queued', now(), errorMessage(error));
            continue;
          }
        }
        const repo = allowed.get(notification.repo.toLowerCase());
        if (!repo) {
          store.updateNotification(notification.id, 'blocked', now(), `Galleon ${notification.repo} is not configured`);
          continue;
        }
        if (!options.canLaunch(repo)) continue;
        const token = randomUUID();
        if (!store.claimDispatch(notification.id, token, now())) continue;
        try {
          capture?.assertCurrent();
          const current = store.getNotification(notification.id);
          if (!current || current.status !== 'queued' || current.runId !== runId) continue;
          const launchedId = options.launch({ repo, prNumber: notification.prNumber, mode: 'review', runId,
            ...(notification.proposal ? { headSha: notification.proposal.headSha, workflowRef: notification.proposal.workflowRef } : {}),
            ...(trigger ? { trigger } : {}) });
          if (launchedId !== runId) throw new Error('Launcher returned an unexpected run ID');
          store.updateNotification(notification.id, 'launched', now());
        } finally { store.releaseDispatch(notification.id, token); }
      } catch (error) {
        store.updateNotification(notification.id, 'failed', now(), errorMessage(error));
        if (notification.trigger) {
          try { options.releaseTriggerPins?.({ store: 'review', rowId: notification.id }); } catch { }
        }
      }
    }
  }

  async function scan(): Promise<void> {
    state.health = { ...state.health, status: 'scanning', error: null };
    store.saveSource(state);
    try {
      const cursorTs = timestamp(state.cursor) ?? activatedTs;
      const since = Math.max(activatedTs, cursorTs - 300).toFixed(6);
      const result = await options.source.scan({ since });
      if (!result || !Array.isArray(result.messages) || typeof result.complete !== 'boolean') throw new Error('Invalid Slack scan response');
      let nextCursor = cursorTs;
      for (const message of result.messages) {
        const ts = timestamp(message?.ts);
        if (!message || message.channelId !== options.channelId || ts === null || ts < activatedTs) continue;
        nextCursor = Math.max(nextCursor, ts);
        for (const value of Array.isArray(message.prUrls) ? message.prUrls : []) {
          const pr = parsePullRequestUrl(value);
          if (!pr) continue;
          const id = createHash('sha256').update(JSON.stringify([key, message.channelId, message.ts, pr.prUrl])).digest('hex');
          const createdAt = now();
          store.insertNotification(key, {
            id, ...pr, sourceUrl: typeof message.permalink === 'string' ? message.permalink : '',
            author: typeof message.author === 'string' ? message.author : 'Unknown',
            channelName: options.channelName, status: 'queued', runId: `slack-${id}`,
            createdAt, updatedAt: createdAt, readAt: null, error: null,
          });
        }
      }
      if (result.complete) {
        state.cursor = nextCursor.toFixed(6);
        state.health = { ...state.health, status: 'healthy', lastSuccessAt: now(), error: null };
      } else {
        state.health = { ...state.health, status: 'partial', error: 'Slack scan was incomplete; cursor retained for retry' };
      }
    } catch (error) {
      state.health = { ...state.health, status: 'unavailable', error: errorMessage(error) };
    } finally {
      store.saveSource(state);
      await drainQueue(null);
    }
  }

  async function scanTriggered(): Promise<void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    let capture: SelectedTriggerCapture<CommunicationReviewTriggerProviderV1> | null;
    try { capture = options.captureTrigger?.(signal) ?? null; }
    catch (error) {
      await drainQueue(null);
      state.health = { ...state.health, status: 'unavailable', error: errorMessage(error) };
      store.saveSource(state);
      return;
    }
    await drainQueue(capture);
    state.health = { ...state.health, enabled: capture !== null, status: capture ? 'scanning' : 'disabled', error: null };
    store.saveSource(state);
    if (!capture) return;
    try {
      if (!options.captureSource || !options.defaultWorkflowRef || !options.retainPins) throw new Error('Slack trigger runtime is incomplete');
      const source = options.captureSource(signal);
      if (source.source.sourceKey !== key || source.channelId !== options.channelId) throw new Error('Slack trigger source changed');
      const expected = { activatedAt: state.activatedAt, cursor: state.cursor };
      const result = await runReviewTrigger({ capture, source, activatedAt: state.activatedAt, cursor: state.cursor,
        defaultWorkflowRef: options.defaultWorkflowRef(), capturedAt: now(), signal });
      const nextState: SlackSourceState = { ...state, cursor: result.complete ? result.nextCursor : expected.cursor, health: result.complete
        ? { ...state.health, status: 'healthy', lastSuccessAt: now(), error: null }
        : { ...state.health, status: 'partial', error: 'Slack scan was incomplete; cursor retained for retry' } };
      const notifications = result.captures.map(item => {
        if (!item.event) throw new Error('Slack trigger proposal is missing its message');
        const proposal = item.proposal;
        const id = createHash('sha256').update(JSON.stringify([key, item.event.channelId, item.event.ts, proposal.url])).digest('hex');
        const createdAt = now();
        return { notification: { id, repo: proposal.repo, prNumber: proposal.number, prUrl: proposal.url,
          sourceUrl: proposal.sourceUrl, author: proposal.author, channelName: proposal.channelName, status: 'queued' as const,
          runId: `slack-${id}`, createdAt, updatedAt: createdAt, readAt: null, error: null }, proposal, trigger: item.trigger,
          pins: triggerDependencyPins(item.trigger, 'review', id) };
      });
      store.commitTriggerScan({ sourceKey: key, expected, state: nextState, notifications, assertCurrent() {
        capture.assertCurrent(); source.assertCurrent();
      }, retainPins: options.retainPins });
      state.cursor = nextState.cursor;
      state.health = nextState.health;
      await drainQueue(capture);
    } catch (error) {
      state.health = { ...state.health, status: 'unavailable', error: errorMessage(error) };
      store.saveSource(state);
    }
  }

  return {
    poll() {
      pending ??= (options.captureTrigger ? scanTriggered() : scan()).finally(() => { pending = null; });
      return pending;
    },
    health() { return { ...state.health }; },
  };
}
