import { parseTaskRepo, parseWorkRefV1, type WorkRefV1 } from './tasks';
import { invalidSourceContract, sourceFields, sourceJson, sourceObject, sourceText } from './source-contract-validation';

export interface LegacyTodoCommandQuery {
  readonly requestId: string; readonly path: string; readonly method: 'POST' | 'PUT' | 'DELETE'; readonly input: unknown;
}
export interface LegacyTodoCommandReceipt {
  readonly version: 1; readonly requestId: string; readonly commandId: 'create' | 'update' | 'delete'; readonly repo: string | null;
  readonly status: 'succeeded' | 'rejected' | 'pending' | 'unrecorded' | 'blocked';
  readonly reason: 'not-recorded' | 'mutation-unconfirmed' | 'original-authority-unavailable' | 'mutation-proof-mismatch' | null;
  readonly message: string | null;
  readonly result: { readonly kind: 'changed'; readonly ref: WorkRefV1; readonly repo: string; readonly revision: string }
    | { readonly kind: 'deleted'; readonly ref: WorkRefV1; readonly repo: string }
    | { readonly kind: 'not-found'; readonly ref: WorkRefV1 } | null;
}
export interface TodoLegacyPendingV1 {
  readonly requestId: string;
  readonly commandId: LegacyTodoCommandReceipt['commandId'];
  readonly externalId: string | null;
}
export type TodoLegacyRecoveryResultV1<T> = { readonly status: 'available'; readonly value: T }
  | { readonly status: 'unavailable'; readonly reason: 'all-galleons-required' | 'storage-unavailable' | 'invalid-storage'
    | 'request-changed' | 'confirmation-required' | 'service-unavailable' | 'invalid-response' | 'timeout' };
export interface TodoLegacyRecoveryServiceV1 {
  readonly version: 1;
  pending(signal?: AbortSignal): Promise<TodoLegacyRecoveryResultV1<readonly TodoLegacyPendingV1[]>>;
  check(requestId: string, signal?: AbortSignal): Promise<TodoLegacyRecoveryResultV1<LegacyTodoCommandReceipt>>;
  acknowledge(requestId: string, signal?: AbortSignal): Promise<TodoLegacyRecoveryResultV1<void>>;
}

export function parseLegacyTodoCommandQuery(input: unknown): LegacyTodoCommandQuery {
  const value = sourceObject(sourceJson(input)); sourceFields(value, ['requestId', 'path', 'method', 'input']);
  const requestId = sourceText(value.requestId, 36); const path = sourceText(value.path, 128);
  if (!/^[a-f\d-]{36}$/i.test(requestId)) invalidSourceContract();
  if (value.method === 'POST' && path === '/api/todos' || value.method === 'PUT' && /^\/api\/todos\/TODO-[1-9]\d*$/.test(path)) sourceObject(value.input);
  else if (!(value.method === 'DELETE' && /^\/api\/todos\/TODO-[1-9]\d*$/.test(path) && value.input === null)) invalidSourceContract();
  return Object.freeze({ requestId, path, method: value.method as LegacyTodoCommandQuery['method'], input: value.input });
}

export function legacyTodoPending(query: LegacyTodoCommandQuery): TodoLegacyPendingV1 {
  return Object.freeze({ requestId: query.requestId, commandId: query.method === 'POST' ? 'create' : query.method === 'PUT' ? 'update' : 'delete',
    externalId: query.method === 'POST' ? null : query.path.slice('/api/todos/'.length) });
}

export function parseLegacyTodoCommandReceipt(input: unknown, query: LegacyTodoCommandQuery): LegacyTodoCommandReceipt {
  const value = sourceObject(sourceJson(input, 16 * 1024));
  sourceFields(value, ['version', 'requestId', 'commandId', 'repo', 'status', 'reason', 'message', 'result']);
  const expected = legacyTodoPending(query);
  if (value.version !== 1 || value.requestId !== expected.requestId || value.commandId !== expected.commandId) invalidSourceContract();
  const repo = value.repo === null ? null : parseTaskRepo(value.repo);
  let result: LegacyTodoCommandReceipt['result'] = null;
  if (value.result !== null) {
    const raw = sourceObject(value.result);
    sourceFields(raw, raw.kind === 'changed' ? ['kind', 'ref', 'repo', 'revision'] : raw.kind === 'deleted' ? ['kind', 'ref', 'repo'] : ['kind', 'ref']);
    const ref = Object.freeze(parseWorkRefV1(raw.ref));
    if (expected.externalId !== null && ref.externalId !== expected.externalId) invalidSourceContract();
    if (raw.kind === 'changed' && expected.commandId !== 'delete') {
      const input = sourceObject(query.input);
      const destination = Object.hasOwn(input, 'repo') ? parseTaskRepo(input.repo) : expected.commandId === 'update' ? repo : null;
      if (repo === null || destination === null || raw.repo !== destination) invalidSourceContract();
      result = Object.freeze({ kind: 'changed', ref, repo: parseTaskRepo(raw.repo), revision: sourceText(raw.revision, 512) });
    }
    else if (raw.kind === 'deleted' && expected.commandId === 'delete' && raw.repo === repo) result = Object.freeze({ kind: 'deleted', ref, repo: parseTaskRepo(raw.repo) });
    else if (raw.kind === 'not-found' && expected.commandId !== 'create' && repo === null) result = Object.freeze({ kind: 'not-found', ref });
    else invalidSourceContract();
  }
  const terminal = value.status === 'succeeded' || value.status === 'rejected';
  if (terminal ? value.reason !== null || (value.status === 'succeeded' ? result === null || value.message !== null : result !== null || typeof value.message !== 'string')
    : result !== null || value.message !== null || !(value.status === 'unrecorded' && value.reason === 'not-recorded'
      || value.status === 'pending' && value.reason === 'mutation-unconfirmed'
      || value.status === 'blocked' && typeof value.reason === 'string' && ['original-authority-unavailable', 'mutation-proof-mismatch'].includes(value.reason))) invalidSourceContract();
  if (typeof value.message === 'string' && value.message.length > 4096) invalidSourceContract();
  return Object.freeze({ version: 1, requestId: expected.requestId, commandId: expected.commandId, repo,
    status: value.status as LegacyTodoCommandReceipt['status'], reason: value.reason as LegacyTodoCommandReceipt['reason'], message: value.message as string | null, result });
}
