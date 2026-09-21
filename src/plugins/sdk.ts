export * from './profile';
export * from './github-settings';
export * from './jira-settings';
export * from './local-git';
export * from './campaigns';
import type { TerminalRouteV1 } from './terminal-route';
export * from './terminal';
export * from './terminal-route';
import type { PluginPageServices } from './services';
import type { PresentationLocatorV1, PullRequestRouteV1 } from './presentation';
export * from './presentation';
import type { CompositionServiceV1, PageCompositionDefinitionV1, PanelOpaqueStateV1, PluginPanelDefinition, PluginServiceRequirementV1 } from './composition';
export * from './composition';
export type { PluginPageServices } from './services';
export type { AssessmentInput, OutcomeAssessment, OutcomeSummary, OutcomeRun, OutcomeDay, OutcomeWindow } from './outcomes';
export type { UsageQuery, UsageSnapshot, UsageRun, UsageTotals, ProviderUsage, UsageCostEstimate, PricingEstimate } from './usage';
export type { PluginBackendModule, PluginBackendContext, PluginBackendDefinition, PluginSetting, PluginStorage, PluginJson, PricingProvider, TaskSourceDeclaration, PullRequestDeclaration } from './backend';
export * from './tasks';
export * from './task-read';
export * from './task-views';
export * from './task-edit';
export * from './todo-legacy-recovery';
export * from './source-settings';
export * from './source-admin';
export * from './source-command';
export * from './run-read';
export * from './run-inspect';
export * from './download';
export * from './clarification-read';
export * from './clarification-command';
export * from './suggested-contact-admin';
export * from './pull-request-read';
export * from './pull-request-inspect';
export * from './pull-request-command';
export * from './communication';
export * from './communication-command';
export * from './pull-request-provider';
export * from './communication-provider';
export * from './activity-read';
export * from './run-command';

export interface PluginPageDefinition {
  readonly navigation?: boolean;
  readonly id: string;
  readonly title: string;
  readonly slots: readonly string[];
  readonly panes: readonly string[];
  readonly composition?: PageCompositionDefinitionV1;
  readonly requires?: readonly PluginServiceRequirementV1[];
}

export interface PluginManifestV1 {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly sdkVersion: 1;
  readonly pages: readonly PluginPageDefinition[];
}

export interface PluginManifestV2 extends Omit<PluginManifestV1, 'manifestVersion'> {
  readonly manifestVersion: 2;
  readonly panels: readonly PluginPanelDefinition[];
}

export type PluginManifest = PluginManifestV1 | PluginManifestV2;

export interface RegisteredPluginPage extends PluginPageDefinition {
  readonly contributionId: string;
  readonly pluginId: string;
  readonly canonicalPath: string;
}

export interface PageSlot {
  readonly id: string;
  readonly alias: string;
  readonly defaultContributionId: string;
  readonly aliases?: readonly string[];
}

export interface PageResolution {
  readonly contributionId: string;
  readonly slotId: string | null;
  readonly page: RegisteredPluginPage | null;
}

export interface PluginPageState {
  readonly terminal?: TerminalRouteV1 | null;
  readonly pullRequest?: PullRequestRouteV1 | null;
  readonly presentation?: PresentationLocatorV1 | null;
  readonly repo: string | null;
  readonly themeId: string;
  readonly pirateMode: boolean;
  readonly visible: boolean;
  readonly pane: string | null;
  readonly panelInstance?: string | null;
  readonly panelContribution?: string | null;
  readonly panelRouteState?: Readonly<Record<string, PanelOpaqueStateV1>>;
}

export interface PluginPageContext {
  readonly contributionId?: string;
  readonly selectPresentation?: (locator: PresentationLocatorV1 | null) => void;
  readonly state: PluginPageState;
  readonly signal: AbortSignal;
  readonly navigate: (href: string) => void;
  readonly onDispose: (cleanup: () => void) => void;
  readonly services?: PluginPageServices;
  readonly composition?: CompositionServiceV1;
}

export interface PluginPageInstance {
  update(state: PluginPageState): void | Promise<void>;
  refresh?(): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface PluginPageModule {
  mount(container: HTMLElement, context: PluginPageContext): PluginPageInstance | Promise<PluginPageInstance>;
}

export * from './scheduling-provider';

export * from './agent-provider';

export * from './execution-host';
