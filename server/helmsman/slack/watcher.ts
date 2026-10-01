import { createHash, randomUUID } from 'node:crypto';
import type { CommunicationReviewTriggerProviderV1 } from '../../../src/plugins/trigger';
import type { ExecutionStore } from '../execution-store';
import type { AutomaticReviewObservation } from '../automatic-review-ownership';
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
  launch: (input: { repo: string; prNumber: number; mode: 'review'; runId: string; headSha?: string; workflowRef?: string; trigger?: TriggerProvenanceV1 }) => string | Promise<string>;
  now?: () => string;
  intervalMs?: number;
  captureTrigger: (signal: AbortSignal) => SelectedTriggerCapture<CommunicationReviewTriggerProviderV1> | null;
  captureSource?: (signal: AbortSignal) => CommunicationReviewSourceCapture;
  defaultWorkflowRef?: () => string;
  observeOwnership?: (proposal: ReviewNotificationProposal, trigger: TriggerProvenanceV1, signal: AbortSignal) => Promise<AutomaticReviewObservation>;
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
    const rows = [...communicationRows('queued'), ...communicationRows('launched')];
    for (const sourceKey of new Set(rows.flatMap(row => row.sourceKey ? [row.sourceKey] : []))) {
      for (const claim of store.dispatchClaims(sourceKey)) {
        const row = store.getNotification(claim.notificationId);
        if (!row?.runId) continue;
        const run = options.getRun(row.runId);
        if (run || options.isRunActive(row.runId)) {
          const failed = run && typeof run === 'object' && 'status' in run && run.status === 'failed';
          store.updateNotification(row.id, failed ? 'failed' : 'launched', now(), failed ? 'PR run failed; open the run for details' : null);
        }
        store.releaseDispatch(row.id, claim.token);
      }
    }
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
    for (const notification of communicationRows('queued')) {
      const runId = notification.runId;
      if (!runId) {
        store.updateNotification(notification.id, 'failed', now(), 'Missing persisted run ID');
        continue;
      }
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
      let observation: AutomaticReviewObservation | undefined;
      let blockedReason: string | null = null;
      const allowed = persistenceHash(options.allowedRepos().map(repo => repo.toLowerCase()).sort());
      let repo = options.allowedRepos().find(repo => repo.toLowerCase() === notification.repo.toLowerCase());
      if (!repo) blockedReason = `Galleon ${notification.repo} is not configured`;
      try {
        capture.assertCurrent();
        if (notification.trigger && notification.proposal) {
          trigger = parseTriggerProvenanceV1(notification.trigger);
          if (trigger.instanceId !== capture.instanceId || trigger.selectionRevision !== capture.selectionRevision
            || persistenceHash(trigger.provider) !== persistenceHash(capture.record) || persistenceHash(notification.proposal) !== trigger.proposalHash
            || notification.proposal.repo !== notification.repo || notification.proposal.number !== notification.prNumber) {
            blockedReason = 'Captured review trigger is no longer current';
          }
          if (!blockedReason && options.observeOwnership) {
            observation = await options.observeOwnership(notification.proposal, trigger, AbortSignal.timeout(30_000));
            capture.assertCurrent(); observation.assertCurrent();
            if (allowed !== persistenceHash(options.allowedRepos().map(repo => repo.toLowerCase()).sort())) continue;
            blockedReason = observation.blockedReason;
          }
        }
      } catch { continue; }
      const token = randomUUID();
      if (!store.claimDispatch(notification.id, token, now())) continue;
      let attemptedLaunch = false;
      try {
        const assertCurrent = () => {
          capture.assertCurrent(); observation?.assertCurrent();
          if (allowed !== persistenceHash(options.allowedRepos().map(repo => repo.toLowerCase()).sort())) throw new Error('Review galleon scope changed');
          if (options.getRun(runId) || options.isRunActive(runId)) throw new Error('Review already has a recorded execution');
        };
        const transition = (status: 'queued' | 'blocked' | 'launched' | 'failed', error: string | null, check = assertCurrent) => store.transitionDispatch({
          notification, token, status, now: now(), error, ...(observation ? { policy: observation.policy } : {}), assertCurrent: check,
          ...(status === 'blocked' && notification.trigger ? { releasePins: () => options.releaseTriggerPins?.({ store: 'review', rowId: notification.id }) } : {}),
        });
        if (blockedReason) {
          transition('blocked', blockedReason);
          continue;
        }
        if (!observation || observation.policy.decision !== 'other' || !notification.proposal || !trigger) {
          transition('queued', observation?.policy.reason ?? 'Authenticated PR ownership requires retained trigger evidence and an available provider');
          continue;
        }
        repo = options.allowedRepos().find(repo => repo.toLowerCase() === notification.repo.toLowerCase());
        if (!repo || !options.canLaunch(repo)) continue;
        if (!transition('queued', null)) continue;
        assertCurrent();
        attemptedLaunch = true;
        const launchedId = await options.launch({ repo, prNumber: notification.prNumber, mode: 'review', runId,
          headSha: notification.proposal.headSha, workflowRef: notification.proposal.workflowRef, trigger });
        if (launchedId !== runId) throw new Error('Launcher returned an unexpected run ID');
        transition('launched', null, () => {});
      } catch (error) {
        if (attemptedLaunch) {
          store.transitionDispatch({ notification, token, status: 'failed', now: now(), error: errorMessage(error), assertCurrent() {} });
          if (notification.trigger) {
            try { options.releaseTriggerPins?.({ store: 'review', rowId: notification.id }); } catch { }
          }
        }
      } finally { store.releaseDispatch(notification.id, token); }
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
