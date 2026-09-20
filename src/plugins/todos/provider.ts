import type {
  LocalSourceRecordV1, PluginBackendModule, SourceCallContextV1,
  SourceMutationPlanV1, TaskSnapshotV1, TaskSourceProviderV1, WorkRefV1,
} from '@helmsman/plugin-sdk';
import { document, input, LOCAL_TASK_SCHEMA, object, PRIORITIES, repo, sequence, taskInput, TodoSourceError } from './document.js';

const stateMap = { todo: 'ready', in_progress: 'in_progress', in_review: 'review', done: 'done', blocked: 'blocked' } as const;
const activeClaim = (record: LocalSourceRecordV1) => record.claimState !== null && record.claimState !== 'settled';

function records(context: SourceCallContextV1) {
  context.signal.throwIfAborted();
  if (!context.local) throw new TodoSourceError('The local task collection is unavailable');
  return context.local;
}

function authorizedRepo(value: unknown, context: SourceCallContextV1): string {
  const canonical = repo(value);
  if (!context.instance.allowedRepos.some(allowed => allowed.toLowerCase() === canonical.toLowerCase())) throw new TodoSourceError('Galleon is outside the source scope');
  return canonical;
}

function scopedRepo(value: unknown, context: SourceCallContextV1): string {
  const canonical = authorizedRepo(value, context);
  if (context.repo !== null && canonical.toLowerCase() !== context.repo.toLowerCase()) throw new TodoSourceError('Galleon is outside the source scope');
  return canonical;
}

function ref(value: unknown, context: SourceCallContextV1): WorkRefV1 {
  const raw = object(value, ['sourceId', 'externalId']);
  if (raw.sourceId !== context.instance.sourceId) throw new TodoSourceError('Task belongs to another source');
  sequence(raw.externalId);
  return { sourceId: context.instance.sourceId, externalId: raw.externalId as string };
}

function checkedRecord(value: LocalSourceRecordV1, context: SourceCallContextV1): LocalSourceRecordV1 {
  if (!value || value.schema !== LOCAL_TASK_SCHEMA || typeof value.revision !== 'string' || !value.revision
    || ![null, 'reserved', 'claimed', 'settling', 'settled'].includes(value.claimState)
    || value.claimState === 'claimed' && !value.claim) throw new TodoSourceError('Invalid local task record');
  ref(value.ref, context);
  scopedRepo(value.repo, context);
  document(value.data);
  if (value.claim && (value.claim.ref?.sourceId !== value.ref.sourceId || value.claim.ref?.externalId !== value.ref.externalId
    || typeof value.claim.runId !== 'string' || !value.claim.runId || typeof value.claim.claimId !== 'string' || !value.claim.claimId)) throw new TodoSourceError('Invalid local task claim');
  return value;
}

async function read(reference: WorkRefV1, context: SourceCallContextV1): Promise<LocalSourceRecordV1 | null> {
  const expected = ref(reference, context);
  const record = await records(context).get(expected.externalId);
  context.signal.throwIfAborted();
  if (!record) return null;
  checkedRecord(record, context);
  if (record.ref.externalId !== expected.externalId) throw new TodoSourceError('Local task lookup returned another item');
  return record;
}

async function required(reference: WorkRefV1, context: SourceCallContextV1): Promise<LocalSourceRecordV1> {
  const record = await read(reference, context);
  if (!record) throw new TodoSourceError('Todo not found');
  return record;
}

function snapshot(record: LocalSourceRecordV1): TaskSnapshotV1 {
  const value = document(record.data);
  return { version: 1, ref: record.ref, revision: record.revision, displayKey: record.ref.externalId,
    title: value.title, repo: record.repo, url: null, state: stateMap[value.state], priority: PRIORITIES.indexOf(value.priority),
    requirements: { description: value.description, acceptanceCriteria: value.acceptanceCriteria ? [value.acceptanceCriteria] : [], links: [] },
    providerData: { version: 1, kind: 'local-task', priority: value.priority } };
}

function transition(record: LocalSourceRecordV1, state: 'todo' | 'in_progress' | 'in_review' | 'blocked'): SourceMutationPlanV1 {
  return { kind: 'local-record', ref: record.ref, expectedRevision: record.revision,
    next: { schema: LOCAL_TASK_SCHEMA, repo: record.repo, data: { ...taskInput(record.data), state } } };
}

function mutable(record: LocalSourceRecordV1): void {
  if (activeClaim(record) || document(record.data).state === 'in_progress') throw new TodoSourceError('Stop the active voyage before changing this todo');
}

function revision(value: unknown, record: LocalSourceRecordV1): void {
  if (typeof value !== 'string' || value !== record.revision) throw new TodoSourceError('Todo changed; reload before trying again');
}

