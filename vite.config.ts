import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { buildMeta } from './build-meta';
import { themeBootstrapPlugin } from './build-theme';
import { DEFAULT_SERVER_PORT, DEFAULT_UI_PORT } from './server/helmsman/ports';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = Number(env.HELMSMAN_PORT ?? DEFAULT_SERVER_PORT);
  const uiPort = Number(env.HELMSMAN_UI_PORT ?? DEFAULT_UI_PORT);
  const meta = buildMeta();
  return {
    plugins: [themeBootstrapPlugin()],
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
    server: {
      port: uiPort,
      strictPort: true,
      proxy: {
        '/plugin-assets': { target: `http://localhost:${port}`, changeOrigin: true },
        '/api': { target: `http://localhost:${port}`, changeOrigin: false },
      },
    },
    preview: { port: uiPort, strictPort: true },
  };
});
