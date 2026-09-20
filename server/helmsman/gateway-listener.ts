import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { link, lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function listenScopedGateway(server: Server, input: { runsDir: string; configuredPort?: number; docker: boolean }): Promise<number> {
  const path = join(input.runsDir, '.gateway-port.json');
  let saved: number | undefined;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Invalid retained gateway endpoint');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('port' in value)
      || !Number.isSafeInteger(value.port) || Number(value.port) < 1024 || Number(value.port) > 65535) throw new Error('Invalid retained gateway endpoint');
    saved = Number(value.port);
  } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
  const configured = input.configuredPort;
  if (configured !== undefined && (!Number.isSafeInteger(configured) || configured < 0 || configured > 65535
    || configured > 0 && configured < 1024 || input.docker && configured === 0)) throw new Error('Invalid scoped gateway port');
  if (saved !== undefined && configured && configured !== saved) throw new Error('Configured gateway port differs from the retained coordinator endpoint');
  const requested = saved ?? configured ?? (input.docker ? 8790 : 0);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(requested, input.docker ? '0.0.0.0' : '127.0.0.1', () => { server.off('error', onError); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Scoped gateway address is unavailable');
  if (saved === undefined) {
    const temporary = `${path}.${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, port: address.port }), { flag: 'wx', mode: 0o600 });
      await link(temporary, path);
    } catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
    finally { await unlink(temporary).catch(() => {}); }
  }
  return address.port;
}
