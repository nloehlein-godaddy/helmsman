import type { IncomingMessage } from 'node:http';

export function allowMutationRequest(req: Pick<IncomingMessage, 'method' | 'headers'>, pathname: string): boolean {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  if (req.method === 'POST' && pathname === '/api/webhooks/github') return true;
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
    || req.headers['sec-fetch-site'] === 'cross-site' || typeof req.headers.host !== 'string') return false;
  try {
    const destination = new URL(`http://${req.headers.host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname)
      || destination.username || destination.password || destination.pathname !== '/' || destination.search || destination.hash) return false;
    return req.headers.origin === undefined || req.headers.origin === destination.origin;
  } catch { return false; }
}
