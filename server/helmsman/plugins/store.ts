import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { COSTS_PAGE_ID, COSTS_PAGE_SLOT } from '../../../src/plugins/builtins';
import { isContributionId, isPluginId } from '../../../src/plugins/manifest';
import { installPluginArtifact, parsePluginArchive, readPluginArtifact, type PluginArchive } from './artifacts';
import { validatePluginImports } from './imports';
import { builtinPluginPackage, clearPluginSettings, setBuiltinPluginEnabled, writePluginSettings } from './data';

export interface InstalledPlugin { id: string; hash: string; enabled: boolean; }
export interface PluginInstallationState { plugins: InstalledPlugin[]; bindings: Record<string, string>; }
export interface PluginSnapshot {
  catalog: { version: 1; safeMode: boolean; plugins: { package: PluginArchive['package']; hash: string }[]; bindings: Record<string, string> };
  artifacts: ReadonlyMap<string, PluginArchive>;
  errors: string[];
}

export function pluginDirectory(): string {
  return process.env.HELMSMAN_PLUGINS_DIR ?? join(homedir(), '.helmsman', 'plugins');
}

function database(root: string): Database.Database {
  mkdirSync(root, { recursive: true });
  const db = new Database(join(root, 'catalog.sqlite'));
  try {
    db.pragma('busy_timeout = 5000');
    db.exec('CREATE TABLE IF NOT EXISTS plugin_packages (id TEXT PRIMARY KEY, hash TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))); CREATE TABLE IF NOT EXISTS plugin_bindings (slot TEXT PRIMARY KEY, contribution TEXT NOT NULL)');
    return db;
  } catch (error) { db.close(); throw error; }
}

function installed(db: Database.Database): InstalledPlugin[] {
  const rows = db.prepare('SELECT id, hash, enabled FROM plugin_packages ORDER BY id').all() as { id: unknown; hash: unknown; enabled: unknown }[];
  if (rows.length > 32 || rows.some(row => !isPluginId(row?.id) || row.id.startsWith('helmsman.')
    || typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash) || row.enabled !== 0 && row.enabled !== 1)) {
    throw new Error('Plugin installation records are invalid.');
  }
  return rows.map(row => ({ id: row.id as string, hash: row.hash as string, enabled: row.enabled === 1 }));
}

export function readPluginState(root: string): PluginInstallationState {
  const db = database(root);
  try {
    return db.transaction(() => {
      const rows = db.prepare('SELECT slot, contribution FROM plugin_bindings').all() as { slot: unknown; contribution: unknown }[];
      const bindings: Record<string, string> = {};
      for (const row of rows) {
        if (row?.slot !== COSTS_PAGE_SLOT || !isContributionId(row.contribution)) throw new Error('Plugin page bindings are invalid.');
        bindings[row.slot] = row.contribution;
      }
      return { plugins: installed(db), bindings };
    })();
  } finally { db.close(); }
}

function compatible(archive: PluginArchive, nodeMajor = Number(process.versions.node.split('.')[0])): void {
  const range = archive.package.node;
  if (!Number.isSafeInteger(nodeMajor) || nodeMajor < range.minMajor || nodeMajor >= range.maxMajorExclusive) {
    throw new Error(`Plugin ${archive.package.manifest.id} does not support Node ${nodeMajor}.`);
  }
}

export async function installPlugin(root: string, bytes: Uint8Array): Promise<InstalledPlugin> {
  const parsed = parsePluginArchive(bytes);
  compatible(parsed);
  await validatePluginImports(parsed);
  const current = readPluginState(root).plugins;
  const previous = current.find(plugin => plugin.id === parsed.package.manifest.id);
  if (previous?.enabled && previous.hash !== parsed.hash) throw new Error('Disable the plugin before installing another version, then restart Helmsman.');
  if (!previous && current.length >= 32) throw new Error('At most 32 external plugins may be installed.');
  const archive = await installPluginArtifact(root, bytes);
  const id = archive.package.manifest.id;
  const db = database(root);
  try {
    return db.transaction(() => {
      const plugins = installed(db);
      const previous = plugins.find(plugin => plugin.id === id);
      if (previous?.hash === archive.hash) return previous;
      if (previous?.enabled) throw new Error('Disable the plugin before installing another version, then restart Helmsman.');
      if (!previous && plugins.length >= 32) throw new Error('At most 32 external plugins may be installed.');
      db.prepare('INSERT INTO plugin_packages(id, hash, enabled) VALUES (?, ?, 0) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, enabled = 0').run(id, archive.hash);
      return { id, hash: archive.hash, enabled: false };
    })();
  } finally { db.close(); }
}

