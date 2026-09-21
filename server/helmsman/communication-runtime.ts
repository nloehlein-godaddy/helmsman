import type { CommunicationDestinationV1, CommunicationProviderContextV1 } from '../../src/plugins/communication-provider';
import type { NativeTerminalRetainedProviderV1, NativeTerminalProviderRegistry } from './native-terminal-providers';
import { builtinFrontendManifests } from '../../src/plugins/frontend-manifests';
import { isContributionId } from '../../src/plugins/manifest';
import type { PluginCatalog } from '../../src/plugins/runtime';
import type { ArtifactBinding, ProviderBinding } from './execution-store';
import type { OperationStore } from './operations';
import { persistenceHash, stableJson } from './persistence';
import { createCommunicationBrowserSession } from './communication-browser';
import { createCommunicationProviderEffects, type CommunicationReviewBrowserTransportV1 } from './communication-provider-effects';
import { loadRetainedNativeTerminalProvider } from './native-terminal-retained-loader';
import { assertNativeTerminalSelectionCurrent, resolveNativeTerminalSelection } from './native-terminal-selection';
import { resolveSelectedCommunicationProvider, type CommunicationProviderRegistry } from './communication-providers';
import { slackSettings } from './slack/config';
import { slackReviewSettings } from './slack/review-request';
import { withSlackBrowserLock } from './slack/browser';

export function communicationContributionEnabled(catalog: PluginCatalog, caller: string, command = false): boolean {
  if (catalog.safeMode || !isContributionId(caller)) return false;
  const [pluginId, localId] = caller.split('/');
  const manifest = catalog.plugins.find(plugin => plugin.package.manifest.id === pluginId)?.package.manifest
    ?? builtinFrontendManifests.find(manifest => manifest.id === pluginId && catalog.builtins?.some(entry => entry.id === pluginId && entry.enabled && entry.version === manifest.version));
  const contribution = manifest?.pages.find(page => page.id === localId)
    ?? (manifest?.manifestVersion === 2 ? manifest.panels.find(panel => panel.id === localId) : undefined);
  return contribution?.requires?.some(requirement => requirement.id === (command ? 'helmsman/communication-command' : 'helmsman/communication') && requirement.version === 1) === true;
}

