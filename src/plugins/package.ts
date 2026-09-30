import { parseTaskSourceRemoteActionsV1 } from './task-action-declaration';
import type { TriggerDeclarationV1 } from './trigger';
import type { WorkflowDeclarationV1 } from './workflow';
import type { NativeTerminalDeclarationV1 } from './native-terminal';
import type { ExecutionHostDeclarationV1 } from './execution-host';
import type { AgentDeclarationV1 } from './agent-provider';
import type { SchedulingDeclaration } from './scheduling-provider';
import { parseTaskEditorDeclarationV1 } from './task-edit';
import { parseSourceSettingFieldsV1 } from './source-settings';
import { parsePluginManifest } from './manifest';
import type { PluginManifest } from './sdk';
import { isLocalId } from './manifest';
import type { CommunicationDeclaration, PluginBackendDefinition, PluginSetting, PullRequestDeclaration, TaskSourceDeclaration } from './backend';

export interface PluginPackage {
  readonly packageVersion: 1;
  readonly manifest: PluginManifest;
  readonly node: { readonly minMajor: number; readonly maxMajorExclusive: number };
  readonly entries: Readonly<Record<string, string>>;
  readonly panelEntries?: Readonly<Record<string, string>>;
  readonly backend?: PluginBackendDefinition;
}

export class PluginPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginPackageError';
  }
}

export function isPluginAssetPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && value.split('/').every(part => part.length <= 128 && /^[A-Za-z0-9_-]/.test(part)
      && !/[^A-Za-z0-9_.-]/.test(part));
}

function copyData(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new PluginPackageError('Package nesting exceeds the limit.');
  if (value === null || typeof value !== 'object') {
    if (['string', 'number', 'boolean'].includes(typeof value) || value === null) return value;
    throw new PluginPackageError('Package values must be JSON data.');
  }
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new PluginPackageError('Package records must be plain objects.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1024) throw new PluginPackageError('Package contains too many fields.');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !('value' in descriptor)
      || array && !/^(0|[1-9]\d*)$/.test(key)) {
      throw new PluginPackageError('Package fields must be data properties.');
    }
    result[key] = copyData(descriptor.value, depth + 1);
  }
  if (!array) return result;
  if (Object.keys(result).length !== value.length) throw new PluginPackageError('Package arrays must be dense.');
  return Array.from({ length: value.length }, (_, index) => result[String(index)]);
}

function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length
    || fields.some(key => !Object.hasOwn(value, key))) {
    throw new PluginPackageError(`${label} must declare exactly: ${fields.join(', ')}.`);
  }
  return value as Record<string, unknown>;
}

