import type { ClarificationReadResultV1 } from './clarification-read';
import { clarificationFields as fields, clarificationId as id, clarificationInteger as integer, clarificationJson as json,
  clarificationText as text, clarificationUuid as uuid, clarificationVersion as version, invalidClarification as invalid } from './clarification-validation';
import { parseTaskRepo } from './tasks';

export interface RunInstructionQueryV1 { readonly version: 1; readonly repo: string; readonly runId: string; readonly expectedAttempt: number; }
export interface RunInstructionInputV1 extends RunInstructionQueryV1 { readonly expectedChannelId: string; readonly targetId: string; readonly text: string; }
export interface RunInstructionCommandV1 extends RunInstructionInputV1 { readonly requestId: string; }
export interface RunInstructionReceiptQueryV1 { readonly repo: string; readonly requestId: string; }
export interface RunInstructionReceiptV1 {
  readonly version: 1; readonly requestId: string; readonly input: RunInstructionInputV1;
  readonly status: 'sending' | 'delivered' | 'failed' | 'unknown' | 'rejected'; readonly message: string | null;
}
export interface RunInstructionSnapshotV1 extends RunInstructionQueryV1 {
  readonly channelId: string | null; readonly available: boolean; readonly reason: string | null;
  readonly targets: readonly { readonly id: string; readonly provider: string; readonly stage: string }[];
}
export interface RunInstructionPendingV1 { readonly command: RunInstructionCommandV1; readonly receipt: RunInstructionReceiptV1 | null; }
export interface RunInstructionServiceV1 {
  readonly version: 1;
  read(input: RunInstructionQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<RunInstructionSnapshotV1>>;
  submit(input: RunInstructionInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<RunInstructionReceiptV1>>;
  retry(input: RunInstructionReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<RunInstructionReceiptV1>>;
  receipt(input: RunInstructionReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<RunInstructionReceiptV1 | null>>;
  pending(): Promise<readonly RunInstructionPendingV1[]>;
  acknowledge(input: RunInstructionReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}
const queryFields = ['version', 'repo', 'runId', 'expectedAttempt'];
const inputFields = [...queryFields, 'expectedChannelId', 'targetId', 'text'];
function query(value: Record<string, unknown>): RunInstructionQueryV1 {
  return { version: 1, repo: parseTaskRepo(value.repo), runId: id(value.runId), expectedAttempt: integer(value.expectedAttempt) };
}
function input(value: Record<string, unknown>): RunInstructionInputV1 {
  return { ...query(value), expectedChannelId: uuid(value.expectedChannelId), targetId: uuid(value.targetId), text: text(value.text, 8000) };
}
export function parseRunInstructionQueryV1(raw: unknown): RunInstructionQueryV1 {
  const value = version(raw); fields(value, queryFields); return Object.freeze(query(value));
}
export function parseRunInstructionInputV1(raw: unknown): RunInstructionInputV1 {
  const value = version(json(raw, 64_000)); fields(value, inputFields); return Object.freeze(input(value));
}
export function parseRunInstructionCommandV1(raw: unknown): RunInstructionCommandV1 {
  const value = version(json(raw, 64_000)); fields(value, [...inputFields, 'requestId']);
  return Object.freeze({ ...input(value), requestId: uuid(value.requestId) });
}
export function parseRunInstructionReceiptQueryV1(raw: unknown): RunInstructionReceiptQueryV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  const value = raw as Record<string, unknown>; fields(value, ['repo', 'requestId']);
  return Object.freeze({ repo: parseTaskRepo(value.repo), requestId: uuid(value.requestId) });
}
export function parseRunInstructionReceiptV1(raw: unknown, expected?: RunInstructionCommandV1 | RunInstructionReceiptQueryV1): RunInstructionReceiptV1 {
  const value = version(json(raw, 128_000)); fields(value, ['version', 'requestId', 'input', 'status', 'message']);
  const parsed = parseRunInstructionInputV1(value.input); const requestId = uuid(value.requestId);
  if (!['sending', 'delivered', 'failed', 'unknown', 'rejected'].includes(String(value.status))) invalid();
  if (expected && (expected.requestId !== requestId || expected.repo !== parsed.repo)) invalid();
  if (expected && 'text' in expected) {
    const { requestId: _request, ...original } = expected;
    if (JSON.stringify(parseRunInstructionInputV1(original)) !== JSON.stringify(parsed)) invalid();
  }
  return Object.freeze({ version: 1, requestId, input: parsed, status: value.status as RunInstructionReceiptV1['status'], message: value.message === null ? null : text(value.message, 2000) });
}
export function parseRunInstructionSnapshotV1(raw: unknown, expected?: RunInstructionQueryV1): RunInstructionSnapshotV1 {
  const value = version(json(raw, 128_000)); fields(value, [...queryFields, 'channelId', 'available', 'reason', 'targets']);
  const parsed = query(value);
  if (expected && JSON.stringify(parsed) !== JSON.stringify(parseRunInstructionQueryV1(expected))) invalid();
  if (typeof value.available !== 'boolean' || !Array.isArray(value.targets) || value.targets.length > 32) invalid();
  const targets = value.targets.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
    const target = raw as Record<string, unknown>; fields(target, ['id', 'provider', 'stage']);
    return Object.freeze({ id: uuid(target.id), provider: text(target.provider, 256), stage: text(target.stage, 128) });
  });
  const channelId = value.channelId === null ? null : uuid(value.channelId);
  if (new Set(targets.map(target => target.id)).size !== targets.length || value.available !== (targets.length > 0) || value.available && channelId === null) invalid();
  return Object.freeze({ ...parsed, channelId, available: value.available, reason: value.reason === null ? null : text(value.reason, 2000), targets: Object.freeze(targets) });
}
