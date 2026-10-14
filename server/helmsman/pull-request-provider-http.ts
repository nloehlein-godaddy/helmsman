import type { PullRequestHttpV1 } from '../../src/plugins/pull-request-provider';
import { pluginJson } from './plugins/data';

export interface PullRequestProviderConnection {
  readonly id: string;
  readonly credentialHandle: string;
  readonly origin: string;
  readonly subject: string;
}

export interface ResolvedPullRequestProviderConnection extends PullRequestProviderConnection {
  readonly headers: Readonly<Record<string, string>>;
}

export interface PullRequestProviderHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown | null;
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
}

function validatePath(path: string, method: 'GET' | 'POST'): void {
  if (!path.startsWith('/') || path.length > 2048 || /[\\?#\x00-\x20\x7f]/.test(path) || path.startsWith('//')) throw new Error('Invalid pull request provider path.');
  const repo = '[A-Za-z0-9_.-]+';
  const pull = `/repos/${repo}/${repo}/pulls`;
  const commit = `/repos/${repo}/${repo}/commits/(?:[a-f\\d]{40}|[a-f\\d]{64})`;
  const read = new RegExp(`^(?:/user|/search/issues|/repos/${repo}/${repo}|${pull}|${pull}/[1-9]\\d*(?:/reviews|/comments)?|/repos/${repo}/${repo}/issues(?:/[1-9]\\d*/comments)?|${commit}(?:/(?:check-runs|status))?|/repos/${repo}/${repo}/compare/[a-f\\d]{40,64}\\.\\.\\.[a-f\\d]{40,64})$`, 'i');
  const review = new RegExp(`^${pull}/[1-9]\\d*/reviews$`, 'i');
  if (method === 'GET' ? !read.test(path) : !review.test(path)) throw new Error('Pull request provider path is not permitted.');
}

function parseRequest(input: unknown, mutation: boolean): PullRequestProviderHttpRequest {
  const value = pluginJson(input, { maxBytes: 512 * 1024, maxNodes: 16_384 }) as unknown as PullRequestProviderHttpRequest;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['GET', 'POST'].includes(String(value.method)) || typeof value.path !== 'string'
    || !value.query || typeof value.query !== 'object' || Array.isArray(value.query) || !Object.hasOwn(value, 'body')
    || value.method === 'POST' && !mutation || value.method === 'GET' && value.body !== null) throw new Error('Invalid pull request provider request.');
  const method = value.method as 'GET' | 'POST'; validatePath(value.path, method);
  const query = Object.entries(value.query);
  if (query.length > 16) throw new Error('Pull request provider query is too large.');
  for (const [key, item] of query) if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || !safeText(item, 16_384)) throw new Error('Invalid pull request provider query.');
  if (method === 'POST') pluginJson(value.body, { maxBytes: 512 * 1024, maxNodes: 16_384 });
  return Object.freeze({ method, path: value.path, query: Object.freeze(Object.fromEntries(query)), body: value.body });
}

export function createPullRequestProviderHttp(options: {
  connection: PullRequestProviderConnection;
  signal: AbortSignal;
  mutation: boolean;
  resolve(signal: AbortSignal): Promise<ResolvedPullRequestProviderConnection>;
  authorize(request: PullRequestProviderHttpRequest): void | Promise<void>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxTransportBytes?: number;
}): PullRequestHttpV1 {
  const pinned = Object.freeze({ ...options.connection });
  let origin: URL;
  try { origin = new URL(pinned.origin); } catch { throw new Error('Invalid pull request provider connection.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || !safeText(pinned.id, 256) || !safeText(pinned.credentialHandle, 256) || !safeText(pinned.subject, 128)) throw new Error('Invalid pull request provider connection.');
  const timeoutMs = options.timeoutMs ?? 15_000; const maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024; const maxTransportBytes = options.maxTransportBytes ?? 12 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 8 * 1024 * 1024
    || !Number.isSafeInteger(maxTransportBytes) || maxTransportBytes < maxResponseBytes || maxTransportBytes > 64 * 1024 * 1024) throw new Error('Invalid pull request provider HTTP limits.');
  const fetcher = options.fetcher ?? fetch;
  let transportBytes = 0;
  async function request(input: PullRequestProviderHttpRequest): Promise<{ readonly status: number; readonly body: unknown; readonly link?: string }> {
    options.signal.throwIfAborted();
    if (transportBytes >= maxTransportBytes) throw new Error('Pull request provider transport budget is exhausted.');
    const value = parseRequest(input, options.mutation); const url = new URL(value.path, origin);
    if (url.origin !== origin.origin || url.pathname !== value.path) throw new Error('Pull request provider request escaped its connection origin.');
    for (const [key, item] of Object.entries(value.query)) url.searchParams.set(key, item);
    await options.authorize(value); options.signal.throwIfAborted();
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
    const resolved = await options.resolve(signal); signal.throwIfAborted();
    if (!resolved || ['id', 'credentialHandle', 'origin', 'subject'].some(key => resolved[key as keyof PullRequestProviderConnection] !== pinned[key as keyof PullRequestProviderConnection])
      || !resolved.headers || typeof resolved.headers !== 'object') throw new Error('Pinned pull request provider connection is unavailable.');
    const headers = new Headers(resolved.headers); headers.set('Accept', 'application/vnd.github+json');
    if (value.method === 'POST') headers.set('Content-Type', 'application/json');
    await options.authorize(value); signal.throwIfAborted();
    const response = await fetcher(url, { method: value.method, redirect: 'error', headers, signal, ...(value.method === 'POST' ? { body: JSON.stringify(value.body) } : {}) });
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)) { await response.body?.cancel().catch(() => {}); throw new Error('Pull request provider response exceeds the limit.'); }
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      if (reader) for (;;) {
        signal.throwIfAborted(); const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength; transportBytes += chunk.value.byteLength;
        if (bytes > maxResponseBytes) throw new Error('Pull request provider response exceeds the limit.');
        if (transportBytes > maxTransportBytes) throw new Error('Pull request provider transport exceeds the limit.');
        chunks.push(chunk.value);
      }
    } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
    finally { reader?.releaseLock(); }
    signal.throwIfAborted();
    const text = Buffer.concat(chunks, bytes).toString('utf8');
    let body: unknown = null;
    if (text.trim()) {
      try { body = pluginJson(JSON.parse(text), { maxBytes: maxResponseBytes, maxNodes: 100_000 }); }
      catch { throw new Error('Pull request provider response is invalid JSON.'); }
    }
    const link = response.headers.get('link');
    if (link !== null && (!safeText(link, 8192) || /[\r\n]/.test(link))) throw new Error('Pull request provider pagination link is invalid.');
    return Object.freeze({ status: response.status, body, ...(link === null ? {} : { link }) });
  }
  return Object.freeze({ request });
}
