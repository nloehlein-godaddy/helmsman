import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSlackStore, type ReviewNotificationProposal, type SlackStore } from './store';
import type { TriggerProvenanceV1 } from '../trigger-provenance';
import { createSlackWatcher, type SlackWatcherOptions } from './watcher';
import { slackReviewTriggerProvider } from '../../../src/plugins/trigger-slack-review/provider';
import type { CommunicationReviewTriggerProviderV1 } from '../../../src/plugins/trigger';
import type { CommunicationReviewSourceCapture, SelectedTriggerCapture } from '../trigger-runtime';
import type { AutomaticReviewObservation } from '../automatic-review-ownership';

const activation = '2026-09-17T12:00:00.000Z';
const activationTs = Date.parse(activation) / 1000;
const stores: SlackStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function message(offset: number, prUrls = ['https://github.com/org/repo/pull/42']) {
  return { channelId: 'C123', ts: (activationTs + offset).toFixed(6), permalink: 'https://example.slack.com/archives/C123/p123', author: 'Someone', prUrls };
}

function ownership(proposal: ReviewNotificationProposal, trigger: TriggerProvenanceV1, decision: 'own' | 'other' | 'unknown' = 'other'): AutomaticReviewObservation {
  const reason = decision === 'own' ? 'Automatic Slack review skipped: PR is authored by the authenticated GitHub account'
    : decision === 'unknown' ? 'Authenticated ownership unavailable' : null;
  return { policy: { version: 1, kind: 'authenticated-pr-owner', decision, actorLogin: decision === 'unknown' ? null : decision === 'own' ? 'author' : 'viewer',
    authorLogin: decision === 'unknown' ? null : 'author', headSha: proposal.headSha, providerBindingHash: 'd'.repeat(64),
    sourceRevision: trigger.source.revision, observedAt: activation, reason }, blockedReason: decision === 'own' ? reason : null, assertCurrent() {} };
}

function setup(overrides: Partial<SlackWatcherOptions> = {}) {
  const store = overrides.store ?? openSlackStore(':memory:');
  if (!stores.includes(store)) stores.push(store);
  const scan = vi.fn().mockResolvedValue({ messages: [message(1)], complete: true });
  const active = new Set<string>();
  const launch = vi.fn(({ runId }: { runId: string }) => { active.add(runId); return runId; });
  const provider = slackReviewTriggerProvider({ enabled: true, intervalMs: 1000, overlapSeconds: 300, repoFilter: [] });
  const artifact = { pluginId: 'example.slack-trigger', artifactHash: 'c'.repeat(64), packageVersion: '1.0.0', requires: [] };
  const capture: SelectedTriggerCapture<CommunicationReviewTriggerProviderV1> = { instanceId: 'slack-review', selectionRevision: 'revision-1', provider,
    artifacts: [artifact], record: { version: 1, binding: { providerId: 'example.slack-trigger/watch', pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, contractVersion: 1 },
      origin: 'external', settings: {}, metadata: provider.metadata }, assertCurrent() {} };
  const source: CommunicationReviewSourceCapture = { kind: 'communication', channelId: 'C123', channelName: 'airo-editing',
    source: { sourceKey: JSON.stringify(['T123', 'C123']), revision: 'source-1', bindings: [] }, artifacts: [], assertCurrent() {},
    async messages(input) { const value = await scan(input); return { items: value.messages, complete: value.complete }; },
    async detail({ repo, number }) { return { repo, number, headSha: 'a'.repeat(40), title: 'Update', url: `https://github.com/${repo}/pull/${number}`, status: 'open', draft: false }; } };
  const options: SlackWatcherOptions = {
    captureTrigger: () => capture, captureSource: () => source, defaultWorkflowRef: () => 'review@1', observeOwnership: vi.fn(async (proposal, trigger) => ownership(proposal, trigger)), retainPins: vi.fn(),
    store, clientId: 'T123', channelId: 'C123', channelName: 'airo-editing',
    allowedRepos: () => ['org/repo'], canLaunch: () => true,
    getRun: () => null, isRunActive: id => active.has(id), launch, now: () => activation,
    ...overrides,
  };
  return { store, scan, launch, options, watcher: createSlackWatcher(options) };
}

