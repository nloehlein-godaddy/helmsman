import type { PluginJson } from '../../src/plugins/backend';
import { parseNativeTerminalBrowserClickV1, parseNativeTerminalBrowserEvaluateV1, parseNativeTerminalBrowserFillV1, parseNativeTerminalBrowserFocusV1, parseNativeTerminalBrowserTreeV1, parseNativeTerminalBrowserValueV1, parseNativeTerminalBrowserWaitV1, parseNativeTerminalControlResultV1, parseNativeTerminalKeyV1, parseNativeTerminalLinesV1, parseNativeTerminalMetadataV1, parseNativeTerminalReferenceV1, parseNativeTerminalScreenResultV1, parseNativeTerminalSessionV1, parseNativeTerminalTabsV1, parseNativeTerminalTextV1, type NativeTerminalMetadataV1, type NativeTerminalProviderV1, type NativeTerminalBrowserV1 } from '../../src/plugins/native-terminal';
import { clarificationAbortable } from '../../src/plugins/clarification-transport';
import { isContributionId, isPluginId } from '../../src/plugins/manifest';
import type { PluginPackage } from '../../src/plugins/package';
import { sourceFields, sourceJson, sourceObject } from '../../src/plugins/source-contract-validation';
import { persistenceHash } from './persistence';

export interface NativeTerminalProviderBindingV1 {
  readonly providerId: string; readonly pluginId: string; readonly artifactHash: string; readonly contractVersion: 1;
}
export interface NativeTerminalRetainedProviderV1 {
  readonly version: 1; readonly binding: NativeTerminalProviderBindingV1; readonly origin: 'builtin' | 'external';
  readonly settings: Readonly<Record<string, PluginJson>>; readonly metadata: NativeTerminalMetadataV1;
}
export interface NativeTerminalProviderRegistration {
  readonly record: NativeTerminalRetainedProviderV1; readonly provider: NativeTerminalProviderV1; readonly package: PluginPackage;
}
export type NativeTerminalProviderPurpose = 'admission' | 'obligation';

