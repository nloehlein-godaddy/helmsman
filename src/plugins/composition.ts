import type { ExecutionPolicyServiceV1 } from './execution-policy';
import type { TaskActionServiceV1 } from './task-actions';
import type { ProfileServiceV1 } from './profile';
import type { GithubSettingsServiceV1 } from './github-settings';
import type { JiraSettingsServiceV1 } from './jira-settings';
import type { LocalGitServiceV1 } from './local-git';
import type { CampaignServiceV1 } from './campaigns';
import type { TerminalServiceV1 } from './terminal';
import type { CommunicationServiceV1 } from './communication';
import type { CommunicationCommandServiceV1 } from './communication-command';
import type { PullRequestCommandServiceV1 } from './pull-request-command';
import type { ClarificationReadServiceV1 } from './clarification-read';
import type { ClarificationCommandServiceV1 } from './clarification-command';
import type { SuggestedContactAdminServiceV1 } from './suggested-contact-admin';
import type { SourceAdminServiceV1 } from './source-admin';
import type { PresentationLocatorV1 } from './presentation';
import type { TodoLegacyRecoveryServiceV1 } from './todo-legacy-recovery';
import type { PluginPageInstance, PluginPageState } from './sdk';
import type { TaskReadServiceV1 } from './task-read';
import type { RunReadServiceV1 } from './run-read';
import type { RunInspectServiceV1 } from './run-inspect';
import type { DownloadServiceV1 } from './download';
import type { PullRequestReadServiceV1 } from './pull-request-read';
import type { PullRequestInspectServiceV1 } from './pull-request-inspect';
import type { ActivityReadServiceV1 } from './activity-read';
import type { RunCommandServiceV1 } from './run-command';
import type { TaskEditServiceV1 } from './task-edit';
import type { SourceCommandServiceV1 } from './source-command';
import type { TaskViewsReadServiceV1 } from './task-views';
import type { TaskContextServiceV1 } from './task-context';

export interface PluginServiceRequirementV1 {
  readonly id: 'helmsman/task-read' | 'helmsman/task-edit' | 'helmsman/todo-legacy-recovery' | 'helmsman/task-action' | 'helmsman/source-command' | 'helmsman/source-admin' | 'helmsman/task-views-read' | 'helmsman/run-read' | 'helmsman/run-inspect' | 'helmsman/download' | 'helmsman/clarification-read' | 'helmsman/clarification-command' | 'helmsman/suggested-contact-admin' | 'helmsman/pull-request-read' | 'helmsman/pull-request-inspect' | 'helmsman/pull-request-command' | 'helmsman/communication' | 'helmsman/communication-command' | 'helmsman/terminal' | 'helmsman/campaigns' | 'helmsman/jira-settings' | 'helmsman/github-settings' | 'helmsman/profile' | 'helmsman/execution-policy' | 'helmsman/local-git' | 'helmsman/activity-read' | 'helmsman/run-command' | 'helmsman/composition';
  readonly version: 1;
}

export interface PanelContractV1 {
  readonly id: string;
  readonly version: 1;
}

export interface PluginPanelDefinition {
  readonly id: string;
  readonly title: string;
  readonly contract: PanelContractV1;
  readonly requires: readonly PluginServiceRequirementV1[];
}

export interface PageCompositionDefinitionV1 {
  readonly id: string;
  readonly version: 1;
  readonly accepts: readonly PanelContractV1[];
  readonly initialLayout?: InitialCompositionLayoutV1;
}

export interface InitialCompositionLayoutV1 {
  readonly instances: readonly Pick<PanelLayoutInstanceV1, 'instanceId' | 'contributionId'>[];
  readonly columns: readonly (readonly PanelLayoutStackV1[])[];
}

export interface RegisteredPluginPanel extends PluginPanelDefinition {
  readonly contributionId: string;
  readonly pluginId: string;
}

export type PanelScopeV1 = { readonly kind: 'inherit' } | { readonly kind: 'all' }
  | { readonly kind: 'galleon'; readonly repo: string };

export interface PanelOpaqueStateV1 {
  readonly version: number;
  readonly value: unknown;
}

export interface PanelLayoutInstanceV1 {
  readonly instanceId: string;
  readonly contributionId: string;
  readonly hidden: boolean;
  readonly scope: PanelScopeV1;
  readonly state: Readonly<Record<string, PanelOpaqueStateV1>>;
}