export const todosProvider: TaskSourceProviderV1 = {
  async identify(context) {
    const collection = await records(context).describeCollection();
    context.signal.throwIfAborted();
    if (!collection || collection.sourceId !== context.instance.sourceId || collection.schema !== LOCAL_TASK_SCHEMA
      || typeof collection.collectionId !== 'string' || !collection.collectionId || typeof collection.evidenceId !== 'string' || !collection.evidenceId
      || !Number.isSafeInteger(collection.revision) || collection.revision < 0) throw new TodoSourceError('Local collection identity is unavailable');
    return { version: 1, level: 'verified', verifiedAt: new Date().toISOString(),
      authority: { protocol: 'helmsman.local-collection/v1', authorityId: collection.collectionId, identityFormat: LOCAL_TASK_SCHEMA },
      proof: { evidenceId: collection.evidenceId, collectionId: collection.collectionId, revision: collection.revision } };
  },
  async list(request, context) {
    const scope = scopedRepo(request?.repo, context);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100
      || request.state !== null && !Object.values(stateMap).includes(request.state)) throw new TodoSourceError('Invalid local task query');
    const local = records(context);
    const before = await local.describeCollection();
    context.signal.throwIfAborted();
    if (!before || before.sourceId !== context.instance.sourceId || before.schema !== LOCAL_TASK_SCHEMA) throw new TodoSourceError('Local collection identity is unavailable');
    let offset = 0;
    if (request.cursor !== null) {
      if (typeof request.cursor !== 'string' || request.cursor.length > 1024) throw new TodoSourceError('Invalid local task cursor');
      let cursor: Record<string, unknown>;
      try { cursor = object(JSON.parse(request.cursor), ['revision', 'repo', 'state', 'offset']); } catch { throw new TodoSourceError('Invalid local task cursor'); }
      if (cursor.revision !== before.revision || cursor.repo !== scope || cursor.state !== request.state
        || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 || Number(cursor.offset) > 10_000) throw new TodoSourceError('Task collection changed; reload the list');
      offset = Number(cursor.offset);
    }
    const result: LocalSourceRecordV1[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const response = await local.list({ repo: scope, cursor, limit: 100 });
      context.signal.throwIfAborted();
      if (!response || !Array.isArray(response.records) || response.records.length > 100
        || response.nextCursor !== null && (typeof response.nextCursor !== 'string' || !response.nextCursor || response.nextCursor.length > 1024)) throw new TodoSourceError('Invalid local task page');
      for (const record of response.records) {
        checkedRecord(record, context);
        if (record.repo.toLowerCase() !== scope.toLowerCase() || ids.has(record.ref.externalId)) throw new TodoSourceError('Local task page has duplicate or unrelated items');
        ids.add(record.ref.externalId);
        result.push(record);
      }
      cursor = response.nextCursor;
      if (cursor === null) break;
      if (cursors.has(cursor)) throw new TodoSourceError('Local task paging did not advance');
      cursors.add(cursor);
    }
    if (cursor !== null) throw new TodoSourceError('Local collection exceeds its supported quota');
    const after = await local.describeCollection();
    context.signal.throwIfAborted();
    if (!after || after.collectionId !== before.collectionId || after.revision !== before.revision) throw new TodoSourceError('Task collection changed; reload the list');
    const tasks = result.map(snapshot).filter(task => request.state === null || task.state === request.state
      && (request.state !== 'ready' || Boolean(task.requirements.description.trim())))
      .sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2) || sequence(a.ref.externalId) - sequence(b.ref.externalId));
    const items: TaskSnapshotV1[] = [];
    let pageBytes = 2048;
    const encoder = new TextEncoder();
    for (const task of tasks.slice(offset, offset + request.limit)) {
      const bytes = encoder.encode(JSON.stringify(task)).length + 1;
      if (pageBytes + bytes > 2 * 1024 * 1024) break;
      items.push(task);
      pageBytes += bytes;
    }
    if (offset < tasks.length && items.length === 0) throw new TodoSourceError('Local task exceeds the page size limit');
    const nextCursor = offset + items.length < tasks.length ? JSON.stringify({ revision: before.revision, repo: scope, state: request.state, offset: offset + items.length }) : null;
    return { items, nextCursor };
  },
  async lookup(request, context) {
    const reference = ref({ sourceId: context.instance.sourceId, externalId: request?.displayKey }, context);
    return await read(reference, context) ? reference : null;
  },
  async load(reference, context) {
    const record = await read(reference, context);
    return record ? snapshot(record) : null;
  },
  async planClaim(request, context) {
    const record = await required(request?.task?.ref, context);
    const value = document(record.data);
    if (request.expectedInstanceRevision !== context.instance.revision) throw new TodoSourceError('Source configuration changed');
    if (record.claim?.admissionId === request.admissionId && record.claim.runId === request.runId && value.state === 'in_progress') return { kind: 'none', reason: 'This admission already claimed the task' };
    revision(request.task.revision, record);
    const ready = request.retryOf !== null ? (record.claim?.runId ?? record.lastRunId) === request.retryOf && ['todo', 'blocked'].includes(value.state) : value.state === 'todo';
    if (record.claimState === 'claimed' || record.claimState === 'settling' || !ready) throw new TodoSourceError('Todo is no longer ready to launch');
    if (!value.description.trim()) throw new TodoSourceError('Add a description before starting a voyage');
    return transition(record, 'in_progress');
  },
  async planCompletion(request, context) {
    const record = await required(request?.task?.ref, context);
    if (!record.claim || record.claim.claimId !== request.claimReceipt?.claimId || record.claim.runId !== request.runId) throw new TodoSourceError('Todo claim belongs to another voyage');
    if (record.claimState === 'settled') return { kind: 'none', reason: 'This claim is already settled' };
    if (!['succeeded', 'failed', 'stopped'].includes(request.outcome) || document(record.data).state !== 'in_progress') throw new TodoSourceError('Invalid todo completion');
    return transition(record, request.outcome === 'succeeded' ? 'in_review' : 'blocked');
  },
  async planAbort(request, context) {
    const record = await required(request?.task?.ref, context);
    if (request.claimReceipt === null && (!activeClaim(record) || record.claimState === 'reserved')
      && document(record.data).state !== 'in_progress') return { kind: 'none', reason: 'No local claim was applied' };
    if (!record.claim || record.claim.claimId !== request.claimReceipt?.claimId || record.claim.runId !== request.runId
      || record.claim.admissionId !== request.admissionId) throw new TodoSourceError('Todo claim belongs to another admission');
    if (record.claimState === 'settled') return { kind: 'none', reason: 'This claim is already settled' };
    if (document(record.data).state !== 'in_progress') throw new TodoSourceError('Todo state changed before cancellation');
    return transition(record, 'todo');
  },
  async validateAdoption(proposal, context) {
    const identity = await todosProvider.identify(context);
    const matches = proposal?.sourceId === context.instance.sourceId && proposal.identityFormat === LOCAL_TASK_SCHEMA
      && proposal.storageSchema === LOCAL_TASK_SCHEMA && identity.authority?.protocol === proposal.expectedAuthority?.protocol
      && identity.authority?.authorityId === proposal.expectedAuthority?.authorityId && identity.authority?.identityFormat === proposal.expectedAuthority?.identityFormat;
    const probeResults = [];
    if (matches) for (const probe of proposal.probes) {
      const record = await read(probe.ref, context);
      probeResults.push({ ref: probe.ref, matches: record?.revision === probe.revision, evidence: { schema: record?.schema ?? null } });
    }
    const compatible = matches && probeResults.every(probe => probe.matches);
    return { compatible, authority: identity, identityFormat: LOCAL_TASK_SCHEMA, readableSchemas: [LOCAL_TASK_SCHEMA], probeResults,
      diagnostic: compatible ? null : 'The source identity, schema, or retained item revisions do not match' };
  },
  effects: {},
  commands: {
    create: { async prepare(value, context) {
      records(context);
      const parsed = input(value, false);
      const scope = scopedRepo(parsed.repo, context);
      return { kind: 'create', schema: LOCAL_TASK_SCHEMA, repo: scope,
        data: { version: 1, title: parsed.title!, description: parsed.description ?? '', acceptanceCriteria: parsed.acceptanceCriteria ?? '',
          priority: parsed.priority ?? 'P2', state: parsed.state ?? 'todo' } };
    } },
    update: { async prepare(value, context) {
      const request = object(value, ['ref', 'expectedRevision', 'patch']);
      const record = await required(ref(request.ref, context), context);
      mutable(record);
      revision(request.expectedRevision, record);
      const parsed = input(request.patch, true);
      const { repo: nextRepo, ...patch } = parsed;
      return { kind: 'update', ref: record.ref, expectedRevision: record.revision,
        next: { schema: LOCAL_TASK_SCHEMA, repo: authorizedRepo(nextRepo ?? record.repo, context), data: { ...taskInput(record.data), ...patch } } };
    } },
    delete: { async prepare(value, context) {
      const request = object(value, ['ref', 'expectedRevision']);
      const record = await required(ref(request.ref, context), context);
      mutable(record);
      revision(request.expectedRevision, record);
      return { kind: 'delete', ref: record.ref, expectedRevision: record.revision };
    } },
  },
};

const plugin: PluginBackendModule = { activate(context) { context.registerTaskSource('todos', todosProvider); } };
export default plugin;
