import type { PluginPageInstance, PluginPageState } from './sdk';
import type { TaskReadServiceV1 } from './task-read';
import type { RunReadServiceV1 } from './run-read';
import type { PullRequestReadServiceV1 } from './pull-request-read';
import type { ActivityReadServiceV1 } from './activity-read';
import type { RunCommandServiceV1 } from './run-command';

export interface PluginServiceRequirementV1 {
  readonly id: 'helmsman/task-read' | 'helmsman/run-read' | 'helmsman/pull-request-read' | 'helmsman/activity-read' | 'helmsman/run-command' | 'helmsman/composition';
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
  readonly instanceId: string;
  readonly activity: PanelActivityV1;
  readonly savedState: PanelOpaqueStateV1 | null;
  readonly routeState?: PanelOpaqueStateV1 | null;
}

export interface PluginPanelContext {
  readonly state: PluginPanelState;
  readonly signal: AbortSignal;
  readonly activity: PanelActivityV1;
  readonly services: PluginPanelServicesV1;
  readonly navigate: (href: string) => void;
  readonly onDispose: (cleanup: () => void) => void;
  readonly saveState: (state: PanelOpaqueStateV1 | null) => Promise<void>;
}

export interface PluginPanelServicesV1 {
  readonly version: 1;
  readonly tasks?: TaskReadServiceV1;
  readonly runs?: RunReadServiceV1;
  readonly pullRequests?: PullRequestReadServiceV1;
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