export interface PanelLayoutStackV1 {
  readonly instances: readonly string[];
  readonly activeInstanceId: string;
  readonly collapsed: boolean;
}

export interface CompositionLayoutV1 {
  readonly version: 1;
  readonly compositionId: string;
  readonly revision: number;
  readonly instances: readonly PanelLayoutInstanceV1[];
  readonly columns: readonly (readonly PanelLayoutStackV1[])[];
}

export interface PanelActivityV1 {
  readonly epoch: number;
  readonly signal: AbortSignal;
  readonly active: boolean;
  readonly repo: string | null;
}

export interface PluginPanelState extends PluginPageState {
  readonly headerRepo?: string | null;
  readonly instanceId: string;
  readonly activity: PanelActivityV1;
  readonly savedState: PanelOpaqueStateV1 | null;
  readonly routeState?: PanelOpaqueStateV1 | null;
}

export interface PluginPanelContext {
  readonly contributionId?: string;
  readonly selectPresentation?: (locator: PresentationLocatorV1 | null) => void;
  readonly state: PluginPanelState;
  readonly signal: AbortSignal;
  readonly activity: PanelActivityV1;
  readonly services: PluginPanelServicesV1;
  readonly navigate: (href: string) => void;
  readonly onDispose: (cleanup: () => void) => void;
  readonly saveState: (state: PanelOpaqueStateV1 | null) => Promise<void>;
  readonly compareAndSetState?: (expected: PanelOpaqueStateV1 | null, state: PanelOpaqueStateV1 | null) => Promise<void>;
  readonly setScope?: (scope: PanelScopeV1) => Promise<void>;
}

export interface PluginPanelServicesV1 {
  readonly version: 1;
  readonly tasks?: TaskReadServiceV1;
  readonly taskEdit?: TaskEditServiceV1;
  readonly todoLegacyRecovery?: TodoLegacyRecoveryServiceV1;
  readonly sourceCommands?: SourceCommandServiceV1;
  readonly sourceAdmin?: SourceAdminServiceV1;
  readonly taskViews?: TaskViewsReadServiceV1;
  readonly taskContext?: TaskContextServiceV1;
  readonly taskActions?: TaskActionServiceV1;
  readonly runs?: RunReadServiceV1;
  readonly runInspect?: RunInspectServiceV1;
  readonly downloads?: DownloadServiceV1;
  readonly clarifications?: ClarificationReadServiceV1;
  readonly clarificationCommands?: ClarificationCommandServiceV1;
  readonly suggestedContacts?: SuggestedContactAdminServiceV1;
  readonly pullRequests?: PullRequestReadServiceV1;
  readonly pullRequestInspect?: PullRequestInspectServiceV1;
  readonly pullRequestCommands?: PullRequestCommandServiceV1;
  readonly communication?: CommunicationServiceV1;
  readonly terminal?: TerminalServiceV1;
  readonly campaigns?: CampaignServiceV1;
  readonly jiraSettings?: JiraSettingsServiceV1;
  readonly githubSettings?: GithubSettingsServiceV1;
  readonly profile?: ProfileServiceV1;
  readonly executionPolicy?: ExecutionPolicyServiceV1;
  readonly localGit?: LocalGitServiceV1;
  readonly communicationCommands?: CommunicationCommandServiceV1;
  readonly activity?: ActivityReadServiceV1;
  readonly runCommands?: RunCommandServiceV1;
}

export interface PluginPanelInstance extends Omit<PluginPageInstance, 'update'> {
  update(state: PluginPanelState): void | Promise<void>;
}

export interface PluginPanelModule {
  mount(container: HTMLElement, context: PluginPanelContext): PluginPanelInstance | Promise<PluginPanelInstance>;
}

export interface ManagedPanelInstanceV1 {
  readonly instanceId: string;
  setActive(active: boolean): void;
  refresh(): Promise<void>;
  dispose(): void;
}

export interface CompositionServiceV1 {
  readonly version: 1;
  readonly compositionId: string;
  discover(): readonly RegisteredPluginPanel[];
  readLayout(): Promise<CompositionLayoutV1>;
  updateLayout(layout: CompositionLayoutV1, expectedRevision: number): Promise<CompositionLayoutV1>;
  subscribe(listener: () => void): () => void;
  mount(instanceId: string, container: HTMLElement): Promise<ManagedPanelInstanceV1>;
}
