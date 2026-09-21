import type { PluginJson } from './backend';
import type { SourceCommandResultV1 } from './source-command';
import { parseTaskRepo } from './tasks';
import { parseSourceSettingFieldsV1, validateSourceSettingV1, type SourceSettingFieldsV1 } from './source-settings';
import { invalidSourceContract, sourceFields, sourceInteger, sourceJson, sourceObject, sourceText, sourceUuid } from './source-contract-validation';

export interface SourceAdminTargetV1 { readonly sourceId: string; readonly sourceRevision: number; readonly instanceId: string; readonly instanceRevision: number; }
export interface SourceAdminScheduleV1 { readonly repo: string; readonly revision: number; readonly instanceIds: readonly string[]; }
export interface SourceAdminRuntimeV1 { readonly repo: string; readonly epoch: string; readonly revision: number; readonly enabled: boolean; }
export type SourceReplacementModeV1 = 'adoption' | 'refresh';
export interface SourceAdminSourceV1 {
  readonly target: SourceAdminTargetV1; readonly label: string; readonly providerId: string; readonly identityLevel: string;
  readonly current: boolean; readonly available: boolean; readonly desiredEnabled: boolean; readonly allowedRepos: readonly string[];
  readonly settingsFields: SourceSettingFieldsV1; readonly settings: Readonly<Record<string, PluginJson>>;
  readonly replacements: readonly { readonly mode: SourceReplacementModeV1; readonly providerId: string; readonly artifactHash: string }[];
}
export interface SourceAdminSnapshotV1 {
  readonly version: 1; readonly repo: string | null; readonly repos: readonly string[]; readonly sources: readonly SourceAdminSourceV1[];
  readonly schedules: readonly SourceAdminScheduleV1[]; readonly runtimes: readonly SourceAdminRuntimeV1[];
}
export interface SourceAdminValidationInputV1 {
  readonly repo: string; readonly target: SourceAdminTargetV1; readonly mode: SourceReplacementModeV1;
  readonly providerId: string; readonly artifactHash: string; readonly actor: string; readonly reason: string;
}
export interface SourceAdminValidationV1 extends SourceAdminValidationInputV1 {
  readonly validationId: string; readonly instanceId: string; readonly evidenceHash: string;
}
export type SourceAdminInputV1 = { readonly version: 1; readonly repo: string | null } & (
  | { readonly kind: 'configure'; readonly target: SourceAdminTargetV1; readonly changes: { readonly label: string; readonly desiredEnabled: boolean; readonly allowedRepos: readonly string[]; readonly settings: Readonly<Record<string, PluginJson>> } }
  | { readonly kind: 'schedule'; readonly repo: string; readonly expectedRevision: number; readonly instanceIds: readonly string[] }
  | { readonly kind: 'runtime'; readonly repo: string; readonly epoch: string; readonly expectedRevision: number; readonly enabled: boolean }
  | { readonly kind: 'replace'; readonly repo: string; readonly validation: SourceAdminValidationV1 }
);
export type SourceAdminCommandV1 = SourceAdminInputV1 & { readonly requestId: string };
export type SourceAdminMutationResultV1 =
  | { readonly kind: 'configured'; readonly target: SourceAdminTargetV1 }
  | { readonly kind: 'scheduled'; readonly schedule: SourceAdminScheduleV1 }
  | { readonly kind: 'runtime'; readonly runtime: SourceAdminRuntimeV1 }
  | { readonly kind: 'replaced'; readonly sourceId: string; readonly currentInstanceId: string; readonly sourceRevision: number };
