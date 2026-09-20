import type {
  LocalSourceRecordV1, LocalTaskInputV1, PluginBackendModule, SourceCallContextV1,
  SourceMutationPlanV1, TaskSnapshotV1, TaskSourceProviderV1, WorkRefV1,
} from '@helmsman/plugin-sdk';

const schema = 'helmsman.local-task/v1';
const priorities = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;
const states = ['todo', 'in_progress', 'in_review', 'done', 'blocked'] as const;
const taskStates = ['ready', 'in_progress', 'review', 'done', 'blocked'] as const;

function fields(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error('Expected a task object');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !('value' in descriptor) || allowed && !allowed.includes(key)) throw new Error('Unsupported task field');
  }
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || !empty && !value.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Invalid task text');
  return value;
}
function local(context: SourceCallContextV1) {
  context.signal.throwIfAborted();
  if (!context.local) throw new Error('Local collection service is required');
  return context.local;
}
function allowedRepo(value: unknown, context: SourceCallContextV1): string {
  const repo = string(value, 512);
  if (!context.instance.allowedRepos.includes(repo)) throw new Error('Galleon is not authorized');
  return repo;
}
function key(value: unknown, context: SourceCallContextV1): WorkRefV1 {
  const reference = fields(value, ['sourceId', 'externalId']);
  if (reference.sourceId !== context.instance.sourceId) throw new Error('Different logical source');
  return { sourceId: context.instance.sourceId, externalId: string(reference.externalId, 512) };
}
function taskData(value: unknown): LocalTaskInputV1 {
  const data = fields(value);
  if (data.version !== 1 || !priorities.some(priority => priority === data.priority) || !states.some(state => state === data.state)) throw new Error('Unsupported local task schema');
  return { version: 1, title: string(data.title, 240), description: string(data.description, 20_000, true),
    acceptanceCriteria: string(data.acceptanceCriteria, 20_000, true), priority: data.priority as LocalTaskInputV1['priority'], state: data.state as LocalTaskInputV1['state'] };
}
function toTask(record: LocalSourceRecordV1): TaskSnapshotV1 {
  const data = taskData(record.data);
  return { version: 1, ref: record.ref, revision: record.revision, displayKey: record.ref.externalId, title: data.title, repo: record.repo, url: null,
    state: taskStates[states.indexOf(data.state)]!, priority: priorities.indexOf(data.priority), requirements: { description: data.description,
      acceptanceCriteria: data.acceptanceCriteria ? [data.acceptanceCriteria] : [], links: [] }, providerData: { version: 1, implementation: 'independent-local-collection' } };
}
async function find(value: WorkRefV1, context: SourceCallContextV1, required = true): Promise<LocalSourceRecordV1 | null> {
  const reference = key(value, context);
  const record = await local(context).get(reference.externalId);
  context.signal.throwIfAborted();
  if (!record) { if (required) throw new Error('Task not found'); return null; }
  if (record.schema !== schema || record.ref?.sourceId !== reference.sourceId || record.ref.externalId !== reference.externalId
    || context.repo !== null && record.repo !== context.repo) throw new Error('Local record scope changed');
  allowedRepo(record.repo, context); taskData(record.data);
  return record;
}
function change(record: LocalSourceRecordV1, state: LocalTaskInputV1['state']): SourceMutationPlanV1 {
  return { kind: 'local-record', ref: record.ref, expectedRevision: record.revision, next: { schema, repo: record.repo, data: { ...taskData(record.data), state } } };
}
function edit(value: unknown, previous?: LocalTaskInputV1): { data: LocalTaskInputV1; repo?: string } {
  const raw = fields(value, ['title', 'description', 'acceptanceCriteria', 'priority', 'state', 'repo']);
  const patch: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) patch[name] = string(value, name === 'description' || name === 'acceptanceCriteria' ? 20_000 : 512, ['description', 'acceptanceCriteria'].includes(name)).trim();
  const { repo, ...content } = patch;
  const data = taskData({ version: 1, title: '', description: '', acceptanceCriteria: '', priority: 'P2', state: 'todo', ...previous, ...content });
  if (data.state === 'in_progress') throw new Error('Only a claim can start work');
  return { data, ...(repo === undefined ? {} : { repo }) };
}

