import type { PricingEstimate, UsageQueryService, UsageSnapshot } from './usage';
import type { TaskSourceProviderV1 } from './tasks';

export type PluginJson = null | boolean | number | string | readonly PluginJson[] | { readonly [key: string]: PluginJson };
export type PluginSetting =
  | { readonly type: 'number'; readonly default: number; readonly minimum: number; readonly maximum: number }
  | { readonly type: 'string'; readonly default: string; readonly maxLength: number }
  | { readonly type: 'boolean'; readonly default: boolean };

export interface TaskSourceDeclaration {
  readonly readViews?: readonly ('underway' | 'history')[];
  readonly identityFormats: readonly string[];
  readonly effectIds: readonly string[];
  readonly commandIds: readonly string[];
  readonly access: readonly ('local-records' | 'connection-http')[];
}

export interface PluginBackendDefinition {
  readonly entry: string;
  readonly provides: readonly { readonly id: 'helmsman/pricing' | 'helmsman/task-source'; readonly version: 1; readonly localId: string }[];
  readonly taskSources?: Readonly<Record<string, TaskSourceDeclaration>>;
  readonly settings: Readonly<Record<string, PluginSetting>>;
  readonly storageVersion: 1;
}

export interface PricingProvider {
  estimate(snapshot: UsageSnapshot): PricingEstimate | null | Promise<PricingEstimate | null>;
}

export interface PluginStorage {
  get(key: string): Promise<PluginJson | undefined>;
  set(key: string, value: PluginJson): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PluginBackendContext {
  readonly pluginId: string;
  readonly signal: AbortSignal;
  readonly settings: Readonly<Record<string, PluginJson>>;
  readonly storage: PluginStorage;
  readonly usage: UsageQueryService;
  onDispose(cleanup: () => void | Promise<void>): void;
  registerPricing(localId: string, provider: PricingProvider): void;
  registerTaskSource(localId: string, provider: TaskSourceProviderV1): void;
}

export interface PluginBackendModule {
  activate(context: PluginBackendContext): void | Promise<void>;
}
