import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { buildMeta } from './build-meta';

const meta = buildMeta();

export default defineConfig({
  resolve: {
    alias: {
      '@helmsman/plugin-sdk/node': fileURLToPath(new URL('./src/plugins/execution-host-node.ts', import.meta.url)),
      '@helmsman/plugin-sdk': fileURLToPath(new URL('./src/plugins/sdk.ts', import.meta.url)),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(meta.version),
    __BUILD_DATE__: JSON.stringify(meta.date),
  },
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, '.agent-workspaces/**', '.helmsman-runs/**'],
  },
});
