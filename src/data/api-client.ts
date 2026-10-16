import { apiCachePolicy } from './api-cache-policy';
import { onIntegrationSettingsChanged } from './integration-status-events';

type ReadScope = { readonly signal: AbortSignal; readonly keys: Set<string>; readonly onUpdate: () => void; queuedGeneration: number | null };
type Entry = { readonly response: Response; readonly bytes: number; readonly signature: string; readonly freshUntil: number; readonly expiresAt: number };
type Flight = { readonly controller: AbortController; readonly generation: number; promise: Promise<Response>; subscribers: number; background: boolean; notify: boolean; settled: boolean };
export interface ApiReadScope {
  readonly fetch: typeof fetch;
  fresh<T>(operation: () => Promise<T>): Promise<T>;
}
export interface ApiClient {
  readonly fetch: typeof fetch;
  createReadScope(lifetime: AbortSignal, onUpdate: () => void): ApiReadScope;
  invalidate(): void;
  reject(path: string): void;
}
const maximumEntryBytes = 4 * 1024 * 1024;
const maximumCacheBytes = 16 * 1024 * 1024;
const maximumEntries = 64;
const aborted = () => new DOMException('API request aborted', 'AbortError');
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? aborted());
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([pending, stopped]); } finally { signal.removeEventListener('abort', cancel); }
}
const readOnlyPosts = new Set(['/api/task-action/discover', '/api/task-edit/load', '/api/task-edit/list', '/api/task-edit/create', '/api/source-admin/validate', '/api/local-git/preview', '/api/terminal/screen', '/api/todo-legacy-recovery/receipt']);

