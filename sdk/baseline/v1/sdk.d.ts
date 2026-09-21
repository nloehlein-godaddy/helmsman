export * from "./profile.js";
export * from "./github-settings.js";
export * from "./jira-settings.js";
export * from "./local-git.js";
export * from "./campaigns.js";
import type { TerminalRouteV1 } from "./terminal-route.js";
export * from "./terminal.js";
export * from "./terminal-route.js";
import type { PluginPageServices } from "./services.js";
import type { PresentationLocatorV1, PullRequestRouteV1 } from "./presentation.js";
export * from "./presentation.js";
import type { CompositionServiceV1, PageCompositionDefinitionV1, PanelOpaqueStateV1, PluginPanelDefinition, PluginServiceRequirementV1 } from "./composition.js";
export * from "./composition.js";
export type { PluginPageServices } from "./services.js";
export type { AssessmentInput, OutcomeAssessment, OutcomeSummary, OutcomeRun, OutcomeDay, OutcomeWindow } from "./outcomes.js";
export type { UsageQuery, UsageSnapshot, UsageRun, UsageTotals, ProviderUsage, UsageCostEstimate, PricingEstimate } from "./usage.js";
export type { PluginBackendModule, PluginBackendContext, PluginBackendDefinition, PluginSetting, PluginStorage, PluginJson, PricingProvider, TaskSourceDeclaration, PullRequestDeclaration } from "./backend.js";
export * from "./tasks.js";
export * from "./task-read.js";
export * from "./task-views.js";
export * from "./task-edit.js";
export * from "./todo-legacy-recovery.js";
export * from "./source-settings.js";
export * from "./source-admin.js";
export * from "./source-command.js";
export * from "./run-read.js";
export * from "./run-inspect.js";
export * from "./download.js";
export * from "./clarification-read.js";
export * from "./clarification-command.js";
export * from "./suggested-contact-admin.js";
export * from "./pull-request-read.js";
export * from "./pull-request-inspect.js";
export * from "./pull-request-command.js";
export * from "./communication.js";
export * from "./communication-command.js";
export * from "./pull-request-provider.js";
export * from "./communication-provider.js";
export * from "./activity-read.js";
export * from "./run-command.js";
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
export * from "./scheduling-provider.js";
export * from "./agent-provider.js";
export * from "./execution-host.js";
export * from "./native-terminal.js";
export * from "./workflow.js";
export * from "./trigger.js";
