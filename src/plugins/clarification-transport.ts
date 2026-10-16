import { apiFetch, rejectApiCache } from '../data/api-client';
import { isContributionId } from './manifest';
import { parseTaskRepo } from './tasks';
import { parseTaskReadGalleons } from './task-read';
import type { RunReadScopeV1 } from './run-read-service';
import type { ClarificationReadResultV1, ClarificationReadUnavailableReasonV1 } from './clarification-read';

export interface ClarificationHostOptions { caller: string; scope(): RunReadScopeV1; fetch?: typeof globalThis.fetch; }
export function clarificationAvailable<T>(value: T): ClarificationReadResultV1<T> { return Object.freeze({ status: 'available', value }); }
export function clarificationUnavailable(reason: ClarificationReadUnavailableReasonV1): ClarificationReadResultV1<never> { return Object.freeze({ status: 'unavailable', reason }); }
const cancelled = () => new DOMException('Clarification service scope is no longer active', 'AbortError');
export async function clarificationAbortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason ?? cancelled()); if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
function discard(response?: Response): void { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
async function body(response: Response, signal: AbortSignal, maximum: number): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > maximum) throw new TypeError('Invalid clarification response');
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0; let text = ''; let complete = false;
  try {
    while (true) {
      const next = await clarificationAbortable(reader.read(), signal);
      if (next.done) { complete = true; return JSON.parse(text + decoder.decode()) as unknown; }
      bytes += next.value.byteLength; if (bytes > maximum) throw new TypeError('Clarification response exceeds limit');
      text += decoder.decode(next.value, { stream: true });
    }
  } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function createClarificationTransport(lifetime: AbortSignal, options: ClarificationHostOptions, maximum: number): (caller?: AbortSignal) => {
  readonly scope: RunReadScopeV1; readonly signal: AbortSignal; check(): void; allowed(repo: string): boolean;
  permitted(repo: string | null): Promise<ClarificationReadResultV1<readonly string[]>>;
  request<T>(path: string, parse: (value: unknown) => T, payload?: unknown): Promise<ClarificationReadResultV1<T>>;
} {
  if (!isContributionId(options.caller)) throw new TypeError('Invalid clarification contribution');
  const fetcher = options.fetch ?? apiFetch;
  return caller => {
    const current = options.scope(); const scope = { ...current, repo: current.repo === null ? null : parseTaskRepo(current.repo) };
    function check() {
      lifetime.throwIfAborted(); caller?.throwIfAborted(); scope.signal.throwIfAborted(); const latest = options.scope();
      if (!scope.active || !latest.active || latest.epoch !== scope.epoch || latest.repo !== scope.repo || latest.signal !== scope.signal) throw cancelled();
    }
    check(); const timeout = AbortSignal.timeout(30_000); const signal = AbortSignal.any([lifetime, scope.signal, timeout, ...(caller ? [caller] : [])]);
    async function request<T>(path: string, parse: (value: unknown) => T, payload?: unknown): Promise<ClarificationReadResultV1<T>> {
      let response: Response | undefined;
      try {
        check(); signal.throwIfAborted();
        response = await clarificationAbortable<Response>(fetcher(path, { method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal,
          headers: { Accept: 'application/json', 'X-Helmsman-Contribution': options.caller, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }).then(value => {
          try { check(); signal.throwIfAborted(); return value; } catch (error) { discard(value); throw error; }
        }), signal);
        check(); signal.throwIfAborted();
        if (response.status === 401 || response.status === 403) return clarificationUnavailable('forbidden');
        if (response.status === 404) return clarificationUnavailable('not-found');
        if (!response.ok && response.status !== 409 && response.status !== 400) return clarificationUnavailable('service-unavailable');
        try {
          const value = await body(response, signal, maximum); check(); signal.throwIfAborted();
          if (!response.ok) {
            const reason = value && typeof value === 'object' && !Array.isArray(value) ? (value as { reason?: unknown }).reason : undefined;
            return clarificationUnavailable(reason === 'cursor-invalid' ? 'cursor-invalid' : reason === 'conflict' ? 'conflict' : 'invalid-response');
          }
          return clarificationAvailable(parse(value));
        } catch { check(); signal.throwIfAborted(); rejectApiCache(path); return clarificationUnavailable('invalid-response'); }
      } catch { check(); return clarificationUnavailable(timeout.aborted ? 'timeout' : 'connection-failed'); }
      finally { discard(response); }
    }
    async function permitted(repo: string | null): Promise<ClarificationReadResultV1<readonly string[]>> {
      if (scope.repo !== null && scope.repo !== repo) return clarificationUnavailable('forbidden');
      const result = await request('/api/context', parseTaskReadGalleons); if (result.status === 'unavailable') return result;
      if (repo !== null && !result.value.includes(repo)) return clarificationUnavailable('forbidden');
      return clarificationAvailable(repo === null ? result.value : Object.freeze([repo]));
    }
    return { scope, signal, check, request, permitted, allowed: repo => scope.repo === null || scope.repo === repo };
  };
}
