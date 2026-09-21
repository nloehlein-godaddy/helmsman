import type { CampaignRecord, CampaignTask } from '../../src/data/campaigns';
import type { CampaignTriggerCandidateV1, CampaignTriggerProviderV1 } from '../../src/plugins/trigger';
import type { CampaignStore } from './campaigns';
import type { ExecutionStore } from './execution-store';
import { persistenceHash } from './persistence';
import { parseTriggerProvenanceV1, triggerDependencyPins, type TriggerProvenanceV1 } from './trigger-provenance';
import { campaignTriggerProposal, runCampaignTrigger, triggerSource, type SelectedTriggerCapture } from './trigger-runtime';

export interface CampaignLaunch extends CampaignRecord {
  runId: string;
  workflowRef: string;
  campaignId: string;
  phaseId: string;
  retryOf?: string;
  trigger?: TriggerProvenanceV1;
}
export interface CampaignDispatcherOptions {
  store: CampaignStore;
  canStart(repo: string): boolean;
  getRun(runId: string): { status: 'running' | 'succeeded' | 'failed' | 'stopped' } | null;
  launch(task: CampaignLaunch): string | Promise<string>;
  stop(runId: string): unknown | Promise<unknown>;
  now?: () => number;
  claimTtlMs?: number;
  captureTrigger?: (signal: AbortSignal) => SelectedTriggerCapture<CampaignTriggerProviderV1> | null;
  retainPins?: ExecutionStore['retainPins'];
  releaseTriggerPins?: ExecutionStore['releaseTriggerPins'];
}

