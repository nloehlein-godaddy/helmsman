import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type Database from 'better-sqlite3';
import { storeConnection } from './store-connection';
import { parsePublicationRequest, type PublicationRequest, type PublicationResponse } from './publication-client';
import type { GoCaaSAuthMode } from './gocaas';

export interface GatewayCapability { token: string; runId: string; expiresAt: number }
export interface GatewayScope { repo: string; branch: string; readOnly: boolean }
export interface ScopedGatewayOptions {
  path?: string | Database.Database;
  modelUpstream: { baseUrl: string; credential: () => Promise<string | undefined>; authMode?: GoCaaSAuthMode };
  githubKey?: () => string | undefined;
  active(runId: string): boolean;
  scope?: (runId: string) => GatewayScope | null;
  clarificationReady?: (runId: string) => boolean;
  clarificationGate?: (runId: string, query: URLSearchParams) => boolean;
  push?: (runId: string, scope: GatewayScope, headSha: string) => Promise<void>;
  publication?: (runId: string, scope: GatewayScope, request: PublicationRequest, signal: AbortSignal) => Promise<PublicationResponse>;
  fetcher?: typeof fetch;
  now?: () => number;
}

export function createScopedGateway(input: ScopedGatewayOptions) {
  const connection = storeConnection(input.path ?? ':memory:');
  const { sql } = connection;
  connection.migrate({ owner: 'core.capabilities', ddl: 'CREATE TABLE IF NOT EXISTS run_capabilities (hash TEXT PRIMARY KEY, runId TEXT NOT NULL, expiresAt INTEGER NOT NULL)' });
  connection.migrate({ owner: 'core.publication-capabilities', ddl: 'CREATE TABLE IF NOT EXISTS publication_capabilities (hash TEXT PRIMARY KEY, runId TEXT NOT NULL, expiresAt INTEGER NOT NULL)' });
  const now = input.now ?? Date.now;
  const fetcher = input.fetcher ?? fetch;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  async function read(req: IncomingMessage): Promise<Buffer> {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of req) {
      const bytes = Buffer.from(part);
      size += bytes.length;
      if (size > 10_000_000) throw new Error('Request body too large');
      parts.push(bytes);
    }
    return Buffer.concat(parts);
  }
  const reply = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
  };
  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 300_000);
    res.on('close', () => abort.abort());
    try {
      const auth = req.headers.authorization;
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-api-key'];
      const path = req.url ?? '';
      const table = path === '/publication/v1' ? 'publication_capabilities' : 'run_capabilities';
      const cap = typeof token === 'string' && /^[a-f\d]{64}$/.test(token)
        ? sql.prepare(`SELECT runId, expiresAt FROM ${table} WHERE hash = ?`).get(hash(token)) as { runId: string; expiresAt: number } | undefined : undefined;
      if (!cap || cap.expiresAt <= now() || !input.active(cap.runId)) { reply(res, 401, { error: 'Inactive capability' }); return; }
      if (path === '/publication/v1' && req.method === 'POST') {
        const scope = input.scope?.(cap.runId);
        if (!scope || scope.readOnly || !input.publication || input.clarificationReady?.(cap.runId) !== true) { reply(res, 403, { error: 'Publication not permitted' }); return; }
        let request: PublicationRequest;
        try {
          const body = await read(req);
          if (body.length > 64_000) throw new Error('Publication request too large');
          request = parsePublicationRequest(JSON.parse(body.toString('utf8')));
        } catch { reply(res, 400, { error: 'Provide valid approved publication evidence' }); return; }
        const current = input.scope?.(cap.runId);
        if (request.approved.branch !== scope.branch || !input.active(cap.runId) || input.clarificationReady?.(cap.runId) !== true
          || !current || current.readOnly || current.repo !== scope.repo || current.branch !== scope.branch
          || !sql.prepare('SELECT hash FROM publication_capabilities WHERE hash=? AND expiresAt>?').get(hash(String(token)), now())) {
          reply(res, 403, { error: 'Publication scope or capability changed' }); return;
        }
        reply(res, 200, await input.publication(cap.runId, scope, request, abort.signal)); return;
      }
      if ((path === '/clarification-gate' || path.startsWith('/clarification-gate?')) && req.method === 'GET') {
        const query = new URL(path, 'http://localhost').searchParams;
        const ready = input.clarificationGate ? input.clarificationGate(cap.runId, query) : query.size === 0 && input.clarificationReady?.(cap.runId) === true;
        reply(res, 200, { ready }); return;
      }
      if (path === '/git/push' && req.method === 'POST') {
        const scope = input.scope?.(cap.runId);
        if (!scope || scope.readOnly || !input.push) { reply(res, 403, { error: 'Publication not permitted' }); return; }
        const value: unknown = JSON.parse((await read(req)).toString('utf8'));
        if (!value || typeof value !== 'object' || !('headSha' in value) || typeof value.headSha !== 'string'
          || !/^[a-f\d]{40}(?:[a-f\d]{24})?$/.test(value.headSha) || Object.keys(value).length !== 1) {
          reply(res, 400, { error: 'Provide the exact approved revision' }); return;
        }
        await input.push(cap.runId, scope, value.headSha);
        reply(res, 200, { ok: true }); return;
      }
      let url: string;
      let key: string | undefined;
      let headers: Record<string, string>;
      if (req.method === 'POST' && ['/openai/v1/responses', '/openai/v1/responses/compact'].includes(path)) {
        key = await input.modelUpstream.credential();
        url = `${input.modelUpstream.baseUrl}${path.slice('/openai/v1'.length)}`;
        headers = { Authorization: `${input.modelUpstream.authMode === 'sso-jwt' ? 'sso-jwt' : 'Bearer'} ${key ?? ''}`, 'content-type': 'application/json' };
      } else if (req.method === 'POST' && ['/anthropic/v1/messages', '/anthropic/v1/messages?beta=true'].includes(path)) {
        key = await input.modelUpstream.credential(); url = `${input.modelUpstream.baseUrl}/messages${path.endsWith('?beta=true') ? '?beta=true' : ''}`;
        headers = { ...(input.modelUpstream.authMode === 'sso-jwt' ? { Authorization: `sso-jwt ${key ?? ''}` } : { 'x-api-key': key ?? '' }), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
        const beta = req.headers['anthropic-beta'];
        if (beta !== undefined) {
          if (typeof beta !== 'string' || beta.length > 2048 || !/^[a-z0-9][a-z0-9-]{0,127}(?:,\s*[a-z0-9][a-z0-9-]{0,127})*$/.test(beta)) {
            reply(res, 400, { error: 'Invalid Anthropic beta header' }); return;
          }
          headers['anthropic-beta'] = beta;
        }
      } else if (req.method === 'GET' && path.startsWith('/github/repos/')) {
        const scope = input.scope?.(cap.runId);
        const prefix = scope ? `/github/repos/${scope.repo}/` : '';
        const suffix = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : '';
        if (!suffix || /%|\\|\.\.|#/.test(suffix) || !/^(?:(?:pulls|issues)(?:\/\d+(?:\/(?:comments|reviews|files|commits))?)?|commits(?:\/[a-zA-Z0-9_.-]+)?|contents(?:\/[^?]*)?|compare\/[a-zA-Z0-9_.-]+)(?:\?[^#]*)?$/.test(suffix)) {
          reply(res, 403, { error: 'Read is outside this run scope' }); return;
        }
        key = input.githubKey?.(); url = `https://api.github.com${path.slice('/github'.length)}`;
        headers = { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github+json' };
      } else { reply(res, 403, { error: 'Operation not permitted' }); return; }
      if (!key) { reply(res, 503, { error: 'Upstream credential is not configured' }); return; }
      const body = req.method === 'POST' ? await read(req) : undefined;
      if (!input.active(cap.runId) || !sql.prepare('SELECT hash FROM run_capabilities WHERE hash = ? AND expiresAt > ?').get(hash(String(token)), now())) {
        reply(res, 401, { error: 'Inactive capability' }); return;
      }
      const upstream = await fetcher(url, { method: req.method, redirect: 'error', headers, body: body ? new Uint8Array(body) : undefined, signal: abort.signal });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        let size = 0;
        try {
          while (!abort.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 100_000_000) throw new Error('Upstream response too large');
            if (!res.write(chunk.value)) await once(res, 'drain', { signal: abort.signal });
          }
        } finally { await reader.cancel().catch(() => {}); }
      }
      res.end();
    } catch {
      if (!res.headersSent) reply(res, 502, { error: 'Scoped gateway request failed' });
      else res.destroy();
    } finally { clearTimeout(deadline); }
  }
  function issue(table: 'run_capabilities' | 'publication_capabilities', runId: string, ttlMs: number): GatewayCapability {
      if (!/^[a-z\d_-]{1,128}$/i.test(runId) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) throw new Error('Invalid capability');
      const capability = { token: randomBytes(32).toString('hex'), runId, expiresAt: now() + ttlMs };
      sql.prepare(`INSERT INTO ${table} (hash, runId, expiresAt) VALUES (?, ?, ?)`).run(hash(capability.token), runId, capability.expiresAt);
      return capability;
  }
  return {
    issue: (runId: string, ttlMs: number) => issue('run_capabilities', runId, ttlMs),
    issuePublication: (runId: string, ttlMs: number) => issue('publication_capabilities', runId, ttlMs),
    revoke(token: string) { for (const table of ['run_capabilities', 'publication_capabilities']) sql.prepare(`DELETE FROM ${table} WHERE hash = ?`).run(hash(token)); },
    revokeRun(runId: string) { for (const table of ['run_capabilities', 'publication_capabilities']) sql.prepare(`DELETE FROM ${table} WHERE runId = ?`).run(runId); },
    server() { return createServer((req, res) => { void handler(req, res); }); },
    close() { connection.close(); },
  };
}
