import { isPluginId } from '../../../src/plugins/manifest';
import type { PluginPackage } from '../../../src/plugins/package';
import { PersistenceConflictError } from '../persistence';
import { parsePluginArchive, readPluginArtifact, type PluginArchive } from './artifacts';
import { builtinFrontendPackages } from './builtin-frontend';
import { assertPluginNodeCompatibility } from './compatibility';
import { validatePluginImports } from './imports';
import type { PluginLifecycleRecord } from './lifecycle';
import { installPlugin, readPluginState, type PluginCoordinator } from './store';

type Expected = { hash: string; revision: number; desiredEnabled: boolean };
type PluginEntry = {
  id: string; name: string; version: string; kind: 'builtin' | 'external'; hash: string;
  desiredEnabled: boolean; health: PluginLifecycleRecord['health']; state: PluginLifecycleRecord['state'];
  revision: number; obligationsOnly: boolean;
};

export class PluginManagementError extends Error {
  readonly status: 400 | 409;
  constructor(message: string, status: 400 | 409) { super(message); this.status = status; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function expected(value: unknown): Expected | null {
  if (value === null) return null;
  if (!object(value) || !exact(value, ['hash', 'revision', 'desiredEnabled'])
    || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || typeof value.desiredEnabled !== 'boolean') throw new PluginManagementError('Invalid expected plugin state.', 400);
  return value as Expected;
}

function selected(row: PluginLifecycleRecord | null): Expected | null {
  return row ? { hash: row.artifactHash, revision: row.revision, desiredEnabled: row.desiredEnabled } : null;
}

function assertSelected(coordinator: PluginCoordinator, id: string, input: Expected | null): PluginLifecycleRecord | null {
  const row = coordinator.state(id);
  const current = selected(row);
  const changed = input === null || current === null ? input !== current
    : input.hash !== current.hash || input.revision !== current.revision || input.desiredEnabled !== current.desiredEnabled;
  if (changed) {
    throw new PluginManagementError('Plugin selection changed. Refresh before trying again.', 409);
  }
  return row;
}

function pluginId(value: unknown): string {
  if (!isPluginId(value)) throw new PluginManagementError('Invalid plugin ID.', 400);
  return value;
}

function archiveBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 20_971_520 || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new PluginManagementError('Invalid plugin archive encoding.', 400);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new PluginManagementError('Invalid plugin archive encoding.', 400);
  return bytes;
}

async function validateArchive(value: unknown): Promise<PluginArchive> {
  try {
    const archive = parsePluginArchive(archiveBytes(value));
    assertPluginNodeCompatibility(archive.package);
    await validatePluginImports(archive);
    return archive;
  } catch (error) {
    if (error instanceof PluginManagementError) throw error;
    throw new PluginManagementError(error instanceof Error ? error.message : 'Invalid plugin archive.', 400);
  }
}

function label(pkg: PluginPackage): string { return pkg.manifest.pages[0]?.title ?? pkg.manifest.id; }

export function createPluginManager(options: { root: string; coordinator: PluginCoordinator; builtins?: readonly PluginPackage[] }) {
  const { root, coordinator } = options;
  const builtins = [...builtinFrontendPackages, ...(options.builtins ?? [])];
  const initialSelections = new Map(coordinator.lifecycle.list().map(row => [row.pluginId, `${row.artifactHash}:${row.desiredEnabled}:${row.revision}`]));
  let mutationSucceeded = false;
  async function snapshot() {
    await coordinator.reconcile();
    const installed = readPluginState(root).plugins;
    const rows = coordinator.lifecycle.list();
    const restartRequired = mutationSucceeded || rows.length !== initialSelections.size
      || rows.some(row => initialSelections.get(row.pluginId) !== `${row.artifactHash}:${row.desiredEnabled}:${row.revision}`);
    const plugins: PluginEntry[] = [];
    for (const row of rows) {
      const builtin = builtins.find(pkg => pkg.manifest.id === row.pluginId);
      const external = installed.some(plugin => plugin.id === row.pluginId);
      if (!builtin && !external) continue;
      let pkg: PluginPackage | null = builtin ?? null;
      if (external) {
        try { pkg = (await readPluginArtifact(root, row.artifactHash)).package; }
        catch { pkg = null; }
      }
      plugins.push({ id: row.pluginId, name: pkg ? label(pkg) : row.pluginId, version: pkg?.manifest.version ?? 'unknown',
        kind: builtin ? 'builtin' : 'external', hash: row.artifactHash, desiredEnabled: row.desiredEnabled,
        health: row.health, state: row.state, revision: row.revision, obligationsOnly: row.obligationsOnly });
    }
    return { version: 1 as const, plugins, restartRequired, readOnly: false as const };
  }

  async function handle(input: unknown) {
    if (!object(input) || typeof input.action !== 'string') throw new PluginManagementError('Invalid plugin management request.', 400);
    if (input.action === 'inspect') {
      if (!exact(input, ['action', 'archiveBase64'])) throw new PluginManagementError('Invalid plugin inspection request.', 400);
      const archive = await validateArchive(input.archiveBase64);
      const id = archive.package.manifest.id;
      return { version: 1 as const, preview: { id, name: label(archive.package), version: archive.package.manifest.version,
        hash: archive.hash, kind: 'external' as const, expected: selected(coordinator.state(id)) } };
    }
    if (input.action === 'install') {
      if (!exact(input, ['action', 'archiveBase64', 'confirmedHash', 'expected', 'trustConfirmed'])
        || input.trustConfirmed !== true || typeof input.confirmedHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.confirmedHash)) {
        throw new PluginManagementError('Installation requires a confirmed plugin archive.', 400);
      }
      const expectedState = expected(input.expected);
      const archive = await validateArchive(input.archiveBase64);
      if (archive.hash !== input.confirmedHash) throw new PluginManagementError('The selected plugin archive changed. Inspect it again.', 409);
      assertSelected(coordinator, archive.package.manifest.id, expectedState);
      if (expectedState?.desiredEnabled) throw new PluginManagementError('Disable the plugin before installing another version, then restart Helmsman.', 409);
      try {
        await installPlugin(root, archive.bytes, coordinator, expectedState && { artifactHash: expectedState.hash,
          revision: expectedState.revision, desiredEnabled: expectedState.desiredEnabled });
      } catch (error) {
        if (error instanceof PersistenceConflictError) throw new PluginManagementError(error.message, 409);
        throw error;
      }
      mutationSucceeded = true;
      return snapshot();
    }
    if (input.action === 'enable' || input.action === 'disable' || input.action === 'uninstall') {
      const fields = input.action === 'enable' ? ['action', 'id', 'expected', 'trustConfirmed'] : ['action', 'id', 'expected'];
      if (!exact(input, fields) || input.action === 'enable' && input.trustConfirmed !== true) {
        throw new PluginManagementError('Invalid plugin lifecycle request.', 400);
      }
      const id = pluginId(input.id);
      const expectedState = expected(input.expected);
      if (!expectedState) throw new PluginManagementError('Plugin selection changed. Refresh before trying again.', 409);
      const row = assertSelected(coordinator, id, expectedState);
      if (!row) throw new PluginManagementError('Plugin is unavailable.', 409);
      if (input.action === 'uninstall' && id.startsWith('helmsman.')) throw new PluginManagementError('Built-in plugins cannot be uninstalled.', 400);
      if (input.action === 'enable' && !id.startsWith('helmsman.')) {
        const archive = await readPluginArtifact(root, row.artifactHash);
        if (archive.package.manifest.id !== id) throw new PluginManagementError('Installed plugin identity changed.', 409);
        await validateArchive(archive.bytes.toString('base64'));
      }
      const intended = { artifactHash: expectedState.hash, revision: expectedState.revision, desiredEnabled: expectedState.desiredEnabled };
      try {
        if (input.action === 'uninstall') await coordinator.uninstall(id, intended);
        else await coordinator.change(id, input.action === 'enable', { expected: intended });
      } catch (error) {
        if (error instanceof PersistenceConflictError) throw new PluginManagementError(error.message, 409);
        throw error;
      }
      mutationSucceeded = true;
      return snapshot();
    }
    throw new PluginManagementError('Unknown plugin management action.', 400);
  }
  return { snapshot, handle };
}
