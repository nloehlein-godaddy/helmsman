import type { TaskEditorDeclarationV1 } from './task-edit';
import type { SourceSettingFieldsV1 } from './source-settings';
import type { PricingEstimate, UsageQueryService, UsageSnapshot } from './usage';
import type { TaskSourceProviderV1 } from './tasks';
import type { PullRequestProviderV1 } from './pull-request-provider';

export type PluginJson = null | boolean | number | string | readonly PluginJson[] | { readonly [key: string]: PluginJson };
export type PluginSetting =
  | { readonly type: 'number'; readonly default: number; readonly minimum: number; readonly maximum: number }
  | { readonly type: 'string'; readonly default: string; readonly maxLength: number }
  | { readonly type: 'boolean'; readonly default: boolean };

export interface TaskSourceDeclaration {
  readonly settingsFields?: SourceSettingFieldsV1;
  readonly editorContracts?: readonly TaskEditorDeclarationV1[];
  readonly readViews?: readonly ('underway' | 'history' | 'triage' | 'bugs')[];
  readonly identityFormats: readonly string[];
  readonly effectIds: readonly string[];
  readonly commandIds: readonly string[];
  readonly access: readonly ('local-records' | 'connection-http')[];
}

export interface PullRequestDeclaration {
  readonly access: readonly ['core-http'];
}

export interface PluginBackendDefinition {
  readonly entry: string;
  readonly provides: readonly { readonly id: 'helmsman/pricing' | 'helmsman/task-source' | 'helmsman/pull-request'; readonly version: 1; readonly localId: string }[];
  readonly taskSources?: Readonly<Record<string, TaskSourceDeclaration>>;
  readonly pullRequests?: Readonly<Record<string, PullRequestDeclaration>>;
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
  registerPullRequest(localId: string, provider: PullRequestProviderV1): void;
}

export interface PluginBackendModule {
  activate(context: PluginBackendContext): void | Promise<void>;
}
