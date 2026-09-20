import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [installation, phase, stateRoot] = process.argv.slice(2);
const module = path => import(pathToFileURL(join(installation, path)).href);
const { openPersistence } = await module('server/helmsman/persistence.js');
const { openDb } = await module('server/helmsman/db.js');
const { openExecutionStore } = await module('server/helmsman/execution-store.js');
const { openPluginLifecycle } = await module('server/helmsman/plugins/lifecycle.js');
const { createPluginCoordinator, loadPluginSnapshot, readPluginState } = await module('server/helmsman/plugins/store.js');
const { activateBackendPlugins } = await module('server/helmsman/plugins/backend.js');
const { openTodoStore } = await module('server/helmsman/todos.js');
const { openTaskSourceStore, writeTaskSource } = await module('server/helmsman/task-sources/store.js');
const { openLocalSourceAdapter } = await module('server/helmsman/task-sources/local-records.js');
const { createSourceAdoptionCoordinator } = await module('server/helmsman/task-sources/adoption.js');
const { createSourceAdmissionCoordinator } = await module('server/helmsman/task-sources/admission.js');
const { createTaskSourceService } = await module('server/helmsman/task-source-service.js');
const { retainLegacyRuntime, verifyLegacyRuntime } = await module('server/helmsman/legacy-runtime-artifact.js');

await mkdir(stateRoot, { recursive: true });
const plugins = join(stateRoot, 'plugins');
const persistence = openPersistence(join(stateRoot, 'state.sqlite'));
const db = openDb(persistence.sql);
const executions = openExecutionStore(persistence);
const lifecycle = openPluginLifecycle(persistence, executions);
const runsDir = join(stateRoot, 'runs');
await mkdir(runsDir, { recursive: true });
const retained = await retainLegacyRuntime(installation, join(runsDir, '.runtime-artifacts'));
const coordinator = await createPluginCoordinator({ root: plugins, persistence, executions, lifecycle, runtimeArtifact: retained.artifact, resetHealth: true });
const runtime = await activateBackendPlugins({ root: plugins, coordinator, snapshot: await loadPluginSnapshot(plugins, false, coordinator),
  usage: { query: async () => { throw new Error('Task sources must not need usage access'); } } });
assert.deepEqual(runtime.errors, []);
const store = openTaskSourceStore(persistence);
const local = openLocalSourceAdapter(store);
const service = createTaskSourceService({ store, registry: runtime.taskSources, local, http() { throw new Error('Local sources must not need HTTP'); } });
const admission = createSourceAdmissionCoordinator({ store, registry: runtime.taskSources, local, context: service.context });
const signal = AbortSignal.timeout(15_000);
const repo = 'org/collection';
const checkpoint = join(stateRoot, 'source-checkpoint.json');
const installed = readPluginState(plugins).plugins;
const binding = (id, localId) => {
  const plugin = installed.find(value => value.id === id);
  assert.ok(plugin);
  return { pluginId: id, providerId: `${id}/${localId}`, artifactHash: plugin.hash, contractVersion: 1, connectionId: null, credentialHandle: null };
};

