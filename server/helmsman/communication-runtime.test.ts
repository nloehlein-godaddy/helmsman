import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommunicationRuntime } from './communication-runtime';
import { bootstrapCommunicationProviderSelection, createCommunicationProviderRegistry } from './communication-providers';
import type { CommunicationProviderV1 } from '../../src/plugins/communication-provider';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'communication-runtime-')); roots.push(root);
  const env: Record<string, string | undefined> = { SLACK_ENABLED: 'true', SLACK_WATCH_ENABLED: 'true', SLACK_CLIENT_ID: 'T123', SLACK_CHANNEL_ID: 'C123', SLACK_CHANNEL_NAME: 'watched', SLACK_REVIEW_CHANNEL: 'C456', SLACK_REVIEW_MENTION: 'reviewers' };
  const scan = vi.fn<CommunicationProviderV1['scanReviewRequests']>(async () => ({ messages: [], complete: true }));
  const provider: CommunicationProviderV1 = { prepareReviewRequest: vi.fn(), invokeReviewRequest: vi.fn(), reconcileReviewRequest: vi.fn(), scanReviewRequests: scan };
  const registry = createCommunicationProviderRegistry({ eligible: () => true });
  const binding = { providerId: 'example.slack/slack', pluginId: 'example.slack', artifactHash: 'a'.repeat(64), contractVersion: 1 as const, connectionId: null, credentialHandle: null };
  registry.publish([registry.stage(binding, provider)]); bootstrapCommunicationProviderSelection(root, binding.providerId);
  const runtime = createCommunicationRuntime({ root, env: () => env, registry, operations: {} as never, artifacts: () => [], verifyArtifacts: async () => {} });
  return { env, runtime, scan };
}
it.each([undefined, '', 'surface:3'])('keeps notification scanner identity valid with optional browser surface %s', async surface => {
  const f = fixture(); f.env.SLACK_BROWSER_SURFACE = surface;
  const key = f.runtime.scanKey(); expect(JSON.parse(key).settings.surface).toBe(surface || null);
  await expect(f.runtime.scan({ since: null })).resolves.toEqual({ complete: true, messages: [] }); expect(f.scan).toHaveBeenCalledTimes(1);
  f.env.SLACK_WATCH_ENABLED = 'false'; expect(() => f.runtime.scanKey()).not.toThrow();
});
it('rejects scanner results when the browser surface changes during the read', async () => {
  const f = fixture(); let complete!: () => void; f.scan.mockImplementationOnce(async () => { await new Promise<void>(resolve => { complete = resolve; }); return { messages: [], complete: true }; });
  const result = f.runtime.scan({ since: null }); await vi.waitFor(() => expect(f.scan).toHaveBeenCalledOnce()); f.env.SLACK_BROWSER_SURFACE = 'surface:4'; complete(); await expect(result).rejects.toThrow('Communication scanner changed during read.');
});
