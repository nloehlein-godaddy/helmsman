import type { PluginJson, TaskSourceDeclaration } from './backend';

export type SourceId = string;
export type SourceInstanceId = string;

export interface WorkRefV1 {
  readonly sourceId: SourceId;
  readonly externalId: string;
}

export interface SourceAuthorityV1 {
  readonly protocol: string;
  readonly authorityId: string;
  readonly identityFormat: string;
}

export interface SourceBindingV1 {
  readonly providerId: string;
  readonly pluginId: string;
  readonly artifactHash: string;
  readonly contractVersion: 1;
  readonly connectionId: string | null;
  readonly credentialHandle: string | null;
}

export interface SourceInstanceV1 {
  readonly version: 1;
  readonly id: SourceInstanceId;
  readonly sourceId: SourceId;
  readonly label: string;
  readonly revision: number;
  readonly desiredEnabled: boolean;
  readonly identityLevel: 'verified' | 'operator-seeded';
  readonly authority: SourceAuthorityV1 | null;
  readonly binding: SourceBindingV1;
  readonly settings: Readonly<Record<string, PluginJson>>;
  readonly allowedRepos: readonly string[];
}

export interface TaskSnapshotV1 {
  readonly version: 1;
  readonly ref: WorkRefV1;
  readonly revision: string;
  readonly displayKey: string;
  readonly title: string;
  readonly repo: string;
  readonly url: string | null;
  readonly state: 'ready' | 'in_progress' | 'review' | 'done' | 'blocked';
  readonly priority: number | null;
  readonly requirements: {
    readonly description: string;
    readonly acceptanceCriteria: readonly string[];
    readonly links: readonly { title: string; url: string }[];
  };
  readonly providerData: PluginJson;
}

export interface SourceCallContextV1 {
  readonly instance: SourceInstanceV1;
  readonly signal: AbortSignal;
  readonly repo: string | null;
  readonly local: LocalSourceRecordsV1 | null;
  readonly http: SourceReadHttpV1 | null;
}

export interface TaskPageV1 {
  readonly items: readonly TaskSnapshotV1[];
  readonly nextCursor: string | null;
}

export interface SourceIdentityEvidenceV1 {
  readonly version: 1;
  readonly level: 'verified' | 'operator-seeded';
  readonly authority: SourceAuthorityV1 | null;
  readonly verifiedAt: string;
  readonly proof: PluginJson;
}

export interface TaskSourceProviderV1 {
  identify(context: SourceCallContextV1): Promise<SourceIdentityEvidenceV1>;
  list(input: {
    repo: string;
    state: TaskSnapshotV1['state'] | null;
    cursor: string | null;
    limit: number;
  }, context: SourceCallContextV1): Promise<TaskPageV1>;
  lookup(input: { displayKey: string }, context: SourceCallContextV1): Promise<WorkRefV1 | null>;
  load(ref: WorkRefV1, context: SourceCallContextV1): Promise<TaskSnapshotV1 | null>;
  planClaim(input: SourceClaimRequestV1, context: SourceCallContextV1): Promise<SourceMutationPlanV1>;
  planCompletion(input: SourceCompletionRequestV1, context: SourceCallContextV1): Promise<SourceMutationPlanV1>;
  planAbort(input: SourceAbortRequestV1, context: SourceCallContextV1): Promise<SourceMutationPlanV1>;
  validateAdoption(input: SourceAdoptionProposalV1, context: SourceCallContextV1): Promise<SourceAdoptionEvidenceV1>;
  readonly effects: Readonly<Record<string, SourceEffectHandlerV1>>;
  readonly commands?: Readonly<Record<string, SourceCommandHandlerV1>>;
}

export interface LocalSourceRecordV1 {
  readonly ref: WorkRefV1;
  readonly repo: string;
  readonly revision: string;
  readonly schema: string;
  readonly data: PluginJson;
  readonly claim: SourceClaimReceiptV1 | null;
  readonly lastRunId: string | null;
  readonly claimState: 'reserved' | 'claimed' | 'settling' | 'settled' | null;
}

