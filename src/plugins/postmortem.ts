export type PostmortemProviderV1 = 'codex' | 'claude-code';
export type PostmortemStatusV1 = 'starting' | 'busy' | 'ready' | 'idle' | 'capped' | 'error';
export type PostmortemActivityV1 = 'starting' | 'resuming' | 'thinking' | null;
export interface PostmortemSessionV1 {
  readonly id: string; readonly runId: string; readonly provider: PostmortemProviderV1; readonly model: string | null; readonly effort: string | null;
  readonly status: PostmortemStatusV1; readonly error: string | null; readonly turns: number; readonly costUsd: number | null;
}
export interface PostmortemMessageV1 {
  readonly id: number; readonly clientId: string | null; readonly role: 'user' | 'agent' | 'system';
  readonly kind: 'text' | 'tool' | 'command' | 'phase' | 'error' | 'patch'; readonly text: string; readonly ts: string;
}
export interface PostmortemPatchV1 {
  readonly file: string; readonly path: string; readonly repo: 'helmsman' | 'target'; readonly baseSha: string | null; readonly summary: string;
  readonly valid: boolean; readonly reason: string | null; readonly applyCommand: string | null;
}
export interface PostmortemSnapshotV1 { readonly session: PostmortemSessionV1; readonly activity: PostmortemActivityV1; readonly messages: readonly PostmortemMessageV1[]; readonly patches: readonly PostmortemPatchV1[] }
export type PostmortemEventV1 = { readonly type: 'snapshot'; readonly snapshot: PostmortemSnapshotV1 } | { readonly type: 'message'; readonly message: PostmortemMessageV1 }
  | { readonly type: 'status'; readonly session: PostmortemSessionV1; readonly activity: PostmortemActivityV1 } | { readonly type: 'patches'; readonly patches: readonly PostmortemPatchV1[] };
export type PostmortemResultV1<T> = { readonly status: 'available'; readonly value: T } | { readonly status: 'unavailable'; readonly code: number; readonly message: string };
export interface PostmortemStartInputV1 { readonly repo: string; readonly runId: string; readonly provider?: PostmortemProviderV1; readonly model?: string | null; readonly effort?: string | null; readonly fresh?: boolean }
export interface PostmortemSessionQueryV1 { readonly repo: string; readonly sessionId: string }
export interface PostmortemServiceV1 {
  readonly version: 1;
  start(input: PostmortemStartInputV1, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>>;
  read(input: PostmortemSessionQueryV1, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>>;
  send(input: PostmortemSessionQueryV1 & { readonly clientId: string; readonly text: string }, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>>;
  stop(input: PostmortemSessionQueryV1, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>>;
  watch(input: PostmortemSessionQueryV1, listener: (event: PostmortemEventV1) => void, signal: AbortSignal): Promise<void>;
}
const STATUSES = new Set(['starting', 'busy', 'ready', 'idle', 'capped', 'error']);
const ROLES = new Set(['user', 'agent', 'system']);
const KINDS = new Set(['text', 'tool', 'command', 'phase', 'error', 'patch']);
const ACTIVITIES = new Set(['starting', 'resuming', 'thinking']);
const invalid = (): never => { throw new TypeError('Invalid post-mortem response'); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const string = (value: unknown): string => typeof value === 'string' ? value : invalid();
const nullableString = (value: unknown): string | null => value === null || value === undefined ? null : string(value);
const nullableNumber = (value: unknown): number | null => value === null || value === undefined ? null : typeof value === 'number' && Number.isFinite(value) ? value : invalid();
const member = <T extends string>(set: Set<string>, value: unknown): T => typeof value === 'string' && set.has(value) ? value as T : invalid();
const activity = (value: unknown): PostmortemActivityV1 => value === null || value === undefined ? null : member(ACTIVITIES, value);

function session(raw: unknown): PostmortemSessionV1 {
  const value = object(raw);
  return Object.freeze({ id: string(value.id), runId: string(value.runId), provider: value.provider === 'claude-code' ? 'claude-code' as const : value.provider === 'codex' ? 'codex' as const : invalid(),
    model: nullableString(value.model), effort: nullableString(value.effort), status: member<PostmortemStatusV1>(STATUSES, value.status), error: nullableString(value.error),
    turns: typeof value.turns === 'number' && Number.isSafeInteger(value.turns) && value.turns >= 0 ? value.turns : invalid(), costUsd: nullableNumber(value.costUsd) });
}
function message(raw: unknown): PostmortemMessageV1 {
  const value = object(raw);
  return Object.freeze({ id: typeof value.id === 'number' && Number.isSafeInteger(value.id) ? value.id : invalid(), clientId: nullableString(value.clientId),
    role: member<PostmortemMessageV1['role']>(ROLES, value.role), kind: member<PostmortemMessageV1['kind']>(KINDS, value.kind), text: string(value.text), ts: string(value.ts) });
}
function patch(raw: unknown): PostmortemPatchV1 {
  const value = object(raw);
  return Object.freeze({ file: string(value.file), path: string(value.path), repo: value.repo === 'helmsman' || value.repo === 'target' ? value.repo : invalid(),
    baseSha: nullableString(value.baseSha), summary: string(value.summary), valid: typeof value.valid === 'boolean' ? value.valid : invalid(),
    reason: nullableString(value.reason), applyCommand: nullableString(value.applyCommand) });
}
const list = <T>(value: unknown, parse: (item: unknown) => T): readonly T[] => Array.isArray(value) ? Object.freeze(value.map(parse)) : invalid();

export function parsePostmortemSnapshotV1(raw: unknown): PostmortemSnapshotV1 {
  const value = object(raw);
  return Object.freeze({ session: session(value.session), activity: activity(value.activity), messages: list(value.messages, message), patches: list(value.patches, patch) });
}
export function parsePostmortemEventV1(raw: unknown): PostmortemEventV1 | null {
  try {
    const value = object(raw);
    if (value.type === 'snapshot') return { type: 'snapshot', snapshot: parsePostmortemSnapshotV1(value.snapshot) };
    if (value.type === 'message') return { type: 'message', message: message(value.message) };
    if (value.type === 'status') return { type: 'status', session: session(value.session), activity: activity(value.activity) };
    if (value.type === 'patches') return { type: 'patches', patches: list(value.patches, patch) };
    return null;
  } catch { return null; }
}
