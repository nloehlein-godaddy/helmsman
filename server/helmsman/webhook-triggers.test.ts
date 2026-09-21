import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { openPersistence, type Persistence } from './persistence';
import { openExecutionStore } from './execution-store';
import { openAdmissionStore } from './admission-store';
import { openWebhookIntake, type WebhookLaunch } from './webhooks';
import type { SelectedTriggerCapture } from './trigger-runtime';
import type { WebhookTriggerProviderV1 } from '../../src/plugins/trigger';

const opened: Persistence[] = [];
afterEach(() => { for (const item of opened.splice(0)) item.close(); });
const raw = Buffer.from('{"kind":"task"}');
function headers(body = raw, delivery = 'delivery-1') { return { delivery, event: 'issues', signature: `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}` }; }
function fixture() {
  const persistence = openPersistence(':memory:'); opened.push(persistence);
  const executions = openExecutionStore(persistence); const admissions = openAdmissionStore(persistence, executions);
  let enabled = true; let allow = true; let current = true; let generation = 'original'; let ignored = false;
  const artifact = { pluginId: 'example.webhook', artifactHash: 'a'.repeat(64), packageVersion: '1.0.0', requires: [] };
  const parse = vi.fn<WebhookTriggerProviderV1['parse']>(() => ignored ? null : { workflowRef: 'coding@1', intent: { mode: 'freeform', repo: 'o/r', title: generation, task: generation } });
  const provider: WebhookTriggerProviderV1 = { metadata: { version: 1, kind: 'webhook', label: 'Independent webhook',
    ingress: { signatureHeader: 'x-signature', deliveryHeader: 'x-delivery', eventHeader: 'x-event', algorithm: 'hmac-sha256', signaturePrefix: 'sha256=' } }, parse };
  function capture(): SelectedTriggerCapture<WebhookTriggerProviderV1> | null {
    if (!enabled) return null;
    return { instanceId: 'github-webhook', selectionRevision: generation, provider,
      record: { version: 1, origin: 'external', binding: { providerId: 'example.webhook/parse', pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, contractVersion: 1 },
        settings: { marker: generation }, metadata: provider.metadata }, artifacts: [artifact], assertCurrent() { if (!enabled || !current) throw new Error('Selection changed'); } };
  }
  const launch = vi.fn((input: WebhookLaunch) => { admissions.admit({ runId: input.runId, repo: input.repo,
    request: { trigger: JSON.parse(JSON.stringify(input.trigger)) }, settings: {}, artifacts: input.trigger?.artifacts ?? [] }, 2); return input.runId; });
  const verifyLaunch = vi.fn(async () => {});
  const deps = { secret: () => 'secret', captureTrigger: capture, allowedRepos: () => ['o/r'], canStart: () => allow,
    getRun: (id: string) => { const admission = admissions.get(id); return admission ? { status: admission.state === 'failed' ? 'failed' : 'running' } : null; }, isRunActive: () => false, launch, verifyLaunch,
    retainPins: executions.retainPins, releaseTriggerPins: executions.releaseTriggerPins };
  const open = () => openWebhookIntake(persistence.sql, deps);
  return { persistence, executions, admissions, open, intake: open(), parse, launch, verifyLaunch,
    enable(value: boolean) { enabled = value; }, allow(value: boolean) { allow = value; }, change() { current = false; },
    replace(value: string) { generation = value; }, ignore(value: boolean) { ignored = value; } };
}

describe('authored webhook trigger durability', () => {
  it('authenticates duplicate deliveries before returning their retained result', () => {
    const f = fixture(); f.intake.receive(raw, headers());
    expect(() => f.intake.receive(raw, { ...headers(), signature: undefined })).toThrow('signature');
    expect(() => f.intake.receive(Buffer.from('{}'), headers(Buffer.from('{}')))).toThrow('different payload');
    expect(f.parse).toHaveBeenCalledOnce();
  });
  it('dedupes ignored deliveries across replacement and releases only their settled pins', () => {
    const f = fixture(); f.ignore(true); expect(f.intake.receive(raw, headers())).toMatchObject({ ignored: true, runId: null });
    expect(f.executions.pins()).toEqual([]); f.ignore(false); f.replace('replacement');
    expect(f.open().receive(raw, headers())).toMatchObject({ ignored: true, duplicate: true, runId: null });
    expect(f.parse).toHaveBeenCalledOnce(); expect(f.launch).not.toHaveBeenCalled();
  });
  it('retains the original normalized launch across disable/restart/replacement without reparsing', async () => {
    const f = fixture(); f.allow(false); const received = f.intake.receive(raw, headers());
    expect(f.executions.pins()).toMatchObject([{ kind: 'dependency', ownerId: 'trigger:webhook:delivery-1' }]);
    f.enable(false); f.allow(true); await f.open().poll(); expect(f.launch).not.toHaveBeenCalled();
    f.enable(true); f.replace('replacement'); await f.open().poll();
    expect(f.launch).toHaveBeenCalledOnce(); expect(f.launch.mock.calls[0]?.[0]).toMatchObject({ title: 'original', task: 'original', trigger: { provider: { settings: { marker: 'original' } } } });
    expect(f.parse).toHaveBeenCalledOnce(); expect(f.admissions.get(received.runId!)?.state).toBe('pending');
    expect(f.executions.pins().some(pin => pin.kind === 'dependency')).toBe(true);
    f.admissions.fail(received.runId!, 'preflight stopped'); await f.open().poll();
    expect(f.executions.pins()).toEqual([]); expect(f.launch).toHaveBeenCalledOnce();
  });
  it('rejects a changed parser selection during async dispatch verification', async () => {
    const f = fixture(); f.intake.receive(raw, headers());
    f.verifyLaunch.mockImplementation(async () => { f.change(); }); await f.intake.poll();
    expect(f.launch).not.toHaveBeenCalled(); expect(f.executions.pins()).toHaveLength(1);
  });
  it('rolls enqueue back when artifact pin retention fails', () => {
    const f = fixture(); f.executions.retainPins([{ kind: 'dependency', ownerId: 'trigger:webhook:delivery-1', pluginId: 'example.webhook', artifactHash: 'b'.repeat(64) }]);
    expect(() => f.intake.receive(raw, headers())).toThrow('two versions'); expect(f.intake.status()).toEqual([]);
  });
  it('uses declared ingress headers without exposing them to the parser', () => {
    const f = fixture(); const signed = headers(); f.intake.receive(raw, { values: { 'x-signature': signed.signature, 'x-delivery': signed.delivery, 'x-event': signed.event } });
    expect(f.parse.mock.calls[0]?.[0]).toEqual({ version: 1, deliveryId: signed.delivery, event: signed.event, body: { kind: 'task' } });
  });
});
