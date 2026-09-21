import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCampaignStore, type CampaignStore } from './campaigns';
import { createCampaignDispatcher, type CampaignDispatcherOptions, type CampaignLaunch } from './campaign-dispatcher';
import type { CampaignTriggerProviderV1 } from '../../src/plugins/trigger';
import type { SelectedTriggerCapture } from './trigger-runtime';
import { captureTriggerProvenanceV1 } from './trigger-provenance';

const stores: CampaignStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup(concurrency = 2) {
  let clock = Date.parse('2026-09-18T00:00:00.000Z');
  const store = openCampaignStore(':memory:', { now: () => new Date(clock).toISOString() }); stores.push(store);
  const campaign = store.create({ name: 'Campaign', repo: 'org/a', workflowRef: 'coding@v1', concurrency });
  const phase = store.createPhase(campaign.id, { name: 'Phase' });
  const preview = store.previewImport({ phaseId: phase.id, format: 'jsonl', allowedRepos: ['org/a', 'org/b', 'org/c'],
    content: '{"task":"A"}\n{"task":"B","repo":"org/b"}\n{"task":"C","repo":"org/c"}' });
  const tasks = store.confirmImport(preview.id);
  store.setPhaseState(phase.id, 'start');
  const runs = new Map<string, { status: 'running' | 'succeeded' | 'failed' | 'stopped' }>();
  const launch = vi.fn((task: CampaignLaunch) => { runs.set(task.runId, { status: 'running' }); return task.runId; });
  const stop = vi.fn((runId: string) => { runs.set(runId, { status: 'stopped' }); });
  const options: CampaignDispatcherOptions = { store, canStart: () => true, getRun: id => runs.get(id) ?? null,
    launch, stop, now: () => clock, claimTtlMs: 1000 };
  return { store, campaign, phase, tasks, runs, launch, stop, options, advance: () => { clock += 1001; }, dispatcher: createCampaignDispatcher(options) };
}

