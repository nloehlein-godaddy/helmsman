// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { todosProvider } from '../../src/plugins/todos/provider';
import { LOCAL_TASK_EDITOR_V1 } from '../../src/plugins/task-edit';
import { parseSourceCommandV1, type SourceCommandV1 } from '../../src/plugins/source-command';
import type { TaskSourceProviderV1 } from '../../src/plugins/tasks';
import { openPersistence, persistenceHash, type Persistence } from './persistence';
import { openTaskSourceStore, writeTaskSource } from './task-sources/store';
import { createTaskSourceRegistry } from './task-sources/registry';
import { openLocalSourceAdapter } from './task-sources/local-records';
import { createTaskSourceService } from './task-source-service';
import { createTaskEditService } from './task-edit-service';
import { createSourceCommandCoordinator, SourceCommandAccessError } from './source-command-coordinator';
import { openSourceCommandStore } from './source-command-store';
import { openDb } from './db';
import { openExecutionStore } from './execution-store';
import { openAdmissionStore } from './admission-store';
import { openOperationStore } from './operations';
import { handleRecoveryRequest } from './recovery-http';
import { createRecoveryService, readRecoverySnapshot } from './recovery-service';

const connections: Persistence[] = []; const roots: string[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const caller = 'example.todos/panel';
function fixture(provider: TaskSourceProviderV1 = todosProvider) {
  const root = mkdtempSync(join(tmpdir(), 'source-command-')); roots.push(root); const path = join(root, 'main.sqlite');
  const persistence = openPersistence(path); connections.push(persistence); const store = openTaskSourceStore(persistence);
  const registry = createTaskSourceRegistry({ eligible: () => true });
  const binding = { providerId: 'example.todos/todos', pluginId: 'example.todos', artifactHash: 'a'.repeat(64), contractVersion: 1 as const, connectionId: null, credentialHandle: null };
  const declaration = { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: ['create', 'update', 'delete'], access: ['local-records'] as const,
    editorContracts: [{ ...LOCAL_TASK_EDITOR_V1, commands: { create: 'create', update: 'update', delete: 'delete' } }] };
  registry.publish([registry.stage(binding, declaration, provider)]);
  const { source, instance } = store.provision({ provisioningKey: 'local', label: 'Tasks', identityEvidence: { version: 1, level: 'verified', authority: { protocol: 'local', authorityId: 'collection', identityFormat: 'helmsman.local-task/v1' }, verifiedAt: '2026-09-20T00:00:00Z', proof: {} }, storageLayout: 'documents', binding, settings: {}, allowedRepos: ['owner/project', 'owner/other'] });
  persistence.transaction(() => writeTaskSource(store, { ...source, conversionReady: true }));
  const local = openLocalSourceAdapter(store); const service = createTaskSourceService({ store, registry, local, http: () => { throw new Error('Undeclared HTTP'); } });
  const commands = openSourceCommandStore(persistence); let enabled = true;
  const options = { store, registry, local, service, commands, repos: () => ['owner/project', 'owner/other'],
    authorize: () => { if (!enabled) throw new SourceCommandAccessError('Disabled'); }, owner: { token: 'test-owner', pid: 123 }, ownerAlive: () => true };
  const coordinator = createSourceCommandCoordinator(options); const edit = createTaskEditService(options);
  const selection = { version: 1 as const, sourceId: source.id, instanceId: instance.id, instanceRevision: instance.revision, repo: 'owner/project' };
  function create(input: Record<string, string> = {}): SourceCommandV1 {
    return parseSourceCommandV1({ version: 1, requestId: randomUUID(), selection, sourceRevision: source.revision, editor: LOCAL_TASK_EDITOR_V1,
      action: 'create', commandId: 'create', target: null, destinationRepo: selection.repo, input: { title: 'Task', repo: selection.repo, description: 'Work', ...input } });
  }
  function mutation(action: 'update' | 'delete', ref: { sourceId: string; externalId: string }, patch: Record<string, string> = {}): SourceCommandV1 {
    const record = local.get(ref.sourceId, ref.externalId)!;
    return parseSourceCommandV1({ ...create(), selection: { ...selection, repo: record.repo }, action, commandId: action,
      target: { ref, expectedRevision: record.revision }, destinationRepo: action === 'delete' ? null : patch.repo ?? record.repo,
      input: action === 'update' ? patch : {} });
  }
  function resolution(requestId: string) {
    const record = commands.get(caller, requestId)!;
    return { caller, requestId, repo: record.command.selection.repo, receiptHash: persistenceHash(record.receipt), actor: 'operator', reason: 'Verified local mutation absent', evidence: { note: 'Checked durable receipt' } };
  }
  return { path, persistence, store, registry, local, service, commands, options, coordinator, edit, selection, create, mutation, source, instance, resolution,
    disable: () => { enabled = false; store.configureInstance({ instanceId: instance.id, expectedRevision: instance.revision, desiredEnabled: false }); registry.publish([]); } };
}
it('atomically creates, moves and deletes canonical tasks and replays terminal results after disablement', async () => {
  const f = fixture(); const create = f.create(); const created = await f.coordinator.submit(caller, create);
  expect(created).toMatchObject({ status: 'succeeded', result: { kind: 'changed', repo: create.selection.repo } });
  expect(JSON.stringify(created)).not.toMatch(/claim|credential|artifactHash|description/);
  const ref = created.result!.ref;
  const move = f.mutation('update', ref, { repo: 'owner/other', title: 'Moved' }); const moved = await f.coordinator.submit(caller, move);
  expect(moved.result).toMatchObject({ kind: 'changed', ref, repo: 'owner/other' });
  const remove = f.mutation('delete', ref); const deleted = await f.coordinator.submit(caller, remove);
  expect(deleted.result).toEqual({ kind: 'deleted', ref, repo: 'owner/other', previousRevision: remove.target!.expectedRevision });
  f.disable();
  for (const [command, receipt] of [[create, created], [move, moved], [remove, deleted]] as const) expect(await f.coordinator.submit(caller, command)).toEqual(receipt);
  expect(f.local.get(ref.sourceId, ref.externalId)).toBeNull();
});
it('verifies actual retained run identity and galleon before exposing provider editor links', async () => {
  const f = fixture({ ...todosProvider, async readEditor(input, context) {
    const document = await todosProvider.readEditor!(input, context);
    return document ? { ...document, relatedRun: { runId: 'original-run', repo: context.repo! } } : null;
  } });
  const created = await f.coordinator.submit(caller, f.create()); const ref = created.result!.ref;
  const query = { selection: f.selection, editor: LOCAL_TASK_EDITOR_V1, ref };
  const getRun = vi.fn((): { id: string; repo: string } | null => ({ id: 'original-run', repo: f.selection.repo }));
  const edit = createTaskEditService({ ...f.options, getRun });
  expect((await edit.load(query, new AbortController().signal))?.relatedRun).toEqual({ runId: 'original-run', repo: f.selection.repo });
  expect((await edit.create({ selection: f.selection, editor: LOCAL_TASK_EDITOR_V1 }, new AbortController().signal)).relatedRun).toBeNull();
  expect((await f.edit.load(query, new AbortController().signal))?.relatedRun).toBeNull();
  getRun.mockReturnValueOnce(null);
  expect((await edit.load(query, new AbortController().signal))?.relatedRun).toBeNull();
  getRun.mockReturnValueOnce({ id: 'different-run', repo: f.selection.repo });
  expect((await edit.load(query, new AbortController().signal))?.relatedRun).toBeNull();
  getRun.mockImplementationOnce(() => { throw new Error('Related run storage unavailable'); });
  expect((await edit.load(query, new AbortController().signal))?.relatedRun).toBeNull();
  await f.coordinator.submit(caller, f.mutation('update', ref, { repo: 'owner/other' }));
  const moved = { ...query, selection: { ...f.selection, repo: 'owner/other' } };
  expect((await edit.load(moved, new AbortController().signal))?.relatedRun).toBeNull();
  expect(getRun).toHaveBeenLastCalledWith('original-run');
});
it('rejects stale task revisions durably and never reinterprets a changed request', async () => {
  const f = fixture(); const created = await f.coordinator.submit(caller, f.create()); const ref = created.result!.ref;
  const first = f.mutation('update', ref, { title: 'First' }); const stale = f.mutation('update', ref, { title: 'Second' });
  await f.coordinator.submit(caller, first); const rejected = await f.coordinator.submit(caller, stale);
  expect(rejected.status).toBe('rejected'); expect(await f.coordinator.submit(caller, stale)).toEqual(rejected);
  await expect(f.coordinator.submit(caller, { ...stale, input: { ...stale.input as object, title: 'New' } })).rejects.toThrow('content changed');
});
it('rechecks active claims and source scope after asynchronous preparation', async () => {
  const prepared = vi.fn(todosProvider.commands!.update!.prepare); let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const provider = { ...todosProvider, commands: { ...todosProvider.commands, update: { async prepare(...args: Parameters<typeof prepared>) { const plan = await prepared(...args); await wait; return plan; } } } };
  const f = fixture(provider); const created = await f.coordinator.submit(caller, f.create()); const command = f.mutation('update', created.result!.ref, { title: 'Changed' });
  const pending = f.coordinator.submit(caller, command); await vi.waitFor(() => expect(prepared).toHaveBeenCalled());
  f.store.reserveWork({ ref: created.result!.ref, admissionId: 'run', runId: 'run', instanceId: f.instance.id, expectedSourceRevision: f.source.revision, expectedInstanceRevision: f.instance.revision });
  release(); expect((await pending).status).toBe('rejected');
  expect(f.local.get(created.result!.ref.sourceId, created.result!.ref.externalId)?.data).toMatchObject({ title: 'Task' });
});
it('rejects a provider plan that changes pinned target or destination', async () => {
  const f = fixture(); const created = await f.coordinator.submit(caller, f.create()); const command = f.mutation('update', created.result!.ref, { repo: 'owner/other' });
  const receipt = await f.coordinator.submit(caller, { ...command, destinationRepo: 'owner/project' });
  expect(receipt.status).toBe('rejected'); expect(f.local.get(created.result!.ref.sourceId, created.result!.ref.externalId)?.repo).toBe('owner/project');
});
it('rolls back a local mutation when saving its public receipt fails', async () => {
  const f = fixture(); const settle = f.commands.settle;
  const commands = { ...f.commands, settle: vi.fn<typeof settle>((caller, receipt) => { if (receipt.status === 'succeeded') throw new Error('Database failure'); return settle(caller, receipt); }) };
  const service = createSourceCommandCoordinator({ ...f.options, commands }); const command = f.create();
  expect((await service.submit(caller, command)).status).toBe('recovery-required');
  expect(f.persistence.sql.prepare('SELECT * FROM source_documents').all()).toEqual([]);
  expect(f.persistence.sql.prepare('SELECT * FROM source_commands').all()).toEqual([]);
});
it('reconciles an immutable recorded local receipt before disabled source and contribution gates', async () => {
  const f = fixture(); const command = f.create();
  const record = f.commands.reserve(caller, command, { instance: f.instance, sourceRevision: f.source.revision });
  const plan = await todosProvider.commands!.create!.prepare(command.input, f.service.context(f.instance, command.selection.repo, new AbortController().signal));
  f.local.applyCommand({ requestId: record.localRequestId, instance: f.instance, repo: command.selection.repo, commandId: command.commandId, commandInput: command.input, plan });
  f.disable(); const receipt = f.coordinator.receipt(caller, { repo: command.selection.repo, requestId: command.requestId });
  expect(receipt?.status).toBe('succeeded'); expect(await f.coordinator.submit(caller, command)).toEqual(receipt);
});
it('resolves uncertain commands with audit, exact replay and no task mutation, including after restart', async () => {
  const provider = { ...todosProvider, commands: { ...todosProvider.commands, create: { async prepare() { throw new Error('Unknown provider failure'); } } } };
  const f = fixture(provider); const command = f.create(); expect((await f.coordinator.submit(caller, command)).status).toBe('recovery-required');
  const proof = f.resolution(command.requestId); expect(f.coordinator.recovery()[0]?.canResolve).toBe(true);
  const safe = readRecoverySnapshot(f.path, command.selection.repo); expect(safe.sourceCommands).toMatchObject([{ requestId: command.requestId, actions: [] }]);
  expect(JSON.stringify(safe.sourceCommands)).not.toMatch(/Work|credential|binding/);
  expect(() => f.coordinator.resolveNotApplied({ ...proof, receiptHash: 'a'.repeat(64) })).toThrow('receipt changed');
  const rejected = f.coordinator.resolveNotApplied(proof); expect(rejected).toMatchObject({ status: 'rejected', resolution: { kind: 'not-applied' } });
  f.persistence.close(); const next = openPersistence(f.path); connections.push(next); const reopened = openSourceCommandStore(next);
  expect(reopened.get(caller, command.requestId)?.receipt).toEqual(rejected);
  expect(reopened.resolve(proof, () => { throw new Error('Do not reinspect replay'); })).toEqual(rejected);
  expect(() => reopened.resolve({ ...proof, reason: 'Changed' }, () => {})).toThrow('proof changed');
  expect(next.sql.prepare('SELECT * FROM source_documents').all()).toEqual([]);
});
it('fences late preparation after core recovery records non-application', async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const provider = { ...todosProvider, commands: { ...todosProvider.commands, create: { async prepare(...args: Parameters<NonNullable<TaskSourceProviderV1['commands']>[string]['prepare']>) { await wait; return todosProvider.commands!.create!.prepare(...args); } } } };
  const f = fixture(provider); const command = f.create(); const pending = f.coordinator.submit(caller, command);
  const record = f.commands.get(caller, command.requestId)!; f.commands.settle(caller, { ...record.receipt, status: 'recovery-required' });
  const rejected = f.coordinator.resolveNotApplied(f.resolution(command.requestId)); release();
  expect(await pending).toEqual(rejected); expect(f.persistence.sql.prepare('SELECT * FROM source_documents').all()).toEqual([]);
});
it('discovers editor contracts, reads bounded public documents, and lists undescribed To do items before pagination', async () => {
  const f = fixture(); const command = f.create({ description: '' }); await f.coordinator.submit(caller, command);
  expect(f.edit.discover('owner/project').sources[0]?.editors[0]).toMatchObject(LOCAL_TASK_EDITOR_V1);
  const create = await f.edit.create({ selection: f.selection, editor: LOCAL_TASK_EDITOR_V1 }, new AbortController().signal);
  expect(create).toMatchObject({ target: null, value: { title: '', repo: 'owner/project' }, destinationRepos: ['owner/project', 'owner/other'] });
  const page = await f.edit.list({ selection: f.selection, editor: LOCAL_TASK_EDITOR_V1, filter: { state: 'todo' }, cursor: null, limit: 1 }, new AbortController().signal);
  expect(page.items).toHaveLength(1);
  expect(page.total).toBe(1);
  const record = f.local.get(page.items[0]!.ref.sourceId, page.items[0]!.ref.externalId)!;
  expect(page.items[0]).toMatchObject({ createdAt: (record.data as Record<string, unknown>).createdAt, updatedAt: (record.data as Record<string, unknown>).updatedAt });
  expect(page.items[0]).not.toHaveProperty('providerData');
  expect((await f.service.list({ ...f.selection, state: 'ready', cursor: null, limit: 1 }, new AbortController().signal)).items).toEqual([]);
  const loaded = await f.edit.load({ selection: f.selection, editor: LOCAL_TASK_EDITOR_V1, ref: page.items[0]!.ref }, new AbortController().signal);
  expect(loaded?.commands.update?.available).toBe(true); expect(JSON.stringify(loaded)).not.toMatch(/claim|credential|binding|artifact/);
});
it('times out a provider that ignores cancellation and never applies its late plan', async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const provider = { ...todosProvider, commands: { ...todosProvider.commands, create: { async prepare(...args: Parameters<NonNullable<TaskSourceProviderV1['commands']>[string]['prepare']>) { await wait; return todosProvider.commands!.create!.prepare(...args); } } } };
  const f = fixture(provider); const service = createSourceCommandCoordinator({ ...f.options, prepareTimeoutMs: 10 }); const command = f.create();
  const receipt = await service.submit(caller, command); expect(receipt.status).toBe('recovery-required');
  expect(service.recovery()[0]?.canResolve).toBe(true);
  release(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.persistence.sql.prepare('SELECT * FROM source_documents').all()).toEqual([]);
  expect(service.resolveNotApplied(f.resolution(command.requestId)).status).toBe('rejected');
});
it('filters full task search before pagination and binds search to continuation identity', async () => {
  const f = fixture(); await f.coordinator.submit(caller, f.create({ title: 'Excluded' }));
  await f.coordinator.submit(caller, f.create({ title: 'Needle one' })); await f.coordinator.submit(caller, f.create({ title: 'Needle two' }));
  const query = { selection: f.selection, editor: LOCAL_TASK_EDITOR_V1, filter: { state: 'todo', search: 'needle' }, cursor: null, limit: 1 };
  const first = await f.edit.list(query, new AbortController().signal);
  expect(first.items.map(item => item.title)).toEqual(['Needle one']); expect(first.nextCursor).not.toBeNull();
  expect(first.total).toBe(2);
  const next = await f.edit.list({ ...query, cursor: first.nextCursor }, new AbortController().signal);
  expect(next.items.map(item => item.title)).toEqual(['Needle two']);
  expect(next.total).toBe(2);
  await expect(f.edit.list({ ...query, filter: { state: 'todo', search: '' }, cursor: first.nextCursor }, new AbortController().signal)).rejects.toThrow('changed');
});
it('bounds editor reads even when a provider ignores cancellation', async () => {
  const f = fixture({ ...todosProvider, readEditor: () => new Promise(() => {}) });
  await expect(f.edit.create({ selection: f.selection, editor: LOCAL_TASK_EDITOR_V1 }, AbortSignal.timeout(10))).rejects.toMatchObject({ name: 'TimeoutError' });
});

