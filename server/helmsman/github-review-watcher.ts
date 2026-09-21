import { createHash, randomUUID } from 'node:crypto';
import { parseTriggerReviewTargetV1, type PullRequestReviewTriggerProviderV1 } from '../../src/plugins/trigger';
import type { ExecutionStore } from './execution-store';
import { persistenceHash } from './persistence';
import { parseTriggerProvenanceV1, triggerDependencyPins, type TriggerProvenanceV1 } from './trigger-provenance';
import { runReviewTrigger, type PullRequestReviewSourceCapture, type SelectedTriggerCapture } from './trigger-runtime';
import type { ReviewNotificationProposal, SlackHealth, SlackNotification, SlackSourceState, SlackStore } from './slack/store';

export interface RequestedReviewPr {
  headSha: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged?: boolean;
}

export interface GithubReviewWatcherOptions {
  store: SlackStore;
  fetchPr: (repo: string, number: number) => Promise<RequestedReviewPr | null>;
  allowedRepos: () => readonly string[];
  canLaunch: (repo: string) => boolean;
  getRun: (id: string) => unknown;
  isRunActive: (id: string) => boolean;
  launch: (input: { repo: string; prNumber: number; mode: 'review'; runId: string; headSha: string; workflowRef?: string; trigger?: TriggerProvenanceV1 }) => string;
  findExistingReview?: (repo: string, number: number, headSha: string) => string | null;
  now?: () => string;
  intervalMs?: number;
  captureTrigger: (signal: AbortSignal) => SelectedTriggerCapture<PullRequestReviewTriggerProviderV1> | null;
  captureSource?: (signal: AbortSignal) => PullRequestReviewSourceCapture;
  defaultWorkflowRef?: () => string;
  verifyProposal?: (proposal: ReviewNotificationProposal, trigger: TriggerProvenanceV1) => void | Promise<void>;
  retainPins?: ExecutionStore['retainPins'];
  releaseTriggerPins?: ExecutionStore['releaseTriggerPins'];
}

export interface GithubReviewWatcher {
  poll(): Promise<void>;
  health(): SlackHealth;
}

const SOURCE = 'github-review-requests';
const CHANNEL = 'GitHub requested reviews';

function identity(repo: string, number: number, head: string): string {
  return createHash('sha256').update(JSON.stringify([SOURCE, repo.toLowerCase(), number, head.toLowerCase()])).digest('hex');
}

function validPr(pr: RequestedReviewPr | null): pr is RequestedReviewPr {
  return !!pr && typeof pr.headSha === 'string' && /^[a-f\d]{40,64}$/i.test(pr.headSha)
    && ['open', 'closed'].includes(pr.state) && typeof pr.draft === 'boolean';
}