function parseBackend(value: unknown): PluginBackendDefinition {
  const hasSources = value !== null && typeof value === 'object' && Object.hasOwn(value, 'taskSources');
  const hasPullRequests = value !== null && typeof value === 'object' && Object.hasOwn(value, 'pullRequests');
  const hasTriggers = value !== null && typeof value === 'object' && Object.hasOwn(value, 'triggers');
  const hasWorkflows = value !== null && typeof value === 'object' && Object.hasOwn(value, 'workflows');
  const hasNativeTerminals = value !== null && typeof value === 'object' && Object.hasOwn(value, 'nativeTerminals');
  const hasExecutionHosts = value !== null && typeof value === 'object' && Object.hasOwn(value, 'executionHosts');
  const hasAgents = value !== null && typeof value === 'object' && Object.hasOwn(value, 'agents');
  const hasScheduling = value !== null && typeof value === 'object' && Object.hasOwn(value, 'scheduling');
  const hasCommunications = value !== null && typeof value === 'object' && Object.hasOwn(value, 'communications');
  const input = record(value, ['entry', 'provides', 'settings', 'storageVersion', ...(hasSources ? ['taskSources'] : []), ...(hasPullRequests ? ['pullRequests'] : []), ...(hasCommunications ? ['communications'] : []), ...(hasScheduling ? ['scheduling'] : []), ...(hasAgents ? ['agents'] : []), ...(hasExecutionHosts ? ['executionHosts'] : []), ...(hasNativeTerminals ? ['nativeTerminals'] : []), ...(hasWorkflows ? ['workflows'] : []), ...(hasTriggers ? ['triggers'] : [])], 'Backend');
  if (!isPluginAssetPath(input.entry) || !/\.m?js$/.test(input.entry) || input.storageVersion !== 1) throw new PluginPackageError('Invalid backend entry or storage version.');
  if (!Array.isArray(input.provides) || input.provides.length > 16) throw new PluginPackageError('Invalid backend capabilities.');
  const provides = input.provides.map(value => {
    const item = record(value, ['id', 'version', 'localId'], 'Capability');
    if (!['helmsman/pricing', 'helmsman/task-source', 'helmsman/pull-request', 'helmsman/communication', 'helmsman/scheduling', 'helmsman/agent', 'helmsman/execution-host', 'helmsman/native-terminal', 'helmsman/workflow', 'helmsman/trigger'].includes(String(item.id)) || item.version !== 1 || !isLocalId(item.localId)) throw new PluginPackageError('Unsupported backend capability.');
    return Object.freeze({ id: item.id as 'helmsman/pricing' | 'helmsman/task-source' | 'helmsman/pull-request' | 'helmsman/communication' | 'helmsman/scheduling' | 'helmsman/agent' | 'helmsman/execution-host' | 'helmsman/native-terminal' | 'helmsman/workflow' | 'helmsman/trigger', version: 1 as const, localId: item.localId });
  });
  if (new Set(provides.map(item => item.localId)).size !== provides.length) throw new PluginPackageError('Duplicate backend capability.');
  const sourceIds = provides.filter(item => item.id === 'helmsman/task-source').map(item => item.localId);
  if (hasSources !== (sourceIds.length > 0)) throw new PluginPackageError('Task sources require matching access declarations.');
  const pullRequestIds = provides.filter(item => item.id === 'helmsman/pull-request').map(item => item.localId);
  if (hasPullRequests !== (pullRequestIds.length > 0)) throw new PluginPackageError('Pull request providers require matching access declarations.');
  const communicationIds = provides.filter(item => item.id === 'helmsman/communication').map(item => item.localId);
  if (hasCommunications !== (communicationIds.length > 0)) throw new PluginPackageError('Communication providers require matching access declarations.');
  const triggerIds = provides.filter(item => item.id === 'helmsman/trigger').map(item => item.localId);
  if (hasTriggers !== (triggerIds.length > 0) || hasTriggers && triggerIds.length !== provides.length) throw new PluginPackageError('Triggers require a trigger-only package with matching trigger policy declarations.');
  const triggers: Record<string, TriggerDeclarationV1> = Object.create(null);
  if (hasTriggers) {
    const declarations = record(input.triggers, triggerIds, 'Trigger providers');
    for (const localId of triggerIds) {
      const declaration = record(declarations[localId], ['access'], 'Trigger declaration');
      if (!Array.isArray(declaration.access) || declaration.access.length !== 1 || !['campaign-candidates', 'review-discovery', 'authenticated-event'].includes(String(declaration.access[0]))) throw new PluginPackageError('Triggers require trigger policy access.');
      triggers[localId] = Object.freeze({ access: Object.freeze([...declaration.access]) as TriggerDeclarationV1['access'] });
    }
  }
  const workflowIds = provides.filter(item => item.id === 'helmsman/workflow').map(item => item.localId);
  if (hasWorkflows !== (workflowIds.length > 0) || hasWorkflows && workflowIds.length !== provides.length) throw new PluginPackageError('Workflows require a workflow-only package with matching workflow policy declarations.');
  const workflows: Record<string, WorkflowDeclarationV1> = Object.create(null);
  if (hasWorkflows) {
    const declarations = record(input.workflows, workflowIds, 'Workflow providers');
    for (const localId of workflowIds) {
      const declaration = record(declarations[localId], ['access'], 'Workflow declaration');
      if (!Array.isArray(declaration.access) || declaration.access.length !== 1 || declaration.access[0] !== 'workflow-policy') throw new PluginPackageError('Workflows require workflow policy access.');
      workflows[localId] = Object.freeze({ access: Object.freeze(['workflow-policy']) as readonly ['workflow-policy'] });
    }
  }
  const nativeTerminalIds = provides.filter(item => item.id === 'helmsman/native-terminal').map(item => item.localId);
  if (hasNativeTerminals !== (nativeTerminalIds.length > 0) || hasNativeTerminals && nativeTerminalIds.length !== provides.length) throw new PluginPackageError('Native terminals require a native-terminal-only package with matching native session declarations.');
  const nativeTerminals: Record<string, NativeTerminalDeclarationV1> = Object.create(null);
  if (hasNativeTerminals) {
    const declarations = record(input.nativeTerminals, nativeTerminalIds, 'Native terminal providers');
    for (const localId of nativeTerminalIds) {
      const declaration = record(declarations[localId], ['access'], 'Native terminal declaration');
      if (!Array.isArray(declaration.access) || declaration.access.length !== 1 || declaration.access[0] !== 'native-session') throw new PluginPackageError('Native terminals require native session access.');
      nativeTerminals[localId] = Object.freeze({ access: Object.freeze(['native-session']) as readonly ['native-session'] });
    }
  }
  const hostIds = provides.filter(item => item.id === 'helmsman/execution-host').map(item => item.localId);
  if (hasExecutionHosts !== (hostIds.length > 0) || hasExecutionHosts && hostIds.length !== provides.length) throw new PluginPackageError('Execution hosts require a host-only package with matching execution declarations.');
  const executionHosts: Record<string, ExecutionHostDeclarationV1> = Object.create(null);
  if (hasExecutionHosts) {
    const declarations = record(input.executionHosts, hostIds, 'Execution host providers');
    for (const localId of hostIds) {
      const declaration = record(declarations[localId], ['access'], 'Execution host declaration');
      if (!Array.isArray(declaration.access) || declaration.access.length !== 1 || declaration.access[0] !== 'execution') throw new PluginPackageError('Execution hosts require execution access.');
      executionHosts[localId] = Object.freeze({ access: Object.freeze(['execution']) as readonly ['execution'] });
    }
  }
  const agentIds = provides.filter(item => item.id === 'helmsman/agent').map(item => item.localId);
  if (hasAgents !== (agentIds.length > 0) || hasAgents && agentIds.length !== provides.length) throw new PluginPackageError('Agents require an agent-only package with matching process declarations.');
  const agents: Record<string, AgentDeclarationV1> = Object.create(null);
  if (hasAgents) {
    const declarations = record(input.agents, agentIds, 'Agent providers');
    for (const localId of agentIds) {
      const declaration = record(declarations[localId], ['access'], 'Agent declaration');
      if (!Array.isArray(declaration.access) || declaration.access.length !== 1 || declaration.access[0] !== 'process-description') throw new PluginPackageError('Agents require process description access.');
      agents[localId] = Object.freeze({ access: Object.freeze(['process-description']) as readonly ['process-description'] });
    }
  }
  const schedulingIds = provides.filter(item => item.id === 'helmsman/scheduling').map(item => item.localId);
  if (hasScheduling !== (schedulingIds.length > 0)) throw new PluginPackageError('Scheduling providers require matching access declarations.');
  const scheduling: Record<string, SchedulingDeclaration> = Object.create(null);
  if (hasScheduling) {
    const declarations = record(input.scheduling, schedulingIds, 'Scheduling providers');
    for (const localId of schedulingIds) {
      const declaration = record(declarations[localId], ['access'], 'Scheduling declaration');
      if (!Array.isArray(declaration.access) || declaration.access.length !== 1 || declaration.access[0] !== 'task-discovery') throw new PluginPackageError('Scheduling providers require scoped task discovery access.');
      scheduling[localId] = Object.freeze({ access: Object.freeze(['task-discovery']) as readonly ['task-discovery'] });
    }
  }
  const taskSources: Record<string, TaskSourceDeclaration> = Object.create(null) as Record<string, TaskSourceDeclaration>;
  if (hasSources) {
    const declarations = record(input.taskSources, sourceIds, 'Task sources');
    const strings = (value: unknown, valid: (item: unknown) => item is string, minimum: number, label: string): readonly string[] => {
      if (!Array.isArray(value) || value.length < minimum || value.length > 32 || !value.every(valid)
        || new Set(value).size !== value.length) throw new PluginPackageError(`Invalid task source ${label}.`);
      return Object.freeze([...value].sort());
    };
    for (const localId of sourceIds) {
      const rawDeclaration = declarations[localId];
      const hasEditors = rawDeclaration !== null && typeof rawDeclaration === 'object' && Object.hasOwn(rawDeclaration, 'editorContracts');
      const hasSettings = rawDeclaration !== null && typeof rawDeclaration === 'object' && Object.hasOwn(rawDeclaration, 'settingsFields');
      const hasRemoteActions = rawDeclaration !== null && typeof rawDeclaration === 'object' && Object.hasOwn(rawDeclaration, 'remoteActions');
      const hasReadViews = rawDeclaration !== null && typeof rawDeclaration === 'object' && Object.hasOwn(rawDeclaration, 'readViews');
      const declaration = record(rawDeclaration, ['identityFormats', 'effectIds', 'commandIds', 'access', ...(hasRemoteActions ? ['remoteActions'] : []), ...(hasReadViews ? ['readViews'] : []), ...(hasEditors ? ['editorContracts'] : []), ...(hasSettings ? ['settingsFields'] : [])], 'Task source declaration');
      const identityFormats = strings(declaration.identityFormats, (item): item is string => typeof item === 'string'
        && item.length <= 128 && /^[a-z][a-z0-9.-]*\/[a-z0-9.-]+$/.test(item), 1, 'identity formats');
      const effectIds = strings(declaration.effectIds, isLocalId, 0, 'effect IDs');
      const commandIds = strings(declaration.commandIds, isLocalId, 0, 'command IDs');
      const access = strings(declaration.access, (item): item is 'local-records' | 'connection-http' => item === 'local-records' || item === 'connection-http', 0, 'access') as TaskSourceDeclaration['access'];
      if (effectIds.length && !access.includes('connection-http') || commandIds.length && !access.includes('local-records')) throw new PluginPackageError('Task source handlers require their matching access capability.');
      const readViews = hasReadViews ? strings(declaration.readViews, (item): item is 'underway' | 'history' | 'triage' | 'bugs' => typeof item === 'string' && ['underway', 'history', 'triage', 'bugs'].includes(item), 0, 'read views') as TaskSourceDeclaration['readViews'] : undefined;
      let remoteActions;
      if (hasRemoteActions) {
        try { remoteActions = parseTaskSourceRemoteActionsV1(declaration.remoteActions, { effectIds, access }); } catch { throw new PluginPackageError('Invalid task remote action declarations.'); }
      }
      let editorContracts;
      if (hasEditors) {
        if (!Array.isArray(declaration.editorContracts) || declaration.editorContracts.length > 16) throw new PluginPackageError('Invalid task editor declarations.');
        try { editorContracts = Object.freeze(declaration.editorContracts.map(parseTaskEditorDeclarationV1)); } catch { throw new PluginPackageError('Invalid task editor declarations.'); }
        if (new Set(editorContracts.map(editor => editor.id)).size !== editorContracts.length || editorContracts.some(editor => Object.values(editor.commands).some(command => command !== null && !commandIds.includes(command)))) throw new PluginPackageError('Task editor commands must be declared.');
      }
      let settingsFields;
      if (hasSettings) {
        try { settingsFields = parseSourceSettingFieldsV1(declaration.settingsFields); } catch { throw new PluginPackageError('Invalid source setting declarations.'); }
      }
      taskSources[localId] = Object.freeze({ ...(remoteActions ? { remoteActions } : {}), ...(settingsFields ? { settingsFields } : {}), ...(editorContracts ? { editorContracts } : {}), identityFormats, effectIds, commandIds, access, ...(readViews ? { readViews } : {}) });
    }
  }
  const pullRequests: Record<string, PullRequestDeclaration> = Object.create(null) as Record<string, PullRequestDeclaration>;
  if (hasPullRequests) {
    const declarations = record(input.pullRequests, pullRequestIds, 'Pull request providers');
    for (const localId of pullRequestIds) {
      const declaration = record(declarations[localId], ['access'], 'Pull request declaration');
      if (!Array.isArray(declaration.access) || declaration.access.length !== 1 || declaration.access[0] !== 'core-http') {
        throw new PluginPackageError('Pull request providers require core HTTP access.');
      }
      pullRequests[localId] = Object.freeze({ access: Object.freeze(['core-http']) as unknown as readonly ['core-http'] });
    }
  }
  const communications: Record<string, CommunicationDeclaration> = Object.create(null) as Record<string, CommunicationDeclaration>;
  if (hasCommunications) {
    const declarations = record(input.communications, communicationIds, 'Communication providers');
    for (const localId of communicationIds) {
      const declaration = record(declarations[localId], ['access'], 'Communication declaration');
      if (!Array.isArray(declaration.access) || declaration.access.length !== 1 || !['browser-session', 'provider-network'].includes(declaration.access[0])) {
        throw new PluginPackageError('Communication providers require browser session or provider network access.');
      }
      communications[localId] = Object.freeze({ access: Object.freeze([declaration.access[0]]) as unknown as CommunicationDeclaration['access'] });
    }
  }
  if (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings) || Object.keys(input.settings).length > 64) throw new PluginPackageError('Invalid settings schema.');
  const settings: Record<string, PluginSetting> = {};
  for (const key of Object.keys(input.settings).sort()) {
    if (key.length > 64 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || /[^A-Za-z0-9_-]/.test(key)) throw new PluginPackageError('Invalid setting key.');
    const raw = (input.settings as Record<string, unknown>)[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PluginPackageError('Invalid setting schema.');
    const type = (raw as Record<string, unknown>).type;
    const schema = record(raw, type === 'number' ? ['type', 'default', 'minimum', 'maximum'] : type === 'string' ? ['type', 'default', 'maxLength'] : ['type', 'default'], 'Setting');
    if (type === 'number' && (typeof schema.minimum !== 'number' || typeof schema.maximum !== 'number'
      || !Number.isFinite(schema.minimum) || !Number.isFinite(schema.maximum) || schema.minimum > schema.maximum)
      || type === 'string' && (typeof schema.maxLength !== 'number' || !Number.isSafeInteger(schema.maxLength) || schema.maxLength < 1 || schema.maxLength > 4096)
      || !['number', 'string', 'boolean'].includes(String(type))) throw new PluginPackageError('Invalid setting constraints.');
    const parsed = Object.freeze({ ...schema }) as PluginSetting;
    validatePluginSetting(parsed, schema.default);
    settings[key] = parsed;
  }
  return Object.freeze({ entry: input.entry, provides: Object.freeze(provides), settings: Object.freeze(settings), storageVersion: 1,
    ...(hasTriggers ? { triggers: Object.freeze(triggers) } : {}),
    ...(hasWorkflows ? { workflows: Object.freeze(workflows) } : {}),
    ...(hasNativeTerminals ? { nativeTerminals: Object.freeze(nativeTerminals) } : {}),
    ...(hasExecutionHosts ? { executionHosts: Object.freeze(executionHosts) } : {}),
    ...(hasAgents ? { agents: Object.freeze(agents) } : {}),
    ...(hasScheduling ? { scheduling: Object.freeze(scheduling) } : {}),
    ...(hasSources ? { taskSources: Object.freeze(taskSources) } : {}),
    ...(hasPullRequests ? { pullRequests: Object.freeze(pullRequests) } : {}),
    ...(hasCommunications ? { communications: Object.freeze(communications) } : {}) });
}