describe('Slack watcher', () => {
  it('persists observed trigger proposal and provenance before launching it', async () => {
    const f = setup();
    const artifact = { pluginId: 'example.slack-trigger', artifactHash: 'c'.repeat(64), packageVersion: '1.0.0', requires: [] };
    const provider: CommunicationReviewTriggerProviderV1 = { metadata: { version: 1, label: 'Slack reviews', kind: 'review-watch', source: 'communication', intervalMs: 1000 },
      async scan(input, context) {
        const batch = await context.messages({ since: input.cursor });
        const target = await context.detail({ repo: 'org/repo', number: 42 });
        return { proposals: target ? [{ eventId: batch.items[0]!.eventId, targetId: target.targetId, workflowRef: input.defaultWorkflowRef,
          sourceUrl: batch.items[0]!.permalink, author: batch.items[0]!.author, channelName: batch.items[0]!.channelId }] : [],
          nextCursor: batch.items[0]!.ts, complete: batch.complete };
      } };
    const capture: SelectedTriggerCapture<CommunicationReviewTriggerProviderV1> = { instanceId: 'slack-review', selectionRevision: 'revision-1', provider,
      artifacts: [artifact], record: { version: 1, binding: { providerId: 'example.slack-trigger/watch', pluginId: 'example.slack-trigger', artifactHash: artifact.artifactHash, contractVersion: 1 },
        origin: 'external', settings: {}, metadata: provider.metadata }, assertCurrent() {} };
    const source: CommunicationReviewSourceCapture = { kind: 'communication', channelId: 'C123', channelName: 'airo-editing',
      source: { sourceKey: JSON.stringify(['T123', 'C123']), revision: 'source-1', bindings: [] }, artifacts: [], assertCurrent() {},
      async messages() { return { items: [message(1)], complete: true }; },
      async detail() { return { repo: 'org/repo', number: 42, headSha: 'a'.repeat(40), title: 'Update', url: 'https://github.com/org/repo/pull/42', status: 'open', draft: false }; } };
    const retainPins = vi.fn();
    const watcher = createSlackWatcher({ ...f.options, captureTrigger: () => capture, captureSource: () => source,
      defaultWorkflowRef: () => 'review@1', observeOwnership: vi.fn(async (proposal, trigger) => ownership(proposal, trigger)), retainPins, releaseTriggerPins: vi.fn() });
    await watcher.poll();
    expect(f.launch).toHaveBeenCalledWith(expect.objectContaining({ headSha: 'a'.repeat(40), workflowRef: 'review@1', trigger: expect.objectContaining({ instanceId: 'slack-review' }) }));
    expect(f.store.listNotifications()[0]).toMatchObject({ channelName: 'airo-editing', proposal: { targetId: expect.any(String), headSha: 'a'.repeat(40) },
      trigger: { selectionRevision: 'revision-1' } });
    expect(retainPins).toHaveBeenCalledWith([expect.objectContaining({ ownerId: expect.stringMatching(/^trigger:review:/) })]);
  });

  it('discards a stale asynchronous trigger scan without moving its cursor', async () => {
    const f = setup();
    let current = true;
    let stale = true;
    const artifact = { pluginId: 'example.slack-trigger', artifactHash: 'd'.repeat(64), packageVersion: '1.0.0', requires: [] };
    const provider: CommunicationReviewTriggerProviderV1 = { metadata: { version: 1, label: 'Slack reviews', kind: 'review-watch', source: 'communication', intervalMs: 1000 },
      async scan(input, context) { const batch = await context.messages({ since: input.cursor }); return { proposals: [], nextCursor: batch.items[0]?.ts ?? input.cursor, complete: true }; } };
    const capture: SelectedTriggerCapture<CommunicationReviewTriggerProviderV1> = { instanceId: 'slack-review', selectionRevision: 'revision-1', provider,
      artifacts: [artifact], record: { version: 1, binding: { providerId: 'example.slack-trigger/watch', pluginId: 'example.slack-trigger', artifactHash: artifact.artifactHash, contractVersion: 1 },
        origin: 'external', settings: {}, metadata: provider.metadata }, assertCurrent() { if (!current) throw new Error('selection changed'); } };
    const source: CommunicationReviewSourceCapture = { kind: 'communication', channelId: 'C123', channelName: 'airo-editing',
      source: { sourceKey: JSON.stringify(['T123', 'C123']), revision: 'source-1', bindings: [] }, artifacts: [], assertCurrent() {},
      async messages() { if (stale) { stale = false; current = false; return { items: [message(900)], complete: true }; } return { items: [], complete: true }; }, async detail() { return null; } };
    const watcher = createSlackWatcher({ ...f.options, captureTrigger: () => capture, captureSource: () => source,
      defaultWorkflowRef: () => 'review@1', observeOwnership: vi.fn(async (proposal, trigger) => ownership(proposal, trigger)), retainPins: vi.fn() });
    await watcher.poll();
    expect(watcher.health()).toMatchObject({ status: 'unavailable', error: 'selection changed' });
    current = true;
    await watcher.poll();
    expect(f.scan).not.toHaveBeenCalled();
    expect(watcher.health().status).toBe('healthy');
  });
  it('preserves legacy queue identity and receipts while disabled without new intake or launch', async () => {
    let enabled = false;
    const f = setup();
    const capture = f.options.captureTrigger(new AbortController().signal);
    f.options.captureTrigger = () => enabled ? capture : null;
    const key = JSON.stringify(['T123', 'C123']);
    f.store.insertNotification(key, { id: 'legacy-row', runId: 'slack-original', repo: 'org/repo', prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42', sourceUrl: message(1).permalink, author: 'Someone', channelName: 'airo-editing',
      status: 'queued', createdAt: activation, updatedAt: activation, readAt: null, error: null });
    await f.watcher.poll();
    expect(f.scan).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
    enabled = true;
    f.scan.mockResolvedValue({ messages: [], complete: true });
    await f.watcher.poll();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.store.getNotification('legacy-row')?.error).toContain('retained trigger evidence');
    expect(f.store.getNotification('legacy-row')).toMatchObject({ trigger: null, proposal: null, runId: 'slack-original' });
    enabled = false;
    f.options.getRun = () => ({ status: 'failed' });
    await f.watcher.poll();
    expect(f.store.getNotification('legacy-row')?.status).toBe('failed');
    expect(f.launch).not.toHaveBeenCalled();
  });

  it('uses activation as the baseline and captures posts arriving during the first scan', async () => {
    const { watcher, scan, launch, store } = setup();
    scan.mockResolvedValue({ messages: [message(-60), message(1)], complete: true });
    await watcher.poll();
    expect(scan).toHaveBeenCalledWith({ since: activationTs.toFixed(6) });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.listNotifications()).toHaveLength(1);
    expect(watcher.health()).toMatchObject({ status: 'healthy', lastSuccessAt: activation });
  });

  it('launches each full link once per message regardless of author, and launches reposts', async () => {
    const { watcher, scan, launch, store } = setup();
    const first = message(1, [
      'https://github.com/org/repo/pull/42', 'https://github.com/ORG/REPO/pull/42#discussion',
      'https://github.com/org/repo/pull/43', '/org/repo/pull/44',
    ]);
    first.author = 'Me';
    scan.mockResolvedValue({ messages: [first], complete: true });
    await watcher.poll();
    await watcher.poll();
    expect(launch).toHaveBeenCalledTimes(2);
    scan.mockResolvedValue({ messages: [first, message(3)], complete: true });
    await watcher.poll();
    expect(launch).toHaveBeenCalledTimes(3);
    expect(store.listNotifications().every(row => row.status === 'launched')).toBe(true);
  });

  it('retains the cursor after partial scans and failures while deduplicating discovered requests', async () => {
    const { watcher, scan, launch } = setup();
    scan.mockResolvedValueOnce({ messages: [message(900)], complete: false });
    await watcher.poll();
    expect(watcher.health().status).toBe('partial');
    scan.mockRejectedValueOnce(new Error('signed out'));
    await watcher.poll();
    expect(watcher.health()).toMatchObject({ status: 'unavailable', error: 'signed out', lastSuccessAt: null });
    scan.mockResolvedValueOnce({ messages: [message(900)], complete: true });
    await watcher.poll();
    expect(scan.mock.calls.map(call => call[0].since)).toEqual(Array(3).fill(activationTs.toFixed(6)));
    expect(launch).toHaveBeenCalledTimes(1);
    await watcher.poll();
    expect(scan).toHaveBeenLastCalledWith({ since: (activationTs + 600).toFixed(6) });
  });

  it('persists queued requests before launch, survives reopen, and marks launch unread', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'helmsman-slack-'));
    directories.push(directory);
    const path = join(directory, 'state.db');
    const initial = setup({ store: openSlackStore(path), canLaunch: () => false });
    await initial.watcher.poll();
    const queued = initial.store.listNotifications()[0]!;
    expect(queued).toMatchObject({ status: 'queued', runId: `slack-${queued.id}` });
    initial.store.markRead(queued.id, activation);
    stores.splice(stores.indexOf(initial.store), 1);
    initial.store.close();
    const restarted = setup({ store: openSlackStore(path), now: () => '2026-09-17T12:10:00.000Z' });
    restarted.scan.mockRejectedValue(new Error('browser closed'));
    await restarted.watcher.poll();
    expect(restarted.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repo: 'org/repo', prNumber: 42, mode: 'review', runId: queued.runId }));
    expect(restarted.store.listNotifications()[0]).toMatchObject({ id: queued.id, status: 'launched', readAt: null });
  });

  it.each(['persisted', 'active'])('recovers a %s run without launching twice', async (kind) => {
    const initial = setup({ canLaunch: () => false });
    await initial.watcher.poll();
    const runId = initial.store.listNotifications()[0]!.runId;
    const restarted = setup({
      store: initial.store,
      getRun: id => kind === 'persisted' && id === runId ? { status: 'running' } : null,
      isRunActive: id => kind === 'active' && id === runId,
    });
    await restarted.watcher.poll();
    expect(restarted.launch).not.toHaveBeenCalled();
    expect(initial.store.listNotifications()[0]?.status).toBe('launched');
  });

  it('restarts a launch interrupted before a run row existed, retaining its run ID', async () => {
    const initial = setup();
    await initial.watcher.poll();
    const runId = initial.store.listNotifications()[0]!.runId;
    const restarted = setup({ store: initial.store });
    await restarted.watcher.poll();
    expect(restarted.launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repo: 'org/repo', prNumber: 42, mode: 'review', runId }));
  });

  it('never retries a completed run after restart', async () => {
    const initial = setup();
    await initial.watcher.poll();
    const restarted = setup({ store: initial.store, getRun: () => ({ status: 'succeeded' }) });
    await restarted.watcher.poll();
    expect(restarted.launch).not.toHaveBeenCalled();
    expect(initial.store.listNotifications()[0]?.status).toBe('launched');
  });

  it('blocks unsupported repositories and lets another repository pass a busy one', async () => {
    const { watcher, scan, launch, store } = setup({
      allowedRepos: () => ['org/repo', 'org/other'], canLaunch: repo => repo !== 'org/repo',
    });
    scan.mockResolvedValue({ messages: [message(1, [
      'https://github.com/org/repo/pull/1', 'https://github.com/org/other/pull/2', 'https://github.com/untrusted/repo/pull/3',
    ])], complete: true });
    await watcher.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ repo: 'org/other', prNumber: 2 });
    expect(store.listNotifications().find(row => row.prNumber === 1)?.status).toBe('queued');
    expect(store.listNotifications().find(row => row.prNumber === 3)).toMatchObject({ status: 'blocked', error: 'Galleon untrusted/repo is not configured' });
  });

  it('persists launch errors and does not automatically retry an uncertain launch', async () => {
    const launch = vi.fn(() => { throw new Error('launch failed'); });
    const { watcher, store } = setup({ launch });
    await watcher.poll();
    await watcher.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.listNotifications()[0]).toMatchObject({ status: 'failed', error: 'launch failed' });
  });

  it('turns a later asynchronous run failure into an unread persistent notification', async () => {
    const getRun = vi.fn<SlackWatcherOptions['getRun']>().mockReturnValue(null);
    const { watcher, store } = setup({ getRun });
    await watcher.poll();
    const id = store.listNotifications()[0]!.id;
    expect(store.markRead(id, activation)).toBe(true);
    getRun.mockReturnValue({ status: 'failed' });
    await watcher.poll();
    expect(store.listNotifications()[0]).toMatchObject({ status: 'failed', readAt: null, error: expect.stringContaining('PR run failed') });
  });

  it('coalesces overlapping polls and rejects malformed external message data', async () => {
    const { watcher, scan, launch } = setup();
    let finish: ((result: unknown) => void) | undefined;
    scan.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = watcher.poll();
    const second = watcher.poll();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish?.({ messages: [null, {}, { ...message(1), prUrls: null }, message(2)], complete: true });
    await first;
    expect(scan).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
    expect(watcher.health().status).toBe('unavailable');
  });

  it('retains queued posts when disabled during a scan and launches after re-enabling', async () => {
    let enabled = true;
    const { watcher, scan, launch, store } = setup({ canLaunch: () => enabled });
    let finish: ((result: unknown) => void) | undefined;
    scan.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = watcher.poll();
    await vi.waitFor(() => expect(finish).toBeDefined());
    enabled = false;
    finish?.({ messages: [message(1)], complete: true });
    await pending;
    expect(launch).not.toHaveBeenCalled();
    const notification = store.listNotifications()[0]!;
    expect(notification.status).toBe('queued');
    enabled = true;
    await watcher.poll();
    expect(launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repo: 'org/repo', prNumber: 42, mode: 'review', runId: notification.runId }));
    expect(store.listNotifications()).toHaveLength(1);
    expect(store.listNotifications()[0]?.status).toBe('launched');
  });
  it('persists an own-PR block through restart and releases only its terminal trigger pins', async () => {
    const releaseTriggerPins = vi.fn();
    const observeOwnership = vi.fn(async (proposal, trigger) => ownership(proposal, trigger, 'own'));
    const f = setup({ releaseTriggerPins, observeOwnership });
    await f.watcher.poll();
    const row = f.store.listNotifications()[0]!;
    expect(row).toMatchObject({ status: 'blocked', policy: { decision: 'own', actorLogin: 'author', headSha: 'a'.repeat(40) } });
    expect(f.launch).not.toHaveBeenCalled();
    expect(releaseTriggerPins).toHaveBeenCalledExactlyOnceWith({ store: 'review', rowId: row.id });
    const restarted = setup({ store: f.store, observeOwnership });
    await restarted.watcher.poll();
    expect(restarted.launch).not.toHaveBeenCalled();
    expect(observeOwnership).toHaveBeenCalledOnce();
  });

  it('retains unknown ownership and pins through a database reopen, then permits a fresh known-other observation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'helmsman-ownership-'));
    directories.push(directory); const path = join(directory, 'state.db');
    const releaseTriggerPins = vi.fn();
    const f = setup({ store: openSlackStore(path), releaseTriggerPins,
      observeOwnership: async (proposal, trigger) => ownership(proposal, trigger, 'unknown') });
    await f.watcher.poll();
    const row = f.store.listNotifications()[0]!;
    expect(row).toMatchObject({ status: 'queued', policy: { decision: 'unknown' } });
    expect(f.launch).not.toHaveBeenCalled(); expect(releaseTriggerPins).not.toHaveBeenCalled();
    stores.splice(stores.indexOf(f.store), 1); f.store.close();
    const restarted = setup({ store: openSlackStore(path) });
    await restarted.watcher.poll();
    expect(restarted.launch).toHaveBeenCalledOnce();
    expect(restarted.store.getNotification(row.id)).toMatchObject({ status: 'launched', policy: { decision: 'other' } });
  });

  it.each(['no-run', 'admitted', 'active'] as const)('recovers a pre-dispatch claim with %s evidence after restart', async kind => {
    const f = setup({ canLaunch: () => false }); await f.watcher.poll();
    const row = f.store.listNotifications()[0]!;
    expect(f.store.claimDispatch(row.id, 'orphaned-token', activation)).toBe(true);
    const observeOwnership = vi.fn(async (proposal, trigger) => ownership(proposal, trigger));
    const restarted = setup({ store: f.store, observeOwnership,
      getRun: () => kind === 'admitted' ? { status: 'running' } : null,
      ...(kind === 'active' ? { isRunActive: () => true } : {}) });
    await restarted.watcher.poll();
    expect(restarted.launch).toHaveBeenCalledTimes(kind === 'no-run' ? 1 : 0);
    expect(observeOwnership).toHaveBeenCalledTimes(kind === 'no-run' ? 1 : 0);
    expect(restarted.store.getNotification(row.id)?.status).toBe('launched');
    expect(restarted.store.ownsDispatch(row.id, 'orphaned-token')).toBe(false);
  });

  it.each(['capture', 'scope', 'source'] as const)('does not save a late own decision after %s authority changes', async kind => {
    const f = setup({ canLaunch: () => false }); await f.watcher.poll();
    const row = f.store.listNotifications()[0]!;
    let finish!: () => void; let current = true;
    const capture = f.options.captureTrigger(new AbortController().signal)!;
    f.options.captureTrigger = () => ({ ...capture, assertCurrent() { if (!current && kind === 'capture') throw new Error('Trigger changed'); } });
    f.options.allowedRepos = () => !current && kind === 'scope' ? [] : ['org/repo'];
    f.options.observeOwnership = async (proposal, trigger) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { ...ownership(proposal, trigger, 'own'), assertCurrent() { if (!current && kind === 'source') throw new Error('Credential changed'); } };
    };
    f.scan.mockRejectedValue(new Error('No new scan available'));
    const pending = f.watcher.poll(); await vi.waitFor(() => expect(finish).toBeDefined()); current = false; finish();
    await pending;
    expect(f.store.getNotification(row.id)).toMatchObject({ status: 'queued', policy: null });
    expect(f.launch).not.toHaveBeenCalled();
  });

  it('cannot apply an observation to a queue row whose original run identity changed during the read', async () => {
    const f = setup({ canLaunch: () => false }); await f.watcher.poll();
    const row = f.store.listNotifications()[0]!;
    f.options.observeOwnership = async (proposal, trigger) => {
      f.store.setNotificationRunId(row.id, 'replacement-run');
      return ownership(proposal, trigger, 'own');
    };
    f.scan.mockRejectedValue(new Error('No new scan available'));
    await f.watcher.poll();
    expect(f.store.getNotification(row.id)).toMatchObject({ status: 'queued', runId: 'replacement-run', policy: null });
    expect(f.launch).not.toHaveBeenCalled();
  });

});
