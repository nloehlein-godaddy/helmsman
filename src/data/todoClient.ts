import { TODO_PRIORITIES, TODO_STATES, type Todo, type TodoInput } from './todos';

const mutationStorageKey = 'helmsman.todos.pending-mutations.v1';
function pendingMutations(): Map<string, string> {
  const stored = sessionStorage.getItem(mutationStorageKey);
  if (stored === null) return new Map();
  const entries: unknown = JSON.parse(stored);
  if (!Array.isArray(entries) || entries.length > 128 || !entries.every(entry => Array.isArray(entry) && entry.length === 2
    && typeof entry[0] === 'string' && typeof entry[1] === 'string' && /^[a-f\d-]{36}$/i.test(entry[1]))) {
    throw new Error('Pending Todo changes could not be recovered. Their mutation identities must be retained before retrying.');
  }
  return new Map(entries as [string, string][]);
}
function mutation(path: string, method: string, input: unknown): { path: string; complete(): void } {
  const normalized = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) : input;
  const key = JSON.stringify([path, method, normalized]);
  const pending = pendingMutations();
  let requestId = pending.get(key);
  if (!requestId) {
    if (pending.size >= 128) throw new Error('Too many unconfirmed Todo changes. Retry pending changes before making more changes.');
    requestId = crypto.randomUUID(); pending.set(key, requestId);
    sessionStorage.setItem(mutationStorageKey, JSON.stringify([...pending]));
  }
  return { path: `${path}?requestId=${encodeURIComponent(requestId)}`, complete: () => {
    const remaining = pendingMutations();
    if (remaining.get(key) === requestId) {
      remaining.delete(key);
      if (remaining.size) sessionStorage.setItem(mutationStorageKey, JSON.stringify([...remaining]));
      else sessionStorage.removeItem(mutationStorageKey);
    }
  } };
}

export interface TodosResponse {
  todos: Todo[];
  jiraEnabled: boolean;
}

export function isTodo(value: unknown): value is Todo {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<Todo>;
  return typeof item.id === 'string' && Boolean(item.id)
    && typeof item.title === 'string' && typeof item.repo === 'string'
    && typeof item.description === 'string' && typeof item.acceptanceCriteria === 'string'
    && TODO_PRIORITIES.some(priority => priority === item.priority)
    && TODO_STATES.some(state => state === item.state)
    && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
    && typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt))
    && (item.completedAt === null || typeof item.completedAt === 'string' && Number.isFinite(Date.parse(item.completedAt)))
    && (item.runId === null || typeof item.runId === 'string');
}

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { ...init, signal: AbortSignal.timeout(10_000) });
  const payload: unknown = await response.json().catch(() => null);
  const data = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown> : null;
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `Todo request failed (${response.status}).`);
  if (!data) throw new Error('Unexpected todo response. Refresh and try again.');
  return data;
}

export async function fetchTodos(): Promise<TodosResponse> {
  const data = await request('/api/todos');
  if (!Array.isArray(data.todos) || !data.todos.every(isTodo) || typeof data.jiraEnabled !== 'boolean') {
    throw new Error('Unable to read the todo list. Refresh and try again.');
  }
  return { todos: data.todos, jiraEnabled: data.jiraEnabled };
}

async function saveTodo(path: string, method: 'POST' | 'PUT', input: TodoInput): Promise<Todo> {
  const pending = mutation(path, method, input);
  const data = await request(pending.path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!isTodo(data.todo)) throw new Error('Unable to confirm the saved todo. Refresh before retrying.');
  pending.complete();
  return data.todo;
}

export function createTodo(input: TodoInput): Promise<Todo> {
  return saveTodo('/api/todos', 'POST', input);
}

export function updateTodo(id: string, input: TodoInput): Promise<Todo> {
  return saveTodo(`/api/todos/${encodeURIComponent(id)}`, 'PUT', input);
}

export async function deleteTodo(id: string): Promise<void> {
  const pending = mutation(`/api/todos/${encodeURIComponent(id)}`, 'DELETE', null);
  const data = await request(pending.path, { method: 'DELETE' });
  if (data.ok !== true) throw new Error('Unable to confirm deletion. Refresh before retrying.');
  pending.complete();
}