describe('campaign dispatcher', () => {
  it('captures an alternative trigger choice before claiming and launches the retained proposal', async () => {
    const f = setup(1);
    const artifact = { pluginId: 'example.trigger', artifactHash: 'a'.repeat(64), packageVersion: '1.0.0', requires: [] };
    const provider: CampaignTriggerProviderV1 = { metadata: { version: 1, label: 'Last first', kind: 'campaign', intervalMs: 1000 },
      select: input => input.candidates.at(-1) ? { candidateId: input.candidates.at(-1)!.candidateId } : null };
    const capture: SelectedTriggerCapture<CampaignTriggerProviderV1> = { instanceId: 'campaign', selectionRevision: 'revision-1', provider,
      artifacts: [artifact], record: { version: 1, binding: { providerId: 'example.trigger/watch', pluginId: 'example.trigger', artifactHash: artifact.artifactHash, contractVersion: 1 },
        origin: 'external', settings: {}, metadata: provider.metadata }, assertCurrent() {} };
    const retainPins = vi.fn();
    const dispatcher = createCampaignDispatcher({ ...f.options, captureTrigger: () => capture, retainPins, releaseTriggerPins: vi.fn() });
    await dispatcher.poll();
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.launch.mock.calls[0]?.[0]).toMatchObject({ runId: f.tasks.at(-1)?.runId, trigger: { instanceId: 'campaign', proposalHash: expect.any(String) } });
    expect(f.store.trigger(f.tasks.at(-1)!.id)).toMatchObject({ selectionRevision: 'revision-1' });
    expect(retainPins).toHaveBeenCalledWith([expect.objectContaining({ ownerId: `trigger:campaign:${f.tasks.at(-1)!.id}` })]);
  });

  it('reconciles receipts but does not reclaim captured work while its trigger is disabled', async () => {
    const f = setup(1);
    const artifact = { pluginId: 'example.trigger', artifactHash: 'b'.repeat(64), packageVersion: '1.0.0', requires: [] };
    const provider: CampaignTriggerProviderV1 = { metadata: { version: 1, label: 'Campaign', kind: 'campaign', intervalMs: 1000 }, select: input => ({ candidateId: input.candidates[0]!.candidateId }) };
    const capture: SelectedTriggerCapture<CampaignTriggerProviderV1> = { instanceId: 'campaign', selectionRevision: 'revision-1', provider,
      artifacts: [artifact], record: { version: 1, binding: { providerId: 'example.trigger/watch', pluginId: 'example.trigger', artifactHash: artifact.artifactHash, contractVersion: 1 },
        origin: 'external', settings: {}, metadata: provider.metadata }, assertCurrent() {} };
    const first = createCampaignDispatcher({ ...f.options, canStart: () => false, captureTrigger: () => capture, retainPins: vi.fn() });
    await first.poll();
    expect(f.launch).not.toHaveBeenCalled();
    const trigger = captureTriggerProvenanceV1({ instanceId: capture.instanceId, selectionRevision: capture.selectionRevision,
      provider: capture.record, artifacts: capture.artifacts, source: { sourceKey: `campaign:${f.tasks[0]!.id}`, revision: 'source-1', bindings: [] },
      input: { candidates: [f.tasks[0]!.id] }, proposal: { taskId: f.tasks[0]!.id }, capturedAt: '2026-09-18T00:00:00.000Z' });
    const captured = f.store.claimTriggered({ id: f.tasks[0]!.id, attempt: 1, trigger, pins: [], assertCurrent() {}, retainPins() {} });
    if (captured?.claimToken) f.store.releaseClaim(captured.id, captured.claimToken);
    await createCampaignDispatcher({ ...f.options, captureTrigger: () => null, retainPins: vi.fn() }).poll();
    expect(f.launch).not.toHaveBeenCalled();
  });
  it('starts bounded work with stable IDs and pinned workflow, then fills freed capacity', async () => {
    const f = setup();
    await f.dispatcher.poll();
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.launch.mock.calls[0]?.[0]).toMatchObject({ runId: f.tasks[0]?.runId, workflowRef: 'coding@v1', campaignId: f.campaign.id, phaseId: f.phase.id });
    f.runs.set(f.tasks[0]!.runId, { status: 'succeeded' });
    await f.dispatcher.poll();
    expect(f.launch).toHaveBeenCalledTimes(3);
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('succeeded');
    await f.dispatcher.poll();
    expect(f.launch).toHaveBeenCalledTimes(3);
  });

  it('pauses new work without stopping and stops active runs after a durable stop', async () => {
    const f = setup(1);
    await f.dispatcher.poll();
    f.store.setPhaseState(f.phase.id, 'pause');
    await f.dispatcher.poll();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.store.setPhaseState(f.phase.id, 'stop');
    const restarted = createCampaignDispatcher(f.options);
    await restarted.poll();
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(f.tasks[0]!.runId);
    await restarted.poll();
    expect(f.store.tasks(f.phase.id).every(task => task.state === 'cancelled')).toBe(true);
  });

  it('reconciles an ambiguous launch with a recorded run before any retry', async () => {
    const f = setup(1);
    f.launch.mockImplementation(task => { f.runs.set(task.runId, { status: 'running' }); throw new Error('Lost response'); });
    await f.dispatcher.poll();
    f.advance();
    await createCampaignDispatcher(f.options).poll();
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('running');
  });

  it('retains an unconfirmed start until its claim expires, then reuses its original run ID', async () => {
    const f = setup(1);
    f.launch.mockImplementationOnce(() => { throw new Error('No acknowledgement'); });
    await f.dispatcher.poll();
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('claiming');
    await f.dispatcher.poll();
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.advance();
    await createCampaignDispatcher(f.options).poll();
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.launch.mock.calls[0]?.[0].runId).toBe(f.launch.mock.calls[1]?.[0].runId);
  });

  it('keeps an acknowledged launch claim until a durable run exists so preflight crashes recover', async () => {
    const f = setup(1);
    f.launch.mockImplementationOnce(task => task.runId);
    await f.dispatcher.poll();
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('claiming');
    f.advance();
    await createCampaignDispatcher(f.options).poll();
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.launch.mock.calls[0]?.[0].runId).toBe(f.launch.mock.calls[1]?.[0].runId);
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('running');
  });

  it('does not release a stale claim while the galleon is externally busy', async () => {
    const f = setup(1);
    f.store.claim(f.tasks[0]!.id);
    f.advance();
    await createCampaignDispatcher({ ...f.options, canStart: () => false }).poll();
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('claiming');
    expect(f.launch).not.toHaveBeenCalled();
  });

  it('coalesces polls and competing dispatchers do not duplicate asynchronous launches', async () => {
    const f = setup(1);
    let resolve!: (id: string) => void;
    const launch = vi.fn((_task: CampaignLaunch) => new Promise<string>(done => { resolve = done; }));
    const a = createCampaignDispatcher({ ...f.options, launch });
    const b = createCampaignDispatcher({ ...f.options, launch });
    const first = a.poll();
    expect(a.poll()).toBe(first);
    await b.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    resolve(f.tasks[0]!.runId);
    await first;
  });

  it('finishing a phase cancels queued work but lets its active work finish', async () => {
    const f = setup(1);
    await f.dispatcher.poll();
    f.store.setPhaseState(f.phase.id, 'finish');
    await f.dispatcher.poll();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.runs.set(f.tasks[0]!.runId, { status: 'succeeded' });
    await f.dispatcher.poll();
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('succeeded');
  });
});