export async function setPluginEnabled(root: string, id: string, enabled: boolean): Promise<void> {
  if (id.startsWith('helmsman.')) { setBuiltinPluginEnabled(root, id, enabled); return; }
  const plugin = readPluginState(root).plugins.find(plugin => plugin.id === id);
  if (!plugin) throw new Error(`Plugin is not installed: ${id}`);
  if (enabled) {
    const archive = await readPluginArtifact(root, plugin.hash);
    if (archive.package.manifest.id !== id) throw new Error('Plugin artifact identity does not match its installation.');
    compatible(archive);
    await validatePluginImports(archive);
  }
  const db = database(root);
  try {
    const result = db.prepare('UPDATE plugin_packages SET enabled = ? WHERE id = ? AND hash = ?').run(enabled ? 1 : 0, id, plugin.hash);
    if (result.changes !== 1) throw new Error('Plugin installation changed; retry the operation.');
  } finally { db.close(); }
}

export async function configurePlugin(root: string, id: string, input: unknown) {
  const builtin = id.startsWith('helmsman.') ? builtinPluginPackage(root, id) : null;
  const installed = builtin ? null : readPluginState(root).plugins.find(plugin => plugin.id === id);
  const pkg = builtin ?? (installed ? (await readPluginArtifact(root, installed.hash)).package : null);
  if (!pkg) throw new Error(`Plugin is not installed: ${id}`);
  return writePluginSettings(root, pkg, input);
}

export function resetPluginSettings(root: string, id: string, key?: string): void {
  const builtin = id.startsWith('helmsman.') ? builtinPluginPackage(root, id) : null;
  if (!builtin && !readPluginState(root).plugins.some(plugin => plugin.id === id)) throw new Error(`Plugin is not installed: ${id}`);
  clearPluginSettings(root, id, key);
}

export async function selectPluginPage(root: string, slot: string, contribution: string | null): Promise<void> {
  if (slot !== COSTS_PAGE_SLOT || contribution !== null && !isContributionId(contribution)) throw new Error('Invalid page slot or contribution.');
  if (contribution && contribution !== COSTS_PAGE_ID) {
    const plugin = readPluginState(root).plugins.find(plugin => contribution.startsWith(`${plugin.id}/`));
    if (plugin) {
      const artifact = await readPluginArtifact(root, plugin.hash);
      const page = artifact.package.manifest.pages.find(page => `${plugin.id}/${page.id}` === contribution);
      if (!page?.slots.includes(slot)) throw new Error('The installed contribution does not support this slot.');
    }
  }
  const db = database(root);
  try {
    if (contribution === null) db.prepare('DELETE FROM plugin_bindings WHERE slot = ?').run(slot);
    else db.prepare('INSERT INTO plugin_bindings(slot, contribution) VALUES (?, ?) ON CONFLICT(slot) DO UPDATE SET contribution = excluded.contribution').run(slot, contribution);
  } finally { db.close(); }
}

export async function loadPluginSnapshot(root: string, safeMode = false): Promise<PluginSnapshot> {
  const snapshot: PluginSnapshot = { catalog: { version: 1, safeMode, plugins: [], bindings: {} }, artifacts: new Map(), errors: [] };
  let state: PluginInstallationState;
  try { state = readPluginState(root); } catch {
    snapshot.catalog.safeMode = true;
    snapshot.errors.push('Plugin catalog could not be read; optional page loading is disabled.');
    return snapshot;
  }
  snapshot.catalog.bindings = state.bindings;
  if (safeMode) return snapshot;
  const artifacts = new Map<string, PluginArchive>();
  for (const plugin of state.plugins.filter(plugin => plugin.enabled)) {
    try {
      const artifact = await readPluginArtifact(root, plugin.hash);
      if (artifact.package.manifest.id !== plugin.id) throw new Error('Artifact identity mismatch.');
      compatible(artifact);
      await validatePluginImports(artifact);
      artifacts.set(`${plugin.id}/${plugin.hash}`, artifact);
      snapshot.catalog.plugins.push({ package: artifact.package, hash: plugin.hash });
    } catch {
      snapshot.errors.push(`Plugin ${plugin.id} could not be loaded; its pages remain unavailable.`);
    }
  }
  snapshot.artifacts = artifacts;
  return snapshot;
}