export interface LocalSourceRecordsV1 {
  describeCollection(): Promise<{
    sourceId: SourceId;
    collectionId: string;
    schema: string;
    revision: number;
    evidenceId: string;
  }>;
  list(input: { repo: string; cursor: string | null; limit: number }): Promise<{
    records: readonly LocalSourceRecordV1[];
    nextCursor: string | null;
  }>;
  get(externalId: string): Promise<LocalSourceRecordV1 | null>;
}

export interface SourceReadHttpV1 {
  get(input: { path: string; query: Readonly<Record<string, string>> }): Promise<{
    status: number;
    body: PluginJson;
  }>;
}

export interface LocalTaskDocumentV1 {
  readonly version: 1;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: string;
  readonly priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  readonly state: 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export type LocalSourceCommandPlanV1 =
  | { kind: 'create'; schema: string; repo: string; data: PluginJson }
  | { kind: 'update'; ref: WorkRefV1; expectedRevision: string; next: { schema: string; repo: string; data: PluginJson } }
  | { kind: 'delete'; ref: WorkRefV1; expectedRevision: string };

export interface SourceCommandHandlerV1 {
  prepare(input: PluginJson, context: SourceCallContextV1): Promise<LocalSourceCommandPlanV1>;
}

export interface SourceClaimRequestV1 {
  readonly admissionId: string;
  readonly runId: string;
  readonly task: TaskSnapshotV1;
  readonly expectedInstanceRevision: number;
  readonly retryOf: string | null;
}

export interface SourceCompletionRequestV1 {
  readonly runId: string;
  readonly attempt: number;
  readonly task: TaskSnapshotV1;
  readonly claimReceipt: SourceClaimReceiptV1;
  readonly outcome: 'succeeded' | 'failed' | 'stopped';
  readonly publication: { repo: string; prNumber: number } | null;
}

export interface SourceClaimReceiptV1 {
  readonly version: 1;
  readonly claimId: string;
  readonly ref: WorkRefV1;
  readonly admissionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly binding: SourceBindingV1;
  readonly taskSnapshotHash: string;
  readonly localRecordRevision: string | null;
  readonly operations: readonly { operationId: string; receipt: PluginJson }[];
}

export interface SourceAbortRequestV1 {
  readonly admissionId: string;
  readonly runId: string;
  readonly task: TaskSnapshotV1;
  readonly claimReceipt: SourceClaimReceiptV1 | null;
  readonly reason: 'cancelled' | 'preflight-failed' | 'stopped-before-launch';
  readonly claimSteps: readonly {
    operationId: string;
    state: 'unsent' | 'acknowledged' | 'uncertain' | 'blocked';
    evidence: PluginJson;
  }[];
}

export interface SourceSettlementReceiptV1 {
  readonly version: 1;
  readonly claimId: string;
  readonly claimRevision: number;
  readonly disposition: 'released' | 'completed' | 'retained-for-operator';
  readonly reason: string;
  readonly localRecordRevision: string | null;
  readonly operations: readonly { operationId: string; receipt: PluginJson }[];
}

export type SourceMutationPlanV1 =
  | { readonly kind: 'none'; readonly reason: string }
  | {
      readonly kind: 'local-record';
      readonly ref: WorkRefV1;
      readonly expectedRevision: string;
      readonly next: { schema: string; repo: string; data: PluginJson };
    }
  | {
      readonly kind: 'remote-effects';
      readonly effects: readonly {
        readonly localId: string;
        readonly handler: string;
        readonly target: PluginJson;
        readonly payload: PluginJson;
        readonly after: readonly string[];
      }[];
    };

export interface SourceEffectContextV1 {
  readonly signal: AbortSignal;
  readonly operationId: string;
  readonly generation: number;
  readonly instance: SourceInstanceV1;
  readonly http: SourceReadHttpV1;
}

export interface SourceEffectMutationContextV1 extends SourceEffectContextV1 {
  readonly http: SourceMutationHttpV1;
}

export interface SourceMutationHttpV1 extends SourceReadHttpV1 {
  send(input: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    body: PluginJson;
  }): Promise<{ status: number; body: PluginJson }>;
}

