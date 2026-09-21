import { parseTaskRepo } from './tasks';
import { parseTaskReadGalleons, parseTaskReadItem, parseTaskReadListQueryV1, parseTaskReadLoadQueryV1, parseTaskReadLookupQueryV1, parseTaskReadLookupRef, parseTaskReadUnderwayQueryV1, parseTaskReadPage,
  parseTaskReadSelectionV1, parseTaskReadSources, TASK_READ_LIMITS } from './task-read';
import type { TaskReadDiscoveryV1, TaskReadResultV1, TaskReadSelectionV1, TaskReadServiceV1, TaskReadUnavailableReasonV1 } from './task-read';

export interface TaskReadScopeV1 {
  readonly repo: string | null;
  readonly epoch: number;
  readonly active: boolean;
  readonly signal: AbortSignal;
}

const available = <T>(value: T): TaskReadResultV1<T> => Object.freeze({ status: 'available', value });
const unavailable = (reason: TaskReadUnavailableReasonV1): TaskReadResultV1<never> => Object.freeze({ status: 'unavailable', reason });
const cancelled = () => new DOMException('Task read scope is no longer active', 'AbortError');

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? cancelled());
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}

function discardResponse(response: Response | undefined): void {
  if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
}

async function responseBody(response: Response, signal: AbortSignal): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  let complete = false;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) { complete = true; return body + decoder.decode(); }
      bytes += next.value.byteLength;
      if (bytes > TASK_READ_LIMITS.responseBytes) return null;
      body += decoder.decode(next.value, { stream: true });
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createHostTaskReadService(lifetime: AbortSignal, options: { scope(): TaskReadScopeV1; fetch?: typeof globalThis.fetch }): TaskReadServiceV1 {
  const fetcher = options.fetch ?? globalThis.fetch;
  function operation(caller?: AbortSignal) {
    const current = options.scope();
    const scope = { repo: current.repo === null ? null : parseTaskRepo(current.repo), epoch: current.epoch, signal: current.signal, active: current.active };
    const timeout = AbortSignal.timeout(30_000);
    const signal = AbortSignal.any([lifetime, scope.signal, timeout, ...(caller ? [caller] : [])]);
    function check() {
      lifetime.throwIfAborted(); caller?.throwIfAborted(); scope.signal.throwIfAborted();
      const latest = options.scope();
      if (!scope.active || !latest.active || latest.epoch !== scope.epoch || latest.repo !== scope.repo || latest.signal !== scope.signal) throw cancelled();
    }
    check();
    async function request(path: string): Promise<TaskReadResultV1<{ status: number; body: unknown }>> {
      let response: Response | undefined;
      try {
        check(); signal.throwIfAborted();
        response = await abortable<Response>(fetcher(path, { method: 'GET', signal, credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(value => {
          try { check(); signal.throwIfAborted(); return value; } catch (error) { discardResponse(value); throw error; }
        }), signal);
        check(); signal.throwIfAborted();
        if (response.status === 401 || response.status === 403) return unavailable('forbidden');
        if (response.status === 409) return unavailable('selection-changed');
        if (response.status === 501) return unavailable('view-unavailable');
        if (response.status === 404) return available({ status: 404, body: null });
        if (!response.ok) return unavailable('service-unavailable');
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > TASK_READ_LIMITS.responseBytes) return unavailable('invalid-response');
        const body = await responseBody(response, signal);
        check(); signal.throwIfAborted();
        if (body === null) return unavailable('invalid-response');
        try { return available({ status: response.status, body: JSON.parse(body) as unknown }); } catch { return unavailable('invalid-response'); }
      } catch {
        check();
        return unavailable(timeout.aborted ? 'timeout' : 'connection-failed');
      } finally { discardResponse(response); }
    }
    async function read<T>(path: string, parse: (body: unknown, status: number) => T): Promise<TaskReadResultV1<T>> {
      const response = await request(path);
      if (response.status === 'unavailable') return response;
      check();
      try { return available(parse(response.value.body, response.value.status)); } catch { return unavailable('invalid-response'); }
    }
    async function permitted(repo?: string) {
      if (repo !== undefined && scope.repo !== null && repo !== scope.repo) return unavailable('forbidden');
      const context = await read('/api/context', parseTaskReadGalleons);
      if (context.status === 'unavailable') return context;
      if (scope.repo !== null && !context.value.includes(scope.repo) || repo !== undefined && !context.value.includes(repo)) return unavailable('forbidden');
      return available(scope.repo === null ? context.value : Object.freeze([scope.repo]));
    }
    async function selected(query: TaskReadSelectionV1) {
      const permission = await permitted(query.repo);
      if (permission.status === 'unavailable') return permission;
      const sources = await read(`/api/task-sources?${new URLSearchParams({ repo: query.repo })}`, body => parseTaskReadSources(body, query.repo));
      if (sources.status === 'unavailable') return sources;
      const source = sources.value.find(value => value.instanceId === query.instanceId);
      if (!source || source.sourceId !== query.sourceId || source.instanceRevision !== query.instanceRevision) return unavailable('selection-changed');
      if (source.availability !== 'available') return unavailable(source.availability === 'disabled' ? 'disabled' : 'source-unavailable');
      return available(source);
    }
    return { scope, check, read, permitted, selected };
  }
  return Object.freeze<TaskReadServiceV1>({
    version: 1,
    async discover(signal?: AbortSignal) {
      const call = operation(signal);
      const repos = await call.permitted();
      if (repos.status === 'unavailable') return repos;
      const galleons: TaskReadDiscoveryV1['galleons'][number][] = [];
      let index = 0;
      let instances = 0;
      let exceeded = false;
      await Promise.all(Array.from({ length: Math.min(repos.value.length, TASK_READ_LIMITS.discoveryConcurrency) }, async () => {
        while (!exceeded && index < repos.value.length) {
          const position = index++;
          const repo = repos.value[position]!;
          const sources = await call.read(`/api/task-sources?${new URLSearchParams({ repo })}`, body => parseTaskReadSources(body, repo));
          call.check();
          if (sources.status === 'available') instances += sources.value.length;
          if (instances > TASK_READ_LIMITS.instances) { exceeded = true; return; }
          galleons[position] = Object.freeze({ repo, sources });
        }
      }));
      call.check();
      if (exceeded) return unavailable('invalid-response');
      return available(Object.freeze({ version: 1 as const, repo: call.scope.repo, galleons: Object.freeze(galleons) }));
    },
    async list(input, signal) {
      const query = parseTaskReadListQueryV1(input);
      const call = operation(signal);
      const permitted = await call.selected(query);
      if (permitted.status === 'unavailable') return permitted;
      const params = new URLSearchParams({ repo: query.repo, revision: String(query.instanceRevision), limit: String(query.limit) });
      if (query.state !== null) params.set('state', query.state);
      if (query.cursor !== null) params.set('cursor', query.cursor);
      const result = await call.read(`/api/task-sources/${encodeURIComponent(query.instanceId)}/tasks?${params}`, (body, status) => status === 404 ? null : parseTaskReadPage(body, query));
      if (result.status === 'unavailable') return result;
      return result.value === null ? unavailable('not-found') : available(result.value);
    },
    async load(input, signal) {
      const query = parseTaskReadLoadQueryV1(input);
      const call = operation(signal);
      const permitted = await call.selected(query);
      if (permitted.status === 'unavailable') return permitted;
      const params = new URLSearchParams({ repo: query.repo, revision: String(query.instanceRevision), sourceId: query.sourceId, externalId: query.ref.externalId });
      return call.read(`/api/task-sources/${encodeURIComponent(query.instanceId)}/tasks?${params}`, (body, status) => status === 404
        ? Object.freeze({ selection: parseTaskReadSelectionV1(query), ref: query.ref, task: null }) : parseTaskReadItem(body, query));
    },
    async lookup(input, signal) {
      const query = parseTaskReadLookupQueryV1(input); const call = operation(signal);
      const source = await call.selected(query);
      if (source.status === 'unavailable') return source;
      const params = new URLSearchParams({ repo: query.repo, revision: String(query.instanceRevision), key: query.displayKey });
      const reference = await call.read(`/api/task-sources/${encodeURIComponent(query.instanceId)}/lookup?${params}`, (body, status) => {
        if (status === 404) throw new TypeError('Task source lookup unavailable');
        return parseTaskReadLookupRef(body, query);
      });
      if (reference.status === 'unavailable') return reference;
      if (reference.value === null) return available(null);
      call.check();
      const load = { ...query, ref: reference.value };
      const taskParams = new URLSearchParams({ repo: query.repo, revision: String(query.instanceRevision), sourceId: query.sourceId, externalId: reference.value.externalId });
      return call.read(`/api/task-sources/${encodeURIComponent(query.instanceId)}/tasks?${taskParams}`, (body, status) => status === 404
        ? Object.freeze({ selection: parseTaskReadSelectionV1(query), ref: reference.value!, task: null }) : parseTaskReadItem(body, load));
    },
    async underway(input, signal) {
      const query = parseTaskReadUnderwayQueryV1(input); const call = operation(signal);
      const source = await call.selected(query);
      if (source.status === 'unavailable') return source;
      if (!source.value.readViews?.includes('underway')) return unavailable('view-unavailable');
      const params = new URLSearchParams({ repo: query.repo, revision: String(query.instanceRevision), limit: String(query.limit), view: 'underway' });
      if (query.cursor !== null) params.set('cursor', query.cursor);
      return call.read(`/api/task-sources/${encodeURIComponent(query.instanceId)}/tasks?${params}`, (body, status) => {
        if (status === 404) throw new TypeError('Underway view unavailable');
        const page = parseTaskReadPage(body, { ...query, state: null });
        if (page.items.some(task => task.state === 'done')) throw new TypeError('Completed work is outside the Underway view');
        return page;
      });
    },
  });
}
