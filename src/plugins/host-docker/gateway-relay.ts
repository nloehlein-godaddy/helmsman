export const gatewayRelaySource = String.raw`import { createServer } from 'node:http';

const target = new URL(process.argv[1]);
const server = createServer(async (request, response) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  try {
    const url = new URL(request.url ?? '/', target);
    const upstream = await fetch(url, {
      method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value]])),
      body: ['GET', 'HEAD'].includes(request.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      redirect: 'manual',
    });
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    response.writeHead(502).end();
  }
});
server.listen(Number(process.argv[2]), '0.0.0.0');
`;
