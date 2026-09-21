// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTriggerMetadataV1, type CampaignTriggerInputV1, type CampaignTriggerProviderV1, type CommunicationReviewTriggerContextV1, type CommunicationReviewTriggerProviderV1, type PullRequestReviewTriggerProviderV1, type ReviewTriggerInputV1, type WebhookTriggerProviderV1 } from '../../src/plugins/trigger';
import { parsePluginPackage } from '../../src/plugins/package';
import { boundedTriggerProvider, createTriggerProviderRegistry } from './trigger-providers';
import { assertTriggerSelectionCurrent, DEFAULT_TRIGGER_PROVIDERS, resolveTriggerSelection } from './trigger-selection';
import { captureTriggerProvenanceV1, parseTriggerProvenanceV1, triggerDependencyPins, triggerPinOwner } from './trigger-provenance';
import { installPluginArtifact } from './plugins/artifacts';
import { activateBackendPlugins, type BackendRuntime } from './plugins/backend';
import { clearPluginSettings, initializeTriggerProviderSelection, initializeTriggerSettings, readTriggerProviderSelection, readPluginSettings, selectTriggerProvider, triggerProviderSelectionInitialized, writePluginSettings } from './plugins/data';
import { pluginCommand } from './plugins/cli';

const metadata = { version: 1 as const, label: 'Campaign', kind: 'campaign' as const, intervalMs: 5000 };
const provider: CampaignTriggerProviderV1 = { metadata, select: input => input.candidates[0] ? { candidateId: input.candidates[0].candidateId } : null };
const campaign: CampaignTriggerInputV1 = { version: 1, candidates: [{ candidateId: 'observed', repo: 'owner/repo', campaignId: 'campaign', phaseId: 'phase', taskId: 'task', attempt: 1, workflowRef: 'coding@1', title: 'Task', mode: 'freeform', createdAt: '2026-09-21T00:00:00Z' }], truncated: false };
const reviewInput: ReviewTriggerInputV1 = { version: 1, activatedAt: '2026-09-21T00:00:00Z', cursor: null, defaultWorkflowRef: 'review@1' };
const target = { targetId: 'target', repo: 'owner/repo', number: 1, headSha: 'a'.repeat(40), title: 'PR', url: 'https://github.com/owner/repo/pull/1', status: 'open' as const, draft: false };
const event = { eventId: 'event', channelId: 'channel', ts: '1790000000.000001', permalink: 'https://example.com/message', author: 'Author', prUrls: [target.url] };
const proposal = { eventId: event.eventId, targetId: target.targetId, workflowRef: 'review@1', sourceUrl: event.permalink, author: event.author, channelName: 'Review' };
const context = (): CommunicationReviewTriggerContextV1 => ({ source: 'communication', signal: new AbortController().signal, async messages() { return { items: [event], complete: true }; }, async detail() { return target; } });
const watch: CommunicationReviewTriggerProviderV1 = { metadata: { version: 1, label: 'Review', kind: 'review-watch', source: 'communication', intervalMs: 300000 }, async scan(input, context) {
  await context.messages({ since: input.cursor }); await context.detail({ repo: target.repo, number: target.number }); return { proposals: [proposal], nextCursor: event.ts, complete: true };
} };
const webhook: WebhookTriggerProviderV1 = { metadata: { version: 1, label: 'Webhook', kind: 'webhook', ingress: { signatureHeader: 'x-signature', eventHeader: 'x-event', deliveryHeader: 'x-delivery', algorithm: 'hmac-sha256', signaturePrefix: 'sha256=' } }, parse: () => ({ workflowRef: 'coding@1', intent: { mode: 'freeform', repo: 'owner/repo', title: 'Issue', task: 'Implement' } }) };
function descriptor(id = 'example.trigger', access = 'campaign-candidates') {
  return { packageVersion: 1, manifest: { manifestVersion: 1, id, version: '1.0.0', sdkVersion: 1, pages: [] }, entries: {}, node: { minMajor: 22, maxMajorExclusive: 30 },
    backend: { entry: 'backend.js', provides: [{ id: 'helmsman/trigger', version: 1, localId: 'policy' }], triggers: { policy: { access: [access] } }, storageVersion: 1,
      settings: { enabled: { type: 'boolean', default: true }, intervalMs: { type: 'number', default: 5000, minimum: 1000, maximum: 3600000 } } } };
}
const roots: string[] = []; const runtimes: BackendRuntime[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(runtimes.splice(0).map(value => value.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-triggers-')); roots.push(root); return root; }
function registration(registry = createTriggerProviderRegistry({ eligible: () => true })) {
  const pkg = parsePluginPackage(descriptor()); const result = registry.stage({ binding: { providerId: 'example.trigger/policy', pluginId: 'example.trigger', artifactHash: 'a'.repeat(64), contractVersion: 1 }, provider, package: pkg, settings: { enabled: true, intervalMs: 5000 }, origin: 'external' }); registry.publish([result]); return { registry, result, pkg };
}
it('requires complete metadata and matching trigger-only access declarations', () => {
  const pkg = descriptor(); expect(() => parsePluginPackage({ ...pkg, backend: { ...pkg.backend, provides: [...pkg.backend.provides, { id: 'helmsman/pricing', version: 1, localId: 'price' }] } })).toThrow('trigger-only');
  for (const invalid of [{ ...metadata, intervalMs: 999 }, { ...metadata, source: 'communication' }, { ...watch.metadata, source: 'unknown' }, { ...webhook.metadata, ingress: { ...webhook.metadata.ingress, algorithm: 'none' } }, { ...webhook.metadata, ingress: { ...webhook.metadata.ingress, signatureHeader: 'bad\nheader' } }, { ...webhook.metadata, ingress: { ...webhook.metadata.ingress, deliveryHeader: 'x-event' } }]) expect(() => parseTriggerMetadataV1(invalid)).toThrow();
  const registry = createTriggerProviderRegistry({ eligible: () => true }); expect(() => registry.stage({ binding: { providerId: 'example.trigger/policy', pluginId: 'example.trigger', artifactHash: 'a'.repeat(64), contractVersion: 1 }, provider, package: parsePluginPackage(descriptor('example.trigger', 'review-discovery')), settings: {}, origin: 'external' })).toThrow('kind');
});
it('accepts only observed immutable campaign candidates and rejects invalid inputs before authored code', () => {
  const select = vi.fn((input: CampaignTriggerInputV1) => { expect(Object.isFrozen(input.candidates[0])).toBe(true); return { candidateId: 'observed' }; }); const bounded = boundedTriggerProvider({ ...provider, select }) as CampaignTriggerProviderV1;
  expect(bounded.select(campaign)).toEqual({ candidateId: 'observed' }); select.mockClear();
  for (const input of [null, { ...campaign, candidates: [null] }, { ...campaign, candidates: [...campaign.candidates, ...campaign.candidates] }, { ...campaign, candidates: [{ ...campaign.candidates[0], claimToken: 'private' }] }]) expect(() => bounded.select(input as never)).toThrow(); expect(select).not.toHaveBeenCalled();
  expect(() => (boundedTriggerProvider({ ...provider, select: () => ({ candidateId: 'forged' }) }) as CampaignTriggerProviderV1).select(campaign)).toThrow('unobserved');
});
it('restricts webhook input and normalized intent while preserving ignored events', () => {
  const input = { version: 1 as const, deliveryId: 'delivery', event: 'issues', body: { action: 'opened' } };
  expect((boundedTriggerProvider(webhook) as WebhookTriggerProviderV1).parse(input)?.intent.mode).toBe('freeform');
  expect((boundedTriggerProvider({ ...webhook, parse: () => null }) as WebhookTriggerProviderV1).parse(input)).toBeNull();
  const parse = vi.fn(webhook.parse); const bounded = boundedTriggerProvider({ ...webhook, parse }) as WebhookTriggerProviderV1;
  for (const value of [{ ...input, secret: 'private' }, { ...input, deliveryId: 'bad/delivery' }, { ...input, body: { invalid: undefined } }]) expect(() => bounded.parse(value as never)).toThrow(); expect(parse).not.toHaveBeenCalled();
  expect(() => (boundedTriggerProvider({ ...webhook, parse: () => ({ workflowRef: 'coding@1', intent: { mode: 'freeform', repo: 'owner/repo', title: 'x', task: 'x', runId: 'forged' } }) as never }) as WebhookTriggerProviderV1).parse(input)).toThrow();
});
it('provides only source-scoped discovery with frozen observed results and expires its context', async () => {
  let captured: CommunicationReviewTriggerContextV1 | undefined; let signal: AbortSignal | undefined;
  const bounded = boundedTriggerProvider({ ...watch, async scan(input: ReviewTriggerInputV1, ctx: CommunicationReviewTriggerContextV1) { captured = ctx; expect(Object.keys(ctx).sort()).toEqual(['detail', 'messages', 'signal', 'source']); const batch = await ctx.messages({ since: input.cursor }); expect(Object.isFrozen(batch.items[0])).toBe(true); await ctx.detail({ repo: target.repo, number: 1 }); return { proposals: [proposal], complete: true, nextCursor: event.ts }; } }) as CommunicationReviewTriggerProviderV1;
  await expect(bounded.scan(reviewInput, { ...context(), async messages(_input, request) { signal = request; return { items: [event], complete: true }; } })).resolves.toMatchObject({ complete: true });
  expect(signal?.aborted).toBe(true); await expect(captured!.detail({ repo: target.repo, number: 1 })).rejects.toThrow();
});
it('requires requested list membership, matching detail identity and honest completeness', async () => {
  const requested: PullRequestReviewTriggerProviderV1 = { metadata: { ...watch.metadata, source: 'pull-request' }, async scan(_input, ctx) { await ctx.requested(); await ctx.detail({ repo: target.repo, number: 1 }); return { proposals: [{ ...proposal, eventId: null }], complete: true, nextCursor: null }; } };
  const ctx = { source: 'pull-request' as const, signal: new AbortController().signal, async requested() { return { items: [{ repo: target.repo, number: 1 }], quality: 'complete' as const, truncated: false }; }, async detail() { return target; } };
  await expect((boundedTriggerProvider(requested) as PullRequestReviewTriggerProviderV1).scan(reviewInput, ctx)).resolves.toMatchObject({ complete: true });
  await expect((boundedTriggerProvider(requested) as PullRequestReviewTriggerProviderV1).scan(reviewInput, { ...ctx, async requested() { return { items: [], quality: 'complete', truncated: false }; } })).rejects.toThrow('unobserved');
  await expect((boundedTriggerProvider(requested) as PullRequestReviewTriggerProviderV1).scan(reviewInput, { ...ctx, async detail() { return { ...target, number: 2 }; } })).rejects.toThrow('changed its target');
  await expect((boundedTriggerProvider(watch) as CommunicationReviewTriggerProviderV1).scan(reviewInput, { ...context(), async messages() { return { items: [event], complete: false }; } })).rejects.toThrow('complete evidence');
  const noReads = boundedTriggerProvider({ ...watch, async scan() { return { proposals: [], complete: true, nextCursor: null }; } }) as CommunicationReviewTriggerProviderV1;
  await expect(noReads.scan(reviewInput, context())).rejects.toThrow('complete evidence');
});
it('rejects forged review handles and source methods without dispatch', async () => {
  for (const result of [{ proposals: [{ ...proposal, targetId: 'invented' }], complete: true, nextCursor: event.ts }, { proposals: [{ ...proposal, eventId: 'invented' }], complete: true, nextCursor: event.ts }]) {
    const bounded = boundedTriggerProvider({ ...watch, async scan(input: ReviewTriggerInputV1, ctx: CommunicationReviewTriggerContextV1) { await watch.scan(input, ctx); return result; } }) as CommunicationReviewTriggerProviderV1;
    await expect(bounded.scan(reviewInput, context())).rejects.toThrow('unobserved');
  }
  await expect((boundedTriggerProvider(watch) as CommunicationReviewTriggerProviderV1).scan(reviewInput, { ...context(), async detail() { return { ...target, draft: true }; } })).rejects.toThrow('ineligible');
  await expect((boundedTriggerProvider(watch) as CommunicationReviewTriggerProviderV1).scan(reviewInput, { ...context(), source: 'pull-request' } as never)).rejects.toThrow('source');
});
it('bounds review scans and forwards cancellation to outstanding discovery', async () => {
  vi.useFakeTimers(); let signal: AbortSignal | undefined; const activation = new AbortController();
  const bounded = boundedTriggerProvider(watch, activation.signal) as CommunicationReviewTriggerProviderV1;
  const ctx = { ...context(), async messages(_input: { since: string | null }, request?: AbortSignal) { signal = request; return new Promise<never>(() => {}); } };
  const timed = expect(bounded.scan(reviewInput, ctx)).rejects.toThrow('timed out'); await vi.advanceTimersByTimeAsync(30000); await timed; expect(signal?.aborted).toBe(true);
  const cancelled = expect(bounded.scan(reviewInput, ctx)).rejects.toThrow(); await vi.advanceTimersByTimeAsync(0); activation.abort(); await cancelled; expect(signal?.aborted).toBe(true);
  await expect(bounded.scan(reviewInput, context())).rejects.toThrow();
});
it('activates restricted trigger modules with captured settings and rejects settings drift', async () => {
  const root = await temporary(); const source = `export default { activate(context) {
    if(Object.keys(context).sort().join(',')!=='onDispose,pluginId,registerTrigger,settings,signal')throw Error('Unexpected services');
    context.registerTrigger('policy',{metadata:{...${JSON.stringify(metadata)},intervalMs:context.settings.intervalMs},select(input){return input.candidates[0]?{candidateId:input.candidates[0].candidateId}:null;}});
  }};`;
  const archive = await installPluginArtifact(root, Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1, package: descriptor(), files: [{ path: 'backend.js', base64: Buffer.from(source).toString('base64') }] })));
  writePluginSettings(root, archive.package, { intervalMs: 6000 });
  const runtime = await activateBackendPlugins({ root, snapshot: { catalog: { version: 1, safeMode: false, plugins: [], bindings: {} }, errors: [], artifacts: new Map([['example.trigger', archive]]) }, usage: { async query() { throw new Error('Unavailable'); } } }); runtimes.push(runtime);
  expect(runtime.errors).toEqual([]); const record = runtime.triggers.list()[0]!; expect(record.record.settings.intervalMs).toBe(6000);
  writePluginSettings(root, archive.package, { intervalMs: 7000 }); expect(runtime.triggers.list()).toEqual([]); expect(runtime.triggers.resolve(record.record.binding, 'obligation')).toBe(record);
});
it('distinguishes explicit disabled from default and fences independent role revisions', async () => {
  const root = await temporary(); const { registry, result } = registration();
  expect(readTriggerProviderSelection(root, 'campaign').providerId).toBe('default');
  await pluginCommand(['--dir', root, 'select-trigger', 'campaign', result.record.binding.providerId], { coordinate: false }); const selected = resolveTriggerSelection({ root, registry, kind: 'campaign' });
  selectTriggerProvider(root, 'github-review', null); expect(() => assertTriggerSelectionCurrent({ root, registry }, selected)).not.toThrow();
  await pluginCommand(['--dir', root, 'select-trigger', 'campaign', 'disabled'], { coordinate: false }); expect(resolveTriggerSelection({ root, registry, kind: 'campaign' }).record).toBeNull(); expect(() => assertTriggerSelectionCurrent({ root, registry }, selected)).toThrow('changed');
  await pluginCommand(['--dir', root, 'select-trigger', 'campaign', 'default'], { coordinate: false }); expect(readTriggerProviderSelection(root, 'campaign').providerId).toBe('default'); expect(() => resolveTriggerSelection({ root, registry, kind: 'campaign' })).toThrow('unavailable');
  selectTriggerProvider(root, 'github-webhook', result.record.binding.providerId); expect(() => resolveTriggerSelection({ root, registry, kind: 'github-webhook' })).toThrow('role');
  expect(DEFAULT_TRIGGER_PROVIDERS['slack-review']).toBe('helmsman.trigger-slack-review/watch');
});
it('bootstraps selections/settings once while preserving disabled choices and later resets', async () => {
  const root = await temporary(); const pkg = parsePluginPackage(descriptor()); expect(triggerProviderSelectionInitialized(root, 'campaign')).toBe(false);
  expect(() => initializeTriggerProviderSelection(root, 'campaign', 'bad')).toThrow(); expect(triggerProviderSelectionInitialized(root, 'campaign')).toBe(false);
  selectTriggerProvider(root, 'campaign', null); initializeTriggerProviderSelection(root, 'campaign', 'bad stale'); expect(readTriggerProviderSelection(root, 'campaign').providerId).toBeNull();
  writePluginSettings(root, pkg, { intervalMs: 9000 }); initializeTriggerSettings(root, pkg, { intervalMs: 5000 }); expect(readPluginSettings(root, pkg).intervalMs).toBe(9000);
  clearPluginSettings(root, pkg.manifest.id); expect(() => initializeTriggerSettings(root, pkg, { intervalMs: 'bad stale' })).not.toThrow(); expect(readPluginSettings(root, pkg).intervalMs).toBe(5000);
});
it('captures immutable queue provenance and dependency pins without creating execution admissions', () => {
  const { result } = registration(); const artifact = { pluginId: result.record.binding.pluginId, artifactHash: result.record.binding.artifactHash, packageVersion: '1.0.0', requires: [] };
  const provenance = captureTriggerProvenanceV1({ instanceId: 'campaign', selectionRevision: 'initial', provider: result.record, artifacts: [artifact], source: { sourceKey: 'campaign', revision: 'observed', bindings: [] }, input: campaign, proposal: { candidateId: 'observed' }, capturedAt: '2026-09-21T00:00:00Z' });
  expect(Object.isFrozen(provenance.source.bindings)).toBe(true); expect(provenance.inputHash).toMatch(/^[a-f\d]{64}$/);
  expect(triggerDependencyPins(provenance, 'campaign', 'ct-task')).toEqual([{ kind: 'dependency', ownerId: 'trigger:campaign:ct-task', pluginId: artifact.pluginId, artifactHash: artifact.artifactHash }]);
  expect(() => triggerPinOwner('review', '../escape')).toThrow();
  for (const invalid of [{ ...provenance, proposalHash: '' }, { ...provenance, artifacts: [{ ...artifact, requires: ['example.missing'] }] }, { ...provenance, artifacts: [{ ...artifact, requires: [artifact.pluginId] }] }, { ...provenance, artifacts: [{ ...artifact, artifactHash: 'b'.repeat(64) }] }, { ...provenance, source: { ...provenance.source, bindings: [{ role: 'effect', capability: 'helmsman/pull-request', contributionId: 'example.other/provider', pluginId: 'example.other', artifactHash: 'b'.repeat(64), contractVersion: 1, connectionId: null, credentialHandle: null }] } }]) expect(() => parseTriggerProvenanceV1(invalid)).toThrow();
});
it('captures source settings and fences PR/communication admission after configuration changes', async () => {
  const root = await temporary();
  for (const kind of ['pull-request', 'communication'] as const) {
    const id = `example.${kind}`; const field = kind === 'pull-request' ? 'pullRequests' : 'communications';
    const declaration = kind === 'pull-request' ? { access: ['core-http'] } : { access: ['browser-session'] };
    const methods = kind === 'pull-request' ? 'async list(){return {};},async detail(){return {};},async diff(){return {};},async prepareReview(){return {};},async invokeReview(){return {};},async reconcileReview(){return {};}' : 'async prepareReviewRequest(){return {};},async invokeReviewRequest(){return {};},async reconcileReviewRequest(){return {};},async scanReviewRequests(){return {};}';
    const pkg = descriptor(id); const backend = { entry: 'backend.js', provides: [{ id: `helmsman/${kind}`, version: 1, localId: 'source' }], [field]: { source: declaration }, storageVersion: 1, settings: pkg.backend.settings };
    const source = `export default {activate(context){context.${kind === 'pull-request' ? 'registerPullRequest' : 'registerCommunication'}('source',{${methods}});}}`;
    const archive = await installPluginArtifact(root, Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1, package: { ...pkg, backend }, files: [{ path: 'backend.js', base64: Buffer.from(source).toString('base64') }] })));
    writePluginSettings(root, archive.package, { intervalMs: 6000 });
    const runtime = await activateBackendPlugins({ root, snapshot: { catalog: { version: 1, safeMode: false, plugins: [], bindings: {} }, errors: [], artifacts: new Map([[id, archive]]) }, usage: { async query() { throw new Error('Unavailable'); } } }); runtimes.push(runtime);
    expect(runtime.errors).toEqual([]); const registry = kind === 'pull-request' ? runtime.pullRequests : runtime.communications; const registered = registry.list()[0]!; expect(registered.settings?.intervalMs).toBe(6000); expect(Object.isFrozen(registered.settings)).toBe(true);
    writePluginSettings(root, archive.package, { intervalMs: 7000 }); expect(registry.list()).toEqual([]); expect(registry.resolve(registered.binding, 'obligation')).toBe(registered); expect(() => registry.resolve(registered.binding, 'admission')).toThrow();
  }
});