export interface SourceEffectHandlerV1 {
  readonly delivery: 'reconcile' | 'idempotent';
  invoke(input: { target: PluginJson; payload: PluginJson }, context: SourceEffectMutationContextV1): Promise<SourceEffectResultV1>;
  reconcile(input: { target: PluginJson; payload: PluginJson }, context: SourceEffectContextV1): Promise<SourceEffectResultV1>;
}

export type SourceEffectResultV1 =
  | { status: 'acknowledged'; receipt: PluginJson }
  | { status: 'definitely-not-applied'; retryable: boolean; reason: string; evidence: PluginJson }
  | { status: 'unknown'; reason: string; evidence: PluginJson }
  | { status: 'blocked'; reason: string; evidence: PluginJson };

export interface SourceAdoptionProposalV1 {
  readonly sourceId: SourceId;
  readonly expectedSourceRevision: number;
  readonly previousBinding: SourceBindingV1;
  readonly proposedBinding: SourceBindingV1;
  readonly expectedAuthority: SourceAuthorityV1;
  readonly identityFormat: string;
  readonly storageSchema: string | null;
  readonly probes: readonly { ref: WorkRefV1; revision: string }[];
}

export interface SourceAdoptionEvidenceV1 {
  readonly compatible: boolean;
  readonly authority: SourceIdentityEvidenceV1;
  readonly identityFormat: string;
  readonly readableSchemas: readonly string[];
  readonly probeResults: readonly { ref: WorkRefV1; matches: boolean; evidence: PluginJson }[];
  readonly diagnostic: string | null;
}

export type LocalTaskInputV1 = Omit<LocalTaskDocumentV1, 'createdAt' | 'updatedAt' | 'completedAt'>;

export const TASK_SOURCE_LIMITS: Readonly<{ pageItems: number; pageBytes: number; taskBytes: number; providerDataBytes: number; cursorLength: number; collectionRecords: number }> = Object.freeze({ pageItems: 100, pageBytes: 2 * 1024 * 1024, taskBytes: 256 * 1024, providerDataBytes: 32 * 1024, cursorLength: 2048, collectionRecords: 10_000 });
export class TaskSourceValidationError extends Error {}

