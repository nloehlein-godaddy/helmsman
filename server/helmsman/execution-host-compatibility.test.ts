// @vitest-environment node
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { parseExecutionHostMetadataV1, type ExecutionHostLaunchSpecV1, type ExecutionHostProviderV1 } from '../../src/plugins/execution-host';
import { createDetachedExecutionHost } from '../../src/plugins/host-local/provider';
import { createDockerExecutionHost } from '../../src/plugins/host-docker/provider';
import { executionHostAdapter } from './execution-host-execution';
import { loadRetainedExecutionHostProvider } from './execution-host-retained-loader';
import { parseExecutionHostRetainedProviderV1 } from './execution-host-providers';
import { assertExecutionHostCoordinatorSupport, assertExecutionHostSelectionCurrent, resolveExecutionHostSelection } from './execution-host-selection';
import { persistenceHash } from './persistence';
import { activateBackendPlugins } from './plugins/backend';
import { pluginCommand } from './plugins/cli';
import { loadPluginSnapshot } from './plugins/store';

const evidence = join(import.meta.dirname, '../../docs/adversarial-review-2026-09-21-round-2/evidence/codex_execution');
const wrapperPath = join(import.meta.dirname, 'run-wrapper.mjs');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function spec(root: string): ExecutionHostLaunchSpecV1 {
  return { version: 1, runId: 'compat_run', launchId: 'compat_launch', attempt: 1, cmd: process.execPath,
    args: ['-e', 'setTimeout(() => process.exit(0), 100)'], cwd: root, logPath: join(root, 'run.log'), exitPath: join(root, 'run.exit'),
    specPath: join(root, 'run.json'), receiptPath: join(root, 'run.receipt'), wrapperPath, coordinator: false, configuration: null };
}
function adapter(provider: ExecutionHostProviderV1) {
  return executionHostAdapter({ runId: 'compat_run', providerId: 'example.historical-host/detached', provider,
    configuration: null, wrapperPath, runtimeRoot: process.cwd() });
}

async function crashedCoordinator(provider: ExecutionHostProviderV1, root: string, serializedCoordinator: boolean | undefined): Promise<void> {
  let stop: (() => Promise<void>) | undefined;
  try {
    const stage = `const fs=require('node:fs');const timer=setInterval(()=>fs.writeFileSync('stage-ticks',String(Date.now())),20);setTimeout(()=>{clearInterval(timer);fs.writeFileSync('stage-done','done');},1200);`;
    const entry = join(root, 'pre-pr-cli.js');
    await writeFile(entry, `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(stage)}],{detached:true,stdio:'ignore'});setInterval(()=>{if(fs.existsSync('stage-ticks'))process.exit(1);},20);setTimeout(()=>process.exit(1),2000);`);
    const launch = { ...spec(root), args: [entry], coordinator: true };
    const ref = await provider.launch(serializedCoordinator === false ? { ...launch, coordinator: false } : launch);
    stop = () => provider.stop(ref);
    await vi.waitFor(async () => expect(await provider.isAlive(ref)).toBe(false), { timeout: 5000 });
    const tick = await readFile(join(root, 'stage-ticks'), 'utf8');
    await pause(100);
    expect(await readFile(join(root, 'stage-ticks'), 'utf8')).not.toBe(tick);
    expect(existsSync(launch.exitPath)).toBe(false);
    expect(await provider.discover(launch, ref)).toMatchObject({ status: 'unknown' });
    expect(await readFile(launch.logPath, 'utf8')).toContain('coordinator stage settlement is unknown');
    expect(JSON.parse(await readFile(launch.specPath, 'utf8')).coordinator).toBe(serializedCoordinator);
  } finally {
    await stop?.().catch(() => {});
    await pause(2200);
  }
}

it('preserves historical retained metadata identity and validates explicit coordinator protocol support', () => {
  const metadata = { version: 1, label: 'Old host', workspace: 'worktree', stageExecution: 'local' };
  expect(parseExecutionHostMetadataV1(metadata)).toEqual(metadata);
  expect(persistenceHash(parseExecutionHostMetadataV1(metadata))).toBe(persistenceHash(metadata));
  expect(() => assertExecutionHostCoordinatorSupport(parseExecutionHostMetadataV1(metadata), false)).not.toThrow();
  expect(() => assertExecutionHostCoordinatorSupport(parseExecutionHostMetadataV1(metadata), true)).toThrow('protocol 1');
  expect(() => assertExecutionHostCoordinatorSupport(parseExecutionHostMetadataV1({ ...metadata, coordinatorProtocol: 1 }), true)).not.toThrow();
  for (const coordinatorProtocol of [null, false, 0, 2, '1']) {
    expect(() => parseExecutionHostMetadataV1({ ...metadata, coordinatorProtocol })).toThrow();
  }
});