export function createCommunicationRuntime(options: {
  root: string; registry: CommunicationProviderRegistry; operations: OperationStore;
  nativeTerminals: NativeTerminalProviderRegistry; defaultBrowserProviderId: string;
  browserRuntime: { readonly pluginsRoot: string; readonly runtimeArtifactsRoot: string };
  env(): Record<string, string | undefined>;
  artifacts(binding: Pick<ProviderBinding, 'pluginId' | 'artifactHash'>): readonly ArtifactBinding[];
  verifyArtifacts(artifacts: readonly ArtifactBinding[]): Promise<void>;
  assertReviewable?(repo: string, number: number): Promise<void>;
}) {
  const browserSelectionOptions = { root: options.root, registry: options.nativeTerminals, defaultProviderId: options.defaultBrowserProviderId, kind: 'browser' as const };
  function browserSelection() {
    const resolved = resolveNativeTerminalSelection(browserSelectionOptions);
    const registration = options.nativeTerminals.resolve(resolved.record.binding);
    if (!registration.provider.browser || !registration.record.metadata.browser) throw new Error('Selected browser provider is unavailable.');
    assertNativeTerminalSelectionCurrent(browserSelectionOptions, resolved);
    return { resolved, browser: registration.provider.browser, sessionIdentity: () => registration.provider.sessionIdentity() };
  }
  function connectionFor(record: NativeTerminalRetainedProviderV1, settings = slackSettings(options.env())) {
    if (!/^[A-Z\d]{3,32}$/.test(settings.clientId)) return null;
    return { connectionId: persistenceHash({ workspace: settings.clientId, surface: settings.surface ?? null,
      browser: { binding: record.binding, settings: record.settings } }), credentialHandle: 'native-browser' };
  }
  function connection() {
    try { return connectionFor(browserSelection().resolved.record); }
    catch { return null; }
  }
  const selected = () => resolveSelectedCommunicationProvider({ root: options.root, registry: options.registry, connection });
  function scanIdentity(binding = selected(), settings = slackSettings(options.env()), browser = browserSelection().resolved) {
    const providerSettings = binding ? options.registry.resolve({ providerId: binding.contributionId, pluginId: binding.pluginId,
      artifactHash: binding.artifactHash, contractVersion: 1, connectionId: null, credentialHandle: null }, 'admission').settings ?? {} : null;
    return stableJson({ binding, providerSettings, settings: { ...settings, surface: settings.surface ?? null }, browser });
  }
  function destination(binding: ProviderBinding): CommunicationDestinationV1 | null {
    const env = options.env(); const browser = slackSettings(env); const review = slackReviewSettings(env);
    if (binding.connectionId !== connection()?.connectionId || binding.credentialHandle !== 'native-browser' || !review.enabled) return null;
    return Object.freeze({ providerId: binding.contributionId, artifactHash: binding.artifactHash,
      workspace: browser.clientId, channel: review.channel, mention: review.mention, connectionId: binding.connectionId });
  }
  function admissionSession(binding: ProviderBinding, target: CommunicationDestinationV1, signal: AbortSignal) {
    const settings = slackSettings(options.env()); const selectedBrowser = browserSelection();
    if (binding.connectionId !== connectionFor(selectedBrowser.resolved.record, settings)?.connectionId || target.workspace !== settings.clientId)
      throw new Error('Retained communication connection changed.');
    const artifacts = options.artifacts(selectedBrowser.resolved.record.binding);
    return { surface: settings.surface ?? null, watchedChannel: { id: settings.channelId, name: settings.channelName },
      browser: createCommunicationBrowserSession({ workspace: target.workspace, surface: settings.surface ?? null, signal, browser: selectedBrowser.browser, sessionIdentity: selectedBrowser.sessionIdentity }),
      browserTransport: { provider: selectedBrowser.resolved.record, artifacts, surface: settings.surface ?? null },
      assertCurrent: () => assertNativeTerminalSelectionCurrent(browserSelectionOptions, selectedBrowser.resolved) };
  }
  async function retainedSession(transport: CommunicationReviewBrowserTransportV1, target: CommunicationDestinationV1, signal: AbortSignal) {
    const loaded = await loadRetainedNativeTerminalProvider({ ...options.browserRuntime, record: transport.provider, artifacts: transport.artifacts, signal });
    const browser = loaded.provider.browser;
    if (!browser || !loaded.provider.metadata.browser) { await loaded.dispose(); throw new Error('Retained communication browser provider is unavailable.'); }
    const settings = slackSettings(options.env());
    return { surface: transport.surface, watchedChannel: { id: settings.channelId, name: settings.channelName },
      browser: createCommunicationBrowserSession({ workspace: target.workspace, surface: transport.surface, signal, browser,
        sessionIdentity: () => loaded.provider.sessionIdentity() }), dispose: loaded.dispose };
  }
  const assertAdmission = () => {
    const binding = selected();
    if (!binding || !destination(binding)) throw new Error('Selected communication provider is unavailable.');
  };
  const effects = createCommunicationProviderEffects({ registry: options.registry, selected, destination, admissionSession, retainedSession,
    artifacts: options.artifacts, verifyArtifacts: options.verifyArtifacts, assertAdmission, withSession: withSlackBrowserLock,
    async authorize(binding, operation, context) {
      const review = operation.target as { repo?: unknown; number?: unknown } | null;
      if (typeof review?.repo !== 'string' || typeof review.number !== 'number') return { allowed: false, reason: 'Invalid retained communication target.' };
      try { await options.assertReviewable?.(review.repo, review.number); }
      catch { return { allowed: false, reason: 'The retained review request is no longer eligible for delivery.' }; }
      const live = options.operations.get(operation.id);
      if (!live || live.contentHash !== operation.contentHash || live.generation !== context.generation || live.status !== 'leased'
        || !live.leaseExpiresAt || Date.parse(live.leaseExpiresAt) <= Date.now()) return { allowed: false, reason: 'Communication operation lease is no longer current.' };
      const target = operation.target as { destination?: CommunicationDestinationV1 } | null;
      if (!target?.destination || stableJson(target.destination) !== stableJson(destination(binding)))
        return { allowed: false, reason: 'Retained communication destination or connection changed.' };
      return { allowed: true };
    },
  });
  return Object.freeze({ effects, selected, assertAdmission,
    destination(): CommunicationDestinationV1 | null { const binding = selected(); return binding ? destination(binding) : null; },
    scanKey(): string {
      try { return scanIdentity(); }
      catch {
        const settings = slackSettings(options.env());
        return stableJson({ binding: null, settings: { ...settings, surface: settings.surface ?? null }, browser: null, unavailable: true });
      }
    },
    captureScan() {
      const browser = browserSelection(); const binding = selected(); const settings = slackSettings(options.env());
      if (!binding || !settings.enabled || settings.error) throw new Error('Selected communication scanner is unavailable.');
      const identity = scanIdentity(binding, settings, browser.resolved);
      const browserBinding: ProviderBinding = { role: 'host', capability: 'helmsman/native-terminal',
        contributionId: browser.resolved.record.binding.providerId, pluginId: browser.resolved.record.binding.pluginId,
        artifactHash: browser.resolved.record.binding.artifactHash, contractVersion: 1, connectionId: null, credentialHandle: null };
      return { sourceKey: JSON.stringify([settings.clientId, settings.channelId]), revision: persistenceHash(identity),
        bindings: [binding, browserBinding], artifacts: [...options.artifacts(binding), ...options.artifacts(browserBinding)],
        channelId: settings.channelId, channelName: settings.channelName,
        assertCurrent() {
          assertNativeTerminalSelectionCurrent(browserSelectionOptions, browser.resolved);
          if (scanIdentity() !== identity) throw new Error('Communication scanner changed during read.');
        } };
    },
    async scan(input: { since: string | null }, signal?: AbortSignal) {
      const selectedBrowser = browserSelection(); const binding = selected(); const settings = slackSettings(options.env());
      if (!binding || !settings.enabled || settings.error) throw new Error('Selected communication scanner is unavailable.');
      const target = destination(binding);
      if (!target) throw new Error('Communication integration is disabled.');
      if (binding.connectionId !== connectionFor(selectedBrowser.resolved.record, settings)?.connectionId) throw new Error('Communication browser selection changed before read.');
      const initial = scanIdentity(binding, settings, selectedBrowser.resolved);
      const registration = options.registry.resolve({ providerId: binding.contributionId, pluginId: binding.pluginId, artifactHash: binding.artifactHash,
        contractVersion: 1, connectionId: null, credentialHandle: null }, 'admission');
      const controller = new AbortController();
      const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      readSignal.throwIfAborted();
      const context: CommunicationProviderContextV1 = { signal: readSignal, destination: target,
        surface: settings.surface ?? null, watchedChannel: { id: settings.channelId, name: settings.channelName },
        browser: createCommunicationBrowserSession({ workspace: target.workspace, surface: settings.surface ?? null, signal: readSignal,
          browser: selectedBrowser.browser, sessionIdentity: selectedBrowser.sessionIdentity }),
        beforeSend: async () => { throw new Error('Communication scans cannot send.'); } };
      const result = await withSlackBrowserLock(() => registration.provider.scanReviewRequests(input, context));
      readSignal.throwIfAborted();
      assertNativeTerminalSelectionCurrent(browserSelectionOptions, selectedBrowser.resolved);
      if (scanIdentity() !== initial) throw new Error('Communication scanner changed during read.');
      if (!result || typeof result.complete !== 'boolean' || !Array.isArray(result.messages) || result.messages.length > 10_000) throw new Error('Invalid communication scan response.');
      return { complete: result.complete, messages: result.messages.map(message => {
        if (!message || message.channelId !== settings.channelId || typeof message.ts !== 'string' || !/^\d{10,}\.\d{1,6}$/.test(message.ts)
          || typeof message.author !== 'string' || message.author.length > 512 || !Array.isArray(message.prUrls) || message.prUrls.length > 100
          || message.prUrls.some((url: unknown) => typeof url !== 'string' || url.length > 2048)) throw new Error('Invalid communication scan message.');
        const url = new URL(message.permalink);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.slack.com') || url.username || url.password || url.port
          || url.pathname !== `/archives/${settings.channelId}/p${message.ts.replace('.', '')}`) throw new Error('Invalid communication message permalink.');
        return { channelId: message.channelId, ts: message.ts, author: message.author, permalink: url.href, prUrls: [...message.prUrls] };
      }) };
    },
  });
}