function invalid(label: string): never { throw new TaskSourceValidationError(`Invalid task source ${label}`); }
function jsonCopy(input: unknown, maximumBytes: number): PluginJson {
  let nodes = 0;
  const seen = new Set<object>();
  function copy(value: unknown, depth: number): PluginJson {
    if (++nodes > 50_000 || depth > 24) return invalid('JSON complexity');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || seen.has(value) || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid('JSON');
    seen.add(value);
    const result: Record<string, PluginJson> = Object.create(null) as Record<string, PluginJson>;
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor) || Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) return invalid('JSON property');
      if (/^(password|secret|token|access[-_]?token|refresh[-_]?token|api[-_]?(?:key|token)|private[-_]?key|authorization|cookie|gate[-_]?token|capability)$/i.test(key)) return invalid('secret field');
      result[key] = copy(descriptor.value, depth + 1);
    }
    seen.delete(value);
    if (!Array.isArray(value)) return Object.freeze(result);
    if (Object.keys(result).length !== value.length) return invalid('sparse array');
    return Object.freeze(Array.from({ length: value.length }, (_, index) => result[String(index)]!));
  }
  const result = copy(input, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > maximumBytes) return invalid('JSON size');
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('object');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid('fields');
}
function str(value: unknown, maximum = 512, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return invalid('string');
  return value;
}
function integer(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return invalid('integer');
  return value;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid('array');
  return value;
}
function oneOf(value: unknown, options: readonly string[]): void { if (typeof value !== 'string' || !options.includes(value)) invalid('enum'); }
export function parseTaskRepo(input: unknown): string {
  const value = str(input, 512);
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(value) || ['.', '..'].includes(value.split('/')[1]!)) invalid('galleon');
  return value;
}
function timestamp(value: unknown): void { if (!Number.isFinite(Date.parse(str(value, 40)))) invalid('timestamp'); }
function url(value: unknown): void {
  const parsed = new URL(str(value, 4096));
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) invalid('URL');
}
export function parseWorkRefV1(input: unknown): WorkRefV1 {
  const value = object(jsonCopy(input, 2048)); fields(value, ['sourceId', 'externalId']);
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(str(value.sourceId))) invalid('source ID');
  str(value.externalId, 512); return value as unknown as WorkRefV1;
}
export function parseSourceBindingV1(input: unknown): SourceBindingV1 {
  const value = object(jsonCopy(input, 4096)); fields(value, ['providerId', 'pluginId', 'artifactHash', 'contractVersion', 'connectionId', 'credentialHandle']);
  str(value.providerId, 240); str(value.pluginId, 128);
  const localId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  const parts = (value.pluginId as string).split('.');
  const contribution = (value.providerId as string).split('/');
  if (parts.length < 2 || parts.some(part => part.length > 64 || !localId.test(part)) || contribution.length !== 2 || contribution[0] !== value.pluginId || !contribution[1] || contribution[1].length > 64 || !localId.test(contribution[1])) invalid('provider identity');
  if (!/^[a-f\d]{64}$/.test(str(value.artifactHash)) || value.contractVersion !== 1) invalid('binding');
  for (const key of ['connectionId', 'credentialHandle']) if (value[key] !== null) str(value[key], 240);
  return value as unknown as SourceBindingV1;
}
function authority(input: unknown): SourceAuthorityV1 {
  const value = object(input); fields(value, ['protocol', 'authorityId', 'identityFormat']);
  str(value.protocol, 100); str(value.authorityId); str(value.identityFormat, 160);
  if (!/^[a-z][a-z0-9.-]*\/v[1-9]\d*$/.test(value.identityFormat as string)) invalid('identity format'); return value as unknown as SourceAuthorityV1;
}
export function parseSourceIdentityEvidenceV1(input: unknown): SourceIdentityEvidenceV1 {
  const value = object(jsonCopy(input, 64 * 1024)); fields(value, ['version', 'level', 'authority', 'verifiedAt', 'proof']);
  if (value.version !== 1) invalid('identity version'); oneOf(value.level, ['verified', 'operator-seeded']); timestamp(value.verifiedAt);
  if (value.level === 'verified') authority(value.authority); else if (value.authority !== null) invalid('unverified authority');
  return value as unknown as SourceIdentityEvidenceV1;
}
function sourceSettings(input: unknown): void {
  const settings = object(input);
  function inspect(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (/(?:password|secret|token|apikey|privatekey|credentials?|credentialhandle|authorization|cookie)$/.test(normalized)) invalid('credential-like source setting');
      inspect(child);
    }
  }
  inspect(settings);
}
export function parseSourceInstanceV1(input: unknown): SourceInstanceV1 {
  const value = object(jsonCopy(input, 128 * 1024));
  fields(value, ['version', 'id', 'sourceId', 'label', 'revision', 'desiredEnabled', 'identityLevel', 'authority', 'binding', 'settings', 'allowedRepos']);
  parseWorkRefV1({ sourceId: value.sourceId, externalId: value.id }); str(value.id, 160); str(value.label, 240); integer(value.revision);
  if (value.version !== 1 || typeof value.desiredEnabled !== 'boolean') invalid('instance');
  oneOf(value.identityLevel, ['verified', 'operator-seeded']);
  if (value.identityLevel === 'verified') authority(value.authority); else if (value.authority !== null) invalid('instance authority');
  parseSourceBindingV1(value.binding); sourceSettings(value.settings);
  const repos = array(value.allowedRepos, 1000); repos.forEach(repo => parseTaskRepo(repo)); if (new Set(repos).size !== repos.length) invalid('duplicate galleons');
  return value as unknown as SourceInstanceV1;
}
export function parseTaskSnapshotV1(input: unknown, expected?: { sourceId?: string; repo?: string }): TaskSnapshotV1 {
  const value = object(jsonCopy(input, TASK_SOURCE_LIMITS.taskBytes));
  fields(value, ['version', 'ref', 'revision', 'displayKey', 'title', 'repo', 'url', 'state', 'priority', 'requirements', 'providerData']);
  const ref = parseWorkRefV1(value.ref); if (expected?.sourceId && ref.sourceId !== expected.sourceId) invalid('task source association');
  if (value.version !== 1) invalid('task version'); str(value.revision); str(value.displayKey, 240); str(value.title, 240); parseTaskRepo(value.repo);
  if (expected?.repo && value.repo !== expected.repo) invalid('task galleon association');
  if (value.url !== null) url(value.url); oneOf(value.state, ['ready', 'in_progress', 'review', 'done', 'blocked']);
  if (value.priority !== null && (typeof value.priority !== 'number' || !Number.isFinite(value.priority))) invalid('priority');
  const requirements = object(value.requirements); fields(requirements, ['description', 'acceptanceCriteria', 'links']);
  str(requirements.description, 20 * 1024, true); array(requirements.acceptanceCriteria, 100).forEach(item => str(item, 20 * 1024));
  array(requirements.links, 100).forEach(item => { const link = object(item); fields(link, ['title', 'url']); str(link.title, 240); url(link.url); });
  if (value.providerData !== null) { const data = object(jsonCopy(value.providerData, TASK_SOURCE_LIMITS.providerDataBytes)); integer(data.version); }
  return value as unknown as TaskSnapshotV1;
}
export function parseTaskPageV1(input: unknown, expected?: { sourceId?: string; repo?: string }): TaskPageV1 {
  const value = object(jsonCopy(input, TASK_SOURCE_LIMITS.pageBytes)); fields(value, ['items', 'nextCursor']);
  const items = array(value.items, TASK_SOURCE_LIMITS.pageItems).map(item => parseTaskSnapshotV1(item, expected));
  if (new Set(items.map(item => `${item.ref.sourceId}:${item.ref.externalId}`)).size !== items.length) invalid('duplicate task');
  if (value.nextCursor !== null) str(value.nextCursor, TASK_SOURCE_LIMITS.cursorLength);
  return value as unknown as TaskPageV1;
}
function localTask(input: unknown, full: boolean): LocalTaskDocumentV1 | LocalTaskInputV1 {
  const value = object(jsonCopy(input, TASK_SOURCE_LIMITS.taskBytes));
  fields(value, ['version', 'title', 'description', 'acceptanceCriteria', 'priority', 'state', ...(full ? ['createdAt', 'updatedAt', 'completedAt'] : [])]);
  if (value.version !== 1) invalid('local task version'); str(value.title, 240); str(value.description, 20 * 1024, true); str(value.acceptanceCriteria, 20 * 1024, true);
  oneOf(value.priority, ['P0', 'P1', 'P2', 'P3', 'P4']); oneOf(value.state, ['todo', 'in_progress', 'in_review', 'done', 'blocked']);
  if (full) { timestamp(value.createdAt); timestamp(value.updatedAt); if (value.completedAt !== null) timestamp(value.completedAt); }
  return value as unknown as LocalTaskDocumentV1 | LocalTaskInputV1;
}
export function parseLocalTaskDocumentV1(input: unknown): LocalTaskDocumentV1 { return localTask(input, true) as LocalTaskDocumentV1; }
export function parseLocalTaskInputV1(input: unknown): LocalTaskInputV1 { return localTask(input, false) as LocalTaskInputV1; }
export function parseSourceMutationPlanV1(input: unknown, expected: { ref: WorkRefV1; repo: string; effectIds: readonly string[] }): SourceMutationPlanV1 {
  const value = object(jsonCopy(input, 256 * 1024));
  if (value.kind === 'none') { fields(value, ['kind', 'reason']); str(value.reason, 2048); }
  else if (value.kind === 'local-record') {
    fields(value, ['kind', 'ref', 'expectedRevision', 'next']); const ref = parseWorkRefV1(value.ref);
    if (ref.sourceId !== expected.ref.sourceId || ref.externalId !== expected.ref.externalId) invalid('plan work association');
    str(value.expectedRevision); const next = object(value.next); fields(next, ['schema', 'repo', 'data']); str(next.schema, 160);
    if (next.repo !== expected.repo) invalid('plan galleon association');
  } else if (value.kind === 'remote-effects') {
    fields(value, ['kind', 'effects']); const effects = array(value.effects, 32).map(object); if (!effects.length) invalid('empty effects');
    const ids = new Set<string>();
    for (const effect of effects) {
      fields(effect, ['localId', 'handler', 'target', 'payload', 'after']);
      const id = str(effect.localId, 100); if (!/^[a-z][a-z0-9-]*$/.test(id) || ids.has(id)) invalid('effect ID'); ids.add(id);
      if (!expected.effectIds.includes(str(effect.handler, 100))) invalid('undeclared effect');
      const after = array(effect.after, 32); after.forEach(item => str(item, 100)); if (new Set(after).size !== after.length) invalid('duplicate dependency');
    }
    const visited = new Set<string>(); const visiting = new Set<string>();
    const visit = (id: string): void => { if (visited.has(id)) return; if (visiting.has(id)) invalid('effect cycle'); visiting.add(id);
      const effect = effects.find(item => item.localId === id); if (!effect) invalid('missing dependency');
      for (const dependency of effect.after as string[]) visit(dependency); visiting.delete(id); visited.add(id);
    }; for (const id of ids) visit(id);
  } else invalid('plan kind');
  return value as unknown as SourceMutationPlanV1;
}
export function parseSourceEffectResultV1(input: unknown): SourceEffectResultV1 {
  const value = object(jsonCopy(input, 64 * 1024));
  if (value.status === 'acknowledged') fields(value, ['status', 'receipt']);
  else { oneOf(value.status, ['definitely-not-applied', 'unknown', 'blocked']); fields(value, ['status', 'reason', 'evidence', ...(value.status === 'definitely-not-applied' ? ['retryable'] : [])]); str(value.reason, 2048); if (value.status === 'definitely-not-applied' && typeof value.retryable !== 'boolean') invalid('retryable'); }
  return value as unknown as SourceEffectResultV1;
}
export function validateTaskSourceProvider(provider: unknown, declaration: TaskSourceDeclaration): asserts provider is TaskSourceProviderV1 {
  const value = object(provider);
  for (const name of ['identify', 'list', 'lookup', 'load', 'planClaim', 'planCompletion', 'planAbort', 'validateAdoption']) if (typeof value[name] !== 'function') invalid(`provider ${name}`);
  const effects = object(value.effects); const commands = value.commands === undefined ? {} : object(value.commands);
  for (const [record, ids] of [[effects, declaration.effectIds], [commands, declaration.commandIds]] as const) if (Object.keys(record).length !== ids.length || ids.some(id => !Object.hasOwn(record, id))) invalid('handler declaration');
  for (const handler of Object.values(effects)) { const effect = object(handler); oneOf(effect.delivery, ['reconcile', 'idempotent']); if (typeof effect.invoke !== 'function' || typeof effect.reconcile !== 'function') invalid('effect handler'); }
  for (const handler of Object.values(commands)) if (typeof object(handler).prepare !== 'function') invalid('command handler');
}

