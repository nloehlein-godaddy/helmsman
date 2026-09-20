// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PrStatus } from '../github';
import { openPersistence, persistenceHash, type Persistence } from './persistence';
import { openExecutionStore } from './execution-store';
import { openOperationStore } from './operations';
import { openSlackReviewRequester, SlackReviewError } from './slack/review-request';
import { createLegacySlackEffects, type LegacySlackTarget } from './legacy-slack-effects';

const roots: string[] = [];
const connections = new Set<Persistence>();
afterEach(() => { for (const connection of connections) connection.close(); connections.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const artifact = { pluginId: 'helmsman.legacy-runtime', artifactHash: 'a'.repeat(64), packageVersion: '1', requires: [] };
const input = { repo: 'org/a', prNumber: 42, requestId: 'b3d6f43c-108c-4d3a-a760-c55a99e4c941' };
const second = { ...input, requestId: 'b3d6f43c-108c-4d3a-a760-c55a99e4c942' };
const receipt = { channel: 'reviews', mention: 'team', permalink: 'https://example.slack.com/archives/C123/p123456' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'legacy-slack-')); roots.push(root);
  const path = join(root, 'state.sqlite');
  let target: LegacySlackTarget = { enabled: true, workspace: 'T123', channel: 'reviews', mention: 'team', connectionId: persistenceHash({ workspace: 'T123', surface: 'surface:1' }) };
  function open() {
    const persistence = openPersistence(path); connections.add(persistence);
    const executions = openExecutionStore(persistence); const operations = openOperationStore(persistence, executions);
    const send = vi.fn(async () => receipt);
    const getPr = vi.fn(async () => ({ isOwnPr: true, state: 'open', merged: false }) as PrStatus);
    const requester = openSlackReviewRequester(persistence.sql, { settings: () => target, send, getPr });
    const verifyArtifacts = vi.fn(async () => {}); const assertAdmission = vi.fn();
    const effects = createLegacySlackEffects({ persistence, operations, artifact, requester, currentTarget: () => target, verifyArtifacts, assertAdmission });
    return { persistence, executions, operations, requester, effects, send, getPr, verifyArtifacts, assertAdmission,
      close() { requester.close(); persistence.close(); connections.delete(persistence); } };
  }
  return { open, target: () => target, configure: (value: Partial<LegacySlackTarget>) => { target = { ...target, ...value }; } };
}

it('persists the immutable operation and exact browser connection before sending, then settles one receipt', async () => {
  const f = fixture(); const state = f.open();
  state.send.mockImplementation(async () => {
    expect(state.operations.list()).toMatchObject([{ kind: 'slack.review-request', status: 'leased', origin: { kind: 'slack-request', runId: null, attempt: null },
      target: { ...input, workspace: 'T123', channel: 'reviews', mention: 'team' }, binding: { connectionId: f.target().connectionId } }]);
    expect(state.requester.receipt(input.requestId)).toMatchObject({ status: 'pending', workspaceTarget: 'T123', connectionTarget: f.target().connectionId });
    expect(state.executions.pins()).toHaveLength(1);
    return receipt;
  });
  expect(await state.effects.request(input)).toEqual({ ok: true, ...receipt });
  expect(state.send).toHaveBeenCalledOnce(); expect(state.operations.list()[0]?.status).toBe('completed');
  expect(state.executions.pins()).toEqual([]);
  expect(await state.effects.request(input)).toEqual({ ok: true, ...receipt }); expect(state.send).toHaveBeenCalledOnce();
});

it('keeps one send path across duplicate clicks, cooldown IDs, and a database restart', async () => {
  const f = fixture(); const first = f.open();
  const promises = [first.effects.request(input), first.effects.request(input)]; expect(promises[0]).toBe(promises[1]);
  await Promise.all(promises); await first.effects.request(second);
  expect(first.send).toHaveBeenCalledOnce(); expect(first.operations.list()).toHaveLength(2);
  expect(first.requester.receipt(second.requestId)).toMatchObject({ status: 'sent', workspaceTarget: 'T123' }); first.close();
  const next = f.open(); expect(await next.effects.request(second)).toEqual({ ok: true, ...receipt }); expect(next.send).not.toHaveBeenCalled();
});