export function createCampaignDispatcher(options: CampaignDispatcherOptions): { poll(): Promise<void> } {
  const { store } = options;
  const now = options.now ?? Date.now;
  const ttl = options.claimTtlMs ?? 60_000;
  if (!Number.isFinite(ttl) || ttl < 1000) throw new Error('Campaign claim lifetime must be at least one second');
  let pending: Promise<void> | null = null;
  let windowOffset = 0;
  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 2000) || 'Campaign dispatch failed';

  async function reconcile(item: CampaignTask): Promise<void> {
    const run = options.getRun(item.runId);
    if (run) {
      if (run.status === 'running') {
        if (item.claimToken) store.markLaunched(item.id, item.claimToken);
        if (store.phase(item.phaseId)?.state === 'stopped') await options.stop(item.runId);
      } else store.settle(item.id, item.runId, run.status === 'stopped' ? 'cancelled' : run.status);
      if (store.trigger(item.id)) {
        try { options.releaseTriggerPins?.({ store: 'campaign', rowId: item.id }); } catch { }
      }
      return;
    }
    if (item.state === 'claiming' && item.claimToken && item.claimedAt
      && now() - Date.parse(item.claimedAt) >= ttl && options.canStart(item.record.repo)) {
      store.releaseClaim(item.id, item.claimToken, 'Previous dispatch was not recorded; retrying the same run ID');
    }
  }

  async function launchClaimed(item: CampaignTask): Promise<void> {
    if (!item.claimToken) return;
    const token = item.claimToken;
    const existing = options.getRun(item.runId);
    if (existing) { await reconcile(item); return; }
    const campaign = store.get(item.campaignId);
    if (!campaign || store.phase(item.phaseId)?.state !== 'running' || !options.canStart(item.record.repo)) {
      store.releaseClaim(item.id, token); return;
    }
    const captured = store.trigger(item.id);
    const trigger = captured ? parseTriggerProvenanceV1(captured) : undefined;
    const candidate = campaignCandidate(item);
    if (trigger && (!candidate || persistenceHash(campaignTriggerProposal(candidate)) !== trigger.proposalHash)) {
      store.settle(item.id, item.runId, 'failed', 'Captured campaign proposal no longer matches the queued task');
      try { options.releaseTriggerPins?.({ store: 'campaign', rowId: item.id }); } catch { }
      return;
    }
    try {
      const launched = await options.launch({ ...item.record, runId: item.runId, workflowRef: campaign.workflowRef, campaignId: item.campaignId, phaseId: item.phaseId,
        ...(item.attempt > 1 ? { retryOf: `${item.id}-${item.attempt - 1}` } : {}), ...(trigger ? { trigger } : {}) });
      if (launched !== item.runId) throw new Error('Launcher returned a different campaign run ID');
      if (options.getRun(item.runId)) await reconcile(item);
      if (store.phase(item.phaseId)?.state === 'stopped') await options.stop(item.runId);
    } catch (error) {
      store.claimError(item.id, token, errorText(error));
      await reconcile(item);
    }
  }

  function releaseSettledTriggerPins(): void {
    for (const campaign of store.list()) for (const phase of store.phases(campaign.id)) for (const item of store.tasks(phase.id)) {
      if (!store.trigger(item.id) || !['succeeded', 'failed', 'cancelled'].includes(item.state)) continue;
      try { options.releaseTriggerPins?.({ store: 'campaign', rowId: item.id }); } catch { }
    }
  }

  function eligible(attempted: Set<string>): CampaignTask[] {
    return store.claimableTasks().filter(candidate => !attempted.has(candidate.id)
      && options.canStart(candidate.record.repo) && !options.getRun(candidate.runId));
  }

  function campaignCandidate(item: CampaignTask): CampaignTriggerCandidateV1 | null {
    const campaign = store.get(item.campaignId);
    if (!campaign) return null;
    return Object.freeze({ candidateId: persistenceHash([item.id, item.attempt, item.updatedAt, campaign.workflowRef]),
      repo: item.record.repo, campaignId: item.campaignId, phaseId: item.phaseId, taskId: item.id, attempt: item.attempt,
      workflowRef: campaign.workflowRef, title: item.record.title ?? item.record.ticketId ?? item.record.task?.slice(0, 4096) ?? '',
      mode: item.record.mode, createdAt: item.createdAt });
  }

  async function scan(): Promise<void> {
    for (const item of store.activeTasks()) {
      try { await reconcile(item); }
      catch (error) { if (item.claimToken) store.claimError(item.id, item.claimToken, errorText(error)); }
    }
    store.completePhases();
    releaseSettledTriggerPins();
    if (!options.captureTrigger) {
      for (const candidate of store.queuedTasks()) {
        if (store.phase(candidate.phaseId)?.state !== 'running' || !options.canStart(candidate.record.repo)) continue;
        const item = store.claim(candidate.id);
        if (item) await launchClaimed(item);
      }
      return;
    }
    const triggerController = new AbortController();
    const triggerCapture = options.captureTrigger(triggerController.signal);
    if (!triggerCapture) return;
    const attempted = new Set<string>();
    for (;;) {
      const captured = eligible(attempted).find(item => store.trigger(item.id));
      if (captured) {
        const provenance = parseTriggerProvenanceV1(store.trigger(captured.id));
        const compatible = provenance.instanceId === triggerCapture.instanceId;
        triggerCapture.assertCurrent();
        attempted.add(captured.id);
        const item = store.claimCaptured(captured.id);
        if (!item) continue;
        if (!compatible) {
          store.settle(item.id, item.runId, 'failed', 'Captured campaign trigger is no longer selected');
          try { options.releaseTriggerPins?.({ store: 'campaign', rowId: item.id }); } catch { }
          continue;
        }
        await launchClaimed(item);
        continue;
      }
      const queued = eligible(attempted).filter(item => !store.trigger(item.id));
      if (!queued.length) break;
      const offset = windowOffset % queued.length;
      const rotated = [...queued.slice(offset), ...queued.slice(0, offset)];
      const window = rotated.slice(0, 100);
      const byHandle = new Map<string, CampaignTask>();
      const candidates = window.flatMap(item => {
        const candidate = campaignCandidate(item);
        if (!candidate) return [];
        byHandle.set(candidate.candidateId, item);
        return [candidate];
      });
      if (!candidates.length) break;
      const decision = runCampaignTrigger({ capture: triggerCapture, candidates, truncated: queued.length > candidates.length,
        source(candidate) {
          const current = byHandle.get(candidate.candidateId);
          const campaign = current ? store.get(current.campaignId) : null;
          const phase = current ? store.phase(current.phaseId) : null;
          if (!current || !campaign || !phase) throw new Error('Campaign trigger candidate disappeared');
          return { source: triggerSource(`campaign:${current.id}`, persistenceHash({ current, campaign, phase })) };
        }, capturedAt: new Date(now()).toISOString(), signal: triggerController.signal });
      if (!decision) {
        if (queued.length > candidates.length) windowOffset = (offset + candidates.length) % queued.length;
        break;
      }
      const selected = byHandle.get(decision.candidate.candidateId);
      if (!selected) throw new Error('Campaign trigger selected an unknown task');
      const sourceRevision = decision.trigger.source.revision;
      const assertCurrent = () => {
        triggerCapture.assertCurrent();
        const current = store.task(selected.id); const campaign = store.get(selected.campaignId); const phase = store.phase(selected.phaseId);
        if (!current || !campaign || !phase || current.state !== 'queued' || current.attempt !== selected.attempt
          || persistenceHash({ current, campaign, phase }) !== sourceRevision) throw new Error('Campaign changed before trigger capture');
      };
      if (!options.retainPins) throw new Error('Campaign trigger pin retention is unavailable');
      attempted.add(selected.id);
      const item = store.claimTriggered({ id: selected.id, attempt: selected.attempt, trigger: decision.trigger,
        pins: triggerDependencyPins(decision.trigger, 'campaign', selected.id), assertCurrent, retainPins: options.retainPins });
      if (!item) continue;
      windowOffset = 0;
      await launchClaimed(item);
    }
  }

  return { poll() { pending ??= scan().finally(() => { pending = null; }); return pending; } };
}
