import { apiFetch } from '../data/api-client';
import { isContributionId } from './manifest';
import { parsePostmortemEventV1, parsePostmortemSnapshotV1, type PostmortemResultV1, type PostmortemServiceV1, type PostmortemSnapshotV1 } from './postmortem';
import type { RunReadScopeV1 } from './run-read-service';

const RESPONSE_LIMIT = 4 * 1024 * 1024;
const unavailable = (code: number, message: string): PostmortemResultV1<never> => Object.freeze({ status: 'unavailable', code, message });

export function createHostPostmortemService(lifetime: AbortSignal, options: { caller: string; scope(): RunReadScopeV1; fetch?: typeof globalThis.fetch }): PostmortemServiceV1 {
  if (!isContributionId(options.caller)) throw new TypeError('Invalid post-mortem contribution');
  const fetcher = options.fetch ?? apiFetch;
  const allowed = (repo: string) => { const scope = options.scope(); return scope.active && !scope.signal.aborted && (scope.repo === null || scope.repo === repo); };
  const headers = (accept: string, body: boolean) => ({ Accept: accept, 'X-Helmsman-Contribution': options.caller, ...(body ? { 'Content-Type': 'application/json' } : {}) });
  async function request(repo: string, path: string, payload: unknown, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>> {
    if (!allowed(repo)) return unavailable(403, 'This run is outside the current galleon scope.');
    const combined = AbortSignal.any([lifetime, options.scope().signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    let response: Response;
    try {
      response = await fetcher(path, { method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: combined,
        headers: headers('application/json', payload !== undefined), ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    } catch (error) {
      if (lifetime.aborted || options.scope().signal.aborted || signal?.aborted) throw error;
      return unavailable(0, 'Post-mortem service is unreachable.');
    }
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    try { body = text && text.length <= RESPONSE_LIMIT ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) {
      const error = body && typeof body === 'object' && !Array.isArray(body) ? (body as { error?: unknown }).error : undefined;
      return unavailable(response.status, typeof error === 'string' ? error : `Post-mortem request failed (${response.status}).`);
    }
    try { return Object.freeze({ status: 'available' as const, value: parsePostmortemSnapshotV1(body) }); }
    catch { return unavailable(response.status, 'Invalid post-mortem response.'); }
  }
  const session = (sessionId: string) => `/api/postmortem/${encodeURIComponent(sessionId)}`;
  const scopeRepo = () => options.scope().repo;
  const scoped = (repo: string) => ({ repo, scopeRepo: scopeRepo() });
  const query = (repo: string) => {
    const params = new URLSearchParams({ repo }); const scope = scopeRepo();
    if (scope !== null) params.set('scopeRepo', scope);
    return `?${params}`;
  };
  return Object.freeze<PostmortemServiceV1>({
    version: 1,
    start: (input, signal) => {
      const { repo, runId, ...body } = input;
      return request(repo, `/api/runs/${encodeURIComponent(runId)}/postmortem`, { ...body, ...scoped(repo) }, signal);
    },
    read: (input, signal) => request(input.repo, `${session(input.sessionId)}${query(input.repo)}`, undefined, signal),
    send: (input, signal) => request(input.repo, `${session(input.sessionId)}/messages`, { clientId: input.clientId, text: input.text, ...scoped(input.repo) }, signal),
    stop: (input, signal) => request(input.repo, `${session(input.sessionId)}/stop`, scoped(input.repo), signal),
    async watch(input, listener, signal) {
      if (!allowed(input.repo)) throw new TypeError('This run is outside the current galleon scope.');
      const combined = AbortSignal.any([lifetime, options.scope().signal, signal]);
      const response = await fetcher(`${session(input.sessionId)}/events${query(input.repo)}`, { credentials: 'same-origin', signal: combined, headers: headers('text/event-stream', false) });
      if (!response.ok || !response.body) throw new Error(`Post-mortem events are unavailable (${response.status}).`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          buffer += decoder.decode(next.value, { stream: true });
          if (buffer.length > RESPONSE_LIMIT) throw new Error('Post-mortem event exceeds its limit');
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const data = buffer.slice(0, index).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
            buffer = buffer.slice(index + 2);
            if (!data) continue;
            let event = null;
            try { event = parsePostmortemEventV1(JSON.parse(data)); } catch { event = null; }
            if (event) listener(event);
          }
        }
      } finally { void reader.cancel().catch(() => {}); }
    },
  });
}
