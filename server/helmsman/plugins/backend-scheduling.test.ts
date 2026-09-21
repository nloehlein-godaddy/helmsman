// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinScheduling } from './builtin-scheduling';
import { activateBackendPlugins, type BackendRuntime } from './backend';
import { clearPluginSettings, initializeSchedulingInterval, readPluginSettings, readSchedulingProviderSelection, selectSchedulingProvider, writePluginSettings } from './data';
import { resolveSelectedSchedulingProvider } from '../scheduling-runtime';
import { createSchedulingProviderRegistry } from '../scheduling-providers';
import { parsePluginPackage } from '../../../src/plugins/package';
import { pluginCommand } from './cli';

const roots: string[] = []; const runtimes: BackendRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'helmsman-scheduling-')); roots.push(root); return root; }
async function start(root: string) {
  const runtime = await activateBackendPlugins({ root, snapshot: { catalog: { version: 1, safeMode: false, plugins: [], bindings: {} }, artifacts: new Map(), errors: [] },
    usage: { async query() { throw new Error('Unused'); } }, builtins: [{ ...builtinScheduling, artifactHash: 'a'.repeat(64) }] });
  runtimes.push(runtime); return runtime;
}
it('registers exact scheduling artifacts, fences settings drift, and applies settings after restart', async () => {
  const root = await temporary(); const runtime = await start(root); expect(runtime.errors).toEqual([]);
  const options = { root, registry: runtime.scheduling, defaultProvider: 'helmsman.scheduling/round-robin' };
  expect(resolveSelectedSchedulingProvider(options).registration.binding.artifactHash).toBe('a'.repeat(64));
  expect(resolveSelectedSchedulingProvider(options).registration.provider.intervalMs).toBe(60000);
  writePluginSettings(root, builtinScheduling.package, { intervalMs: 500 });
  expect(() => resolveSelectedSchedulingProvider(options)).toThrow('unavailable');
  await runtime.dispose();
  expect(resolveSelectedSchedulingProvider({ ...options, registry: (await start(root)).scheduling }).registration.provider.intervalMs).toBe(500);
});
it('migrates legacy cadence once without overwriting explicit settings or restoring reset values', async () => {
  const root = await temporary(); const pkg = builtinScheduling.package;
  initializeSchedulingInterval(root, pkg, 1); expect(readPluginSettings(root, pkg).intervalMs).toBe(250);
  clearPluginSettings(root, pkg.manifest.id, 'intervalMs'); initializeSchedulingInterval(root, pkg, 1000);
  expect(readPluginSettings(root, pkg).intervalMs).toBe(60000);
  const explicit = await temporary(); writePluginSettings(explicit, pkg, { intervalMs: 500 }); initializeSchedulingInterval(explicit, pkg, 1000);
  expect(readPluginSettings(explicit, pkg).intervalMs).toBe(500);
  const invalid = await temporary(); initializeSchedulingInterval(invalid, pkg, NaN); expect(readPluginSettings(invalid, pkg).intervalMs).toBe(60000);
  const upper = await temporary(); initializeSchedulingInterval(upper, pkg, 10_000_000); expect(readPluginSettings(upper, pkg).intervalMs).toBe(3_600_000);
});
it('records every provider selection revision and does not fall back from an unavailable explicit policy', async () => {
  const root = await temporary(); const runtime = await start(root); const options = { root, registry: runtime.scheduling, defaultProvider: 'helmsman.scheduling/round-robin' };
  const first = readSchedulingProviderSelection(root); selectSchedulingProvider(root, 'example.other/policy');
  expect(readSchedulingProviderSelection(root).revision).not.toBe(first.revision);
  expect(() => resolveSelectedSchedulingProvider(options)).toThrow('unavailable');
  await pluginCommand(['--dir', root, 'select-scheduling', 'default'], { coordinate: false });
  expect(readSchedulingProviderSelection(root).providerId).toBeNull(); expect(resolveSelectedSchedulingProvider(options).registration.binding.providerId).toBe(options.defaultProvider);
  const second = readSchedulingProviderSelection(root); selectSchedulingProvider(root, null); expect(readSchedulingProviderSelection(root).revision).not.toBe(second.revision);
});
it('requires scoped discovery declarations and rejects invalid or unstaged registrations', () => {
  const pkg = builtinScheduling.package;
  expect(() => parsePluginPackage({ ...pkg, backend: { ...pkg.backend, scheduling: undefined } }, { allowBuiltin: true })).toThrow();
  expect(() => parsePluginPackage({ ...pkg, backend: { ...pkg.backend, scheduling: { 'round-robin': { access: ['connection-http'] } } } }, { allowBuiltin: true })).toThrow();
  let enabled = true; const registry = createSchedulingProviderRegistry({ eligible: () => enabled });
  const binding = { providerId: 'example.scheduler/policy', pluginId: 'example.scheduler', artifactHash: 'a'.repeat(64), contractVersion: 1 as const };
  const provider = { intervalMs: 1000, async select() { return null; } };
  const registration = registry.stage(binding, provider); registry.publish([registration]); expect(registry.resolve(binding)).toBe(registration);
  expect(() => registry.publish([registration])).toThrow();
  expect(() => registry.stage(binding, { ...provider, intervalMs: 0 })).toThrow();
  expect(() => registry.stage({ ...binding, pluginId: 'example.other' }, provider)).toThrow();
  expect(() => registry.resolve({ ...binding, artifactHash: 'b'.repeat(64) })).toThrow();
  enabled = false; expect(registry.list()).toEqual([]); expect(() => registry.resolve(binding)).toThrow();
});