export interface SourceAdminReceiptV1 {
  readonly version: 1; readonly requestId: string; readonly input: SourceAdminInputV1;
  readonly status: 'succeeded' | 'rejected' | 'expired'; readonly result: SourceAdminMutationResultV1 | null; readonly message: string | null;
}
export interface SourceAdminReceiptQueryV1 { readonly repo: string | null; readonly requestId: string; }
export interface SourceAdminPendingV1 { readonly command: SourceAdminCommandV1; readonly receipt: SourceAdminReceiptV1 | null; }
export interface SourceAdminServiceV1 {
  readonly version: 1;
  snapshot(signal?: AbortSignal): Promise<SourceCommandResultV1<SourceAdminSnapshotV1>>;
  validateReplacement(input: SourceAdminValidationInputV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceAdminValidationV1>>;
  submit(input: SourceAdminInputV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceAdminReceiptV1>>;
  retry?(query: SourceAdminReceiptQueryV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceAdminReceiptV1>>;
  receipt(query: SourceAdminReceiptQueryV1, signal?: AbortSignal): Promise<SourceCommandResultV1<SourceAdminReceiptV1 | null>>;
  pending(): Promise<readonly SourceAdminPendingV1[]>;
  acknowledge(query: SourceAdminReceiptQueryV1): Promise<void>;
}
export const SOURCE_ADMIN_LIMITS: { readonly pending: number; readonly aggregateBytes: number; readonly responseBytes: number } = Object.freeze({ pending: 256, aggregateBytes: 8 * 1024 * 1024, responseBytes: 2 * 1024 * 1024 });
const nonnegative = (value: unknown): number => { if (value === 0) return 0; return sourceInteger(value); };
const bool = (value: unknown): boolean => { if (typeof value !== 'boolean') invalidSourceContract(); return value; };
const hash = (value: unknown): string => { const parsed = sourceText(value, 64); if (!/^[a-f\d]{64}$/.test(parsed)) invalidSourceContract(); return parsed; };
const mode = (value: unknown): SourceReplacementModeV1 => { if (value !== 'adoption' && value !== 'refresh') invalidSourceContract(); return value; };
function list<T>(input: unknown, parse: (value: unknown) => T, maximum: number = 1000): readonly T[] {
  if (!Array.isArray(input) || input.length > maximum) invalidSourceContract(); return Object.freeze(input.map(parse));
}
function strings(input: unknown, parse: (value: unknown) => string, maximum: number = 1000): readonly string[] {
  const values = list(input, parse, maximum); if (new Set(values).size !== values.length) invalidSourceContract(); return values;
}
export function parseSourceAdminTargetV1(input: unknown): SourceAdminTargetV1 {
  const v = sourceObject(input); sourceFields(v, ['sourceId', 'sourceRevision', 'instanceId', 'instanceRevision']);
  return Object.freeze({ sourceId: sourceUuid(v.sourceId), sourceRevision: sourceInteger(v.sourceRevision), instanceId: sourceText(v.instanceId, 160), instanceRevision: sourceInteger(v.instanceRevision) });
}
export function parseSourceAdminScheduleV1(input: unknown): SourceAdminScheduleV1 {
  const v = sourceObject(input); sourceFields(v, ['repo', 'revision', 'instanceIds']);
  return Object.freeze({ repo: parseTaskRepo(v.repo), revision: nonnegative(v.revision), instanceIds: strings(v.instanceIds, value => sourceText(value, 160), 32) });
}
export function parseSourceAdminRuntimeV1(input: unknown): SourceAdminRuntimeV1 {
  const v = sourceObject(input); sourceFields(v, ['repo', 'epoch', 'revision', 'enabled']);
  return Object.freeze({ repo: parseTaskRepo(v.repo), epoch: sourceUuid(v.epoch), revision: nonnegative(v.revision), enabled: bool(v.enabled) });
}
export function parseSourceAdminValidationInputV1(input: unknown): SourceAdminValidationInputV1 {
  const v = sourceObject(sourceJson(input)); sourceFields(v, ['repo', 'target', 'mode', 'providerId', 'artifactHash', 'actor', 'reason']);
  return Object.freeze({ repo: parseTaskRepo(v.repo), target: parseSourceAdminTargetV1(v.target), mode: mode(v.mode), providerId: sourceText(v.providerId, 160), artifactHash: hash(v.artifactHash), actor: sourceText(v.actor, 240), reason: sourceText(v.reason, 2048) });
}
export function parseSourceAdminValidationV1(input: unknown, expected?: SourceAdminValidationInputV1): SourceAdminValidationV1 {
  const v = sourceObject(input); const { validationId, instanceId, evidenceHash, ...base } = v; const parsed = parseSourceAdminValidationInputV1(base);
  if (expected && JSON.stringify(sourceJson(parsed)) !== JSON.stringify(sourceJson(expected))) invalidSourceContract();
  return Object.freeze({ ...parsed, validationId: sourceUuid(validationId), instanceId: sourceText(instanceId, 160), evidenceHash: hash(evidenceHash) });
}
export function parseSourceAdminInputV1(input: unknown): SourceAdminInputV1 {
  const v = sourceObject(sourceJson(input)); if (v.version !== 1) invalidSourceContract(); const repo = v.repo === null ? null : parseTaskRepo(v.repo);
  if (v.kind === 'configure') {
    sourceFields(v, ['version', 'repo', 'kind', 'target', 'changes']); const c = sourceObject(v.changes); sourceFields(c, ['label', 'desiredEnabled', 'allowedRepos', 'settings']);
    return Object.freeze({ version: 1, repo, kind: v.kind, target: parseSourceAdminTargetV1(v.target), changes: Object.freeze({ label: sourceText(c.label, 240), desiredEnabled: bool(c.desiredEnabled), allowedRepos: strings(c.allowedRepos, parseTaskRepo), settings: sourceObject(sourceJson(c.settings, 64 * 1024)) as Readonly<Record<string, PluginJson>> }) });
  }
  if (repo === null) invalidSourceContract();
  if (v.kind === 'schedule') { sourceFields(v, ['version', 'repo', 'kind', 'expectedRevision', 'instanceIds']); return Object.freeze({ version: 1, repo, kind: v.kind, expectedRevision: nonnegative(v.expectedRevision), instanceIds: strings(v.instanceIds, value => sourceText(value, 160), 32) }); }
  if (v.kind === 'runtime') { sourceFields(v, ['version', 'repo', 'kind', 'epoch', 'expectedRevision', 'enabled']); return Object.freeze({ version: 1, repo, kind: v.kind, epoch: sourceUuid(v.epoch), expectedRevision: nonnegative(v.expectedRevision), enabled: bool(v.enabled) }); }
  if (v.kind === 'replace') { sourceFields(v, ['version', 'repo', 'kind', 'validation']); const validation = parseSourceAdminValidationV1(v.validation); if (validation.repo !== repo) invalidSourceContract(); return Object.freeze({ version: 1, repo, kind: v.kind, validation }); }
  return invalidSourceContract();
}
export function parseSourceAdminCommandV1(input: unknown): SourceAdminCommandV1 {
  const v = sourceObject(input); const { requestId, ...base } = v; return Object.freeze({ ...parseSourceAdminInputV1(base), requestId: sourceUuid(requestId) });
}
export function parseSourceAdminReceiptQueryV1(input: unknown): SourceAdminReceiptQueryV1 {
  const v = sourceObject(input); sourceFields(v, ['repo', 'requestId']); return Object.freeze({ repo: v.repo === null ? null : parseTaskRepo(v.repo), requestId: sourceUuid(v.requestId) });
}
export function parseSourceAdminReceiptV1(input: unknown, expected?: SourceAdminCommandV1 | SourceAdminReceiptQueryV1): SourceAdminReceiptV1 {
  const v = sourceObject(sourceJson(input)); sourceFields(v, ['version', 'requestId', 'input', 'status', 'result', 'message']);
  const intent = parseSourceAdminInputV1(v.input); const requestId = sourceUuid(v.requestId);
  if (v.version !== 1 || typeof v.status !== 'string' || !['succeeded', 'rejected', 'expired'].includes(v.status) || expected && (expected.requestId !== requestId || expected.repo !== intent.repo)) invalidSourceContract();
  if (expected && 'kind' in expected) { const { requestId: _id, ...base } = expected; if (JSON.stringify(sourceJson(intent)) !== JSON.stringify(sourceJson(base))) invalidSourceContract(); }
  if (v.status === 'expired' && intent.kind !== 'runtime') invalidSourceContract();
  let result: SourceAdminMutationResultV1 | null = null;
  if (v.status === 'succeeded') {
    if (v.message !== null) invalidSourceContract(); const r = sourceObject(v.result);
    if (intent.kind === 'configure') { sourceFields(r, ['kind', 'target']); const target = parseSourceAdminTargetV1(r.target); if (r.kind !== 'configured' || target.sourceId !== intent.target.sourceId || target.sourceRevision !== intent.target.sourceRevision || target.instanceId !== intent.target.instanceId || target.instanceRevision !== intent.target.instanceRevision + 1) invalidSourceContract(); result = { kind: 'configured', target }; }
    else if (intent.kind === 'schedule') { sourceFields(r, ['kind', 'schedule']); const schedule = parseSourceAdminScheduleV1(r.schedule); if (r.kind !== 'scheduled' || schedule.repo !== intent.repo || schedule.revision !== intent.expectedRevision + 1 || JSON.stringify([...schedule.instanceIds].sort()) !== JSON.stringify([...intent.instanceIds].sort())) invalidSourceContract(); result = { kind: 'scheduled', schedule }; }
    else if (intent.kind === 'runtime') { sourceFields(r, ['kind', 'runtime']); const runtime = parseSourceAdminRuntimeV1(r.runtime); if (r.kind !== 'runtime' || runtime.repo !== intent.repo || runtime.epoch !== intent.epoch || runtime.revision !== intent.expectedRevision + 1 || runtime.enabled !== intent.enabled) invalidSourceContract(); result = { kind: 'runtime', runtime }; }
    else { sourceFields(r, ['kind', 'sourceId', 'currentInstanceId', 'sourceRevision']); if (r.kind !== 'replaced' || r.sourceId !== intent.validation.target.sourceId || r.currentInstanceId !== intent.validation.instanceId || r.sourceRevision !== intent.validation.target.sourceRevision + 1) invalidSourceContract(); result = { kind: 'replaced', sourceId: sourceUuid(r.sourceId), currentInstanceId: sourceText(r.currentInstanceId, 160), sourceRevision: sourceInteger(r.sourceRevision) }; }
  } else if (v.result !== null || v.message === null) invalidSourceContract();
  return Object.freeze({ version: 1, requestId, input: intent, status: v.status as 'succeeded' | 'rejected' | 'expired', result: result && Object.freeze(result), message: v.message === null ? null : sourceText(v.message, 512) });
}
export function parseSourceAdminSnapshotV1(input: unknown, repo: string | null): SourceAdminSnapshotV1 {
  const v = sourceObject(sourceJson(input, SOURCE_ADMIN_LIMITS.responseBytes)); sourceFields(v, ['version', 'repo', 'repos', 'sources', 'schedules', 'runtimes']);
  if (v.version !== 1 || v.repo !== repo) invalidSourceContract(); const repos = strings(v.repos, parseTaskRepo);
  if (repo !== null && (repos.length !== 1 || repos[0] !== repo)) invalidSourceContract();
  const sources = list(v.sources, raw => {
    const s = sourceObject(raw); sourceFields(s, ['target', 'label', 'providerId', 'identityLevel', 'current', 'available', 'desiredEnabled', 'allowedRepos', 'settingsFields', 'settings', 'replacements']);
    const fields = parseSourceSettingFieldsV1(s.settingsFields); const settings = sourceObject(s.settings); const values: Record<string, PluginJson> = Object.create(null);
    if (Object.keys(settings).some(key => !Object.hasOwn(fields, key))) invalidSourceContract();
    for (const [key, value] of Object.entries(settings)) values[key] = validateSourceSettingV1(fields[key]!.schema, value);
    const allowedRepos = strings(s.allowedRepos, parseTaskRepo); if (repo !== null && !allowedRepos.includes(repo)) invalidSourceContract();
    const replacements = list(s.replacements, raw => { const r = sourceObject(raw); sourceFields(r, ['mode', 'providerId', 'artifactHash']); return Object.freeze({ mode: mode(r.mode), providerId: sourceText(r.providerId, 160), artifactHash: hash(r.artifactHash) }); }, 128);
    return Object.freeze({ target: parseSourceAdminTargetV1(s.target), label: sourceText(s.label, 240), providerId: sourceText(s.providerId, 160), identityLevel: sourceText(s.identityLevel, 40), current: bool(s.current), available: bool(s.available), desiredEnabled: bool(s.desiredEnabled), allowedRepos, settingsFields: fields, settings: Object.freeze(values), replacements });
  });
  const schedules = list(v.schedules, parseSourceAdminScheduleV1); const runtimes = list(v.runtimes, parseSourceAdminRuntimeV1);
  for (const rows of [schedules, runtimes]) if (rows.length !== repos.length || new Set(rows.map(row => row.repo)).size !== repos.length || rows.some(row => !repos.includes(row.repo))) invalidSourceContract();
  if (new Set(sources.map(source => source.target.instanceId)).size !== sources.length) invalidSourceContract();
  return Object.freeze({ version: 1, repo, repos, sources, schedules, runtimes });
}
