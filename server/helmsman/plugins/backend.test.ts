// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePluginPackage } from '../../../src/plugins/package';
import type { PluginBackendContext, PluginBackendModule } from '../../../src/plugins/backend';
import type { PricingEstimate, UsageSnapshot } from '../../../src/plugins/usage';
import { activateBackendPlugins, type BackendRuntime, type BuiltinBackendPlugin } from './backend';
import { parsePluginArchive } from './artifacts';
import { builtinPluginPackage, openPluginData, readPricingBinding, readPluginSettings, selectPricingProvider } from './data';
import { configurePlugin, installPlugin, loadPluginSnapshot, setPluginEnabled, type PluginSnapshot } from './store';
import { pluginCommand } from './cli';

const roots: string[] = [];
const runtimes: BackendRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function temporary() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'helmsman-backend-'));
  roots.push(root); return root;
}
function descriptor(id = 'example.pricing') {
  return { packageVersion: 1, manifest: { manifestVersion: 1, id, version: '1.0.0', sdkVersion: 1, pages: [] },
    node: { minMajor: 1, maxMajorExclusive: 1000 }, entries: {}, backend: { entry: 'backend.js', storageVersion: 1,
      provides: [{ id: 'helmsman/pricing', version: 1, localId: 'price' }],
      settings: { usdPerMillionTokens: { type: 'number', default: 2, minimum: 0, maximum: 100 } } } };
}
function snapshot(): UsageSnapshot {
  return { version: 1, currency: 'USD', repo: null, window: { from: '2026-01-01', to: '2026-02-01' }, runs: [],
    records: [
      { runId: 'run', attempt: 1, eventId: 'unknown', provider: 'test', model: null, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, totalTokens: 2, costUsd: null },
      { runId: 'run', attempt: 1, eventId: 'known', provider: 'test', model: null, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, totalTokens: 2, costUsd: 5 },
    ], reported: { knownCostUsd: 5, observedCostUsd: 5, runsWithKnownCost: 1, runsWithoutUsage: 0, inputTokens: 2, cachedInputTokens: 0, outputTokens: 2, totalTokens: 4 } };
}
function estimate(amount = 2): PricingEstimate {
  return { version: 1, currency: 'USD', estimatedUnreportedCostUsd: amount, estimatedUsageEvents: 1, unreportedUsageEvents: 1,
    provenance: { source: 'https://example.test/rates', rateVersion: 'v1', asOf: '2026-01-01' },
    records: [{ runId: 'run', attempt: 1, eventId: 'unknown', estimatedCostUsd: amount }] };
}
const empty: PluginSnapshot = { catalog: { version: 1, safeMode: false, plugins: [], bindings: {} }, artifacts: new Map(), errors: [] };
function builtin(id: string, activate?: PluginBackendModule['activate']): BuiltinBackendPlugin {
  return { package: parsePluginPackage(descriptor(id), { allowBuiltin: true }),
    module: { activate: activate ?? (context => { context.registerPricing('price', { estimate: () => estimate() }); }) } };
}
async function start(root: string, builtins: BuiltinBackendPlugin[] = [], source = empty, defaultPricingProvider?: string, activationTimeoutMs?: number) {
  const runtime = await activateBackendPlugins({ root, snapshot: source, usage: { query: async () => snapshot() }, builtins, defaultPricingProvider, activationTimeoutMs });
  runtimes.push(runtime); return runtime;
}

