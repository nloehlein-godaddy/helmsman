import { parsePluginManifest } from './manifest';
import type { PluginManifest } from './sdk';
import { isLocalId } from './manifest';
import type { PluginBackendDefinition, PluginSetting } from './backend';

export interface PluginPackage {
  readonly packageVersion: 1;
  readonly manifest: PluginManifest;
  readonly node: { readonly minMajor: number; readonly maxMajorExclusive: number };
  readonly entries: Readonly<Record<string, string>>;
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
  const input = record(value, ['entry', 'provides', 'settings', 'storageVersion'], 'Backend');
  if (!isPluginAssetPath(input.entry) || !/\.m?js$/.test(input.entry) || input.storageVersion !== 1) throw new PluginPackageError('Invalid backend entry or storage version.');
  if (!Array.isArray(input.provides) || input.provides.length > 16) throw new PluginPackageError('Invalid backend capabilities.');
  const provides = input.provides.map(value => {
    const item = record(value, ['id', 'version', 'localId'], 'Capability');
    if (item.id !== 'helmsman/pricing' || item.version !== 1 || !isLocalId(item.localId)) throw new PluginPackageError('Unsupported backend capability.');
    return Object.freeze({ id: 'helmsman/pricing' as const, version: 1 as const, localId: item.localId });
  });
  if (new Set(provides.map(item => item.localId)).size !== provides.length) throw new PluginPackageError('Duplicate backend capability.');
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
  return Object.freeze({ entry: input.entry, provides: Object.freeze(provides), settings: Object.freeze(settings), storageVersion: 1 });
}

export function validatePluginSetting(schema: PluginSetting, value: unknown): void {
  if (schema.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) || value < schema.minimum || value > schema.maximum
    : schema.type === 'string' ? typeof value !== 'string' || value.length > schema.maxLength
      : typeof value !== 'boolean') throw new PluginPackageError('Setting value does not match its declared schema.');
}

export function parsePluginPackage(value: unknown, options: { allowBuiltin?: boolean } = {}): PluginPackage {
  const copied = copyData(value);
  const hasBackend = copied && typeof copied === 'object' && Object.hasOwn(copied, 'backend');
  const input = record(copied, ['packageVersion', 'manifest', 'node', 'entries', ...(hasBackend ? ['backend'] : [])], 'Package');
  if (input.packageVersion !== 1) throw new PluginPackageError('Unsupported package version.');
  const manifest = parsePluginManifest(input.manifest);
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
  return Object.freeze({ packageVersion: 1, manifest,
    node: Object.freeze({ minMajor, maxMajorExclusive }), entries: Object.freeze(parsedEntries),
    ...(hasBackend ? { backend: parseBackend(input.backend) } : {}) });
}