it('routes audited source recovery independently of disabled presentation and preserves exact replay', async () => {
  const f = fixture({ ...todosProvider, commands: { ...todosProvider.commands, create: { async prepare() { throw new Error('Unknown'); } } } });
  const command = f.create(); await f.coordinator.submit(caller, command); f.disable();
  const executions = openExecutionStore(f.persistence); const admissions = openAdmissionStore(f.persistence, executions); const operations = openOperationStore(f.persistence, executions);
  const service = createRecoveryService({ db: openDb(f.persistence.sql), executions, admissions, operations, lifecycle: { list: () => [] }, sourceCommands: f.coordinator });
  const entry = service.snapshot(command.selection.repo).sourceCommands[0]!;
  expect(entry.actions).toEqual(['resolve-source-command']); expect(service.snapshot('owner/other').sourceCommands).toEqual([]);
  const input = { action: 'resolve-source-command', ...f.resolution(command.requestId) };
  const action = () => handleRecoveryRequest('POST', '/api/recovery/actions', new URLSearchParams(), input, service);
  expect(await action()).toEqual({ status: 200, json: { ok: true } });
  expect(service.snapshot().sourceCommands).toEqual([]); expect(await action()).toEqual({ status: 200, json: { ok: true } });
  await expect(service.act({ ...input, evidence: { note: 'Changed' } })).rejects.toThrow('proof changed');
  await expect(service.act({ ...input, caller: null })).rejects.toMatchObject({ status: 400 });
});
it('requires a linked audit for special rejection and rejects mutation evidence added after inspection', async () => {
  const f = fixture({ ...todosProvider, commands: { ...todosProvider.commands, create: { async prepare() { throw new Error('Unknown'); } } } });
  const command = f.create(); await f.coordinator.submit(caller, command); const record = f.commands.get(caller, command.requestId)!;
  expect(() => f.commands.settle(caller, { ...record.receipt, status: 'rejected', resolution: { version: 1, kind: 'not-applied', id: randomUUID() } })).toThrow('transition');
  const proof = f.resolution(command.requestId);
  f.persistence.sql.prepare('INSERT INTO source_commands VALUES(?,?,?)').run(record.localRequestId, 'a'.repeat(64), 'null');
  expect(() => f.coordinator.resolveNotApplied(proof)).toThrow('retained mutation');
  expect(f.coordinator.recovery()[0]?.canResolve).toBe(false);
});
it('rejects audit corruption and never lets an old receipt become a different terminal result', async () => {
  const f = fixture({ ...todosProvider, commands: { ...todosProvider.commands, create: { async prepare() { throw new Error('Unknown'); } } } });
  const command = f.create(); await f.coordinator.submit(caller, command); const receipt = f.coordinator.resolveNotApplied(f.resolution(command.requestId));
  expect(() => f.commands.settle(caller, { ...receipt, message: 'Changed' })).toThrow('already settled');
  f.persistence.sql.prepare('UPDATE public_source_command_resolutions SET inputHash=?').run('a'.repeat(64));
  expect(() => f.commands.get(caller, command.requestId)).toThrow('audit integrity');
});