function failedRun(run: unknown): boolean {
  return !!run && typeof run === 'object' && 'status' in run && run.status === 'failed';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGithubReviewWatcher(options: GithubReviewWatcherOptions): GithubReviewWatcher {
  const { store } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const state = store.ensureSource(SOURCE, now(), {
    enabled: false, status: 'unavailable', channelName: CHANNEL,
    intervalMs: options.intervalMs ?? 300_000, lastSuccessAt: null, error: 'Waiting for first scan',
  });
  let pending: Promise<void> | null = null;

  const reviewRows = (status: 'queued' | 'launched') => store.notificationsByStatus(status).filter(notification => {
    if (!notification.trigger) return notification.sourceKey === SOURCE;
    try {
      const trigger = parseTriggerProvenanceV1(notification.trigger);
      return trigger.provider.metadata.kind === 'review-watch' && trigger.provider.metadata.source === 'pull-request';
    } catch { return false; }
  });

  function recover(): void {
    for (const notification of reviewRows('launched')) {
      const run = notification.runId ? options.getRun(notification.runId) : null;
      if (failedRun(run)) store.updateNotification(notification.id, 'failed', now(), 'PR run failed; open the run for details');
      else if (!run && notification.runId && !options.isRunActive(notification.runId)) store.updateNotification(notification.id, 'queued', now());
      if (run && notification.trigger) {
        try { options.releaseTriggerPins?.({ store: 'review', rowId: notification.id }); } catch { }
      }
    }
  }

  function reconcileCapturedReceipts(): void {
    recover();
    for (const notification of reviewRows('queued')) {
      if (recoverQueued(notification)) {
        if (notification.trigger && notification.runId && options.getRun(notification.runId)) {
          try { options.releaseTriggerPins?.({ store: 'review', rowId: notification.id }); } catch { }
        }
      }
    }
  }

  async function drainCaptured(capture: SelectedTriggerCapture<PullRequestReviewTriggerProviderV1>,
    source: PullRequestReviewSourceCapture, observed: ReadonlySet<string>): Promise<void> {
    for (const notification of reviewRows('queued')) {
      if (!observed.has(`${notification.repo.toLowerCase()}#${notification.prNumber}`)) continue;
      const repo = options.allowedRepos().find(value => value.toLowerCase() === notification.repo.toLowerCase());
      if (!repo) {
        store.updateNotification(notification.id, 'blocked', now(), `Galleon ${notification.repo} is not configured`);
        if (notification.trigger) try { options.releaseTriggerPins?.({ store: 'review', rowId: notification.id }); } catch { }
        continue;
      }
      try {
        let trigger: TriggerProvenanceV1 | undefined;
        let headSha: string;
        let workflowRef: string | undefined;
        if (notification.trigger) {
          if (!notification.proposal || !options.verifyProposal) continue;
          trigger = parseTriggerProvenanceV1(notification.trigger);
          if (trigger.instanceId !== capture.instanceId || persistenceHash(notification.proposal) !== trigger.proposalHash) throw new Error('Captured review trigger is no longer current');
          try {
            capture.assertCurrent(); source.assertCurrent();
            if (persistenceHash(trigger.source) !== persistenceHash(source.source)) throw new Error('Recorded review source changed');
            const detail = await source.detail({ repo, number: notification.prNumber });
            capture.assertCurrent(); source.assertCurrent();
            if (!detail) continue;
            const target = parseTriggerReviewTargetV1({ ...detail, targetId: notification.proposal.targetId });
            if (!target || target.repo.toLowerCase() !== repo.toLowerCase() || target.number !== notification.prNumber) throw new Error('Review source returned a different target');
            const reason = target.status !== 'open' ? 'Pull request is no longer open' : target.draft ? 'Pull request is a draft'
              : target.headSha.toLowerCase() !== notification.proposal.headSha.toLowerCase() ? 'A newer PR revision superseded this queued review' : null;
            if (reason) {
              const current = store.getNotification(notification.id);
              if (!current || current.status !== 'queued' || current.runId !== notification.runId) continue;
              if (recoverQueued(current)) continue;
              store.updateNotification(notification.id, 'blocked', now(), reason);
              try { options.releaseTriggerPins?.({ store: 'review', rowId: notification.id }); } catch { }
              continue;
            }
            await options.verifyProposal(notification.proposal, trigger);
            capture.assertCurrent(); source.assertCurrent();
          } catch (error) {
            store.updateNotification(notification.id, 'queued', now(), message(error));
            continue;
          }
          headSha = notification.proposal.headSha;
          workflowRef = notification.proposal.workflowRef;
        } else {
          const pr = await options.fetchPr(repo, notification.prNumber);
          if (!validPr(pr) || pr.state !== 'open' || pr.merged || pr.draft || identity(repo, notification.prNumber, pr.headSha) !== notification.id) continue;
          headSha = pr.headSha;
        }
        if (!options.canLaunch(repo)) continue;
        const token = randomUUID();
        if (!store.claimDispatch(notification.id, token, now())) continue;
        try {
          capture.assertCurrent(); source.assertCurrent();
          const current = store.getNotification(notification.id);
          if (!current || current.status !== 'queued' || current.runId !== notification.runId) continue;
          const existing = options.findExistingReview?.(repo, notification.prNumber, headSha);
          if (existing) {
            store.setNotificationRunId(notification.id, existing);
            store.updateNotification(notification.id, 'launched', now());
            if (trigger && options.getRun(existing)) try { options.releaseTriggerPins?.({ store: 'review', rowId: notification.id }); } catch { }
            continue;
          }
          const runId = notification.runId;
          if (!runId) throw new Error('Missing persisted run ID');
          const launched = options.launch({ repo, prNumber: notification.prNumber, mode: 'review', runId, headSha,
            ...(workflowRef ? { workflowRef } : {}), ...(trigger ? { trigger } : {}) });
          if (launched !== runId) throw new Error('Launcher returned an unexpected run ID');
          store.updateNotification(notification.id, 'launched', now());
        } finally { store.releaseDispatch(notification.id, token); }
      } catch (error) {
        store.updateNotification(notification.id, notification.trigger ? 'blocked' : 'failed', now(), message(error));
        if (notification.trigger) try { options.releaseTriggerPins?.({ store: 'review', rowId: notification.id }); } catch { }
      }
    }
  }

  function recoverQueued(notification: SlackNotification): boolean {
    if (!notification.runId) return false;
    const run = options.getRun(notification.runId);
    if (!run && !options.isRunActive(notification.runId)) return false;
    const failed = failedRun(run);
    store.updateNotification(notification.id, failed ? 'failed' : 'launched', now(), failed ? 'PR run failed; open the run for details' : null);
    return true;
  }

  async function scanTriggered(): Promise<void> {
    reconcileCapturedReceipts();
    const signal = AbortSignal.timeout(30_000);
    let capture: SelectedTriggerCapture<PullRequestReviewTriggerProviderV1> | null;
    try { capture = options.captureTrigger(signal); }
    catch (error) {
      state.health = { ...state.health, status: 'unavailable', error: message(error) };
      store.saveSource(state);
      return;
    }
    state.health = { ...state.health, enabled: capture !== null, status: capture ? 'scanning' : 'disabled', error: null };
    store.saveSource(state);
    if (!capture) return;
    try {
      if (!options.captureSource || !options.defaultWorkflowRef || !options.retainPins) throw new Error('GitHub review trigger runtime is incomplete');
      const source = options.captureSource(signal);
      if (source.source.sourceKey !== SOURCE) throw new Error('GitHub review trigger source changed');
      const expected = { activatedAt: state.activatedAt, cursor: state.cursor };
      const result = await runReviewTrigger({ capture, source, activatedAt: state.activatedAt, cursor: null,
        defaultWorkflowRef: options.defaultWorkflowRef(), capturedAt: now(), signal });
      const nextState: SlackSourceState = { ...state, cursor: null, health: result.complete
        ? { ...state.health, status: 'healthy', lastSuccessAt: now(), error: null }
        : { ...state.health, status: 'partial', error: 'GitHub review request scan was incomplete; queued requests retained' } };
      const notifications = result.captures.map(item => {
        const proposal = item.proposal;
        const id = identity(proposal.repo, proposal.number, proposal.headSha);
        const createdAt = now();
        return { notification: { id, repo: proposal.repo, prNumber: proposal.number, prUrl: proposal.url,
          sourceUrl: proposal.sourceUrl, author: proposal.author, channelName: CHANNEL, status: 'queued' as const,
          runId: `github-${id}`, createdAt, updatedAt: createdAt, readAt: null, error: null }, proposal, trigger: item.trigger,
          pins: triggerDependencyPins(item.trigger, 'review', id) };
      });
      store.commitTriggerScan({ sourceKey: SOURCE, expected, state: nextState, notifications, assertCurrent() {
        capture.assertCurrent(); source.assertCurrent();
      }, retainPins: options.retainPins });
      state.cursor = null; state.health = nextState.health;
      reconcileCapturedReceipts();
      const observed = new Set(result.observedRequested?.items.map(item => `${item.repo.toLowerCase()}#${item.number}`) ?? []);
      if (result.observedRequested?.quality === 'complete' && !result.observedRequested.truncated) {
        for (const notification of reviewRows('queued')) {
          if (!notification.trigger || observed.has(`${notification.repo.toLowerCase()}#${notification.prNumber}`)) continue;
          const trigger = parseTriggerProvenanceV1(notification.trigger);
          if (trigger.instanceId !== capture.instanceId || persistenceHash(trigger.source) !== persistenceHash(source.source)) continue;
          store.updateNotification(notification.id, 'blocked', now(), 'Review request was removed');
          try { options.releaseTriggerPins?.({ store: 'review', rowId: notification.id }); } catch { }
        }
      }
      await drainCaptured(capture, source, observed);
    } catch (error) {
      state.health = { ...state.health, status: 'unavailable', error: message(error) };
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
