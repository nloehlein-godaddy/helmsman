// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { todosProvider } from '../../src/plugins/todos/provider';
import { parseSourceAdminCommandV1, type SourceAdminInputV1 } from '../../src/plugins/source-admin';
import type { PluginJson, TaskSourceDeclaration } from '../../src/plugins/backend';
import { openPersistence, type Persistence } from './persistence';
import { openTaskSourceStore, writeTaskSource } from './task-sources/store';
import { createTaskSourceRegistry } from './task-sources/registry';
import { openLocalSourceAdapter } from './task-sources/local-records';
import { createTaskSourceService } from './task-source-service';
import { openTaskSourceSchedule } from './task-source-schedule';
import { AutoClaimScheduler } from './scheduler';
import { createSourceAdminService } from './source-admin-service';

const connections: Persistence[] = []; const roots: string[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const caller = 'example.settings/panel'; const repo = 'owner/project';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'source-admin-')); roots.push(root);
  const persistence = openPersistence(join(root, 'main.sqlite')); connections.push(persistence); const store = openTaskSourceStore(persistence);
  const registry = createTaskSourceRegistry({ eligible: () => true });
  const binding = { providerId: 'example.todos/todos', pluginId: 'example.todos', artifactHash: 'a'.repeat(64), contractVersion: 1 as const, connectionId: null, credentialHandle: null };
  const declaration: TaskSourceDeclaration = { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: ['create', 'update', 'delete'], access: ['local-records'],
    settingsFields: { visible: { label: 'Visible setting', schema: { type: 'string', default: '', maxLength: 20 } }, implicit: { label: 'Optional setting', schema: { type: 'string', default: 'default', maxLength: 20 } } } };
  const replacementBinding = { ...binding, pluginId: 'example.other', providerId: 'example.other/todos', artifactHash: 'b'.repeat(64) };
  registry.publish([registry.stage(binding, declaration, todosProvider), registry.stage(replacementBinding, declaration, todosProvider)]);
  const { source, instance } = store.provision({ provisioningKey: 'local', label: 'Tasks', identityEvidence: { version: 1, level: 'verified', authority: { protocol: 'helmsman.local-collection/v1', authorityId: 'collection', identityFormat: 'helmsman.local-task/v1' }, verifiedAt: '2026-09-20T00:00:00Z', proof: {} }, storageLayout: 'documents', binding,
    settings: { visible: 'before', internal: 'hidden-secret' }, allowedRepos: [repo, 'owner/other'] });
  persistence.transaction(() => writeTaskSource(store, { ...source, conversionReady: true }));
  const local = openLocalSourceAdapter(store); const service = createTaskSourceService({ store, registry, local, http: () => { throw new Error('Undeclared HTTP'); } });
  const schedule = openTaskSourceSchedule(store, service); schedule.initialize({ repos: [repo, 'owner/other'], defaultSourceId: source.id });
  const scheduler = new AutoClaimScheduler({ canStart: () => true, fetchTopBacklog: async () => null, launch: () => {} });
  const options = { store, registry, service, schedule, scheduler, repos: () => [repo, 'owner/other'], authorize: () => {} };
  const admin = createSourceAdminService(options);
  const target = { sourceId: source.id, sourceRevision: source.revision, instanceId: instance.id, instanceRevision: instance.revision };
  const configure = (): SourceAdminInputV1 => ({ version: 1, kind: 'configure', repo, target, changes: { label: 'Edited', desiredEnabled: true, allowedRepos: [repo, 'owner/other'], settings: { visible: 'after' } } });
  const command = (input: SourceAdminInputV1) => parseSourceAdminCommandV1({ ...input, requestId: randomUUID() });
  return { persistence, store, registry, service, schedule, scheduler, options, admin, source, instance, target, configure, command, replacementBinding };
}
it('projects only declared settings and separates persistent selection from runtime state', () => {
  const f = fixture(); const value = f.admin.snapshot(caller, repo);
  expect(value.sources[0]).toMatchObject({ target: f.target, settings: { visible: 'before' }, settingsFields: { visible: { label: 'Visible setting' } } });
  expect(JSON.stringify(value)).not.toMatch(/hidden-secret|credentialHandle|connectionId/);
  expect(value.sources[0]?.settings).not.toHaveProperty('implicit');
  expect(value.schedules).toEqual([{ repo, revision: 1, instanceIds: [f.instance.id] }]);
  expect(value.runtimes).toEqual([{ repo, epoch: f.scheduler.runtime(repo).epoch, revision: 0, enabled: false }]);
});
it('configures declared fields with CAS, preserves hidden fields, and replays immutable receipts after disablement', () => {
  const f = fixture(); const input = f.command(f.configure()); const receipt = f.admin.submit(caller, input);
  expect(receipt).toMatchObject({ status: 'succeeded', result: { kind: 'configured', target: { ...f.target, instanceRevision: 2 } } });
  expect(f.store.instance(f.instance.id)?.settings).toEqual({ visible: 'after', internal: 'hidden-secret' });
  f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: 2, desiredEnabled: false }); f.registry.removePlugin('example.todos');
  expect(f.admin.submit(caller, input)).toEqual(receipt);
  expect(f.admin.receipt(caller, { repo, requestId: input.requestId })).toEqual(receipt);
  expect(f.admin.submit(caller, f.command(f.configure())).status).toBe('rejected');
  expect(() => f.admin.submit(caller, { ...input, changes: { ...input.kind === 'configure' ? input.changes : {}, label: 'Different' } })).toThrow();
});
it('rolls configuration back if its durable receipt cannot be saved', () => {
  const f = fixture(); const input = f.command(f.configure());
  f.persistence.sql.exec("CREATE TRIGGER reject_admin_receipt BEFORE INSERT ON public_source_admin_receipts BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END");
  expect(() => f.admin.submit(caller, input)).toThrow('receipt unavailable');
  expect(f.store.instance(f.instance.id)?.revision).toBe(1);
  expect(f.store.instance(f.instance.id)?.settings.visible).toBe('before');
  f.persistence.sql.exec('DROP TRIGGER reject_admin_receipt'); expect(f.admin.submit(caller, input).status).toBe('succeeded');
});
it('resolves exact terminal receipts after their original galleon disappears from discovery', () => {
  const f = fixture(); const input = f.command(f.configure()); const saved = f.admin.submit(caller, input);
  const changed = createSourceAdminService({ ...f.options, repos: () => [] });
  expect(changed.receipt(caller, { repo, requestId: input.requestId })).toEqual(saved);
  expect(changed.submit(caller, input)).toEqual(saved);
  expect(() => changed.submit(caller, f.command(f.configure()))).toThrow('unavailable');
});
it('rejects hidden and invalid settings without changing any source state', () => {
  const f = fixture(); const original = f.configure(); if (original.kind !== 'configure') throw new Error('Fixture');
  for (const settings of [{ internal: 'overwritten' }, { visible: 'x'.repeat(21) }, { visible: null }] as Record<string, PluginJson>[]) {
    expect(f.admin.submit(caller, f.command({ ...original, changes: { ...original.changes, settings } })).status).toBe('rejected');
  }
  expect(f.store.instance(f.instance.id)).toEqual(f.instance);
});
it('allows core source configuration after its provider becomes unavailable while preserving hidden settings', () => {
  const f = fixture(); const original = f.configure(); if (original.kind !== 'configure') throw new Error('Fixture');
  f.registry.removePlugin('example.todos');
  expect(f.admin.snapshot(caller, repo).sources[0]).toMatchObject({ available: false, settingsFields: {}, settings: {} });
  expect(f.admin.submit(caller, f.command({ ...original, changes: { ...original.changes, desiredEnabled: false, settings: {} } })).status).toBe('succeeded');
  expect(f.store.instance(f.instance.id)).toMatchObject({ desiredEnabled: false, settings: f.instance.settings });
});
it('resets omitted declared settings to provider defaults while preserving undeclared values', () => {
  const f = fixture(); const original = f.configure(); if (original.kind !== 'configure') throw new Error('Fixture');
  expect(f.admin.submit(caller, f.command({ ...original, changes: { ...original.changes, settings: {} } })).status).toBe('succeeded');
  expect(f.store.instance(f.instance.id)?.settings).toEqual({ internal: 'hidden-secret' });
  expect(f.admin.snapshot(caller, repo).sources[0]?.settings).toEqual({});
});
it('saves source selection independently of automatic start enablement and handles selection CAS', () => {
  const f = fixture(); const input = f.command({ version: 1, kind: 'schedule', repo, expectedRevision: 1, instanceIds: [] });
  const saved = f.admin.submit(caller, input); expect(saved.status).toBe('succeeded');
  expect(f.scheduler.isEnabled(repo)).toBe(false);
  expect(f.admin.submit(caller, f.command({ version: 1, kind: 'schedule', repo, expectedRevision: 1, instanceIds: [f.instance.id] })).status).toBe('rejected');
  expect(f.admin.submit(caller, input)).toEqual(saved);
});
it('pins runtime toggles to the process and CAS, including changes through the legacy setter', () => {
  const f = fixture(); const current = f.scheduler.runtime(repo);
  const input = f.command({ version: 1, kind: 'runtime', repo, epoch: current.epoch, expectedRevision: current.revision, enabled: true });
  const saved = f.admin.submit(caller, input); expect(saved.status).toBe('succeeded'); expect(f.scheduler.isEnabled(repo)).toBe(true);
  f.scheduler.setEnabled(repo, false); expect(f.admin.submit(caller, input)).toEqual(saved); expect(f.scheduler.isEnabled(repo)).toBe(false);
  expect(f.admin.submit(caller, f.command({ version: 1, kind: 'runtime', repo, epoch: current.epoch, expectedRevision: current.revision, enabled: true })).status).toBe('rejected');
  const scheduler = new AutoClaimScheduler({ canStart: () => true, fetchTopBacklog: async () => null, launch: () => {} });
  const restarted = createSourceAdminService({ ...f.options, scheduler });
  expect(restarted.submit(caller, input)).toEqual(saved); expect(scheduler.isEnabled(repo)).toBe(false);
  expect(() => restarted.submit(caller, { ...input, epoch: scheduler.runtime(repo).epoch })).toThrow();
  expect(() => restarted.submit(caller, { ...f.configure(), requestId: input.requestId })).toThrow();
  expect(f.persistence.sql.prepare('SELECT * FROM public_source_admin_runtime_intents').all()).toHaveLength(2);
});
it('reserves runtime identity before toggling and reconciles failed receipt storage without toggling again', () => {
  const f = fixture(); const current = f.scheduler.runtime(repo);
  const input = f.command({ version: 1, kind: 'runtime', repo, epoch: current.epoch, expectedRevision: 0, enabled: true });
  f.persistence.sql.exec("CREATE TRIGGER reject_admin_receipt BEFORE INSERT ON public_source_admin_receipts BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END");
  expect(() => f.admin.submit(caller, input)).toThrow('receipt unavailable'); expect(f.scheduler.isEnabled(repo)).toBe(true);
  expect(f.persistence.sql.prepare('SELECT * FROM public_source_admin_runtime_intents').all()).toHaveLength(1);
  f.scheduler.setEnabled(repo, false); f.persistence.sql.exec('DROP TRIGGER reject_admin_receipt');
  expect(() => f.admin.submit(caller, { ...f.configure(), requestId: input.requestId })).toThrow();
  expect(f.admin.submit(caller, input)).toMatchObject({ status: 'succeeded' });
  expect(f.scheduler.runtime(repo)).toMatchObject({ enabled: false, revision: 2 });
});
it('expires an unresolved old-process toggle after storage failure and never reuses its identity for a new command', () => {
  const f = fixture(); const current = f.scheduler.runtime(repo);
  const input = f.command({ version: 1, kind: 'runtime', repo, epoch: current.epoch, expectedRevision: 0, enabled: true });
  f.persistence.sql.exec("CREATE TRIGGER reject_admin_receipt BEFORE INSERT ON public_source_admin_receipts BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END");
  expect(() => f.admin.submit(caller, input)).toThrow('receipt unavailable'); f.persistence.sql.exec('DROP TRIGGER reject_admin_receipt');
  const scheduler = new AutoClaimScheduler({ canStart: () => true, fetchTopBacklog: async () => null, launch: () => {} });
  const restarted = createSourceAdminService({ ...f.options, scheduler });
  expect(() => restarted.submit(caller, { ...f.configure(), requestId: input.requestId })).toThrow();
  expect(restarted.submit(caller, input)).toMatchObject({ status: 'expired' }); expect(scheduler.runtime(repo)).toMatchObject({ enabled: false, revision: 0 });
  expect(() => restarted.submit(caller, { ...input, epoch: scheduler.runtime(repo).epoch })).toThrow();
});
it('does not toggle when its durable reservation cannot commit', () => {
  const f = fixture(); const current = f.scheduler.runtime(repo);
  f.persistence.sql.exec("CREATE TRIGGER reject_runtime_intent BEFORE INSERT ON public_source_admin_runtime_intents BEGIN SELECT RAISE(ABORT,'reservation unavailable'); END");
  expect(() => f.admin.submit(caller, f.command({ version: 1, kind: 'runtime', repo, epoch: current.epoch, expectedRevision: 0, enabled: true }))).toThrow('reservation unavailable');
  expect(f.scheduler.runtime(repo)).toMatchObject({ enabled: false, revision: 0 });
});
it('requires exact caller-owned replacement evidence and replays committed receipts after later configuration changes', async () => {
  const f = fixture(); const validation = await f.admin.validateReplacement(caller, { repo, target: f.target, mode: 'adoption', providerId: f.replacementBinding.providerId,
    artifactHash: f.replacementBinding.artifactHash, actor: 'Operator', reason: 'Use replacement provider' }, new AbortController().signal);
  expect(f.admin.submit('example.other/panel', f.command({ version: 1, kind: 'replace', repo, validation })).status).toBe('rejected');
  expect(f.admin.submit(caller, f.command({ version: 1, kind: 'replace', repo, validation: { ...validation, evidenceHash: 'c'.repeat(64) } })).status).toBe('rejected');
  const input = f.command({ version: 1, kind: 'replace', repo, validation }); const saved = f.admin.submit(caller, input);
  expect(saved).toMatchObject({ status: 'succeeded', result: { kind: 'replaced', sourceId: f.source.id, currentInstanceId: validation.instanceId, sourceRevision: 2 } });
  f.store.configureInstance({ instanceId: validation.instanceId, expectedRevision: 1, desiredEnabled: false });
  expect(f.admin.submit(caller, input)).toEqual(saved);
});
it('bounds replacement validation when a provider ignores cancellation', async () => {
  const f = fixture(); vi.spyOn(f.service.adoption, 'validate').mockReturnValue(new Promise(() => {}));
  await expect(f.admin.validateReplacement(caller, { repo, target: f.target, mode: 'adoption', providerId: f.replacementBinding.providerId,
    artifactHash: f.replacementBinding.artifactHash, actor: 'Operator', reason: 'Use replacement provider' }, AbortSignal.timeout(10))).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(f.persistence.sql.prepare('SELECT * FROM public_source_admin_validations').all()).toEqual([]);
});
it('rejects pinned replacement proof after configuration changes without silently revalidating', async () => {
  const f = fixture(); const validation = await f.admin.validateReplacement(caller, { repo, target: f.target, mode: 'adoption', providerId: f.replacementBinding.providerId,
    artifactHash: f.replacementBinding.artifactHash, actor: 'Operator', reason: 'Use replacement provider' }, new AbortController().signal);
  f.store.configureInstance({ instanceId: f.instance.id, expectedRevision: 1, label: 'Changed after validation' });
  expect(f.admin.submit(caller, f.command({ version: 1, kind: 'replace', repo, validation })).status).toBe('rejected');
  expect(f.store.source(f.source.id)?.currentInstanceId).toBe(f.instance.id);
  expect(f.persistence.sql.prepare('SELECT * FROM source_adoptions').all()).toEqual([]);
});
