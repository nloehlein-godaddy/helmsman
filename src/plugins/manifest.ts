import type { PluginManifest, PluginPageDefinition } from './sdk';

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

function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new PluginManifestError(`${label} must be an object.`);
  }
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key))) {
    throw new PluginManifestError(`${label} contains unsupported fields.`);
  }
  if (fields.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor || !('value' in descriptor);
  })) throw new PluginManifestError(`${label} must declare every supported field as data.`);
  return value as Record<string, unknown>;
}

function identifiers(value: unknown, valid: (value: unknown) => value is string, label: string): readonly string[] {
  if (!Array.isArray(value) || !Array.from(value).every(valid) || new Set(value).size !== value.length) {
    throw new PluginManifestError(`${label} must contain unique valid identifiers.`);
  }
  return Object.freeze([...value]);
}

function parsePage(value: unknown): PluginPageDefinition {
  const page = record(value, ['id', 'title', 'slots', 'panes'], 'Page');
  if (!isLocalId(page.id)) throw new PluginManifestError('Page ID is invalid.');
  if (typeof page.title !== 'string' || !page.title.trim() || page.title.length > 128
    || /[\u0000-\u001f\u007f]/.test(page.title)) {
    throw new PluginManifestError('Page title must be nonempty text of at most 128 characters.');
  }
  return Object.freeze({
    id: page.id,
    title: page.title,
    slots: identifiers(page.slots, isSlotId, 'Page slots'),
    panes: identifiers(page.panes, isLocalId, 'Page panes'),
  });
}

export function parsePluginManifest(value: unknown): PluginManifest {
  const manifest = record(value, ['manifestVersion', 'id', 'version', 'sdkVersion', 'pages'], 'Manifest');
  if (manifest.manifestVersion !== 1) throw new PluginManifestError('Unsupported manifest version.');
  if (manifest.sdkVersion !== 1) throw new PluginManifestError('Unsupported SDK version.');
  if (!isPluginId(manifest.id)) throw new PluginManifestError('Plugin ID must have a publisher namespace.');
  if (typeof manifest.version !== 'string' || manifest.version.length > 128 || !releaseVersion.test(manifest.version)) {
    throw new PluginManifestError('Plugin version must be a semantic package version.');
  }
  if (!Array.isArray(manifest.pages)) throw new PluginManifestError('Manifest pages must be an array.');
  const pages = Array.from(manifest.pages, parsePage);
  if (new Set(pages.map(page => page.id)).size !== pages.length) throw new PluginManifestError('Page IDs must be unique.');
  return Object.freeze({
    manifestVersion: 1, id: manifest.id, version: manifest.version, sdkVersion: 1,
    pages: Object.freeze(pages),
  });
}
