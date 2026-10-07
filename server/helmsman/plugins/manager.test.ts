// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openExecutionStore, type ExecutionStore } from '../execution-store';
import { openPersistence, type Persistence } from '../persistence';
import { parsePluginArchive } from './artifacts';
import { openPluginLifecycle } from './lifecycle';
import { createPluginManager, PluginManagementError } from './manager';
import { createPluginCoordinator, type PluginCoordinator } from './store';

const id = 'example.managed';
const major = Number(process.versions.node.split('.')[0]);
function archive(version = '1.0.0', pluginId = id) {
  return Buffer.from(JSON.stringify({ format: 'helmsman-plugin', version: 1,
    package: { packageVersion: 1, manifest: { manifestVersion: 1, id: pluginId, version, sdkVersion: 1, pages: [] },
      node: { minMajor: major, maxMajorExclusive: major + 1 }, entries: {} }, files: [] }));
}
function expected(row: ReturnType<PluginCoordinator['state']>) {
  return row && { hash: row.artifactHash, revision: row.revision, desiredEnabled: row.desiredEnabled };
}
let temp: string;
let root: string;
let persistence: Persistence;
let executions: ExecutionStore;
let coordinator: PluginCoordinator;
let manager: ReturnType<typeof createPluginManager>;
beforeEach(async () => {
  temp = mkdtempSync(join(realpathSync(tmpdir()), 'helmsman-plugin-manager-'));
  root = join(temp, 'plugins');
  persistence = openPersistence(join(temp, 'state.sqlite'));
  executions = openExecutionStore(persistence);
  coordinator = await createPluginCoordinator({ root, persistence, executions, lifecycle: openPluginLifecycle(persistence, executions) });
  manager = createPluginManager({ root, coordinator });
});
afterEach(() => { coordinator.dispose(); persistence.close(); rmSync(temp, { recursive: true, force: true }); });

it('requires an inspected hash and explicit trust before installing or enabling, then updates a disabled plugin', async () => {
  const first = archive(); const encoded = first.toString('base64');
  const inspection = await manager.handle({ action: 'inspect', archiveBase64: encoded });
  expect(inspection).toEqual({ version: 1, preview: { id, name: id, version: '1.0.0',
    hash: parsePluginArchive(first).hash, kind: 'external', expected: null } });
  if (!('preview' in inspection)) throw new Error('Missing inspection');
  await expect(manager.handle({ action: 'install', archiveBase64: encoded, confirmedHash: inspection.preview.hash,
    expected: null, trustConfirmed: false })).rejects.toMatchObject({ status: 400 });
  await expect(manager.handle({ action: 'install', archiveBase64: encoded, confirmedHash: 'a'.repeat(64),
    expected: null, trustConfirmed: true })).rejects.toMatchObject({ status: 409 });
  expect((await manager.snapshot()).plugins).toEqual([]);
  const installed = await manager.handle({ action: 'install', archiveBase64: encoded, confirmedHash: inspection.preview.hash,
    expected: null, trustConfirmed: true });
  expect(installed).toMatchObject({ restartRequired: true, readOnly: false, plugins: [{ id, version: '1.0.0', desiredEnabled: false }] });
  const initial = expected(coordinator.state(id));
  await expect(manager.handle({ action: 'enable', id, expected: initial, trustConfirmed: false })).rejects.toMatchObject({ status: 400 });
  await manager.handle({ action: 'enable', id, expected: initial, trustConfirmed: true });
  await expect(manager.handle({ action: 'disable', id, expected: initial })).rejects.toMatchObject({ status: 409 });
  await manager.handle({ action: 'disable', id, expected: expected(coordinator.state(id)) });
  const second = archive('2.0.0'); const replacement = await manager.handle({ action: 'inspect', archiveBase64: second.toString('base64') });
  if (!('preview' in replacement)) throw new Error('Missing replacement inspection');
  expect(replacement.preview.expected).toEqual(expected(coordinator.state(id)));
  await manager.handle({ action: 'install', archiveBase64: second.toString('base64'), confirmedHash: replacement.preview.hash,
    expected: replacement.preview.expected, trustConfirmed: true });
  expect((await manager.snapshot()).plugins).toMatchObject([{ id, version: '2.0.0', desiredEnabled: false }]);
});

it('preserves retained pins through disablement and rejects replacement or uninstall', async () => {
  const first = archive(); const preview = await manager.handle({ action: 'inspect', archiveBase64: first.toString('base64') });
  if (!('preview' in preview)) throw new Error('Missing inspection');
  await manager.handle({ action: 'install', archiveBase64: first.toString('base64'), confirmedHash: preview.preview.hash,
    expected: null, trustConfirmed: true });
  await manager.handle({ action: 'enable', id, expected: expected(coordinator.state(id)), trustConfirmed: true });
  executions.retainPins([{ kind: 'operation', ownerId: 'retained-operation', pluginId: id, artifactHash: preview.preview.hash }]);
  await manager.handle({ action: 'disable', id, expected: expected(coordinator.state(id)) });
  expect((await manager.snapshot()).plugins).toMatchObject([{ state: 'draining', obligationsOnly: true }]);
  const second = archive('2.0.0'); const replacement = await manager.handle({ action: 'inspect', archiveBase64: second.toString('base64') });
  if (!('preview' in replacement)) throw new Error('Missing replacement inspection');
  await expect(manager.handle({ action: 'install', archiveBase64: second.toString('base64'), confirmedHash: replacement.preview.hash,
    expected: replacement.preview.expected, trustConfirmed: true })).rejects.toThrow('Retained operation');
  await expect(manager.handle({ action: 'uninstall', id, expected: expected(coordinator.state(id)) })).rejects.toThrow('referenced');
  expect(coordinator.state(id)?.artifactHash).toBe(preview.preview.hash);
});

it('rejects malformed requests and stale install expectations without changing lifecycle state', async () => {
  await expect(manager.handle({ action: 'inspect', archiveBase64: 'YQ==' })).rejects.toBeInstanceOf(PluginManagementError);
  await expect(manager.handle({ action: 'inspect', archiveBase64: 'YQ==', extra: true })).rejects.toMatchObject({ status: 400 });
  const first = archive(); const inspection = await manager.handle({ action: 'inspect', archiveBase64: first.toString('base64') });
  if (!('preview' in inspection)) throw new Error('Missing inspection');
  await manager.handle({ action: 'install', archiveBase64: first.toString('base64'), confirmedHash: inspection.preview.hash,
    expected: null, trustConfirmed: true });
  await expect(manager.handle({ action: 'install', archiveBase64: first.toString('base64'), confirmedHash: inspection.preview.hash,
    expected: null, trustConfirmed: true })).rejects.toMatchObject({ status: 409 });
  expect(coordinator.state(id)?.revision).toBe(1);
});
