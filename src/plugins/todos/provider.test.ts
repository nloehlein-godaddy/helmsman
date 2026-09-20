// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { LocalSourceRecordV1, PluginBackendContext, PluginJson, SourceCallContextV1, SourceClaimReceiptV1, SourceCompletionRequestV1, WorkRefV1 } from '@helmsman/plugin-sdk';
import plugin, { todosProvider } from './provider';
import { document, input, LOCAL_TASK_SCHEMA } from './document';

const sourceId = '11111111-1111-4111-8111-111111111111';
const binding = { providerId: 'example.local-todos/todos', pluginId: 'example.local-todos', artifactHash: 'a'.repeat(64), contractVersion: 1 as const, connectionId: null, credentialHandle: null };
const reference = (id = 'TODO-1'): WorkRefV1 => ({ sourceId, externalId: id });
const timestamp = '2026-09-20T12:00:00.000Z';
function record(id = 'TODO-1', data: Record<string, PluginJson> = {}): LocalSourceRecordV1 {
  return { ref: reference(id), repo: 'org/repo', revision: '1', schema: LOCAL_TASK_SCHEMA, claim: null, claimState: null, lastRunId: null,
    data: { version: 1, title: 'Fix behavior', description: 'Requirements from the author', acceptanceCriteria: 'Keep every requirement', priority: 'P2', state: 'todo',
      createdAt: timestamp, updatedAt: timestamp, completedAt: null, ...data } };
}
function receipt(id = 'TODO-1'): SourceClaimReceiptV1 {
  return { version: 1, claimId: 'claim-1', ref: reference(id), admissionId: 'admission-1', runId: 'run-1', revision: 1,
    binding, taskSnapshotHash: 'b'.repeat(64), localRecordRevision: '1', operations: [] };
}
function fixture(initial: LocalSourceRecordV1[] = [record()]) {
  const items = new Map(initial.map(item => [item.ref.externalId, item]));
  const controller = new AbortController();
  let collectionRevision = 1;
  const context: SourceCallContextV1 = {
    signal: controller.signal, repo: 'org/repo', http: null,
    instance: { version: 1, id: '22222222-2222-4222-8222-222222222222', sourceId, label: 'Local todos', revision: 1, desiredEnabled: true,
      identityLevel: 'verified', authority: { protocol: 'helmsman.local-collection/v1', authorityId: 'collection-1', identityFormat: LOCAL_TASK_SCHEMA }, binding, settings: {}, allowedRepos: ['org/repo'] },
    local: {
      describeCollection: vi.fn(async () => ({ sourceId, collectionId: 'collection-1', schema: LOCAL_TASK_SCHEMA, revision: collectionRevision, evidenceId: 'evidence-1' })),
      get: vi.fn(async id => items.get(id) ?? null),
      list: vi.fn(async query => {
        const values = [...items.values()].filter(item => item.repo === query.repo);
        const offset = Number(query.cursor ?? 0);
        return { records: values.slice(offset, offset + query.limit), nextCursor: offset + query.limit < values.length ? String(offset + query.limit) : null };
      }),
    },
  };
  return { context, items, controller, changeCollection: () => collectionRevision++ };
}
const command = (id: string, value: unknown, context: SourceCallContextV1) => todosProvider.commands![id]!.prepare(value as PluginJson, context);
async function claim(context: SourceCallContextV1, retryOf: string | null = null) {
  const task = await todosProvider.load(reference(), context);
  return todosProvider.planClaim({ admissionId: 'admission-1', runId: 'run-1', task: task!, expectedInstanceRevision: 1, retryOf }, context);
}
async function completion(context: SourceCallContextV1, outcome: SourceCompletionRequestV1['outcome']) {
  const task = await todosProvider.load(reference(), context);
  return todosProvider.planCompletion({ runId: 'run-1', attempt: 1, task: task!, claimReceipt: receipt(), outcome, publication: null }, context);
}

