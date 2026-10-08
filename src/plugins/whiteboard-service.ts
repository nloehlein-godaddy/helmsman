import { isContributionId } from './manifest';
import { parseWhiteboardSnapshotV1, parseWhiteboardTargetV1, type WhiteboardResultV1, type WhiteboardServiceV1, type WhiteboardTargetV1 } from './whiteboard';
import type { RunReadScopeV1 } from './run-read-service';

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason); if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}

export function createHostWhiteboardService(lifetime: AbortSignal, options: { caller: string; scope(): RunReadScopeV1; fetch?: typeof globalThis.fetch }): WhiteboardServiceV1 {
  if (!isContributionId(options.caller)) throw new TypeError('Invalid Whiteboard contribution');
  const fetcher = options.fetch ?? globalThis.fetch;
  async function request(method: 'read' | 'explain' | 'open', raw: WhiteboardTargetV1, caller?: AbortSignal): Promise<WhiteboardResultV1> {
    const target = parseWhiteboardTargetV1(raw); const scope = options.scope();
    const check = () => {
      lifetime.throwIfAborted(); caller?.throwIfAborted(); scope.signal.throwIfAborted();
      const current = options.scope();
      if (!scope.active || !current.active || scope.epoch !== current.epoch || scope.repo !== current.repo || scope.signal !== current.signal) throw new DOMException('Whiteboard scope changed', 'AbortError');
    };
    check();
    const signal = AbortSignal.any([lifetime, scope.signal, AbortSignal.timeout(125_000), ...(caller ? [caller] : [])]);
    const unavailable = (code: number, message: string): WhiteboardResultV1 => ({ status: 'unavailable', code, message });
    try {
      const query = new URLSearchParams({ target: JSON.stringify(target) }); if (scope.repo !== null) query.set('scopeRepo', scope.repo);
      const response = await fetcher(method === 'read' ? `/api/whiteboard?${query}` : `/api/whiteboard/${method}`, {
        method: method === 'read' ? 'GET' : 'POST', credentials: 'same-origin', signal,
        headers: { Accept: 'application/json', 'X-Helmsman-Contribution': options.caller, ...(method === 'read' ? {} : { 'Content-Type': 'application/json' }) },
        ...(method === 'read' ? {} : { body: JSON.stringify({ target, scopeRepo: scope.repo }) }),
      });
      try { check(); } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
      if (!response.body) return unavailable(response.status, 'Invalid Whiteboard response.');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let text = '';
      try {
        while (true) { signal.throwIfAborted(); const next = await abortable(reader.read(), signal); check(); if (next.done) break;
          bytes += next.value.byteLength; if (bytes > 32_768) throw new TypeError('Whiteboard response exceeds limit'); text += decoder.decode(next.value, { stream: true }); }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      let body: unknown; try { body = JSON.parse(text + decoder.decode()); } catch { return unavailable(response.status, 'Invalid Whiteboard response.'); }
      if (!response.ok) return unavailable(response.status, 'Whiteboard is unavailable. Check its local installation and selected comparison.');
      const value = parseWhiteboardSnapshotV1(body);
      if (JSON.stringify(value.target) !== JSON.stringify(target)) return unavailable(502, 'Whiteboard returned a different comparison.');
      return { status: 'available', value };
    } catch { check(); if (signal.aborted) return unavailable(0, 'Whiteboard outcome is unknown. Refresh before retrying.'); return unavailable(0, 'Whiteboard is unavailable. Check its local installation.'); }
  }
  return Object.freeze<WhiteboardServiceV1>({ version: 1, read: (target, signal) => request('read', target, signal), explain: (target, signal) => request('explain', target, signal), open: (target, signal) => request('open', target, signal) });
}
