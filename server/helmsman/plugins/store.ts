import Database from 'better-sqlite3';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { builtinPageSlots, supportsPageSlot } from '../../../src/plugins/frontend-manifests';
import { builtinFrontendPackages } from './builtin-frontend';
import { isContributionId, isPluginId } from '../../../src/plugins/manifest';
import { installPluginArtifact, parsePluginArchive, readPluginArtifact, type PluginArchive } from './artifacts';
import { validatePluginImports } from './imports';
import { builtinPluginPackage, builtinPluginEnabled, clearPluginSettings, projectPluginData, setBuiltinPluginEnabled, writePluginSettings } from './data';
import type { PluginPackage } from '../../../src/plugins/package';
import type { ArtifactBinding, ExecutionStore } from '../execution-store';
import { acknowledgePersistenceIntent, assertMaintenanceAvailable, immediateTransaction, pendingPersistenceIntents, PersistenceConflictError, persistenceHash, stableJson, type Persistence } from '../persistence';
import type { PluginLifecycle, PluginLifecycleRecord } from './lifecycle';
import { storeConnection } from '../store-connection';

export interface InstalledPlugin { id: string; hash: string; enabled: boolean; }
export interface PluginInstallationState { plugins: InstalledPlugin[]; bindings: Record<string, string>; }
export interface PluginSnapshot {
  catalog: { version: 1; safeMode: boolean; builtins?: { id: string; version: string; hash: string; enabled: boolean }[]; plugins: { package: PluginArchive['package']; hash: string }[]; bindings: Record<string, string> };
  artifacts: ReadonlyMap<string, PluginArchive>;
  errors: string[];
}

const frontendPageSlots: readonly string[] = builtinPageSlots.map(slot => slot.id);

export function pluginDirectory(): string {
  return process.env.HELMSMAN_PLUGINS_DIR ?? join(homedir(), '.helmsman', 'plugins');
}