export const alternativeSource: TaskSourceProviderV1 = {
  async identify(context) {
    const collection = await local(context).describeCollection();
    context.signal.throwIfAborted();
    if (collection?.sourceId !== context.instance.sourceId || collection.schema !== schema || !collection.collectionId || !collection.evidenceId) throw new Error('Unsupported collection identity');
    return { version: 1, level: 'verified', authority: { protocol: 'helmsman.local-collection/v1', authorityId: collection.collectionId, identityFormat: schema }, verifiedAt: new Date().toISOString(),
      proof: { collectionId: collection.collectionId, evidenceId: collection.evidenceId, revision: collection.revision } };
  },
  async list(request, context) {
    allowedRepo(request.repo, context);
    const page = await local(context).list({ repo: request.repo, cursor: request.cursor, limit: 1 });
    context.signal.throwIfAborted();
    if (!page || !Array.isArray(page.records) || page.records.length > 1) throw new Error('Invalid local page');
    const items: TaskSnapshotV1[] = [];
    for (const record of page.records) {
      const retained = await find(key(record?.ref, context), context);
      if (!retained || retained.revision !== record.revision || retained.repo !== request.repo) throw new Error('Local page changed');
      const task = toTask(retained);
      if (request.state === null || task.state === request.state && (request.state !== 'ready' || Boolean(task.requirements.description.trim()))) items.push(task);
    }
    return { items, nextCursor: page.nextCursor };
  },
  async lookup(request, context) { const reference = key({ sourceId: context.instance.sourceId, externalId: request.displayKey }, context); return await find(reference, context, false) ? reference : null; },
  async load(reference, context) { const record = await find(reference, context, false); return record ? toTask(record) : null; },
  async planClaim(request, context) {
    const record = (await find(request.task.ref, context))!;
    const data = taskData(record.data);
    if (request.expectedInstanceRevision !== context.instance.revision || record.revision !== request.task.revision) throw new Error('Claim revision changed');
    if (record.claimState === 'claimed' || record.claimState === 'settling' || !data.description.trim()
      || (request.retryOf === null ? data.state !== 'todo' : (record.claim?.runId ?? record.lastRunId) !== request.retryOf || !['todo', 'blocked'].includes(data.state))) throw new Error('Task cannot be claimed');
    return change(record, 'in_progress');
  },
  async planCompletion(request, context) {
    const record = (await find(request.task.ref, context))!;
    if (record.claim?.claimId !== request.claimReceipt?.claimId || record.claim?.runId !== request.runId || taskData(record.data).state !== 'in_progress') throw new Error('Completion owner changed');
    if (!['succeeded', 'failed', 'stopped'].includes(request.outcome)) throw new Error('Unsupported worker outcome');
    return change(record, request.outcome === 'succeeded' ? 'in_review' : 'blocked');
  },
  async planAbort(request, context) {
    const record = (await find(request.task.ref, context))!;
    if (request.claimReceipt === null && ['todo', 'blocked'].includes(taskData(record.data).state)
      && [null, 'reserved', 'settled'].includes(record.claimState)) return { kind: 'none', reason: 'No applied local claim' };
    if (record.claim?.claimId !== request.claimReceipt?.claimId || record.claim?.runId !== request.runId || record.claim?.admissionId !== request.admissionId
      || taskData(record.data).state !== 'in_progress') throw new Error('Cancellation owner changed');
    return change(record, 'todo');
  },
  async validateAdoption(proposal, context) {
    const authority = await alternativeSource.identify(context);
    const same = proposal.sourceId === context.instance.sourceId && proposal.identityFormat === schema && proposal.storageSchema === schema
      && proposal.expectedAuthority.protocol === authority.authority?.protocol && proposal.expectedAuthority.authorityId === authority.authority?.authorityId
      && proposal.expectedAuthority.identityFormat === schema;
    const probeResults = [];
    if (same) for (const probe of proposal.probes) {
      const record = await find(probe.ref, context, false);
      probeResults.push({ ref: probe.ref, matches: record?.revision === probe.revision, evidence: { observedRevision: record?.revision ?? null } });
    }
    const compatible = same && probeResults.every(probe => probe.matches);
    return { compatible, authority, identityFormat: schema, readableSchemas: [schema], probeResults, diagnostic: compatible ? null : 'Collection or probe identity changed' };
  },
  effects: {},
  commands: {
    create: { async prepare(value, context) { local(context); const parsed = edit(value); return { kind: 'create', schema, repo: allowedRepo(parsed.repo, context), data: { ...parsed.data } }; } },
    update: { async prepare(value, context) {
      const request = fields(value, ['ref', 'expectedRevision', 'patch']);
      const record = (await find(key(request.ref, context), context))!;
      if (record.revision !== request.expectedRevision || ![null, 'settled'].includes(record.claimState) || taskData(record.data).state === 'in_progress') throw new Error('Task is claimed or changed');
      const parsed = edit(request.patch, taskData(record.data));
      return { kind: 'update', ref: record.ref, expectedRevision: record.revision, next: { schema, repo: allowedRepo(parsed.repo ?? record.repo, context), data: { ...parsed.data } } };
    } },
    delete: { async prepare(value, context) {
      const request = fields(value, ['ref', 'expectedRevision']); const record = (await find(key(request.ref, context), context))!;
      if (record.revision !== request.expectedRevision || ![null, 'settled'].includes(record.claimState) || taskData(record.data).state === 'in_progress') throw new Error('Task is claimed or changed');
      return { kind: 'delete', ref: record.ref, expectedRevision: record.revision };
    } },
  },
};
const plugin: PluginBackendModule = { activate(context) { context.registerTaskSource('collection', alternativeSource); } };
export default plugin;