export function parseNativeTerminalProviderBindingV1(input: unknown): NativeTerminalProviderBindingV1 {
  const value = sourceObject(input); sourceFields(value, ['providerId', 'pluginId', 'artifactHash', 'contractVersion']);
  if (!isContributionId(value.providerId) || !isPluginId(value.pluginId) || value.providerId.split('/')[0] !== value.pluginId
    || typeof value.artifactHash !== 'string' || !/^[a-f\d]{64}$/.test(value.artifactHash) || value.contractVersion !== 1) throw new TypeError('Invalid native terminal provider binding');
  return Object.freeze({ providerId: value.providerId, pluginId: value.pluginId, artifactHash: value.artifactHash, contractVersion: 1 });
}
export function parseNativeTerminalRetainedProviderV1(input: unknown): NativeTerminalRetainedProviderV1 {
  const value = sourceObject(sourceJson(input, 256 * 1024)); sourceFields(value, ['version', 'binding', 'origin', 'settings', 'metadata']);
  if (value.version !== 1 || value.origin !== 'builtin' && value.origin !== 'external') throw new TypeError('Invalid retained native terminal provider');
  const binding = parseNativeTerminalProviderBindingV1(value.binding);
  if ((value.origin === 'builtin') !== binding.pluginId.startsWith('helmsman.')) throw new TypeError('Native terminal provider origin does not match namespace');
  const settings = sourceObject(value.settings) as Readonly<Record<string, PluginJson>>;
  return Object.freeze({ version: 1, binding, origin: value.origin, settings, metadata: parseNativeTerminalMetadataV1(value.metadata) });
}
export function validateNativeTerminalProvider(provider: NativeTerminalProviderV1): void {
  if (!provider || typeof provider !== 'object' || ['sessionIdentity', 'listTabs', 'readScreen', 'send', 'sendKey'].some(key => typeof (provider as unknown as Record<string, unknown>)[key] !== 'function')) throw new TypeError('Invalid native terminal provider registration');
  const metadata = parseNativeTerminalMetadataV1(provider.metadata);
  if (metadata.browser !== (provider.browser !== undefined)) throw new TypeError('Native terminal browser metadata differs from its implementation');
  if (metadata.browser && (!provider.browser || typeof provider.browser !== 'object' || ['tree', 'focus', 'evaluate', 'click', 'fill', 'wait'].some(key => typeof (provider.browser as unknown as Record<string, unknown>)[key] !== 'function'))) throw new TypeError('Native terminal browser primitives are incomplete');
}
export function boundedNativeTerminalProvider(provider: NativeTerminalProviderV1, signal?: AbortSignal): NativeTerminalProviderV1 {
  validateNativeTerminalProvider(provider);
  async function invoke<T>(operation: (signal: AbortSignal) => Promise<T>, request?: AbortSignal): Promise<T> {
    signal?.throwIfAborted(); request?.throwIfAborted();
    const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(new Error('Native terminal operation timed out')), 30_000);
    const bounded = AbortSignal.any([timeout.signal, ...(signal ? [signal] : []), ...(request ? [request] : [])]);
    try {
      const result = await clarificationAbortable(Promise.resolve().then(() => { bounded.throwIfAborted(); return operation(bounded); }), bounded);
      bounded.throwIfAborted(); return result;
    } finally { clearTimeout(timer); }
  }
  const nativeBrowser = provider.browser;
  const browser = nativeBrowser ? Object.freeze<NativeTerminalBrowserV1>({
    async tree(request) { return parseNativeTerminalBrowserTreeV1(await invoke(signal => nativeBrowser.tree(signal), request)); },
    async focus(input, request) { const parsed = parseNativeTerminalBrowserFocusV1(input); await invoke(signal => nativeBrowser.focus(parsed, signal), request); },
    async evaluate(input, request) { const parsed = parseNativeTerminalBrowserEvaluateV1(input); return parseNativeTerminalBrowserValueV1(await invoke(signal => nativeBrowser.evaluate(parsed, signal), request)); },
    async click(input, request) { const parsed = parseNativeTerminalBrowserClickV1(input); await invoke(signal => nativeBrowser.click(parsed, signal), request); },
    async fill(input, request) { const parsed = parseNativeTerminalBrowserFillV1(input); await invoke(signal => nativeBrowser.fill(parsed, signal), request); },
    async wait(input, request) { const parsed = parseNativeTerminalBrowserWaitV1(input); await invoke(signal => nativeBrowser.wait(parsed, signal), request); },
  }) : undefined;
  return Object.freeze<NativeTerminalProviderV1>({ metadata: parseNativeTerminalMetadataV1(provider.metadata),
    sessionIdentity() { signal?.throwIfAborted(); const identity = parseNativeTerminalSessionV1(provider.sessionIdentity()); signal?.throwIfAborted(); return identity; },
    async listTabs(request) { return parseNativeTerminalTabsV1(await invoke(signal => provider.listTabs(signal), request)); },
    async readScreen(surfaceRef, lines, request) {
      const surface = parseNativeTerminalReferenceV1(surfaceRef); const count = parseNativeTerminalLinesV1(lines);
      return parseNativeTerminalScreenResultV1(await invoke(signal => provider.readScreen(surface, count, signal), request));
    },
    async send(surfaceRef, text, enter, request) {
      const surface = parseNativeTerminalReferenceV1(surfaceRef); const value = parseNativeTerminalTextV1(text);
      if (typeof enter !== 'boolean') throw new TypeError('Invalid native terminal enter flag');
      return parseNativeTerminalControlResultV1(await invoke(signal => provider.send(surface, value, enter, signal), request));
    },
    async sendKey(surfaceRef, key, request) {
      const surface = parseNativeTerminalReferenceV1(surfaceRef); const value = parseNativeTerminalKeyV1(key);
      return parseNativeTerminalControlResultV1(await invoke(signal => provider.sendKey(surface, value, signal), request));
    },
    ...(browser ? { browser } : {}),
  });
}
export function createNativeTerminalProviderRegistry(options: { eligible(binding: NativeTerminalProviderBindingV1, purpose: NativeTerminalProviderPurpose): boolean }) {
  const registrations = new Map<string, NativeTerminalProviderRegistration>(); const staged = new WeakSet<NativeTerminalProviderRegistration>();
  const key = (binding: NativeTerminalProviderBindingV1) => JSON.stringify([binding.providerId, binding.pluginId, binding.artifactHash, binding.contractVersion]);
  return Object.freeze({
    stage(input: { binding: NativeTerminalProviderBindingV1; provider: NativeTerminalProviderV1; package: PluginPackage; settings: Readonly<Record<string, PluginJson>>; origin: 'builtin' | 'external' }): NativeTerminalProviderRegistration {
      const provider = boundedNativeTerminalProvider(input.provider);
      const record = parseNativeTerminalRetainedProviderV1({ version: 1, binding: input.binding, origin: input.origin, settings: input.settings, metadata: provider.metadata });
      if (input.package.manifest.id !== record.binding.pluginId || !input.package.backend?.provides.some(value => String(value.id) === 'helmsman/native-terminal' && `${record.binding.pluginId}/${value.localId}` === record.binding.providerId)) throw new TypeError('Native terminal provider differs from its package declaration');
      const registration = Object.freeze({ record, provider, package: input.package }); staged.add(registration); return registration;
    },
    publish(input: readonly NativeTerminalProviderRegistration[]): void {
      const seen = new Set<string>();
      for (const registration of input) {
        const identity = key(registration.record.binding);
        if (!staged.has(registration) || registrations.has(identity) || seen.has(identity)) throw new Error('Duplicate or unstaged native terminal registration');
        seen.add(identity);
      }
      for (const registration of input) { registrations.set(key(registration.record.binding), registration); staged.delete(registration); }
    },
    resolve(binding: NativeTerminalProviderBindingV1, purpose: NativeTerminalProviderPurpose = 'admission'): NativeTerminalProviderRegistration {
      const registration = registrations.get(key(parseNativeTerminalProviderBindingV1(binding)));
      if (!registration || !options.eligible(registration.record.binding, purpose)) throw new Error('Pinned native terminal provider is unavailable');
      return registration;
    },
    list(purpose: NativeTerminalProviderPurpose = 'admission'): readonly NativeTerminalProviderRegistration[] {
      return Object.freeze([...registrations.values()].filter(value => options.eligible(value.record.binding, purpose)).sort((a, b) => a.record.binding.providerId.localeCompare(b.record.binding.providerId)));
    },
    assertCurrent(record: NativeTerminalRetainedProviderV1): void {
      const parsed = parseNativeTerminalRetainedProviderV1(record); const registration = registrations.get(key(parsed.binding));
      if (!registration || !options.eligible(parsed.binding, 'admission') || persistenceHash(registration.record) !== persistenceHash(parsed)) throw new Error('Native terminal provider or effective settings changed before admission');
    },
    removePlugin(pluginId: string): void { for (const [identity, registration] of registrations) if (registration.record.binding.pluginId === pluginId) registrations.delete(identity); },
  });
}
export type NativeTerminalProviderRegistry = ReturnType<typeof createNativeTerminalProviderRegistry>;