function database(root: string): Database.Database {
  mkdirSync(root, { recursive: true });
  const connection = storeConnection(join(root, 'catalog.sqlite'));
  const db = connection.sql;
  try {
    db.pragma('busy_timeout = 5000');
    connection.migrate({ owner: 'core.plugins.catalog', optionalLegacyTables: ['plugin_projection_revisions'], ddl: `CREATE TABLE IF NOT EXISTS plugin_packages (id TEXT PRIMARY KEY, hash TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)));
      CREATE TABLE IF NOT EXISTS plugin_bindings (slot TEXT PRIMARY KEY, contribution TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_projection_revisions (pluginId TEXT PRIMARY KEY,revision INTEGER NOT NULL,artifactHash TEXT NOT NULL,enabled INTEGER NOT NULL)` });
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
        if (typeof row?.slot !== 'string' || !frontendPageSlots.includes(row.slot) || !isContributionId(row.contribution)) throw new Error('Plugin page bindings are invalid.');
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

export async function installPlugin(root: string, bytes: Uint8Array, coordinator?: PluginCoordinator): Promise<InstalledPlugin> {
  const parsed = parsePluginArchive(bytes);
  compatible(parsed);
  await validatePluginImports(parsed);
  const current = readPluginState(root).plugins;
  const previous = current.find(plugin => plugin.id === parsed.package.manifest.id);
  if (previous?.enabled && previous.hash !== parsed.hash) throw new Error('Disable the plugin before installing another version, then restart Helmsman.');
  if (!previous && current.length >= 32) throw new Error('At most 32 external plugins may be installed.');
  const archive = await installPluginArtifact(root, bytes);
  const id = archive.package.manifest.id;
  if (coordinator) {
    await coordinator.install(archive);
    const selected = readPluginState(root).plugins.find(plugin => plugin.id === id);
    if (!selected) throw new Error('Plugin catalog projection is incomplete');
    return selected;
  }
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

export async function setPluginEnabled(root: string, id: string, enabled: boolean, coordinator?: PluginCoordinator): Promise<void> {
  if (coordinator) { await coordinator.change(id, enabled); return; }
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
  if (!frontendPageSlots.includes(slot) || contribution !== null && !isContributionId(contribution)) throw new Error('Invalid page slot or contribution.');
  if (contribution?.startsWith('helmsman.')) {
    const pkg = builtinFrontendPackages.find(item => contribution.startsWith(`${item.manifest.id}/`));
    const page = pkg?.manifest.pages.find(item => `${pkg.manifest.id}/${item.id}` === contribution);
    if (!page || !supportsPageSlot(page, slot)) throw new Error('The built-in contribution does not support this slot.');
  } else if (contribution) {
    const plugin = readPluginState(root).plugins.find(plugin => contribution.startsWith(`${plugin.id}/`));
    if (plugin) {
      const artifact = await readPluginArtifact(root, plugin.hash);
      const page = artifact.package.manifest.pages.find(page => `${plugin.id}/${page.id}` === contribution);
      if (!page || !supportsPageSlot(page, slot)) throw new Error('The installed contribution does not support this slot.');
    }
  }
  const db = database(root);
  try {
    if (contribution === null) db.prepare('DELETE FROM plugin_bindings WHERE slot = ?').run(slot);
    else db.prepare('INSERT INTO plugin_bindings(slot, contribution) VALUES (?, ?) ON CONFLICT(slot) DO UPDATE SET contribution = excluded.contribution').run(slot, contribution);
  } finally { db.close(); }
}

export async function loadPluginSnapshot(root: string, safeMode = false, coordinator?: PluginCoordinator): Promise<PluginSnapshot> {
  const snapshot: PluginSnapshot = { catalog: { version: 1, safeMode, builtins: [], plugins: [], bindings: {} }, artifacts: new Map(), errors: [] };
  let state: PluginInstallationState;
  try { state = readPluginState(root); } catch {
    snapshot.catalog.safeMode = true;
    snapshot.errors.push('Plugin catalog could not be read; optional page loading is disabled.');
    return snapshot;
  }
  snapshot.catalog.bindings = state.bindings;
  for (const pkg of builtinFrontendPackages) {
    const id = pkg.manifest.id;
    const hash = coordinator?.builtinArtifactHash(id) ?? persistenceHash(pkg);
    let enabled = false;
    try {
      const desiredEnabled = builtinPluginEnabled(root, pkg);
      enabled = !safeMode && (coordinator ? coordinator.canActivate(id, hash) : desiredEnabled);
      if (coordinator && (enabled || coordinator.state(id)?.health === 'active')) {
        coordinator.lifecycle.recordHealth(id, hash, enabled ? 'active' : 'inactive', null);
      }
    } catch { snapshot.errors.push(`Built-in plugin ${id} state could not be read; its frontend remains unavailable.`); }
    snapshot.catalog.builtins!.push({ id, version: pkg.manifest.version, hash, enabled });
  }
  if (safeMode) return snapshot;
  const artifacts = new Map<string, PluginArchive>();
  for (const plugin of state.plugins.filter(plugin => coordinator ? coordinator.canActivate(plugin.id, plugin.hash) || coordinator.state(plugin.id)?.obligationsOnly : plugin.enabled)) {
    try {
      const artifact = await readPluginArtifact(root, plugin.hash);
      if (artifact.package.manifest.id !== plugin.id) throw new Error('Artifact identity mismatch.');
      compatible(artifact);
      await validatePluginImports(artifact);
      artifacts.set(`${plugin.id}/${plugin.hash}`, artifact);
      if (!coordinator || coordinator.canActivate(plugin.id, plugin.hash)) {
        snapshot.catalog.plugins.push({ package: artifact.package, hash: plugin.hash });
        if (coordinator && !artifact.package.backend) coordinator.lifecycle.recordHealth(plugin.id, plugin.hash, 'active', null);
      }
    } catch {
      snapshot.errors.push(`Plugin ${plugin.id} could not be loaded; its pages remain unavailable.`);
    }
  }
  snapshot.artifacts = artifacts;
  return snapshot;
}

export interface PluginCoordinator {
  readonly errors: readonly string[];
  readonly lifecycle: PluginLifecycle;
  reconcile(): Promise<void>;
  install(archive: PluginArchive): Promise<void>;
  change(id: string, enabled: boolean, options?: { drainDependents?: readonly string[] }): Promise<void>;
  uninstall(id: string): Promise<void>;
  state(id: string): PluginLifecycleRecord | null;
  canActivate(id: string, artifactHash?: string): boolean;
  builtinArtifactHash(id: string): string | null;
  subscribe(listener: () => void | Promise<void>): () => void;
  collect(hash: string): Promise<void>;
  dispose(): void;
}

function projectCatalog(root: string, input: { pluginId: string; artifactHash: string; desiredEnabled: boolean; revision: number; removed?: boolean }): void {
  const sql = database(root);
  try {
    immediateTransaction(sql, () => {
      const prior = sql.prepare('SELECT * FROM plugin_projection_revisions WHERE pluginId=?').get(input.pluginId) as { revision: number; artifactHash: string; enabled: number } | undefined;
      if (prior && prior.revision > input.revision) return;
      if (prior?.revision === input.revision && (prior.artifactHash !== input.artifactHash || prior.enabled !== Number(input.desiredEnabled))) throw new Error('Catalog projection revision has conflicting content');
      if (!input.pluginId.startsWith('helmsman.')) {
        if (input.removed) sql.prepare('DELETE FROM plugin_packages WHERE id=?').run(input.pluginId);
        else sql.prepare('INSERT INTO plugin_packages VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,enabled=excluded.enabled')
          .run(input.pluginId, input.artifactHash, Number(input.desiredEnabled));
      }
      sql.prepare('INSERT INTO plugin_projection_revisions VALUES(?,?,?,?) ON CONFLICT(pluginId) DO UPDATE SET revision=excluded.revision,artifactHash=excluded.artifactHash,enabled=excluded.enabled')
        .run(input.pluginId, input.revision, input.artifactHash, Number(input.desiredEnabled));
    });
  } finally { sql.close(); }
}

export async function createPluginCoordinator(options: {
  root: string;
  persistence: Persistence;
  executions: ExecutionStore;
  lifecycle: PluginLifecycle;
  builtins?: readonly { package: PluginPackage; artifactHash: string }[];
  runtimeArtifact?: ArtifactBinding;
  resetHealth?: boolean;
  pollIntervalMs?: number;
  afterProjection?: (target: string, intentId: string) => void;
}): Promise<PluginCoordinator> {
  const { persistence, executions, lifecycle, root } = options;
  persistence.transaction(() => lifecycle.list());
  const errors: string[] = [];
  const report = (message: string) => { if (!errors.includes(message)) errors.push(message); };
  const listeners = new Set<() => void | Promise<void>>();
  let disposed = false;
  let reconciliation: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let observed = '';
  const state = (id: string) => lifecycle.list().find(row => row.pluginId === id) ?? null;
  function verifyArchiveUnderLock(archive: PluginArchive): void {
    if (!persistence.sql.inTransaction) throw new PersistenceConflictError('Artifact selection requires a persistence transaction');
    const path = join(root, 'artifacts', `${archive.hash}.json`);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const file = fstatSync(fd);
      const entry = lstatSync(path);
      if (!file.isFile() || !entry.isFile() || entry.isSymbolicLink() || entry.ino !== file.ino || entry.dev !== file.dev
        || file.size !== archive.bytes.byteLength || !readFileSync(fd).equals(archive.bytes)) throw new Error('Plugin artifact changed before lifecycle selection');
    } finally { closeSync(fd); }
  }
  function register(pkg: PluginPackage, hash: string) {
    lifecycle.registerArtifact({ artifact: { pluginId: pkg.manifest.id, artifactHash: hash, packageVersion: pkg.manifest.version,
      requires: pkg.manifest.id.startsWith('helmsman.') ? ['helmsman.legacy-runtime'] : [] }, schemas: [] });
  }
  async function notify(): Promise<void> {
    const revision = stableJson({ lifecycle: lifecycle.list(), bindings: readPluginState(root).bindings });
    if (revision === observed) return;
    observed = revision;
    for (const listener of listeners) {
      try { await listener(); } catch (error) { report(`Plugin lifecycle listener failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  async function project(): Promise<void> {
    const failures: unknown[] = [];
    for (const intent of pendingPersistenceIntents(persistence).filter(item => item.owner.startsWith('plugin:'))) {
      try {
      const payload = intent.payload as { pluginId?: unknown; artifactHash?: unknown; desiredEnabled?: unknown; removed?: unknown } | null;
      if (!payload || !isPluginId(payload.pluginId) || typeof payload.artifactHash !== 'string' || !/^[a-f\d]{64}$/.test(payload.artifactHash)
        || typeof payload.desiredEnabled !== 'boolean' || payload.removed !== undefined && payload.removed !== true
        || payload.removed === true && payload.desiredEnabled || intent.owner !== `plugin:${payload.pluginId}`) throw new Error('Invalid durable plugin projection intent');
      const input = { pluginId: payload.pluginId, artifactHash: payload.artifactHash, desiredEnabled: payload.desiredEnabled, revision: intent.revision, removed: payload.removed === true };
      if (!input.removed && !input.pluginId.startsWith('helmsman.')) {
        const archive = await readPluginArtifact(root, input.artifactHash);
        if (archive.package.manifest.id !== input.pluginId) throw new Error('Projection artifact identity does not match');
      }
      for (const target of intent.targets) {
        if (intent.acknowledged.includes(target)) continue;
        if (target === 'catalog') projectCatalog(root, input);
        else if (target === 'plugin-data') projectPluginData(root, input);
        else throw new Error('Unsupported plugin projection target');
        options.afterProjection?.(target, intent.id);
        acknowledgePersistenceIntent(persistence, intent.id, target);
      }
      } catch (error) { failures.push(error); }
    }
    await notify();
    if (failures.length) throw failures[0];
  }
  const coordinator: PluginCoordinator = {
    errors, lifecycle, state,
    canActivate(id, artifactHash) {
      const row = state(id);
      return row?.desiredEnabled === true && (artifactHash === undefined || row.artifactHash === artifactHash)
        && !pendingPersistenceIntents(persistence).some(intent => intent.owner === `plugin:${id}`);
    },
    builtinArtifactHash: id => options.builtins?.find(item => item.package.manifest.id === id)?.artifactHash ?? null,
    async reconcile() {
      if (disposed) return;
      do {
        reconciliation ??= project().finally(() => { reconciliation = undefined; });
        await reconciliation;
      } while (!disposed && pendingPersistenceIntents(persistence).some(intent => intent.owner.startsWith('plugin:')));
    },
    async install(archive) {
      persistence.transaction(() => {
        const installed = lifecycle.list();
        if (!installed.some(row => row.pluginId === archive.package.manifest.id)
          && installed.filter(row => !row.pluginId.startsWith('helmsman.')).length >= 32) throw new Error('At most 32 external plugins may be installed.');
        verifyArchiveUnderLock(archive);
        register(archive.package, archive.hash);
        const row = state(archive.package.manifest.id)!;
        if (row.artifactHash === archive.hash && row.revision > 0 && readPluginState(root).plugins.some(plugin => plugin.id === row.pluginId)) return;
        lifecycle.apply({ id: randomUUID(), pluginId: row.pluginId, artifactHash: archive.hash, expectedRevision: row.revision, desiredEnabled: false, drainDependents: [] });
      });
      await coordinator.reconcile();
    },
    async change(id, enabled, input = {}) {
      const row = state(id);
      if (!row) throw new Error(`Plugin lifecycle is unavailable: ${id}`);
      lifecycle.apply({ id: randomUUID(), pluginId: id, artifactHash: row.artifactHash, expectedRevision: row.revision,
        desiredEnabled: enabled, drainDependents: input.drainDependents ?? [] });
      await coordinator.reconcile();
    },
    async uninstall(id) {
      const row = state(id);
      if (!row || id.startsWith('helmsman.')) throw new Error('Only installed external plugins can be uninstalled');
      lifecycle.uninstall(id, row.revision, randomUUID());
      await coordinator.reconcile();
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!timer) {
        const interval = options.pollIntervalMs ?? 250;
        if (!Number.isSafeInteger(interval) || interval < 10 || interval > 60_000) throw new Error('Invalid lifecycle polling interval');
        timer = setInterval(() => { void coordinator.reconcile().catch(error => { report(`Plugin reconciliation failed: ${error instanceof Error ? error.message : String(error)}`); }); }, interval);
        timer.unref();
      }
      return () => { listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer = undefined; } };
    },
    async collect(hash) {
      if (!/^[a-f\d]{64}$/.test(hash)) throw new Error('Invalid plugin artifact hash');
      const archive = await readPluginArtifact(root, hash);
      persistence.transaction(() => {
        const eligibility = lifecycle.canCollect(archive.package.manifest.id, hash);
        if (!eligibility.allowed || executions.pins().some(pin => pin.artifactHash === hash)) throw new PersistenceConflictError('Referenced plugin artifacts cannot be collected');
        unlinkSync(join(root, 'artifacts', `${hash}.json`));
      });
    },
    dispose() { disposed = true; listeners.clear(); if (timer) clearInterval(timer); },
  };
  async function bootstrapReconcile(): Promise<void> {
    try { await coordinator.reconcile(); } catch (error) { report(`Plugin recovery blocked: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (options.resetHealth) persistence.transaction(() => {
    assertMaintenanceAvailable(persistence.sql);
    for (const row of lifecycle.list()) lifecycle.recordHealth(row.pluginId, row.artifactHash, 'inactive', null);
  });
  await bootstrapReconcile();
  if (options.runtimeArtifact) {
    const runtime = options.runtimeArtifact;
    lifecycle.registerArtifact({ artifact: runtime, schemas: [] });
    const row = state(runtime.pluginId)!;
    try {
      if (row.artifactHash !== runtime.artifactHash || row.revision === 0) {
        lifecycle.apply({ id: randomUUID(), pluginId: runtime.pluginId, artifactHash: runtime.artifactHash, expectedRevision: row.revision, desiredEnabled: row.revision === 0 ? true : row.desiredEnabled, drainDependents: [] });
        await coordinator.reconcile();
      }
      if (state(runtime.pluginId)?.desiredEnabled || executions.pins(runtime.pluginId).length) lifecycle.recordHealth(runtime.pluginId, runtime.artifactHash, 'active', null);
    } catch (error) { report(`Legacy runtime activation blocked: ${error instanceof Error ? error.message : String(error)}`); }
  }
  let installedPlugins: readonly InstalledPlugin[] = [];
  try { installedPlugins = readPluginState(root).plugins; }
  catch (error) { report(`Plugin catalog recovery blocked: ${error instanceof Error ? error.message : String(error)}`); }
  for (const item of installedPlugins) {
    try {
      const archive = await readPluginArtifact(root, item.hash);
      persistence.transaction(() => {
        verifyArchiveUnderLock(archive);
        register(archive.package, item.hash);
        const row = state(item.id)!;
        if (row.revision === 0) lifecycle.apply({ id: randomUUID(), pluginId: item.id, artifactHash: item.hash, expectedRevision: row.revision, desiredEnabled: item.enabled, drainDependents: [] });
      });
    } catch (error) { report(`Plugin ${item.id} recovery blocked: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const builtin of options.builtins ?? []) {
    try {
      const enabled = builtinPluginEnabled(root, builtin.package);
      register(builtin.package, builtin.artifactHash);
      const row = state(builtin.package.manifest.id)!;
      if (row.revision === 0 || row.artifactHash !== builtin.artifactHash) lifecycle.apply({ id: randomUUID(), pluginId: row.pluginId, artifactHash: builtin.artifactHash,
        expectedRevision: row.revision, desiredEnabled: row.revision === 0 ? enabled : row.desiredEnabled, drainDependents: [] });
    } catch (error) { report(`Builtin ${builtin.package.manifest.id} recovery blocked: ${error instanceof Error ? error.message : String(error)}`); }
  }
  await bootstrapReconcile();
  return coordinator;
}