try {
  if (phase === 'adopt') {
    const todos = openTodoStore(persistence.sql, () => '2026-09-20T00:00:00.000Z');
    const original = todos.create({ title: 'Existing local task', repo, description: 'Preserve data while changing provider', acceptanceCriteria: 'Keep original identity', priority: 'P1' });
    const identityEvidence = { version: 1, level: 'verified', authority: { protocol: 'helmsman.local-collection/v1', authorityId: 'retained-collection', identityFormat: 'helmsman.local-task/v1' }, verifiedAt: '2026-09-20T00:00:00.000Z', proof: { collectionId: 'retained-collection' } };
    const provision = { label: 'Local work', identityEvidence, storageLayout: 'legacy-todos', collectionId: 'retained-collection', settings: {}, allowedRepos: [repo] };
    const first = store.provision({ ...provision, provisioningKey: 'original', binding: binding('example.local-todos', 'todos') });
    persistence.transaction(() => writeTaskSource(store, { ...first.source, conversionReady: true }));
    const priorTask = await service.load({ instanceId: first.instance.id, instanceRevision: 1, repo, ref: { sourceId: first.source.id, externalId: original.id } }, signal);
    const priorSnapshot = store.retainTaskSnapshot(priorTask, first.instance);
    const replacement = store.provision({ ...provision, provisioningKey: 'replacement', binding: binding('example.alternative-local-tasks', 'collection') });
    assert.equal(replacement.source.id, first.source.id);
    const adoption = createSourceAdoptionCoordinator({ store, registry: runtime.taskSources,
      context: (instance, scope, signal) => ({ instance, repo: scope, signal, local: local.forContext(instance, scope, signal), http: null }) });
    const before = local.get(first.source.id, original.id);
    const validation = await adoption.validate({ sourceId: first.source.id, instanceId: replacement.instance.id, expectedSourceRevision: first.source.revision,
      actor: 'distribution-test', reason: 'Verify independent compatible provider', repo, signal, probes: [{ ref: before.ref, revision: before.revision }] });
    const adopted = adoption.adopt(validation.id);
    assert.equal(adopted.currentInstanceId, replacement.instance.id);
    assert.deepEqual(todos.get(original.id), original);
    const target = { instanceId: replacement.instance.id, instanceRevision: 1, repo };
    const loaded = await service.load({ ...target, ref: before.ref }, signal);
    assert.equal(loaded.providerData.implementation, 'independent-local-collection');
    const create = { ...target, commandId: 'create', requestId: 'create-independent', input: { title: 'New provider task', repo, description: 'Run after restart', priority: 'P0' } };
    const created = await service.command(create, signal);
    assert.equal(created.ref.externalId, 'TODO-2');
    assert.deepEqual(await service.command(create, signal), JSON.parse(JSON.stringify(created)));
    await service.command({ ...target, commandId: 'update', requestId: 'update-existing', input: { ref: before.ref, expectedRevision: before.revision, patch: { title: 'Updated through replacement' } } }, signal);
    assert.equal(todos.get(original.id).createdAt, original.createdAt);
    const claim = admission.reserve({ ref: created.ref, repo, admissionId: 'external-voyage', runId: 'external-voyage', instanceId: replacement.instance.id,
      expectedInstanceRevision: 1, expectedSourceRevision: adopted.revision }, () => {});
    const prepared = await admission.prepare({ claimId: claim.id, repo, signal });
    assert.throws(() => admission.commit(prepared, () => { throw new Error('Simulated admission transaction failure'); }), /Simulated/);
    assert.equal(todos.get(created.ref.externalId).state, 'todo');
    assert.equal(store.claim(claim.id).state, 'reserved');
    const claimed = admission.commit(prepared, value => value);
    assert.equal(todos.get(created.ref.externalId).state, 'in_progress');
    await writeFile(checkpoint, JSON.stringify({ sourceId: adopted.id, instanceId: replacement.instance.id, claimId: claimed.id,
      snapshotHash: claimed.taskSnapshotHash, priorSnapshotHash: priorSnapshot.hash, original, createdRef: created.ref, create }));
    console.log('independent source adopted and claim committed');
  } else if (phase === 'resume') {
    const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
    assert.equal(store.source(saved.sourceId).currentInstanceId, saved.instanceId);
    const prior = store.taskSnapshot(saved.priorSnapshotHash);
    assert.equal(prior.instance.binding.providerId, 'example.local-todos/todos');
    assert.equal(prior.task.ref.externalId, saved.original.id);
    const claim = store.claim(saved.claimId);
    const taskSnapshot = store.taskSnapshot(saved.snapshotHash);
    assert.equal(claim.state, 'claimed');
    assert.equal(taskSnapshot.instance.binding.providerId, 'example.alternative-local-tasks/collection');
    assert.equal((await service.command(saved.create, signal)).ref.externalId, saved.createdRef.externalId);
    const { sourceExecutionTask, sourceExecutionSnapshot } = await module('server/helmsman/task-source-execution.js');
    const { createRunnerDurability } = await module('server/helmsman/runner-durability.js');
    const { detachedHost } = await module('server/helmsman/run-host.js');
    const { startRun } = await module('server/helmsman/runner.js');
    const { RunBus } = await module('server/helmsman/event-bus.js');
    const { loadConfig } = await module('server/config.js');
    const artifact = { pluginId: taskSnapshot.instance.binding.pluginId, artifactHash: taskSnapshot.instance.binding.artifactHash, packageVersion: '0.1.0', requires: [] };
    let completion;
    const durable = createRunnerDurability({ persistence, db, executions, runsDir, maxConcurrency: 1,
      snapshot: (run, task) => sourceExecutionSnapshot({ run, task, artifact: retained.artifact, host: 'detached', config: loadConfig({}), source: taskSnapshot, claim, sourceArtifacts: [artifact] }),
      verify: async () => { assert.ok(await verifyLegacyRuntime(join(runsDir, '.runtime-artifacts'), retained.artifact.artifactHash)); },
      finalize: () => admission.commitSettlement(completion, () => {}) });
    const runId = await startRun(sourceExecutionTask(taskSnapshot, claim), { db, durable, bus: new RunBus(), runsDir,
      genId: () => claim.runId, now: () => new Date().toISOString(), pollIntervalMs: 5,
      host: detachedHost(join(retained.root, 'server/helmsman/run-wrapper.mjs')),
      adapter: { id: 'command', buildCommand: () => ({ cmd: process.execPath, args: ['-e', 'console.log("independent task completed")'] }), parseLine: () => null },
      createWorktree: async () => { const path = join(stateRoot, 'worktree'); await mkdir(path); return { path, branch: 'agent/external-voyage' }; },
      removeWorktree: async () => {},
      prepareFinalization: async row => { completion = await admission.prepareSettlement({ claimId: claim.id, repo, signal, purpose: 'completion',
        request: { runId: row.id, attempt: row.attempt, task: taskSnapshot.task, claimReceipt: claim.receipt, outcome: row.status, publication: null } }); } });
    assert.equal(runId, claim.runId);
    assert.equal(db.getRun(runId).status, 'succeeded');
    assert.equal(store.claim(claim.id).state, 'settled');
    assert.equal(local.get(saved.sourceId, saved.createdRef.externalId).data.state, 'in_review');
    assert.equal(local.get(saved.sourceId, saved.original.id).data.createdAt, saved.original.createdAt);
    assert.equal(executions.reservations().length, 0);
    assert.equal(executions.snapshot(executions.attempt({ runId, attempt: 1 }).snapshotId).logicalWork.taskId, saved.createdRef.externalId);
    console.log('independent source worker completed after restart');
  } else throw new Error('Unknown source distribution phase');
} finally {
  await runtime.dispose(); coordinator.dispose(); persistence.close();
}
