import { describe, expect, it } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import { allowMutationRequest } from './request-origin';

const headers: IncomingHttpHeaders = { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'content-type': 'application/json' };

describe('local mutation request protection', () => {
  it.each(['/api/agents/launch', '/api/agents/run/stop', '/api/agents/run/retry', '/api/agents/run/resume',
    '/api/repos/owner%2Frepo/auto-claim', '/api/task-sources/source/launch', '/api/todos', '/api/config',
    '/api/clarification-command', '/api/recovery/actions', '/api/run-commands', '/api/future-service'])('protects every mutation surface, including %s', path => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(allowMutationRequest({ method, headers }, path)).toBe(true);
      expect(allowMutationRequest({ method, headers: { ...headers, origin: 'http://127.0.0.1:9999', 'content-type': 'text/plain' } }, path)).toBe(false);
      expect(allowMutationRequest({ method, headers: { ...headers, origin: 'https://example.com' } }, path)).toBe(false);
      expect(allowMutationRequest({ method, headers: { ...headers, origin: undefined, 'content-type': undefined } }, path)).toBe(false);
    }
  });

  it.each(['null', 'http://localhost:8787', 'http://127.0.0.1:8787.attacker.example', 'https://127.0.0.1:8787'])('rejects a foreign or opaque origin: %s', origin => {
    expect(allowMutationRequest({ method: 'POST', headers: { ...headers, origin } }, '/api/todos')).toBe(false);
  });

  it.each(['evil.example:8787', '127.0.0.1:8787/extra', 'user@127.0.0.1:8787', 'localhost:8787?query', 'localhost:8787#fragment', 'bad:port'])('rejects a forged or malformed Host: %s', host => {
    expect(allowMutationRequest({ method: 'POST', headers: { ...headers, host, origin: `http://${host}` } }, '/api/todos')).toBe(false);
  });

  it('permits JSON CLI clients and preserves the development proxy browser authority', () => {
    expect(allowMutationRequest({ method: 'POST', headers: { ...headers, origin: undefined } }, '/api/todos')).toBe(true);
    for (const host of ['localhost:5173', '127.0.0.1:5173', '[::1]:5173']) {
      expect(allowMutationRequest({ method: 'POST', headers: { ...headers, host, origin: `http://${host}`, 'content-type': 'Application/JSON; charset=utf-8' } }, '/api/todos')).toBe(true);
    }
    expect(allowMutationRequest({ method: 'POST', headers: { ...headers, origin: undefined, 'sec-fetch-site': 'cross-site' } }, '/api/todos')).toBe(false);
  });

  it('exempts only exact signed webhook intake and read-only/preflight methods', () => {
    expect(allowMutationRequest({ method: 'POST', headers: {} }, '/api/webhooks/github')).toBe(true);
    for (const path of ['/api/webhooks/github/credential', '/api/webhooks/github/', '/api/webhooks/github/other']) {
      expect(allowMutationRequest({ method: 'POST', headers: {} }, path)).toBe(false);
    }
    expect(allowMutationRequest({ method: 'PUT', headers: {} }, '/api/webhooks/github')).toBe(false);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(allowMutationRequest({ method, headers: {} }, '/api/todos')).toBe(true);
  });
});
