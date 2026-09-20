import type { PricingEstimate, UsageQueryService, UsageSnapshot } from './usage';

export type PluginJson = null | boolean | number | string | readonly PluginJson[] | { readonly [key: string]: PluginJson };
export type PluginSetting =
  | { readonly type: 'number'; readonly default: number; readonly minimum: number; readonly maximum: number }
  | { readonly type: 'string'; readonly default: string; readonly maxLength: number }
  | { readonly type: 'boolean'; readonly default: boolean };

export interface PluginBackendDefinition {
  readonly entry: string;
  readonly provides: readonly { readonly id: 'helmsman/pricing'; readonly version: 1; readonly localId: string }[];
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
}

export interface PluginBackendModule {
  activate(context: PluginBackendContext): void | Promise<void>;
}
