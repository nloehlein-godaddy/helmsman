import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile); const root = fileURLToPath(new URL('../../../', import.meta.url));
let temporary: string; let server: Server; let origin: string;
test.beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'execution-settings-browser-'));
  await cp(join(root, 'src/plugins/execution-settings'), temporary, { recursive: true });
  await cp(join(root, 'release/sdk'), join(temporary, 'node_modules/@helmsman/plugin-sdk'), { recursive: true });
  await cp(join(root, 'node_modules/typescript'), join(temporary, 'node_modules/typescript'), { recursive: true });
  await execute(process.execPath, ['build.mjs'], { cwd: temporary });
  server = createServer((req, res) => {
    const match = /^\/(panel|styles)\.js$/.exec(req.url ?? '');
    if (match) void readFile(join(temporary, 'dist', `${match[1]}.js`)).then(bytes => { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bytes); });
    else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--text:#e6edf3;--panel:#162738;--line:#44566c;--bad:#ff9b9b}body{margin:16px;color:var(--text);background:#101d2b;font:16px system-ui}button{padding:.5rem}</style><main></main>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture unavailable'); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (temporary) await rm(temporary, { recursive: true, force: true }); });
test('shows concurrency costs, requires opt-in and keeps scope on desktop and mobile', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
  await page.evaluate(async () => {
    const url = '/panel.js'; const panel = (await import(url)).default;
    const lifetime = new AbortController(); const activity = { epoch: 1, active: true, repo: 'org/selected', signal: new AbortController().signal };
    const state = { repo: 'org/selected', headerRepo: 'org/header', instanceId: 'settings', pirateMode: false, themeId: 'dark', visible: true, pane: null, savedState: null, activity };
    const snapshot = { version: 1, repo: 'org/selected', policy: { version: 1, repo: 'org/selected', revision: 0, maxConcurrentRuns: 1 }, limits: { globalMaxConcurrentRuns: 4, perRunCostCapUsd: 3, activeRuns: 1 }, readiness: { currentVersion: 2, targetVersion: 2, ready: true, blockers: [] } };
    await panel.mount(document.querySelector('main'), { contributionId: 'helmsman.execution-settings/panel', state, activity, signal: lifetime.signal, onDispose() {}, navigate() { throw new Error('Scope navigation changed'); }, saveState: async () => {},
      services: { version: 1, executionPolicy: { version: 1, read: async () => ({ status: 'available', value: snapshot }), set: async (input: { repo: string; expectedRevision: number; maxConcurrentRuns: number }) => {
        if (input.repo !== 'org/selected' || input.expectedRevision !== 0) throw new Error('Wrong scope or revision');
        return { status: 'available', value: { ...snapshot.policy, revision: 1, maxConcurrentRuns: input.maxConcurrentRuns } };
      } } } });
  });
  await expect(page.getByText('Per-run cost cap: $3.00.')).toBeVisible();
  await page.getByLabel('Maximum simultaneous runs here').fill('3'); await page.getByLabel('Maximum simultaneous runs here').blur();
  await expect(page.getByRole('button', { name: 'Save execution settings' })).toBeDisabled();
  await page.getByLabel('Enable parallel runs with these limits').check();
  await page.screenshot({ path: info.outputPath('execution-settings-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('execution-settings-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save execution settings' }).click(); await expect(page.getByText('Execution settings saved.')).toBeVisible();
  expect(errors).toEqual([]);
});
