const downloads = new Map();
const leases = new Set();
const limit = 64 * 1024;

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const request = event.data;
  const port = event.ports?.[0];
  let source;
  try { source = new URL(event.source?.url ?? ''); } catch { return; }
  if (!port || source.origin !== self.location.origin || typeof event.source?.id !== 'string' || request?.version !== 1 || request.type !== 'register'
    || typeof request.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.token) || typeof request.filename !== 'string' || !/^[a-z\d][a-z\d_. -]{0,199}$/i.test(request.filename)
    || /[. ]$/.test(request.filename) || request.contentType !== 'text/plain; charset=utf-8' || [...leases].some(value => value.token === request.token)
    || leases.size >= 32 || [...leases].filter(value => value.client === event.source.id).length >= 4) {
    port?.postMessage({ type: 'error' }); port?.close(); return;
  }
  const session = { port, token: request.token, filename: request.filename, client: event.source.id, timer: null,
    controller: null, pending: null, sequence: 0, done: false, finish: null };
  const close = () => {
    if (session.done) return; session.done = true; clearTimeout(session.timer); downloads.delete(session.token); leases.delete(session);
    session.pending?.(); session.pending = null; session.finish?.(); port.close();
  };
  const fail = message => {
    if (session.done) return; port.postMessage({ type: 'error' }); session.controller?.error(new Error(message)); close();
  };
  const renew = () => { clearTimeout(session.timer); session.timer = setTimeout(() => fail('Download host is unavailable.'), 15000); };
  session.fail = fail; session.close = close;
  port.onmessageerror = () => fail('Invalid download transport.');
  port.onmessage = message => {
    if (session.done) return;
    const value = message.data;
    if (!value || typeof value !== 'object') { fail('Invalid download message.'); return; }
    if (value.type === 'abort') { session.controller?.error(new Error('Download cancelled.')); close(); return; }
    if (value.type === 'heartbeat') { if (session.controller) renew(); port.postMessage({ type: 'heartbeat' }); return; }
    if (!session.controller || !session.pending || value.sequence !== session.sequence) { fail('Unexpected download response.'); return; }
    renew();
    if (value.type === 'done') { session.controller.close(); port.postMessage({ type: 'complete', sequence: session.sequence }); close(); return; }
    if (value.type !== 'chunk' || !(value.chunk instanceof ArrayBuffer) || value.chunk.byteLength < 1 || value.chunk.byteLength > limit) { fail('Invalid download chunk.'); return; }
    session.controller.enqueue(new Uint8Array(value.chunk)); session.pending(); session.pending = null;
  };
  port.start(); leases.add(session); downloads.set(session.token, session);
  session.timer = setTimeout(() => fail('Download token expired.'), 10000); port.postMessage({ type: 'ready' });
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/plugin-download/file/')) return;
  const token = url.pathname.slice('/plugin-download/file/'.length);
  const session = event.request.method === 'GET' && !url.search && /^[a-f0-9]{64}$/.test(token) ? downloads.get(token) : null;
  if (!session) { event.respondWith(new Response('Download unavailable.', { status: 410, headers: { 'Cache-Control': 'no-store' } })); return; }
  downloads.delete(token);
  event.waitUntil(new Promise(resolve => { session.finish = resolve; }));
  const stream = new ReadableStream({
    start(controller) { session.controller = controller; },
    pull() {
      if (session.done) return;
      if (session.pending) { session.fail('Overlapping download reads.'); return; }
      return new Promise(resolve => { session.pending = resolve; session.port.postMessage({ type: 'pull', sequence: ++session.sequence }); });
    },
    cancel() { session.port.postMessage({ type: 'cancelled' }); session.close(); },
  }, { highWaterMark: 0 });
  event.respondWith(new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${session.filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }));
});
