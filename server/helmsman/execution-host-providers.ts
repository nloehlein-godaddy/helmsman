import type { PluginJson } from '../../src/plugins/backend';
import { parseExecutionHostCommandV1, parseExecutionHostConfigurationV1, parseExecutionHostDiscoveryV1, parseExecutionHostLaunchSpecV1, parseExecutionHostMetadataV1, parseExecutionHostPrepareRunInputV1, parseExecutionHostReferenceV1, parseExecutionHostRunIdV1, parseExecutionHostStageInputV1, parseExecutionHostStagePathsV1, type ExecutionHostMetadataV1, type ExecutionHostProviderV1, type ExecutionHostStageV1 } from '../../src/plugins/execution-host';
import { clarificationAbortable } from '../../src/plugins/clarification-transport';
import { isContributionId, isPluginId } from '../../src/plugins/manifest';
import type { PluginPackage } from '../../src/plugins/package';
import { sourceFields, sourceJson, sourceObject } from '../../src/plugins/source-contract-validation';
import { persistenceHash } from './persistence';

export interface ExecutionHostProviderBindingV1 {
  readonly providerId: string; readonly pluginId: string; readonly artifactHash: string; readonly contractVersion: 1;
}
export interface ExecutionHostRetainedProviderV1 {
  readonly version: 1; readonly binding: ExecutionHostProviderBindingV1; readonly origin: 'builtin' | 'external';
  readonly settings: Readonly<Record<string, PluginJson>>; readonly metadata: ExecutionHostMetadataV1;
}
export interface ExecutionHostProviderRegistration {
  readonly record: ExecutionHostRetainedProviderV1; readonly provider: ExecutionHostProviderV1; readonly package: PluginPackage;
}
export type ExecutionHostProviderPurpose = 'admission' | 'obligation';

