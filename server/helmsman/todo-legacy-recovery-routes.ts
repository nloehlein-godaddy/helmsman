import { parseLegacyTodoCommandQuery, parseLegacyTodoCommandReceipt } from '../../src/plugins/todo-legacy-recovery';
import { SourceContractValidationError } from '../../src/plugins/source-contract-validation';
import { PersistenceConflictError, PersistenceValidationError } from './persistence';
import type { TodoApi } from './task-source-todos';
import type { ApiResult } from './router';

export function handleTodoLegacyRecoveryApi(input: { method: string; path: string; body: unknown; todos?: TodoApi }): ApiResult | null {
  if (input.path !== '/api/todo-legacy-recovery/receipt') return null;
  if (input.method !== 'POST') return { status: 405, json: { error: 'Legacy receipt lookup requires POST' } };
  if (!input.todos?.legacyReceipt) return { status: 503, json: { error: 'Legacy Todo receipts unavailable' } };
  try {
    const query = parseLegacyTodoCommandQuery(input.body);
    return { status: 200, json: parseLegacyTodoCommandReceipt(input.todos.legacyReceipt(query), query) };
  } catch (error) {
    if (error instanceof PersistenceConflictError) return { status: 409, json: { error: 'Legacy Todo request identity changed' } };
    if (error instanceof SourceContractValidationError || error instanceof PersistenceValidationError) return { status: 400, json: { error: 'Invalid legacy Todo receipt request' } };
    return { status: 503, json: { error: 'Legacy Todo receipts unavailable' } };
  }
}
