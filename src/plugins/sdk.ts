import type { PluginPageServices } from './services';
export type { PluginPageServices } from './services';
export type { AssessmentInput, OutcomeAssessment, OutcomeSummary, OutcomeRun, OutcomeDay, OutcomeWindow } from './outcomes';
export type { UsageQuery, UsageSnapshot, UsageRun, UsageTotals, ProviderUsage, UsageCostEstimate, PricingEstimate } from './usage';
export type { PluginBackendModule, PluginBackendContext, PluginBackendDefinition, PluginSetting, PluginStorage, PluginJson, PricingProvider, TaskSourceDeclaration } from './backend';
export * from './tasks';

export interface PluginPageDefinition {
  readonly id: string;
  readonly title: string;
  readonly slots: readonly string[];
  readonly panes: readonly string[];
}

export interface PluginManifest {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly sdkVersion: 1;
  readonly pages: readonly PluginPageDefinition[];
}

export interface RegisteredPluginPage extends PluginPageDefinition {
  readonly contributionId: string;
  readonly pluginId: string;
  readonly canonicalPath: string;
}

export interface PageSlot {
  readonly id: string;
  readonly alias: string;
  readonly defaultContributionId: string;
}

export interface PageResolution {
  readonly contributionId: string;
  readonly slotId: string | null;
  readonly page: RegisteredPluginPage | null;
}

export interface PluginPageState {
  readonly repo: string | null;
  readonly themeId: string;
  readonly pirateMode: boolean;
  readonly visible: boolean;
  readonly pane: string | null;
}

export interface PluginPageContext {
  readonly state: PluginPageState;
  readonly signal: AbortSignal;
  readonly navigate: (href: string) => void;
  readonly onDispose: (cleanup: () => void) => void;
  readonly services?: PluginPageServices;
}

export interface PluginPageInstance {
  update(state: PluginPageState): void | Promise<void>;
  refresh?(): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface PluginPageModule {
  mount(container: HTMLElement, context: PluginPageContext): PluginPageInstance | Promise<PluginPageInstance>;
}