describe('backend plugin activation and pricing', () => {
  it.each([false, true])('publishes combined package activation only after backend success (fails: %s)', async fails => {
    const root = await temporary();
    const pkg = descriptor();
    const archive = parsePluginArchive(JSON.stringify({
      format: 'helmsman-plugin', version: 1,
      package: { ...pkg, manifest: { ...pkg.manifest, pages: [{ id: 'page', title: 'Pricing', slots: ['helmsman/costs-page'], panes: ['summary'] }] }, entries: { page: 'page.js' } },
      files: [
        { path: 'page.js', base64: Buffer.from('export default { mount() {} };').toString('base64') },
        { path: 'backend.js', base64: Buffer.from(`export default { activate(context) {
          context.registerPricing('price', { estimate() { return null; } });
          ${fails ? 'throw new Error("Combined package activation failed");' : ''}
        } };`).toString('base64') },
      ],
    }));
    await installPlugin(root, archive.bytes);
    await setPluginEnabled(root, pkg.manifest.id, true);
    const runtime = await start(root, [], await loadPluginSnapshot(root));
    expect(runtime.activePluginIds()).toEqual(fails ? [] : [pkg.manifest.id]);
    expect(Object.isFrozen(runtime.activePluginIds())).toBe(true);
    expect(runtime.providers()).toEqual(fails ? [] : [`${pkg.manifest.id}/price`]);
    expect(runtime.errors).toHaveLength(fails ? 1 : 0);
    expect((await loadPluginSnapshot(root)).artifacts.get(`${pkg.manifest.id}/${archive.hash}`)?.package.manifest.id).toBe(pkg.manifest.id);
    await runtime.dispose();
    expect(runtime.activePluginIds()).toEqual([]);
  });

  it('contains corrupt optional plugin persistence without replacing damaged data or choosing a fallback', async () => {
    const root = await temporary();
    const path = join(root, 'plugin-data.sqlite');
    await writeFile(path, 'preserve corrupt data');
    const runtime = await start(root, [builtin('helmsman.first')], empty, 'helmsman.first/price');
    expect(runtime.errors.length).toBeGreaterThan(0);
    expect(runtime.providers()).toEqual([]);
    await expect(runtime.pricing(snapshot())).rejects.toMatchObject({ code: 'invalid-selection' });
    expect(await readFile(path, 'utf8')).toBe('preserve corrupt data');
  });

  it('validates pricing histories larger than per-key storage quotas', async () => {
    const root = await temporary();
    const input = snapshot();
    const unpriced = input.records[0]!;
    input.records = Array.from({ length: 1000 }, (_, index) => ({ ...unpriced, eventId: String(index) }));
    const runtime = await start(root, [builtin('helmsman.large', context => context.registerPricing('price', {
      estimate: data => ({ ...estimate(1000), estimatedUsageEvents: 1000, unreportedUsageEvents: 1000,
        records: data.records.map(row => ({ runId: row.runId, attempt: row.attempt, eventId: row.eventId, estimatedCostUsd: 1 })) }),
    }))]);
    expect((await runtime.pricing(input)).estimate?.estimatedUsageEvents).toBe(1000);
  });

  it('rejects overflow in accumulated pricing details', async () => {
    const root = await temporary();
    const input = snapshot();
    input.records = [input.records[0]!, { ...input.records[0]!, eventId: 'second' }];
    const runtime = await start(root, [builtin('helmsman.overflow', context => context.registerPricing('price', {
      estimate: data => ({ ...estimate(1e308), estimatedUsageEvents: 2, unreportedUsageEvents: 2,
        records: data.records.map(row => ({ runId: row.runId, attempt: row.attempt, eventId: row.eventId, estimatedCostUsd: 1e308 })) }),
    }))]);
    await expect(runtime.pricing(input)).rejects.toMatchObject({ code: 'invalid-result' });
  });
  it('loads prebuilt ESM only after enablement and persists namespaced settings/storage across restarts', async () => {
    const root = await temporary();
    const code = `import { join } from 'node:path';
      export default { async activate(context) {
        if (join('a','b').length < 1) throw new Error('Node builtins unavailable');
        const boots = await context.storage.get('boots') ?? 0;
        await context.storage.set('boots', boots + 1);
        context.registerPricing('price', { estimate() { return { version:1,currency:'USD',estimatedUnreportedCostUsd:context.settings.usdPerMillionTokens,
          estimatedUsageEvents:1,unreportedUsageEvents:1,provenance:{source:'test',rateVersion:String(boots+1),asOf:'2026-01-01'} }; } });
      } };`;
    const archive = parsePluginArchive(JSON.stringify({ format: 'helmsman-plugin', version: 1, package: descriptor(), files: [{ path: 'backend.js', base64: Buffer.from(code).toString('base64') }] }));
    await installPlugin(root, archive.bytes);
    expect((await start(root, [], await loadPluginSnapshot(root))).providers()).toEqual([]);
    await pluginCommand(['--dir', root, 'configure', 'example.pricing', '{"usdPerMillionTokens":7}']);
    await setPluginEnabled(root, 'example.pricing', true);
    const first = await start(root, [], await loadPluginSnapshot(root));
    expect(first.errors).toEqual([]);
    expect(await first.pricing(snapshot())).toMatchObject({ providerId: 'example.pricing/price', estimate: { estimatedUnreportedCostUsd: 7, provenance: { rateVersion: '1' } } });
    await first.dispose();
    expect(await readdir(join(root, 'runtime'))).toEqual([]);
    const next = await start(root, [], await loadPluginSnapshot(root));
    expect((await next.pricing(snapshot())).estimate?.provenance.rateVersion).toBe('2');
    await setPluginEnabled(root, 'example.pricing', false);
    const disabled = await start(root, [], await loadPluginSnapshot(root));
    await expect(disabled.pricing(snapshot())).rejects.toMatchObject({ code: 'missing' });
    expect(readPluginSettings(root, archive.package).usdPerMillionTokens).toBe(7);
  });

  it('uses deterministic selection precedence and never falls through an unavailable selection', async () => {
    const root = await temporary();
    const runtime = await start(root, [builtin('helmsman.second'), builtin('helmsman.first')]);
    expect(runtime.providers()).toEqual(['helmsman.first/price', 'helmsman.second/price']);
    expect(runtime.activePluginIds()).toEqual(['helmsman.first', 'helmsman.second']);
    await expect(runtime.pricing(snapshot())).rejects.toMatchObject({ code: 'ambiguous' });
    selectPricingProvider(root, 'helmsman.first/price');
    expect((await runtime.pricing(snapshot())).providerId).toBe('helmsman.first/price');
    expect((await runtime.pricing(snapshot(), { galleon: 'helmsman.second/price' })).providerId).toBe('helmsman.second/price');
    expect((await runtime.pricing(snapshot(), { workflow: 'helmsman.first/price', galleon: 'helmsman.second/price' })).providerId).toBe('helmsman.first/price');
    expect((await runtime.pricing(snapshot(), { explicit: 'helmsman.second/price', workflow: 'helmsman.first/price' })).providerId).toBe('helmsman.second/price');
    await expect(runtime.pricing(snapshot(), { explicit: 'missing.provider/price', workflow: 'helmsman.first/price' })).rejects.toMatchObject({ code: 'invalid-selection' });
    await expect(runtime.pricing(snapshot(), { explicit: null as unknown as string })).rejects.toMatchObject({ code: 'invalid-selection' });
  });

  it('preserves explicit unavailable bindings when a provider is disabled and never reseeds a cleared default', async () => {
    const root = await temporary();
    const pkg = builtin('helmsman.first');
    await start(root, [pkg], empty, 'helmsman.first/price');
    expect(readPricingBinding(root)).toBe('helmsman.first/price');
    await pluginCommand(['--dir', root, 'disable', 'helmsman.first']);
    const disabled = await start(root, [pkg], empty, 'helmsman.first/price');
    await expect(disabled.pricing(snapshot())).rejects.toMatchObject({ code: 'invalid-selection' });
    await pluginCommand(['--dir', root, 'select-pricing', 'default']);
    await start(root, [pkg], empty, 'helmsman.first/price');
    expect(readPricingBinding(root)).toBeUndefined();
    await pluginCommand(['--dir', root, 'enable', 'helmsman.first']);
    const enabled = await start(root, [pkg]);
    expect(enabled.providers()).toEqual(['helmsman.first/price']);
    expect(builtinPluginPackage(root, 'helmsman.first')?.manifest.id).toBe('helmsman.first');
  });

  it('rolls back staged storage and registrations and disposes partial activation', async () => {
    const root = await temporary();
    let disposed = 0;
    const failing = builtin('helmsman.failed', async context => {
      context.onDispose(() => { disposed++; });
      context.registerPricing('price', { estimate: () => estimate() });
      await context.storage.set('partial', { changed: true });
      throw new Error('Activation failed');
    });
    const runtime = await start(root, [failing, builtin('helmsman.healthy')]);
    expect(disposed).toBe(1);
    expect(runtime.providers()).toEqual(['helmsman.healthy/price']);
    expect(runtime.errors[0]).toContain('Activation failed');
    const data = openPluginData(root, failing.package);
    expect(data.read('partial')).toBeUndefined(); data.close();
  });

  it('invalidates service handles and contains cleanup failures', async () => {
    const root = await temporary();
    let context!: PluginBackendContext;
    const order: number[] = [];
    const runtime = await start(root, [builtin('helmsman.cleanup', supplied => {
      context = supplied;
      supplied.onDispose(() => { order.push(1); throw new Error('cleanup'); });
      supplied.onDispose(() => { order.push(2); });
      supplied.registerPricing('price', { estimate: () => estimate() });
    })]);
    await runtime.dispose(); await runtime.dispose();
    expect(order).toEqual([2, 1]);
    expect(context.signal.aborted).toBe(true);
    expect(runtime.providers()).toEqual([]);
    await expect(context.storage.set('after', 1)).rejects.toThrow('disposed');
    await expect(context.usage.query({ version: 1, repo: null, from: '2026-01-01', to: '2026-02-01' })).rejects.toThrow('disposed');
    expect(runtime.errors).toEqual(['Plugin helmsman.cleanup cleanup failed.']);
  });

  it('bounds hanging activation and asynchronous cleanup', async () => {
    const root = await temporary();
    let context!: PluginBackendContext;
    const runtime = await start(root, [builtin('helmsman.hanging', async supplied => {
      context = supplied;
      supplied.onDispose(() => new Promise(() => {}));
      await new Promise(() => {});
    })], empty, undefined, 10);
    expect(runtime.providers()).toEqual([]);
    expect(context.signal.aborted).toBe(true);
    expect(runtime.errors).toHaveLength(2);
    expect(() => context.registerPricing('price', { estimate: () => estimate() })).toThrow();
  });

  it.each([
    { estimatedUsageEvents: 2 }, { unreportedUsageEvents: 2 }, { currency: 'EUR' },
    { estimatedUnreportedCostUsd: -1 }, { provenance: { source: 'test', rateVersion: 'v1', asOf: 'bad-date' } },
    { records: [{ runId: 'run', attempt: 1, eventId: 'known', estimatedCostUsd: 2 }] },
    { records: [{ runId: 'run', attempt: 1, eventId: 'unknown', estimatedCostUsd: 3 }] },
  ])('rejects malformed or reported-usage estimates %j', async override => {
    const root = await temporary();
    const runtime = await start(root, [builtin('helmsman.invalid', context => context.registerPricing('price', {
      estimate: () => ({ ...estimate(), ...override }) as PricingEstimate,
    }))]);
    await expect(runtime.pricing(snapshot())).rejects.toMatchObject({ code: 'invalid-result' });
  });

  it('validates settings atomically and isolates plugin storage namespaces', async () => {
    const root = await temporary();
    const first = builtin('helmsman.first', async context => {
      await context.storage.set('shared-key', 'first');
      context.registerPricing('price', { estimate: () => estimate() });
    });
    const second = builtin('helmsman.second', async context => {
      expect(await context.storage.get('shared-key')).toBeUndefined();
      await context.storage.set('shared-key', 'second');
      context.registerPricing('price', { estimate: () => estimate() });
    });
    await start(root, [first, second]);
    await configurePlugin(root, first.package.manifest.id, { usdPerMillionTokens: 8 });
    await expect(configurePlugin(root, first.package.manifest.id, { usdPerMillionTokens: 9, unknown: 1 })).rejects.toThrow('Unknown');
    await expect(configurePlugin(root, first.package.manifest.id, { usdPerMillionTokens: -1 })).rejects.toThrow('schema');
    expect(readPluginSettings(root, first.package).usdPerMillionTokens).toBe(8);
    expect(readPluginSettings(root, second.package).usdPerMillionTokens).toBe(2);
    const a = openPluginData(root, first.package); const b = openPluginData(root, second.package);
    expect(a.read('shared-key')).toBe('first'); expect(b.read('shared-key')).toBe('second');
    a.close(); b.close();
  });

  it('recovers explicitly from removed settings after upgrading a plugin without deleting its storage', async () => {
    const root = await temporary();
    const old = builtin('helmsman.upgrade', async context => {
      await context.storage.set('keep', 'durable');
      context.registerPricing('price', { estimate: () => estimate() });
    });
    await start(root, [old]);
    await configurePlugin(root, old.package.manifest.id, { usdPerMillionTokens: 8 });
    const upgraded = { ...old, package: parsePluginPackage({ ...old.package, manifest: { ...old.package.manifest, version: '2.0.0' },
      backend: { ...old.package.backend, settings: {} } }, { allowBuiltin: true }) };
    const failed = await start(root, [upgraded]);
    expect(failed.providers()).toEqual([]);
    expect(failed.errors[0]).toContain('no longer declared');
    await pluginCommand(['--dir', root, 'reset-settings', old.package.manifest.id, 'usdPerMillionTokens']);
    const restored = await start(root, [upgraded]);
    expect(restored.errors).toEqual([]);
    expect(restored.providers()).toEqual(['helmsman.upgrade/price']);
    const data = openPluginData(root, upgraded.package);
    expect(data.read('keep')).toBe('durable'); data.close();
  });
});
