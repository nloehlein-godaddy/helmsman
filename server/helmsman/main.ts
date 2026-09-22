import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { applicationRoot } from './runtime-paths';
import { createSafeStartServer, safeStartEnabled } from './safe-start';
import { DEFAULT_SERVER_PORT } from './ports';

if (existsSync('.env')) process.loadEnvFile('.env');

if (safeStartEnabled(process.argv.slice(2), process.env)) {
  const server = createSafeStartServer({
    dbPath: process.env.HELMSMAN_DB ?? join(process.cwd(), '.helmsman.sqlite'),
    pluginsDir: process.env.HELMSMAN_PLUGINS_DIR,
    dist: join(applicationRoot(), 'dist'),
    env: process.env,
  });
  server.listen(Number(process.env.HELMSMAN_PORT ?? DEFAULT_SERVER_PORT), '127.0.0.1', () => {
    const address = server.address();
    process.stdout.write(`Helmsman on :${address && typeof address === 'object' ? address.port : '?'} (safe start)\n`);
  });
} else await import('./application');
