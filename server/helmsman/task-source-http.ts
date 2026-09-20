import type { PluginJson } from '../../src/plugins/backend';
import type { SourceMutationHttpV1, SourceReadHttpV1 } from '../../src/plugins/tasks';
import { pluginJson } from './plugins/data';

export interface SourceHttpConnection {
  readonly id: string;
  readonly credentialHandle: string;
  readonly origin: string;
  readonly subject: string;
  readonly authorityId: string | null;
}

export interface ResolvedSourceHttpConnection extends SourceHttpConnection {
  readonly headers: Readonly<Record<string, string>>;
}

export interface SourceHttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: PluginJson | null;
}

export function createSourceHttp(options: {
  connection: SourceHttpConnection;
  signal: AbortSignal;
  resolve(signal: AbortSignal): Promise<ResolvedSourceHttpConnection>;
  authorize(request: SourceHttpRequest): void;
  fetcher?: typeof fetch;
  mutation?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): SourceReadHttpV1 | SourceMutationHttpV1 {
  const pinned = Object.freeze({ ...options.connection });
  const origin = new URL(pinned.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== '/' || !pinned.id || !pinned.credentialHandle || !pinned.subject) throw new Error('Invalid source HTTP connection');
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error('Invalid source HTTP limits');
  const fetcher = options.fetcher ?? fetch;
  async function request(input: SourceHttpRequest): Promise<{ status: number; body: PluginJson }> {
    options.signal.throwIfAborted();
    const parsed = pluginJson(input, { maxBytes: 256 * 1024, maxNodes: 16_384 }) as unknown as SourceHttpRequest;
    if (!parsed || typeof parsed.path !== 'string' || parsed.path.length > 2048 || !parsed.path.startsWith('/')
      || /[\\?#\x00-\x20\x7f]/.test(parsed.path) || parsed.path.startsWith('//')
      || parsed.method !== 'GET' && (!options.mutation || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(parsed.method))) throw new Error('Invalid source HTTP request');
    const url = new URL(parsed.path, origin);
    if (url.origin !== origin.origin || url.pathname !== parsed.path || /%(?:2f|5c|00|0a|0d)/i.test(parsed.path)
      || !parsed.query || typeof parsed.query !== 'object' || Array.isArray(parsed.query)
      || Object.keys(parsed.query).length > 32) throw new Error('Invalid source HTTP path or query');
    for (const [key, value] of Object.entries(parsed.query)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 16_384) throw new Error('Invalid source HTTP query');
      url.searchParams.set(key, value);
    }
    options.authorize(parsed);
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
    const resolved = await options.resolve(signal);
    signal.throwIfAborted();
    if (!resolved || ['id', 'credentialHandle', 'subject', 'authorityId'].some(key => resolved[key as keyof SourceHttpConnection] !== pinned[key as keyof SourceHttpConnection])
      || resolved.origin !== pinned.origin || !resolved.headers || typeof resolved.headers !== 'object') throw new Error('Pinned source HTTP connection is unavailable');
    const headers = new Headers(resolved.headers);
    headers.set('Accept', 'application/json');
    if (parsed.method !== 'GET') headers.set('Content-Type', 'application/json');
    options.authorize(parsed);
    signal.throwIfAborted();
    const response = await fetcher(url, { method: parsed.method, headers, redirect: 'error', signal,
      ...(parsed.method === 'GET' ? {} : { body: JSON.stringify(parsed.body) }) });
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body?.cancel();
      throw new Error('Source HTTP response exceeds the limit');
    }
    const reader = response.body?.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      if (reader) while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) throw new Error('Source HTTP response exceeds the limit');
        chunks.push(part.value);
      }
    } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
    finally { reader?.releaseLock(); }
    signal.throwIfAborted();
    const text = Buffer.concat(chunks, bytes).toString('utf8');
    const body = text.trim() ? pluginJson(JSON.parse(text), { maxBytes, maxNodes: 100_000 }) : null;
    return { status: response.status, body };
  }
  const get: SourceReadHttpV1['get'] = input => request({ method: 'GET', path: input?.path, query: input?.query, body: null });
  if (!options.mutation) return Object.freeze({ get });
  const send: SourceMutationHttpV1['send'] = input => request({ method: input?.method, path: input?.path, query: {}, body: input?.body });
  return Object.freeze({ get, send });
}