it('preserves uncertain browser delivery across restart and reconciles a late receipt while disabled without another send', async () => {
  const f = fixture(); const first = f.open(); first.send.mockRejectedValueOnce(new Error('browser response lost'));
  await expect(first.effects.request(input)).rejects.toMatchObject({ uncertain: true });
  const id = first.operations.list()[0]!.id;
  expect(first.operations.get(id)?.status).toBe('uncertain'); expect(first.executions.pins()).toHaveLength(1); first.close();
  const next = f.open(); await next.effects.drainPending();
  expect(next.operations.get(id)?.status).toBe('uncertain'); expect(next.send).not.toHaveBeenCalled();
  await expect(next.effects.request(input)).rejects.toMatchObject({ uncertain: true }); expect(next.send).not.toHaveBeenCalled();
  f.configure({ enabled: false });
  next.persistence.sql.prepare("UPDATE slack_review_requests SET status='sent',channel=?,mention=?,permalink=? WHERE requestId=?").run(receipt.channel, receipt.mention, receipt.permalink, input.requestId);
  await next.effects.drainPending(); expect(next.operations.get(id)?.status).toBe('completed'); expect(next.executions.pins()).toEqual([]);
  expect(next.send).not.toHaveBeenCalled();
  await expect(next.effects.request(second)).rejects.toMatchObject({ status: 409 }); expect(next.operations.list()).toHaveLength(1);
});

it('keeps actionable definite failures and permits explicit retry after correction', async () => {
  const f = fixture(); const state = f.open();
  state.send.mockRejectedValueOnce(new SlackReviewError('Open Slack and sign in.', 503));
  await expect(state.effects.request(input)).rejects.toMatchObject({ status: 503, uncertain: false, message: 'Open Slack and sign in.' });
  expect(state.operations.list()[0]?.status).toBe('blocked'); await state.effects.drainPending(); expect(state.send).toHaveBeenCalledOnce();
  expect(await state.effects.request(input)).toEqual({ ok: true, ...receipt }); expect(state.send).toHaveBeenCalledTimes(2);
  expect(state.operations.attempts(state.operations.list()[0]!.id).map(item => item.kind)).toContain('operator-retry');
});

it('rechecks workspace, browser connection, and enablement after the PR lookup before browser effects', async () => {
  const f = fixture(); const state = f.open(); const original = f.target();
  state.getPr.mockImplementationOnce(async () => { f.configure({ workspace: 'T999', connectionId: persistenceHash({ workspace: 'T999' }) }); return { isOwnPr: true, state: 'open', merged: false } as PrStatus; });
  await expect(state.effects.request(input)).rejects.toMatchObject({ status: 409, uncertain: false });
  expect(state.send).not.toHaveBeenCalled(); expect(state.requester.receipt(input.requestId)?.status).toBe('failed');
  await expect(state.effects.request(input)).rejects.toMatchObject({ status: 409 });
  f.configure(original); expect(await state.effects.request(input)).toMatchObject({ ok: true }); expect(state.send).toHaveBeenCalledOnce();
});

it('does not infer workspace ownership for legacy receipts or automatically send during recovery', async () => {
  const f = fixture(); const state = f.open();
  await state.requester.request(input); expect(state.requester.receipt(input.requestId)?.workspaceTarget).toBeNull();
  await expect(state.effects.request(input)).rejects.toMatchObject({ uncertain: true });
  await state.effects.drainPending(); expect(state.send).toHaveBeenCalledOnce();
  expect(state.operations.list()[0]?.status).toBe('uncertain'); expect(state.executions.pins()).toHaveLength(1);
});

it('retains requests blocked before provider resolution and never sends them during background reconciliation', async () => {
  const f = fixture(); const state = f.open();
  state.verifyArtifacts.mockRejectedValueOnce(new Error('not installed'));
  await expect(state.effects.request(input)).rejects.toThrow('not installed'); expect(state.operations.list()).toEqual([]);
  state.verifyArtifacts.mockImplementation(async () => {
    if (state.operations.list().length) throw new Error('provider unavailable');
  });
  await expect(state.effects.request(input)).rejects.toMatchObject({ status: 409 });
  expect(state.operations.list()).toHaveLength(1); expect(state.requester.receipt(input.requestId)).toBeNull();
  state.verifyArtifacts.mockResolvedValue(undefined);
  await state.effects.drainPending(); expect(state.send).not.toHaveBeenCalled(); expect(state.operations.list()[0]?.status).toBe('uncertain');
});

it('rolls back rejected admission without invoking the requester or retaining operation pins', async () => {
  const f = fixture(); const state = f.open(); state.assertAdmission.mockImplementation(() => { throw new Error('disabled provider'); });
  await expect(state.effects.request(input)).rejects.toThrow('disabled provider');
  expect(state.operations.list()).toEqual([]); expect(state.executions.pins()).toEqual([]); expect(state.requester.receipt(input.requestId)).toBeNull();
  expect(state.send).not.toHaveBeenCalled();
});
