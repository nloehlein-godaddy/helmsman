import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { communicationConnectionUrl, parseCommunicationConnectionStatusV1, type CommunicationConnectionProviderV1 } from '../../src/plugins/communication-connection';
import { allowMutationRequest } from './request-origin';

interface ConnectionCapture {
  readonly providerId: string;
  readonly identity: string;
  readonly provider: CommunicationConnectionProviderV1;
  assertCurrent(): void;
}
const PREFIX = '/api/communication-connection';
const COOKIE = 'helmsman_communication_oauth';
const TTL = 10 * 60_000;
const stateKey = (value: string) => createHash('sha256').update(value).digest('hex');
const cookie = (state = '') => `${COOKIE}=${state}; Path=${PREFIX}; HttpOnly; Secure; SameSite=Lax; Max-Age=${state ? 600 : 0}`;

export function createCommunicationConnectionHandler(options: {
  capture(): ConnectionCapture | null;
  authorize(caller: string): void;
  now?(): number;
}) {
  const pending = new Map<string, { capture: ConnectionCapture; expiresAt: number; generation: number }>();
  const generations = new Map<string, number>();
  const now = options.now ?? Date.now;
  async function snapshot(capture: ConnectionCapture | null, signal: AbortSignal) {
    if (!capture) return { version: 1, providerId: null, revision: null, status: 'unsupported', message: 'The selected communication provider uses externally configured credentials.', accountLabel: null, redirectUri: null };
    capture.assertCurrent();
    const status = parseCommunicationConnectionStatusV1(await capture.provider.status(signal));
    signal.throwIfAborted(); capture.assertCurrent();
    return { version: 1, providerId: capture.providerId, revision: stateKey(capture.identity), ...status };
  }
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const signal = AbortSignal.timeout(45_000);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(JSON.stringify(body));
    };
    for (const [key, value] of pending) if (value.expiresAt <= now()) pending.delete(key);
    if (url.pathname === `${PREFIX}/callback` && req.method === 'GET') {
      let result = 'error';
      try {
        const state = url.searchParams.get('state') ?? '';
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(state) || url.searchParams.getAll('state').length !== 1) throw new Error('Invalid state');
        const key = stateKey(state);
        const retained = pending.get(key);
        if (!retained || retained.expiresAt <= now()) throw new Error('Expired state');
        const cookieState = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
        if (stateKey(cookieState) !== key) throw new Error('Invalid browser state');
        pending.delete(key);
        retained.capture.assertCurrent();
        if (options.capture()?.identity !== retained.capture.identity) throw new Error('Provider changed');
        await retained.capture.provider.complete(url.searchParams, cookieState, signal, () => {
          signal.throwIfAborted(); retained.capture.assertCurrent();
          if (generations.get(retained.capture.providerId) !== retained.generation) throw new Error('Authorization changed');
        });
        retained.capture.assertCurrent();
        result = 'connected';
      } catch {}
      res.writeHead(303, { Location: `/communication?connection=${result}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(); return true;
    }
    try {
      const caller = req.headers['x-helmsman-contribution'];
      if (typeof caller !== 'string') { json(403, { reason: 'forbidden' }); return true; }
      try { options.authorize(caller); } catch { json(403, { reason: 'forbidden' }); return true; }
      if (url.search) { json(400, { reason: 'invalid-response' }); return true; }
      if (url.pathname !== PREFIX && !['start', 'disconnect', 'check'].some(action => url.pathname === `${PREFIX}/${action}`)) {
        json(404, { reason: 'not-found' }); return true;
      }
      if ((url.pathname === PREFIX && req.method !== 'GET') || (url.pathname !== PREFIX && req.method !== 'POST')) {
        json(405, { reason: 'invalid-response' }); return true;
      }
      const capture = options.capture();
      if (req.method === 'GET') { json(200, await snapshot(capture, signal)); return true; }
      if (!capture) { json(409, { reason: 'service-unavailable' }); return true; }
      capture.assertCurrent();
      const before = await snapshot(capture, signal);
      const callbackOrigin = before.redirectUri ? new URL(before.redirectUri).origin : null;
      const origin = req.headers.origin;
      const trustedProxy = callbackOrigin !== null && origin === callbackOrigin;
      if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        || req.headers['sec-fetch-site'] === 'cross-site' || (!trustedProxy && !allowMutationRequest(req, url.pathname))) {
        json(403, { reason: 'forbidden' }); return true;
      }
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 1024) { json(413, { reason: 'invalid-response' }); return true; }
      }
      let input: unknown;
      try { input = JSON.parse(body); } catch { json(400, { reason: 'invalid-response' }); return true; }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
        || !('expectedRevision' in input) || typeof input.expectedRevision !== 'string') { json(400, { reason: 'invalid-response' }); return true; }
      capture.assertCurrent(); signal.throwIfAborted();
      if (input.expectedRevision !== stateKey(capture.identity)) { json(409, { reason: 'conflict' }); return true; }
      if (url.pathname === `${PREFIX}/start`) {
        if (!callbackOrigin || origin !== callbackOrigin) {
          json(409, { reason: 'conflict' }); return true;
        }
        const generation = (generations.get(capture.providerId) ?? 0) + 1;
        generations.set(capture.providerId, generation);
        const started = await capture.provider.begin(signal);
        signal.throwIfAborted(); capture.assertCurrent();
        if (generations.get(capture.providerId) !== generation) throw new Error('Authorization changed');
        if (typeof started?.state !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(started.state)) throw new Error('Invalid state');
        const authorizationUrl = communicationConnectionUrl(started.authorizationUrl);
        for (const [key, value] of pending) if (value.capture.providerId === capture.providerId) pending.delete(key);
        if (pending.size >= 64) throw new Error('Too many pending authorizations');
        pending.set(stateKey(started.state), { capture, expiresAt: now() + TTL, generation });
        json(200, { version: 1, authorizationUrl }, { 'Set-Cookie': cookie(started.state) });
      } else if (url.pathname === `${PREFIX}/disconnect`) {
        generations.set(capture.providerId, (generations.get(capture.providerId) ?? 0) + 1);
        for (const [key, value] of pending) if (value.capture.providerId === capture.providerId) pending.delete(key);
        await capture.provider.disconnect(signal);
        json(200, await snapshot(capture, signal));
      } else {
        await capture.provider.check(signal);
        json(200, await snapshot(capture, signal));
      }
    } catch { json(503, { reason: 'service-unavailable' }); }
    return true;
  };
}