export function parseLocalSourceCommandPlanV1(input: unknown): LocalSourceCommandPlanV1 {
  const value = object(jsonCopy(input, TASK_SOURCE_LIMITS.taskBytes));
  oneOf(value.kind, ['create', 'update', 'delete']);
  if (value.kind === 'create') { fields(value, ['kind', 'schema', 'repo', 'data']); str(value.schema, 160); parseTaskRepo(value.repo); }
  else {
    fields(value, ['kind', 'ref', 'expectedRevision', ...(value.kind === 'update' ? ['next'] : [])]); parseWorkRefV1(value.ref); str(value.expectedRevision);
    if (value.kind === 'update') { const next = object(value.next); fields(next, ['schema', 'repo', 'data']); str(next.schema, 160); parseTaskRepo(next.repo); }
  }
  return value as unknown as LocalSourceCommandPlanV1;
}

export function parseSourceAdoptionEvidenceV1(input: unknown): SourceAdoptionEvidenceV1 {
  const value = object(jsonCopy(input, 256 * 1024)); fields(value, ['compatible', 'authority', 'identityFormat', 'readableSchemas', 'probeResults', 'diagnostic']);
  if (typeof value.compatible !== 'boolean') invalid('adoption compatibility'); parseSourceIdentityEvidenceV1(value.authority); str(value.identityFormat, 160);
  const schemas = array(value.readableSchemas, 32); schemas.forEach(schema => str(schema, 160)); if (new Set(schemas).size !== schemas.length) invalid('duplicate adoption schema');
  const probes = array(value.probeResults, 100); probes.forEach(item => { const probe = object(item); fields(probe, ['ref', 'matches', 'evidence']); parseWorkRefV1(probe.ref); if (typeof probe.matches !== 'boolean') invalid('adoption probe'); });
  if (value.diagnostic !== null) str(value.diagnostic, 2048);
  return value as unknown as SourceAdoptionEvidenceV1;
}