it.skipIf(process.platform === 'win32')('installs the historical author host, rejects staged admission and launch, and retains direct execution identity', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'historical-host-'));
  let runtime: Awaited<ReturnType<typeof activateBackendPlugins>> | undefined;
  let retained: Awaited<ReturnType<typeof loadRetainedExecutionHostProvider>> | undefined;
  let stop: (() => Promise<void>) | undefined;
  try {
    const author = join(root, 'author'); const store = join(root, 'plugins'); const archive = join(root, 'host.hmp');
    await mkdir(author);
    const descriptor = JSON.parse(await readFile(join(evidence, 'old-host-local-package.json'), 'utf8'));
    descriptor.manifest.id = 'example.historical-host';
    const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    await writeFile(join(author, 'plugin-package.json'), JSON.stringify(descriptor));
    await writeFile(join(author, 'backend.js'), compile(await readFile(join(evidence, 'old-host-local-backend.ts.txt'), 'utf8')));
    await writeFile(join(author, 'provider.js'), compile(await readFile(join(evidence, 'old-host-local-provider.ts.txt'), 'utf8')).replaceAll('@helmsman/plugin-sdk/node', './sdk-node.js'));
    await writeFile(join(author, 'sdk-node.js'), compile(await readFile(join(import.meta.dirname, '../../src/plugins/execution-host-node.ts'), 'utf8')));
    for (const args of [['pack', author, archive], ['install', archive], ['enable', descriptor.manifest.id], ['select-execution-host', `${descriptor.manifest.id}/detached`]]) {
      await pluginCommand(['--dir', store, ...args], { coordinate: false });
    }
    runtime = await activateBackendPlugins({ root: store, snapshot: await loadPluginSnapshot(store), usage: { async query() { throw new Error('Unavailable'); } } });
    expect(runtime.errors).toEqual([]);
    const selected = resolveExecutionHostSelection({ root: store, registry: runtime.executionHosts, defaultProviderId: 'helmsman.host-local/detached' });
    assertExecutionHostSelectionCurrent({ root: store, registry: runtime.executionHosts }, selected);
    const originalIdentity = persistenceHash(selected.record);
    expect(() => assertExecutionHostCoordinatorSupport(selected.record.metadata, true)).toThrow('protocol 1');
    expect(persistenceHash(parseExecutionHostRetainedProviderV1(selected.record))).toBe(originalIdentity);
    retained = await loadRetainedExecutionHostProvider({ pluginsRoot: store, runtimeArtifactsRoot: root, record: selected.record,
      artifacts: [{ pluginId: descriptor.manifest.id, artifactHash: selected.record.binding.artifactHash, packageVersion: descriptor.manifest.version, requires: [] }] });
    const launch = spec(root);
    const launchSpy = vi.fn(retained.provider.launch);
    const host = adapter({ ...retained.provider, launch: launchSpy });
    await expect(host.launch({ ...launch, args: [join(root, 'pre-pr-cli.js')] })).rejects.toThrow('protocol 1');
    expect(launchSpy).not.toHaveBeenCalled();
    expect(existsSync(launch.specPath)).toBe(false);
    const ref = await host.launch({ ...launch, args: [...launch.args] });
    stop = () => host.stop(ref);
    await vi.waitFor(() => expect(existsSync(launch.exitPath)).toBe(true), { timeout: 5000 });
    expect(JSON.parse(await readFile(launch.specPath, 'utf8')).coordinator).toBeUndefined();
    expect(await host.discover?.({ ...launch, args: [...launch.args] }, ref)).toMatchObject({ status: 'found', ref, evidence: { state: 'exited', exitCode: 0 } });
    expect(persistenceHash(selected.record)).toBe(originalIdentity);
    const crashRoot = join(root, 'historical-crash');
    await mkdir(crashRoot);
    await crashedCoordinator(retained.provider, crashRoot, undefined);
  } finally {
    await stop?.().catch(() => {});
    await retained?.dispose(); await runtime?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it.skipIf(process.platform === 'win32').each(['false-coordinator-flag', 'local', 'docker'] as const)(
  'withholds terminal evidence for an unacknowledged coordinator using %s', async kind => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'coordinator-protocol-'));
    const run = vi.fn(async () => ({ stdout: '', code: 0 }));
    const provider = kind === 'docker' ? createDockerExecutionHost({ image: 'example/fixture:local', run }) : createDetachedExecutionHost();
    try {
      await crashedCoordinator(provider, root, kind === 'false-coordinator-flag' ? false : true);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10000,
);

it.skipIf(process.platform === 'win32').each(['local', 'docker'] as const)('settles an acknowledged coordinator through the %s adapter', async kind => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'coordinator-ack-'));
  const run = vi.fn(async () => ({ stdout: '', code: 0 }));
  const provider = kind === 'docker' ? createDockerExecutionHost({ image: 'example/fixture:local', run }) : createDetachedExecutionHost();
  let stop: (() => Promise<void>) | undefined;
  try {
    const entry = join(root, 'pre-pr-cli.js');
    await writeFile(entry, "process.send({ kind: 'helmsman-coordinator-settled', version: 1 }, () => process.exit(0));setTimeout(() => process.exit(1), 2000);");
    const launch = { ...spec(root), args: [entry], coordinator: true };
    const host = adapter(provider);
    const ref = await host.launch({ ...launch, args: [...launch.args] });
    stop = () => host.stop(ref);
    await vi.waitFor(() => expect(existsSync(launch.exitPath)).toBe(true), { timeout: 5000 });
    expect(await host.discover?.({ ...launch, args: [...launch.args] }, ref)).toMatchObject({ status: 'found', evidence: { state: 'exited', exitCode: 0 } });
    expect(run).not.toHaveBeenCalled();
  } finally {
    await stop?.().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
