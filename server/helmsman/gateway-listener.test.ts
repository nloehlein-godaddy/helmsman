import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { listenScopedGateway } from './gateway-listener';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const runsDir = await mkdtemp(join(tmpdir(), 'helmsman-gateway-')); roots.push(runsDir);
  const server = () => { const value = createServer(); servers.push(value); return value; };
  return { runsDir, server };
}
it('chooses an isolated local port and preserves surviving coordinator endpoints after restart', async () => {
  const f = await fixture(); const first = f.server();
  const port = await listenScopedGateway(first, { runsDir: f.runsDir, docker: false });
  expect(first.address()).toMatchObject({ address: '127.0.0.1', port });
  await new Promise<void>(resolve => first.close(() => resolve()));
  expect(await listenScopedGateway(f.server(), { runsDir: f.runsDir, docker: false })).toBe(port);
  await expect(listenScopedGateway(f.server(), { runsDir: f.runsDir, docker: false, configuredPort: port === 65535 ? 65534 : port + 1 })).rejects.toThrow('differs');
});
it('fails closed on malformed retained endpoints and concurrent application ownership', async () => {
  const f = await fixture();
  await listenScopedGateway(f.server(), { runsDir: f.runsDir, docker: false });
  await expect(listenScopedGateway(f.server(), { runsDir: f.runsDir, docker: false })).rejects.toThrow('EADDRINUSE');
  await writeFile(join(f.runsDir, '.gateway-port.json'), '{"version":1,"port":null}');
  await expect(listenScopedGateway(f.server(), { runsDir: f.runsDir, docker: false })).rejects.toThrow('Invalid retained');
});