export function createApiClient(options: { fetch?: typeof fetch; now?: () => number; origin?: string; timeoutMs?: number; schedule?: (callback: () => void) => void } = {}): ApiClient {
  const fetcher = options.fetch ?? ((input, init) => init === undefined ? globalThis.fetch(input) : globalThis.fetch(input, init));
  let fetchIdentity = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? queueMicrotask;
  const origin = options.origin ?? (typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('Invalid API timeout');
  const entries = new Map<string, Entry>();
  const flights = new Map<string, Flight>();
  const scopes = new Set<ReadScope>();
  let bytes = 0;
  let generation = 0;
  function remove(key: string) { bytes -= entries.get(key)?.bytes ?? 0; entries.delete(key); }
  function invalidate(notifyChanges = false) {
    const keys = notifyChanges ? [...entries.keys()] : [];
    generation++;
    entries.clear(); bytes = 0;
    flights.clear();
    for (const key of keys) notify(key);
  }
  function notify(key: string) {
    for (const scope of scopes) {
      if (scope.signal.aborted || !scope.keys.has(key)) continue;
      const queued = scope.queuedGeneration !== null;
      scope.queuedGeneration = generation;
      if (queued) continue;
      schedule(() => {
        const currentGeneration = scope.queuedGeneration;
        scope.queuedGeneration = null;
        if (!scope.signal.aborted && currentGeneration === generation) { try { scope.onUpdate(); } catch {} }
      });
    }
  }
  async function snapshot(response: Response, signal: AbortSignal): Promise<{ response: Response; bytes: number; signature: string } | null> {
    if (!response.ok || response.redirected || !response.body || Number(response.headers.get('content-length')) > maximumEntryBytes) return null;
    const copy = response.clone(); const reader = copy.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = []; let size = 0; let complete = false;
    try {
      while (true) {
        const result = await abortable(reader.read(), signal);
        if (result.done) { complete = true; break; }
        size += result.value.byteLength;
        if (size > maximumEntryBytes) return null;
        chunks.push(result.value);
      }
      const content = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
      const signature = new TextDecoder('utf-8', { fatal: true }).decode(content);
      JSON.parse(signature);
      return { response: new Response(content, { status: response.status, statusText: response.statusText, headers: response.headers }), bytes: size, signature };
    } catch { return null; }
    finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  function save(key: string, entry: Entry) {
    remove(key);
    for (const [key, value] of entries) if (value.expiresAt <= now()) remove(key);
    while (entries.size >= maximumEntries || bytes + entry.bytes > maximumCacheBytes) {
      const first = entries.keys().next().value; if (first === undefined) break;
      remove(first);
    }
    entries.set(key, entry); bytes += entry.bytes;
  }
  function wait(flight: Flight, signal?: AbortSignal | null): Promise<Response> {
    flight.subscribers++;
    let cancel: () => void = () => {};
    const pending = signal ? Promise.race([flight.promise, new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal.reason ?? aborted());
      if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    })]) : flight.promise;
    return pending.then(response => response.clone()).finally(() => {
      signal?.removeEventListener('abort', cancel);
      flight.subscribers--;
      if (flight.subscribers === 0 && !flight.background && !flight.settled) flight.controller.abort();
    });
  }
  const request = async (input: RequestInfo | URL, init?: RequestInit, scope?: ReadScope): Promise<Response> => {
    const currentFetch = options.fetch ?? globalThis.fetch;
    if (currentFetch !== fetchIdentity) { invalidate(); fetchIdentity = currentFetch; }
    const original = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const method = (init?.method ?? original?.method ?? 'GET').toUpperCase();
    const caller = init?.signal ?? original?.signal;
    caller?.throwIfAborted(); scope?.signal.throwIfAborted();
    const url = new URL(original?.url ?? String(input), origin);
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method) && !(method === 'POST' && url.origin === origin && readOnlyPosts.has(url.pathname));
    if (mutation) {
      invalidate();
      try { return await fetcher(input, init); } finally { invalidate(); }
    }
    const policy = method === 'GET' && url.origin === origin && (init?.cache ?? original?.cache) !== 'no-store' ? apiCachePolicy(url) : null;
    if (!policy) {
      const response = await fetcher(input, init);
      if (response.status === 401 || response.status === 403) invalidate(true);
      return response;
    }
    url.hash = ''; url.searchParams.sort();
    const headers = [...new Headers(init?.headers ?? original?.headers).entries()].sort(([a], [b]) => a.localeCompare(b));
    const key = JSON.stringify([url.href, headers, init?.credentials ?? original?.credentials ?? 'same-origin']);
    if (scope) {
      scope.keys.add(key);
      if (scope.keys.size > 128) { const oldest = scope.keys.values().next().value; if (oldest !== undefined) scope.keys.delete(oldest); }
    }
    const reload = ['reload', 'no-cache'].includes(init?.cache ?? original?.cache ?? 'default');
    let cached = entries.get(key);
    if (reload || cached && cached.expiresAt <= now()) { remove(key); cached = undefined; }
    if (!reload && cached && cached.freshUntil > now()) return cached.response.clone();
    let flight = reload ? undefined : flights.get(key);
    if (flight?.controller.signal.aborted) flight = undefined;
    if (!flight) {
      const controller = new AbortController();
      flight = { controller, generation, promise: Promise.resolve(new Response()), subscribers: 0, background: !!cached, notify: !!cached && !reload, settled: false };
      const active = flight; const previous = cached;
      flights.set(key, active);
      const timeout = AbortSignal.timeout(timeoutMs);
      active.promise = (async () => {
        const signal = AbortSignal.any([controller.signal, timeout]);
        const response = await abortable(fetcher(input, { ...init, signal }), signal);
        if (response.status === 401 || response.status === 403) { invalidate(true); return response; }
        if (response.status === 404 || response.status === 409) {
          const retained = entries.has(key); remove(key);
          if (retained) notify(key);
          return response;
        }
        const value = await snapshot(response, signal);
        signal.throwIfAborted();
        if (value && generation === active.generation && flights.get(key) === active && !controller.signal.aborted && !timeout.aborted) {
          save(key, { ...value, freshUntil: now() + policy.ttlMs, expiresAt: now() + policy.staleMs });
          if (active.notify && previous?.signature !== value.signature) notify(key);
        }
        return response;
      })().finally(() => { active.settled = true; if (flights.get(key) === active) flights.delete(key); });
      void active.promise.catch(() => {});
    }
    if (cached && !reload) { flight.background = true; return cached.response.clone(); }
    return wait(flight, caller);
  };
  const apiFetch: typeof fetch = (input, init) => request(input, init);
  return {
    fetch: apiFetch, invalidate,
    reject(_path) { invalidate(); },
    createReadScope(lifetime, onUpdate) {
      const scope: ReadScope = { signal: lifetime, keys: new Set(), onUpdate, queuedGeneration: null };
      if (!lifetime.aborted) {
        scopes.add(scope);
        lifetime.addEventListener('abort', () => scopes.delete(scope), { once: true });
      }
      let fresh = 0;
      return { fetch: (input, init) => {
          const inherited = init?.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
          return request(input, { ...init, signal: inherited ? AbortSignal.any([lifetime, inherited]) : lifetime, ...(fresh ? { cache: 'reload' as const } : {}) }, scope);
        },
        async fresh(operation) { fresh++; try { return await operation(); } finally { fresh--; } } };
    },
  };
}

const client = createApiClient();
const integrationLifetime = new AbortController();
onIntegrationSettingsChanged(() => client.invalidate(), integrationLifetime.signal);
export const apiFetch: typeof fetch = client.fetch;
export const createApiReadScope = client.createReadScope;
export const invalidateApiCache = client.invalidate;
export const rejectApiCache = client.reject;