function operationReceipts(input: unknown): void {
  for (const item of array(input, 32)) {
    const operation = object(item); fields(operation, ['operationId', 'receipt']);
    if (!/^[a-f\d]{64}$/.test(str(operation.operationId))) invalid('operation receipt identity');
    jsonCopy(operation.receipt, 64 * 1024);
  }
}
export function parseSourceClaimReceiptV1(input: unknown): SourceClaimReceiptV1 {
  const value = object(jsonCopy(input, 256 * 1024)); fields(value, ['version', 'claimId', 'ref', 'admissionId', 'runId', 'revision', 'binding', 'taskSnapshotHash', 'localRecordRevision', 'operations']);
  if (value.version !== 1) invalid('claim receipt version'); str(value.claimId, 240); str(value.admissionId, 240); str(value.runId, 240); integer(value.revision);
  parseWorkRefV1(value.ref); parseSourceBindingV1(value.binding);
  if (!/^[a-f\d]{64}$/.test(str(value.taskSnapshotHash))) invalid('task snapshot hash');
  if (value.localRecordRevision !== null) str(value.localRecordRevision); operationReceipts(value.operations);
  return value as unknown as SourceClaimReceiptV1;
}
export function parseSourceSettlementReceiptV1(input: unknown): SourceSettlementReceiptV1 {
  const value = object(jsonCopy(input, 256 * 1024)); fields(value, ['version', 'claimId', 'claimRevision', 'disposition', 'reason', 'localRecordRevision', 'operations']);
  if (value.version !== 1) invalid('settlement version'); str(value.claimId, 240); integer(value.claimRevision); oneOf(value.disposition, ['released', 'completed', 'retained-for-operator']); str(value.reason, 2048);
  if (value.localRecordRevision !== null) str(value.localRecordRevision); operationReceipts(value.operations);
  return value as unknown as SourceSettlementReceiptV1;
}
export function parseLocalSourceRecordV1(input: unknown, expected?: { sourceId?: string; repo?: string }): LocalSourceRecordV1 {
  const value = object(jsonCopy(input, 512 * 1024)); fields(value, ['ref', 'repo', 'revision', 'schema', 'data', 'claim', 'claimState', 'lastRunId']);
  const ref = parseWorkRefV1(value.ref); parseTaskRepo(value.repo); str(value.revision); str(value.schema, 160);
  if (expected?.sourceId && ref.sourceId !== expected.sourceId || expected?.repo && value.repo !== expected.repo) invalid('local record scope');
  if (value.lastRunId !== null) str(value.lastRunId, 240);
  if (value.claimState !== null) oneOf(value.claimState, ['reserved', 'claimed', 'settling', 'settled']);
  if (value.claim !== null) { const claim = parseSourceClaimReceiptV1(value.claim); if (claim.ref.sourceId !== ref.sourceId || claim.ref.externalId !== ref.externalId) invalid('local claim scope'); }
  if (value.claimState === 'claimed' && value.claim === null) invalid('missing claim receipt');
  if (value.schema === 'helmsman.local-task/v1') parseLocalTaskDocumentV1(value.data);
  return value as unknown as LocalSourceRecordV1;
}