describe('independent local Todo provider', () => {
  it('registers only its declared public source and preserves complete task requirements', async () => {
    const registerTaskSource = vi.fn();
    plugin.activate({ registerTaskSource } as unknown as PluginBackendContext);
    expect(registerTaskSource).toHaveBeenCalledWith('todos', todosProvider);
    const f = fixture([record('TODO-1', { acceptanceCriteria: 'x'.repeat(20_000), description: 'd'.repeat(20_000) })]);
    expect(await todosProvider.load(reference(), f.context)).toMatchObject({ ref: reference(), displayKey: 'TODO-1', revision: '1', state: 'ready', priority: 2,
      requirements: { description: 'd'.repeat(20_000), acceptanceCriteria: ['x'.repeat(20_000)], links: [] } });
    expect(await todosProvider.lookup({ displayKey: 'TODO-1' }, f.context)).toEqual(reference());
    expect(await todosProvider.lookup({ displayKey: 'TODO-2' }, f.context)).toBeNull();
  });

  it('sorts and filters across underlying pages before creating stable bounded output pages', async () => {
    const values = Array.from({ length: 103 }, (_, index) => record(`TODO-${104 - index}`, { priority: index === 102 ? 'P0' : 'P2' }));
    values.push(record('TODO-1', { priority: 'P0', state: 'blocked' }));
    const f = fixture(values);
    const first = await todosProvider.list({ repo: 'org/repo', state: 'ready', cursor: null, limit: 3 }, f.context);
    expect(first.items.map(item => item.ref.externalId)).toEqual(['TODO-2', 'TODO-3', 'TODO-4']);
    const second = await todosProvider.list({ repo: 'org/repo', state: 'ready', cursor: first.nextCursor, limit: 3 }, f.context);
    expect(second.items.map(item => item.ref.externalId)).toEqual(['TODO-5', 'TODO-6', 'TODO-7']);
    f.changeCollection();
    await expect(todosProvider.list({ repo: 'org/repo', state: 'ready', cursor: second.nextCursor, limit: 3 }, f.context)).rejects.toThrow('changed');
  });

  it('rejects duplicate, unrelated, and malformed local page results', async () => {
    const f = fixture();
    for (const values of [[record(), record()], [record('TODO-1', { title: null })], [{ ...record(), repo: 'other/repo' }], [null]]) {
      f.context.local!.list = vi.fn(async () => ({ records: values as LocalSourceRecordV1[], nextCursor: null }));
      await expect(todosProvider.list({ repo: 'org/repo', state: null, cursor: null, limit: 10 }, f.context)).rejects.toThrow();
    }
  });

  it('bounds encoded page bytes while retaining all Unicode task requirements', async () => {
    const data = { description: 'ࠀ'.repeat(20_000), acceptanceCriteria: 'ࠀ'.repeat(20_000) };
    const f = fixture(Array.from({ length: 30 }, (_, index) => record(`TODO-${index + 1}`, data)));
    const first = await todosProvider.list({ repo: 'org/repo', state: null, cursor: null, limit: 100 }, f.context);
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(30);
    expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThan(2 * 1024 * 1024);
    const second = await todosProvider.list({ repo: 'org/repo', state: null, cursor: first.nextCursor, limit: 100 }, f.context);
    expect([...first.items, ...second.items]).toHaveLength(30);
    expect(second.items.at(-1)?.requirements).toMatchObject({ description: data.description, acceptanceCriteria: [data.acceptanceCriteria] });
  });

  it('keeps incomplete todos visible while ready discovery skips missing requirements', async () => {
    const f = fixture([record('TODO-1', { description: ' ' }), record('TODO-2')]);
    expect((await todosProvider.list({ repo: 'org/repo', state: null, cursor: null, limit: 100 }, f.context)).items).toHaveLength(2);
    expect((await todosProvider.list({ repo: 'org/repo', state: 'ready', cursor: null, limit: 100 }, f.context)).items.map(item => item.ref.externalId)).toEqual(['TODO-2']);
  });

  it('rejects foreign source IDs, invalid IDs, and cross-galleon queries before reading records', async () => {
    const f = fixture();
    await expect(todosProvider.load({ ...reference(), sourceId: 'other' }, f.context)).rejects.toThrow('another source');
    await expect(todosProvider.lookup({ displayKey: 'TODO-9007199254740992' }, f.context)).rejects.toThrow();
    await expect(todosProvider.list({ repo: 'other/repo', state: null, cursor: null, limit: 10 }, f.context)).rejects.toThrow('scope');
    expect(f.context.local!.get).not.toHaveBeenCalled();
    expect(f.context.local!.list).not.toHaveBeenCalled();
  });

  it('rejects late lookup results after cancellation', async () => {
    const f = fixture();
    f.context.local!.get = vi.fn(async () => { f.controller.abort(); return record(); });
    await expect(todosProvider.load(reference(), f.context)).rejects.toThrow();
  });

  it('prepares CRUD plans without allocating IDs or assigning host timestamps', async () => {
    const f = fixture();
    expect(await command('create', { title: '  New task ', repo: 'org/repo' }, f.context)).toEqual({ kind: 'create', schema: LOCAL_TASK_SCHEMA, repo: 'org/repo',
      data: { version: 1, title: 'New task', description: '', acceptanceCriteria: '', priority: 'P2', state: 'todo' } });
    expect(await command('update', { ref: reference(), expectedRevision: '1', patch: { state: 'done', title: ' Changed ' } }, f.context)).toMatchObject({ kind: 'update', expectedRevision: '1',
      next: { data: { title: 'Changed', state: 'done', description: 'Requirements from the author' } } });
    expect(await command('delete', { ref: reference(), expectedRevision: '1' }, f.context)).toEqual({ kind: 'delete', ref: reference(), expectedRevision: '1' });
    expect(f.items.get('TODO-1')).toEqual(record());
  });

  it.each([
    { title: '', repo: 'org/repo' }, { title: 'x'.repeat(241), repo: 'org/repo' }, { title: 'T', repo: 'missing-owner' },
    { title: 'T', repo: 'org/repo', runId: 'invented' }, { title: 'T', repo: 'org/repo', state: 'in_progress' },
    { title: 'T', repo: 'org/repo', priority: 'P5' }, { title: 'T', repo: 'org/repo', description: 'x'.repeat(20_001) },
  ])('rejects invalid command input %#', async value => {
    await expect(command('create', value, fixture().context)).rejects.toThrow();
  });

  it('rejects accessor input without invoking it', () => {
    const getter = vi.fn(() => 'value');
    expect(() => input(Object.defineProperty({}, 'title', { enumerable: true, get: getter }), false)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects stale edits and protects records with unsettled claims', async () => {
    const f = fixture();
    await expect(command('update', { ref: reference(), expectedRevision: 'old', patch: { title: 'changed' } }, f.context)).rejects.toThrow('changed');
    f.items.set('TODO-1', { ...record(), claim: receipt(), claimState: 'settling' });
    await expect(command('delete', { ref: reference(), expectedRevision: '1' }, f.context)).rejects.toThrow('active voyage');
    await expect(command('update', { ref: reference(), expectedRevision: '1', patch: {} }, f.context)).rejects.toThrow('active voyage');
  });

  it('permits an explicit authorized galleon move without changing the query scope', async () => {
    const f = fixture();
    const context = { ...f.context, instance: { ...f.context.instance, allowedRepos: ['org/repo', 'org/next'] } };
    expect(await command('update', { ref: reference(), expectedRevision: '1', patch: { repo: 'org/next' } }, context))
      .toMatchObject({ kind: 'update', next: { repo: 'org/next' } });
    expect(context.repo).toBe('org/repo');
    await expect(command('update', { ref: reference(), expectedRevision: '1', patch: { repo: 'other/project' } }, context)).rejects.toThrow('scope');
  });

  it('lists migrated protected tasks without inventing a claim receipt', async () => {
    const f = fixture([{ ...record('TODO-1', { state: 'in_progress' }), claimState: 'settling', lastRunId: 'legacy-run' }]);
    expect((await todosProvider.list({ repo: 'org/repo', state: null, cursor: null, limit: 100 }, f.context)).items).toHaveLength(1);
    await expect(command('delete', { ref: reference(), expectedRevision: '1' }, f.context)).rejects.toThrow('active voyage');
    await expect(completion(f.context, 'succeeded')).rejects.toThrow();
    await expect(claim(f.context)).rejects.toThrow('ready');
  });

  it('accepts a retry against a migrated terminal run link without a source receipt', async () => {
    const f = fixture([{ ...record('TODO-1', { state: 'blocked' }), claimState: 'settled', lastRunId: 'legacy-run' }]);
    expect(await claim(f.context, 'legacy-run')).toMatchObject({ kind: 'local-record', next: { data: { state: 'in_progress' } } });
    await expect(claim(f.context, 'another-run')).rejects.toThrow('ready');
  });

  it('requires a description and a current task/configuration revision before claim', async () => {
    const f = fixture([record('TODO-1', { description: ' ' })]);
    await expect(claim(f.context)).rejects.toThrow('description');
    f.items.set('TODO-1', record());
    const task = await todosProvider.load(reference(), f.context);
    expect(await claim(f.context)).toMatchObject({ kind: 'local-record', expectedRevision: '1', next: { data: { state: 'in_progress' } } });
    f.items.set('TODO-1', { ...record(), revision: '2' });
    await expect(todosProvider.planClaim({ admissionId: 'a', runId: 'r', task: task!, expectedInstanceRevision: 1, retryOf: null }, f.context)).rejects.toThrow('changed');
    await expect(todosProvider.planClaim({ admissionId: 'a', runId: 'r', task: task!, expectedInstanceRevision: 2, retryOf: null }, f.context)).rejects.toThrow('configuration');
  });

  it('allows only the previous terminal owner to retry blocked work', async () => {
    const f = fixture([{ ...record('TODO-1', { state: 'blocked' }), claim: receipt(), claimState: 'settled' }]);
    await expect(claim(f.context)).rejects.toThrow('ready');
    await expect(claim(f.context, 'another-run')).rejects.toThrow('ready');
    expect(await claim(f.context, 'run-1')).toMatchObject({ next: { data: { state: 'in_progress' } } });
  });

  it('plans a claim for a core-reserved item while still protecting it from CRUD', async () => {
    const f = fixture([{ ...record(), claimState: 'reserved' }]);
    expect(await claim(f.context)).toMatchObject({ kind: 'local-record', next: { data: { state: 'in_progress' } } });
    await expect(command('delete', { ref: reference(), expectedRevision: '1' }, f.context)).rejects.toThrow('active voyage');
    const task = await todosProvider.load(reference(), f.context);
    expect(await todosProvider.planAbort({ admissionId: 'admission-1', runId: 'run-1', task: task!, claimReceipt: null,
      reason: 'cancelled', claimSteps: [] }, f.context)).toMatchObject({ kind: 'none' });
    f.items.set('TODO-1', { ...record('TODO-1', { state: 'blocked' }), claimState: 'reserved', claim: receipt() });
    expect(await claim(f.context, 'run-1')).toMatchObject({ kind: 'local-record' });
  });

  it.each([['succeeded', 'in_review'], ['failed', 'blocked'], ['stopped', 'blocked']] as const)('maps %s to %s while keeping the original claim owner', async (outcome, state) => {
    const f = fixture([{ ...record('TODO-1', { state: 'in_progress' }), claim: receipt(), claimState: 'claimed' }]);
    expect(await completion(f.context, outcome)).toMatchObject({ kind: 'local-record', next: { data: { state } } });
    const value = f.items.get('TODO-1')!;
    f.items.set('TODO-1', { ...value, claim: { ...receipt(), runId: 'other' } });
    await expect(completion(f.context, outcome)).rejects.toThrow('another voyage');
  });

  it('settles admission abort to ready without requiring a fabricated worker outcome', async () => {
    const f = fixture([{ ...record('TODO-1', { state: 'in_progress' }), claim: receipt(), claimState: 'claimed' }]);
    const task = await todosProvider.load(reference(), f.context);
    const request = { admissionId: 'admission-1', runId: 'run-1', task: task!, claimReceipt: receipt(), reason: 'stopped-before-launch' as const, claimSteps: [] };
    expect(await todosProvider.planAbort(request, f.context)).toMatchObject({ kind: 'local-record', next: { data: { state: 'todo' } } });
    await expect(todosProvider.planAbort({ ...request, admissionId: 'other' }, f.context)).rejects.toThrow('another admission');
    const disabled = { ...f.context, instance: { ...f.context.instance, desiredEnabled: false } };
    expect(await todosProvider.planAbort(request, disabled)).toMatchObject({ kind: 'local-record' });
  });

  it('verifies public local identity and adoption probes without private stores', async () => {
    const f = fixture();
    const identity = await todosProvider.identify(f.context);
    expect(identity).toMatchObject({ level: 'verified', authority: f.context.instance.authority, proof: { evidenceId: 'evidence-1' } });
    const proposal = { sourceId, expectedSourceRevision: 1, previousBinding: binding, proposedBinding: binding,
      expectedAuthority: identity.authority!, identityFormat: LOCAL_TASK_SCHEMA, storageSchema: LOCAL_TASK_SCHEMA, probes: [{ ref: reference(), revision: '1' }] };
    expect(await todosProvider.validateAdoption(proposal, f.context)).toMatchObject({ compatible: true, probeResults: [{ ref: reference(), matches: true }] });
    expect(await todosProvider.validateAdoption({ ...proposal, expectedAuthority: { ...identity.authority!, authorityId: 'other' } }, f.context)).toMatchObject({ compatible: false });
    f.items.set('TODO-1', { ...record(), revision: '2' });
    expect(await todosProvider.validateAdoption(proposal, f.context)).toMatchObject({ compatible: false });
  });

  it('rejects invalid persisted document timestamps and missing required fields', () => {
    expect(() => document({ ...record().data as object, createdAt: 'invalid' })).toThrow('timestamp');
    expect(() => document(null)).toThrow();
  });
});
