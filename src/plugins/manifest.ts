import type { PluginManifest, PluginPageDefinition } from './sdk';
import type { InitialCompositionLayoutV1, PageCompositionDefinitionV1, PanelContractV1, PluginPanelDefinition, PluginServiceRequirementV1 } from './composition';

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginManifestError';
  }
}

const localId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const releaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isLocalId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && localId.test(value);
}

function isNamespace(value: unknown, requireDot: boolean): value is string {
  if (typeof value !== 'string' || value.length > 128) return false;
  const parts = value.split('.');
  return (!requireDot || parts.length > 1) && parts.every(isLocalId);
}

export function isPluginId(value: unknown): value is string {
  return isNamespace(value, true);
}

export function isContributionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const [namespace, id, extra] = value.split('/');
  return extra === undefined && isPluginId(namespace) && isLocalId(id);
}

export function isSlotId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const [namespace, id, extra] = value.split('/');
  return extra === undefined && isNamespace(namespace, false) && isLocalId(id);
}

function record(value: unknown, fields: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new PluginManifestError(`${label} must be an object.`);
  }
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...fields, ...optional].includes(key)
    || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {})))) {
    throw new PluginManifestError(`${label} contains unsupported fields.`);
  }
  if (fields.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor || !('value' in descriptor);
  })) throw new PluginManifestError(`${label} must declare every supported field as data.`);
  return value as Record<string, unknown>;
}

function identifiers(value: unknown, valid: (value: unknown) => value is string, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128 || !Array.from(value).every(valid) || new Set(value).size !== value.length) {
    throw new PluginManifestError(`${label} must contain unique valid identifiers.`);
  }
  return Object.freeze([...value]);
}

function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PluginManifestError('Contribution title must be nonempty text of at most 128 characters.');
  }
  return value;
}

function contract(value: unknown): PanelContractV1 {
  const input = record(value, ['id', 'version'], 'Panel contract');
  if (!isSlotId(input.id) || input.version !== 1) throw new PluginManifestError('Unsupported panel contract.');
  return Object.freeze({ id: input.id, version: 1 });
}

function requirements(value: unknown): readonly PluginServiceRequirementV1[] {
  if (!Array.isArray(value) || value.length > 16) throw new PluginManifestError('Invalid required services.');
  const parsed = Array.from(value, raw => {
    const item = record(raw, ['id', 'version'], 'Required service');
    if (item.version !== 1 || typeof item.id !== 'string' || !['helmsman/task-read', 'helmsman/task-edit', 'helmsman/todo-legacy-recovery', 'helmsman/source-command', 'helmsman/source-admin', 'helmsman/task-views-read', 'helmsman/run-read', 'helmsman/run-inspect', 'helmsman/download', 'helmsman/clarification-read', 'helmsman/clarification-command', 'helmsman/suggested-contact-admin', 'helmsman/pull-request-read', 'helmsman/activity-read', 'helmsman/run-command', 'helmsman/composition'].includes(item.id)) {
      throw new PluginManifestError('Unsupported required service.');
    }
    return Object.freeze({ id: item.id as PluginServiceRequirementV1['id'], version: 1 as const });
  });
  if (new Set(parsed.map(item => item.id)).size !== parsed.length) throw new PluginManifestError('Required services must be unique.');
  return Object.freeze(parsed);
}

function initialLayout(value: unknown): InitialCompositionLayoutV1 {
  const input = record(value, ['instances', 'columns'], 'Initial layout');
  if (!Array.isArray(input.instances) || input.instances.length > 128 || !Array.isArray(input.columns) || input.columns.length > 8) {
    throw new PluginManifestError('Invalid initial layout dimensions.');
  }
  const ids = new Set<string>();
  const instances = Array.from(input.instances, value => {
    const item = record(value, ['instanceId', 'contributionId'], 'Initial panel');
    if (typeof item.instanceId !== 'string' || !/^[a-z\d][a-z\d_.:-]{0,159}$/i.test(item.instanceId)
      || ids.has(item.instanceId) || !isContributionId(item.contributionId)) throw new PluginManifestError('Invalid initial panel identity.');
    ids.add(item.instanceId);
    return Object.freeze({ instanceId: item.instanceId, contributionId: item.contributionId });
  });
  const placed = new Set<string>();
  const columns = Array.from(input.columns, value => {
    if (!Array.isArray(value) || value.length > 128) throw new PluginManifestError('Invalid initial layout column.');
    return Object.freeze(Array.from(value, value => {
      const item = record(value, ['instances', 'activeInstanceId', 'collapsed'], 'Initial stack');
      if (!Array.isArray(item.instances) || !item.instances.length || item.instances.length > 128
        || typeof item.activeInstanceId !== 'string' || !item.instances.includes(item.activeInstanceId)
        || typeof item.collapsed !== 'boolean') throw new PluginManifestError('Invalid initial panel stack.');
      const members = Array.from(item.instances, id => {
        if (typeof id !== 'string' || !ids.has(id) || placed.has(id)) throw new PluginManifestError('Initial panels require exactly one stack.');
        placed.add(id); return id;
      });
      return Object.freeze({ instances: Object.freeze(members), activeInstanceId: item.activeInstanceId, collapsed: item.collapsed });
    }));
  });
  if (placed.size !== ids.size) throw new PluginManifestError('Initial panel is missing its stack.');
  return Object.freeze({ instances: Object.freeze(instances), columns: Object.freeze(columns) });
}

