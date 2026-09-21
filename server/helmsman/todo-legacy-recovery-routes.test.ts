import { describe, expect, it, vi } from 'vitest';
import { handleTodoLegacyRecoveryApi } from './todo-legacy-recovery-routes';
import { PersistenceConflictError } from './persistence';
import type { TodoApi } from './task-source-todos';

const requestId = '11111111-1111-4111-8111-111111111111';
const query = { requestId, path: '/api/todos/TODO-1', method: 'DELETE', input: null };
const receipt = { version: 1 as const, requestId, commandId: 'delete' as const, repo: null, status: 'unrecorded' as const, reason: 'not-recorded' as const, message: null, result: null };
function fixture() {
  const todos: TodoApi = { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), legacyReceipt: vi.fn(() => receipt) };
  const call = (body: unknown = query, method = 'POST') => handleTodoLegacyRecoveryApi({ path: '/api/todo-legacy-recovery/receipt', method, body, todos });
  return { todos, call };
}
describe('legacy Todo receipt route', () => {
  it('looks up exact legacy identity without replaying a task mutation', () => {
    const f = fixture(); expect(f.call()).toEqual({ status: 200, json: receipt });
    expect(f.todos.legacyReceipt).toHaveBeenCalledExactlyOnceWith(query);
    for (const method of ['list', 'get', 'create', 'update', 'remove'] as const) expect(f.todos[method]).not.toHaveBeenCalled();
  });
  it('rejects invalid operation envelopes before accessing receipts', () => {
    const f = fixture();
    for (const body of [{ ...query, path: '/api/config' }, { ...query, input: {} }, { ...query, requestId: 'unstable' }, { ...query, extra: true }, null]) expect(f.call(body)?.status).toBe(400);
    expect(f.todos.legacyReceipt).not.toHaveBeenCalled();
  });
  it('preserves identity conflict and unavailable service separately', () => {
    const f = fixture(); vi.mocked(f.todos.legacyReceipt!).mockImplementation(() => { throw new PersistenceConflictError('Different hash'); });
    expect(f.call()?.status).toBe(409);
    expect(handleTodoLegacyRecoveryApi({ path: '/api/todo-legacy-recovery/receipt', method: 'POST', body: query })?.status).toBe(503);
    expect(f.call(query, 'GET')?.status).toBe(405);
  });
  it('rejects invalid receipt projections before browser acknowledgment', () => {
    const f = fixture(); vi.mocked(f.todos.legacyReceipt!).mockReturnValue({ ...receipt, status: 'succeeded', reason: null });
    expect(f.call()?.status).toBe(400);
  });
});
