// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, get, request, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { gatewayRelaySource } from './gateway-relay';

const servers: Server[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind');
  return address.port;
}

async function relay(upstreamPort: number): Promise<number> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', gatewayRelaySource, `http://127.0.0.1:${upstreamPort}/`, '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return new Promise<number>((done, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Relay did not start: ${output}`)), 5000);
    child.stderr?.on('data', value => { output += String(value); });
    child.stdout?.on('data', value => {
      output += String(value);
      const line = output.split('\n').find(row => row.startsWith('{'));
      if (!line) return;
      clearTimeout(timer);
      const address = JSON.parse(line) as { port?: unknown };
      if (typeof address.port !== 'number') reject(new Error('Relay returned an invalid address'));
      else done(address.port);
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Relay exited ${code}: ${output}`)); });
  });
}

function response(port: number, path: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((done, reject) => {
    const call = request({ host: '127.0.0.1', port, path, method: 'GET' }, result => {
      let body = '';
      result.setEncoding('utf8');
      result.on('data', value => { body += value; });
      result.on('end', () => done({ status: result.statusCode, body }));
    });
    call.once('error', reject);
    call.end();
  });
}

describe('Docker gateway relay', () => {
  it('serves health locally and rejects absolute and protocol-relative request targets', async () => {
    let upstreamRequests = 0;
    let escapedRequests = 0;
    const upstreamPort = await listen(createServer((_request, result) => { upstreamRequests++; result.writeHead(401).end(); }));
    const escapedPort = await listen(createServer((_request, result) => { escapedRequests++; result.writeHead(204).end(); }));
    const relayPort = await relay(upstreamPort);

    await expect(response(relayPort, '/health')).resolves.toEqual({ status: 204, body: '' });
    await expect(response(relayPort, `http://127.0.0.1:${escapedPort}/escape`)).resolves.toEqual({ status: 403, body: '' });
    await expect(response(relayPort, `//127.0.0.1:${escapedPort}/escape`)).resolves.toEqual({ status: 403, body: '' });
    expect(upstreamRequests).toBe(0);
    expect(escapedRequests).toBe(0);
  });

  it('streams the fixed upstream response before that response ends', async () => {
    let release!: () => void;
    const released = new Promise<void>(done => { release = done; });
    const upstreamPort = await listen(createServer(async (incoming, result) => {
      expect(incoming.url).toBe('/openai/v1/responses');
      expect(incoming.headers.authorization).toBe('Bearer scoped');
      expect(incoming.headers['x-untrusted']).toBeUndefined();
      result.writeHead(200, { 'content-type': 'text/event-stream', 'x-untrusted': 'hidden' });
      result.write('first\n');
      await released;
      result.end('second\n');
    }));
    const relayPort = await relay(upstreamPort);

    const observed = await new Promise<{ first: string; endedBeforeRelease: boolean; complete: Promise<string> }>((done, reject) => {
      const call = get({ host: '127.0.0.1', port: relayPort, path: '/openai/v1/responses', headers: { authorization: 'Bearer scoped', 'x-untrusted': 'drop' } }, result => {
        expect(result.headers['content-type']).toBe('text/event-stream');
        expect(result.headers['cache-control']).toBe('no-store');
        expect(result.headers['x-untrusted']).toBeUndefined();
        result.setEncoding('utf8');
        let body = '';
        let ended = false;
        const complete = new Promise<string>(resolve => result.on('end', () => { ended = true; resolve(body); }));
        result.once('data', chunk => { body += chunk; done({ first: chunk, endedBeforeRelease: ended, complete }); });
        result.on('data', chunk => { if (body !== chunk) body += chunk; });
      });
      call.once('error', reject);
    });
    expect(observed.first).toBe('first\n');
    expect(observed.endedBeforeRelease).toBe(false);
    release();
    await expect(observed.complete).resolves.toBe('first\nsecond\n');
  });
});