function composition(value: unknown): PageCompositionDefinitionV1 {
  const input = record(value, ['id', 'version', 'accepts'], 'Composition', ['initialLayout']);
  if (!isSlotId(input.id) || input.version !== 1 || !Array.isArray(input.accepts)
    || input.accepts.length < 1 || input.accepts.length > 32) throw new PluginManifestError('Invalid composition.');
  const accepts = Array.from(input.accepts, contract);
  if (new Set(accepts.map(item => item.id)).size !== accepts.length) throw new PluginManifestError('Composition contracts must be unique.');
  return Object.freeze({ id: input.id, version: 1, accepts: Object.freeze(accepts),
    ...(Object.hasOwn(input, 'initialLayout') ? { initialLayout: initialLayout(input.initialLayout) } : {}) });
}

function parsePanel(value: unknown): PluginPanelDefinition {
  const panel = record(value, ['id', 'title', 'contract', 'requires'], 'Panel');
  if (!isLocalId(panel.id)) throw new PluginManifestError('Panel ID is invalid.');
  return Object.freeze({ id: panel.id, title: title(panel.title), contract: contract(panel.contract), requires: requirements(panel.requires) });
}

function parsePage(value: unknown, version: 1 | 2): PluginPageDefinition {
  const page = record(value, ['id', 'title', 'slots', 'panes'], 'Page', version === 2 ? ['composition', 'requires'] : []);
  if (!isLocalId(page.id)) throw new PluginManifestError('Page ID is invalid.');
  return Object.freeze({
    id: page.id,
    title: title(page.title),
    slots: identifiers(page.slots, isSlotId, 'Page slots'),
    panes: identifiers(page.panes, isLocalId, 'Page panes'),
    ...(Object.hasOwn(page, 'composition') ? { composition: composition(page.composition) } : {}),
    ...(Object.hasOwn(page, 'requires') ? { requires: requirements(page.requires) } : {}),
  });
}

export function parsePluginManifest(value: unknown): PluginManifest {
  const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'manifestVersion') : undefined;
  const version: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (version !== 1 && version !== 2) throw new PluginManifestError('Unsupported manifest version.');
  const manifest = record(value, ['manifestVersion', 'id', 'version', 'sdkVersion', 'pages', ...(version === 2 ? ['panels'] : [])], 'Manifest');
  if (manifest.sdkVersion !== 1) throw new PluginManifestError('Unsupported SDK version.');
  if (!isPluginId(manifest.id)) throw new PluginManifestError('Plugin ID must have a publisher namespace.');
  if (typeof manifest.version !== 'string' || manifest.version.length > 128 || !releaseVersion.test(manifest.version)) {
    throw new PluginManifestError('Plugin version must be a semantic package version.');
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length > 128) throw new PluginManifestError('Manifest pages must be a bounded array.');
  const pages = Array.from(manifest.pages, page => parsePage(page, version));
  if (new Set(pages.map(page => page.id)).size !== pages.length) throw new PluginManifestError('Page IDs must be unique.');
  if (version === 2) {
    if (!Array.isArray(manifest.panels) || manifest.panels.length > 128) throw new PluginManifestError('Manifest panels must be a bounded array.');
    const panels = Array.from(manifest.panels, parsePanel);
    const ids = [...pages, ...panels].map(item => item.id);
    if (new Set(ids).size !== ids.length) throw new PluginManifestError('Contribution IDs must be unique across pages and panels.');
    return Object.freeze({ manifestVersion: 2, id: manifest.id, version: manifest.version, sdkVersion: 1,
      pages: Object.freeze(pages), panels: Object.freeze(panels) });
  }
  return Object.freeze({
    manifestVersion: 1, id: manifest.id, version: manifest.version, sdkVersion: 1,
    pages: Object.freeze(pages),
  });
}