export function validatePluginSetting(schema: PluginSetting, value: unknown): void {
  if (schema.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) || value < schema.minimum || value > schema.maximum
    : schema.type === 'string' ? typeof value !== 'string' || value.length > schema.maxLength
      : typeof value !== 'boolean') throw new PluginPackageError('Setting value does not match its declared schema.');
}

export function parsePluginPackage(value: unknown, options: { allowBuiltin?: boolean } = {}): PluginPackage {
  const copied = copyData(value);
  const hasBackend = copied && typeof copied === 'object' && Object.hasOwn(copied, 'backend');
  const hasPanels = copied && typeof copied === 'object' && Object.hasOwn(copied, 'panelEntries');
  const input = record(copied, ['packageVersion', 'manifest', 'node', 'entries', ...(hasPanels ? ['panelEntries'] : []), ...(hasBackend ? ['backend'] : [])], 'Package');
  if (input.packageVersion !== 1) throw new PluginPackageError('Unsupported package version.');
  const manifest = parsePluginManifest(input.manifest);
  if (hasPanels !== (manifest.manifestVersion === 2)) throw new PluginPackageError('Manifest version 2 requires a separate panel entry map.');
  if (manifest.id.startsWith('helmsman.') && !options.allowBuiltin) throw new PluginPackageError('The helmsman namespace is reserved for builtins.');
  const node = record(input.node, ['minMajor', 'maxMajorExclusive'], 'Node compatibility');
  const minMajor = node.minMajor;
  const maxMajorExclusive = node.maxMajorExclusive;
  if (typeof minMajor !== 'number' || typeof maxMajorExclusive !== 'number'
    || !Number.isSafeInteger(minMajor) || !Number.isSafeInteger(maxMajorExclusive)
    || minMajor < 1 || maxMajorExclusive > 1000 || minMajor >= maxMajorExclusive) {
    throw new PluginPackageError('Node compatibility must specify positive ordered integer bounds at most 1000.');
  }
  const entries = record(input.entries, manifest.pages.map(page => page.id), 'Entries');
  const parsedEntries: Record<string, string> = {};
  for (const id of Object.keys(entries).sort()) {
    const path = entries[id];
    if (!isPluginAssetPath(path) || !/\.m?js$/.test(path)) {
      throw new PluginPackageError('Page entries must reference safe relative .js or .mjs assets.');
    }
    parsedEntries[id] = path;
  }
  const panelEntries: Record<string, string> = {};
  if (manifest.manifestVersion === 2) {
    const entries = record(input.panelEntries, manifest.panels.map(panel => panel.id), 'Panel entries');
    for (const id of Object.keys(entries).sort()) {
      const path = entries[id];
      if (!isPluginAssetPath(path) || !/\.m?js$/.test(path)) throw new PluginPackageError('Panel entries must reference safe relative .js or .mjs assets.');
      panelEntries[id] = path;
    }
  }
  return Object.freeze({ packageVersion: 1, manifest,
    node: Object.freeze({ minMajor, maxMajorExclusive }), entries: Object.freeze(parsedEntries),
    ...(hasPanels ? { panelEntries: Object.freeze(panelEntries) } : {}),
    ...(hasBackend ? { backend: parseBackend(input.backend) } : {}) });
}
