import { createHash, randomUUID } from 'node:crypto';
import type { CommunicationReviewTriggerProviderV1 } from '../../../src/plugins/trigger';
import type { ExecutionStore } from '../execution-store';
import { persistenceHash } from '../persistence';
import { parseTriggerProvenanceV1, triggerDependencyPins, type TriggerProvenanceV1 } from '../trigger-provenance';
import { runReviewTrigger, type CommunicationReviewSourceCapture, type SelectedTriggerCapture } from '../trigger-runtime';
import type { ReviewNotificationProposal, SlackHealth, SlackSourceState, SlackStore } from './store';

export interface SlackWatcherOptions {
  store: SlackStore;
  clientId: string;
  channelId: string;
  channelName: string;
  allowedRepos: () => readonly string[];
  canLaunch: (repo: string) => boolean;
  getRun: (runId: string) => unknown;
  isRunActive: (runId: string) => boolean;
  launch: (input: { repo: string; prNumber: number; mode: 'review'; runId: string; headSha?: string; workflowRef?: string; trigger?: TriggerProvenanceV1 }) => string;
  now?: () => string;
  intervalMs?: number;
  captureTrigger: (signal: AbortSignal) => SelectedTriggerCapture<CommunicationReviewTriggerProviderV1> | null;
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
        if (!capture) continue;
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

  async function scanTriggered(): Promise<void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    let capture: SelectedTriggerCapture<CommunicationReviewTriggerProviderV1> | null;
    try { capture = options.captureTrigger(signal); }
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
      pending ??= scanTriggered().finally(() => { pending = null; });
      return pending;
    },
    health() { return { ...state.health }; },
  };
}