export function parseExecutionHostProviderBindingV1(input: unknown): ExecutionHostProviderBindingV1 {
  const value = sourceObject(input); sourceFields(value, ['providerId', 'pluginId', 'artifactHash', 'contractVersion']);
  if (!isContributionId(value.providerId) || !isPluginId(value.pluginId) || value.providerId.split('/')[0] !== value.pluginId
    || typeof value.artifactHash !== 'string' || !/^[a-f\d]{64}$/.test(value.artifactHash) || value.contractVersion !== 1) throw new TypeError('Invalid execution host provider binding');
  return Object.freeze({ providerId: value.providerId, pluginId: value.pluginId, artifactHash: value.artifactHash, contractVersion: 1 });
}
export function parseExecutionHostRetainedProviderV1(input: unknown): ExecutionHostRetainedProviderV1 {
  const value = sourceObject(sourceJson(input, 256 * 1024)); sourceFields(value, ['version', 'binding', 'origin', 'settings', 'metadata']);
  if (value.version !== 1 || value.origin !== 'builtin' && value.origin !== 'external') throw new TypeError('Invalid retained execution host provider');
  const binding = parseExecutionHostProviderBindingV1(value.binding);
  if ((value.origin === 'builtin') !== binding.pluginId.startsWith('helmsman.')) throw new TypeError('Execution host provider origin does not match namespace');
  const settings = sourceObject(value.settings) as Readonly<Record<string, PluginJson>>;
  return Object.freeze({ version: 1, binding, origin: value.origin, settings, metadata: parseExecutionHostMetadataV1(value.metadata) });
}
export function validateExecutionHostProvider(provider: ExecutionHostProviderV1): void {
  if (!provider || typeof provider !== 'object' || ['prepareRun', 'launch', 'discover', 'isAlive', 'stop'].some(key => typeof (provider as unknown as Record<string, unknown>)[key] !== 'function')) throw new TypeError('Invalid execution host provider registration');
  const metadata = parseExecutionHostMetadataV1(provider.metadata);
  if (metadata.stageExecution === 'isolated' && (typeof provider.prepareStage !== 'function' || typeof provider.stopStages !== 'function')) throw new TypeError('Isolated execution hosts require stage execution and stop support');
  if (provider.prepareStage !== undefined && typeof provider.prepareStage !== 'function' || provider.stopStages !== undefined && typeof provider.stopStages !== 'function') throw new TypeError('Invalid execution host stage methods');
}
export function boundedExecutionHostProvider(provider: ExecutionHostProviderV1, signal?: AbortSignal): ExecutionHostProviderV1 {
  validateExecutionHostProvider(provider);
  async function invoke<T>(operation: () => Promise<T>, cleanup = false): Promise<T> {
    const parent = cleanup ? undefined : signal; parent?.throwIfAborted();
    const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(new Error('Execution host operation timed out')), 30_000);
    const bounded = parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal;
    try {
      const result = await clarificationAbortable(Promise.resolve().then(() => { bounded.throwIfAborted(); return operation(); }), bounded);
      bounded.throwIfAborted(); return result;
    } finally { clearTimeout(timer); }
  }
  const identity = (left: {runId:string;launchId:string;attempt:number;receiptPath:string}, right: {runId:string;launchId:string;attempt:number;receiptPath:string}) => {
    if (persistenceHash(left) !== persistenceHash(right)) throw new Error('Execution host returned a different launch identity');
  };
  async function releaseStage(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return;
    const stage = value as Partial<ExecutionHostStageV1>;
    if (typeof stage.stop === 'function') await invoke(() => stage.stop!(), true).catch(() => {});
    if (typeof stage.cleanup === 'function') await invoke(() => stage.cleanup!(false), true).catch(() => {});
  }
  return Object.freeze<ExecutionHostProviderV1>({ metadata: parseExecutionHostMetadataV1(provider.metadata),
    async prepareRun(input) { return parseExecutionHostConfigurationV1(await invoke(() => provider.prepareRun(parseExecutionHostPrepareRunInputV1(input)))); },
    async launch(input) {
      const spec = parseExecutionHostLaunchSpecV1(input); const ref = parseExecutionHostReferenceV1(await invoke(() => provider.launch(spec)));
      identity(ref.identity, { runId: spec.runId, launchId: spec.launchId, attempt: spec.attempt, receiptPath: spec.receiptPath }); return ref;
    },
    async discover(input, prior) {
      const spec = parseExecutionHostLaunchSpecV1(input); const ref = prior === undefined ? undefined : parseExecutionHostReferenceV1(prior);
      const expected = { runId: spec.runId, launchId: spec.launchId, attempt: spec.attempt, receiptPath: spec.receiptPath };
      if (ref) identity(ref.identity, expected);
      const found = parseExecutionHostDiscoveryV1(await invoke(() => provider.discover(spec, ref)));
      if (found.status === 'found') identity(found.ref.identity, expected); return found;
    },
    async isAlive(ref) { const alive = await invoke(() => provider.isAlive(parseExecutionHostReferenceV1(ref))); if (typeof alive !== 'boolean') throw new TypeError('Execution host liveness must be explicit'); return alive; },
    async stop(ref) { await invoke(() => provider.stop(parseExecutionHostReferenceV1(ref)), true); },
    ...(provider.prepareStage ? { async prepareStage(input, renderCommand) {
      const parsed = parseExecutionHostStageInputV1(input);
      if (typeof renderCommand !== 'function') throw new TypeError('Execution host command renderer is required');
      let preparing = true;
      let stage: ExecutionHostStageV1;
      try { stage = await invoke(() => provider.prepareStage!(parsed, paths => {
        signal?.throwIfAborted(); if (!preparing) throw new Error('Stage command rendering is closed');
        return parseExecutionHostCommandV1(renderCommand(parseExecutionHostStagePathsV1(paths)));
      }).then(async value => { if (!preparing) { await releaseStage(value); throw new Error('Stage preparation is closed'); } return value; })); } finally { preparing = false; }
      let command;
      try {
        const value = sourceObject(stage); sourceFields(value, ['command', 'stop', 'cleanup']);
        if (typeof stage.stop !== 'function' || typeof stage.cleanup !== 'function') throw new TypeError('Invalid execution host stage');
        command = parseExecutionHostCommandV1(stage.command);
      } catch (error) { await releaseStage(stage); throw error; }
      return Object.freeze<ExecutionHostStageV1>({ command,
        async stop() { await invoke(() => stage.stop(), true); },
        async cleanup(success) { if (typeof success !== 'boolean') throw new TypeError('Invalid stage completion'); await invoke(() => stage.cleanup(success), true); },
      });
    } } : {}),
    ...(provider.stopStages ? { async stopStages(runId) { await invoke(() => provider.stopStages!(parseExecutionHostRunIdV1(runId)), true); } } : {}),
  });
}
export function createExecutionHostProviderRegistry(options: { eligible(binding: ExecutionHostProviderBindingV1, purpose: ExecutionHostProviderPurpose): boolean }) {
  const registrations = new Map<string, ExecutionHostProviderRegistration>(); const staged = new WeakSet<ExecutionHostProviderRegistration>();
  const key = (binding: ExecutionHostProviderBindingV1) => JSON.stringify([binding.providerId, binding.pluginId, binding.artifactHash, binding.contractVersion]);
  return Object.freeze({
    stage(input: { binding: ExecutionHostProviderBindingV1; provider: ExecutionHostProviderV1; package: PluginPackage; settings: Readonly<Record<string, PluginJson>>; origin: 'builtin' | 'external' }): ExecutionHostProviderRegistration {
      const provider = boundedExecutionHostProvider(input.provider);
      const record = parseExecutionHostRetainedProviderV1({ version: 1, binding: input.binding, origin: input.origin, settings: input.settings, metadata: provider.metadata });
      if (input.package.manifest.id !== record.binding.pluginId || !input.package.backend?.provides.some(value => String(value.id) === 'helmsman/execution-host' && `${record.binding.pluginId}/${value.localId}` === record.binding.providerId)) throw new TypeError('Execution host provider differs from its package declaration');
      const registration = Object.freeze({ record, provider, package: input.package }); staged.add(registration); return registration;
    },
    publish(input: readonly ExecutionHostProviderRegistration[]): void {
      const seen = new Set<string>();
      for (const registration of input) {
        const identity = key(registration.record.binding);
        if (!staged.has(registration) || registrations.has(identity) || seen.has(identity)) throw new Error('Duplicate or unstaged execution host registration');
        seen.add(identity);
      }
      for (const registration of input) { registrations.set(key(registration.record.binding), registration); staged.delete(registration); }
    },
    resolve(binding: ExecutionHostProviderBindingV1, purpose: ExecutionHostProviderPurpose = 'admission'): ExecutionHostProviderRegistration {
      const registration = registrations.get(key(parseExecutionHostProviderBindingV1(binding)));
      if (!registration || !options.eligible(registration.record.binding, purpose)) throw new Error('Pinned execution host provider is unavailable');
      return registration;
    },
    list(purpose: ExecutionHostProviderPurpose = 'admission'): readonly ExecutionHostProviderRegistration[] {
      return Object.freeze([...registrations.values()].filter(value => options.eligible(value.record.binding, purpose)).sort((a, b) => a.record.binding.providerId.localeCompare(b.record.binding.providerId)));
    },
    assertCurrent(record: ExecutionHostRetainedProviderV1): void {
      const parsed = parseExecutionHostRetainedProviderV1(record); const registration = registrations.get(key(parsed.binding));
      if (!registration || !options.eligible(parsed.binding, 'admission') || persistenceHash(registration.record) !== persistenceHash(parsed)) throw new Error('Execution host provider or effective settings changed before admission');
    },
    removePlugin(pluginId: string): void { for (const [identity, registration] of registrations) if (registration.record.binding.pluginId === pluginId) registrations.delete(identity); },
  });
}
export type ExecutionHostProviderRegistry = ReturnType<typeof createExecutionHostProviderRegistry>;
