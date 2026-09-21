import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PluginPanelInstance, PluginPanelState, RunInspectLogQueryV1, RunReadListQueryV1 } from '@helmsman/plugin-sdk';

const execute = promisify(execFile); const root = fileURLToPath(new URL('../../../', import.meta.url));
let temporary: string; let server: Server; let origin: string;
test.beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'helmsman-authored-runs-'));
  await cp(join(root, 'tests/distribution/deny-source.mjs'), join(temporary, 'deny-source.mjs'));
  for (const name of ['run-viewer', 'run-history']) {
    const author = join(temporary, name); await cp(join(root, 'src/plugins', name), author, { recursive: true });
    await cp(process.env.HELMSMAN_PRESENTATION_SDK ?? join(root, 'release/sdk'), join(author, 'node_modules/@helmsman/plugin-sdk'), { recursive: true });
    await cp(join(root, 'node_modules/typescript'), join(author, 'node_modules/typescript'), { recursive: true });
    await execute(process.execPath, ['build.mjs'], { cwd: author, env: { ...process.env, HELMSMAN_TEST_SOURCE: root,
      NODE_OPTIONS: `--import=${pathToFileURL(join(temporary, 'deny-source.mjs')).href}` } });
  }
  server = createServer((request, response) => {
    const match = /^\/(run-viewer|run-history)\/(panel|state|styles)\.js$/.exec(request.url ?? '');
    if (match) {
      void readFile(join(temporary, match[1]!, 'dist', `${match[2]}.js`)).then(code => { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(code); }).catch(() => { response.writeHead(404); response.end(); });
    } else { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--text:#e6edf3;--text-dim:#9daebf;--accent:#82c9ff;--bad:#ff9b9b;--line:#344658;--line-strong:#536c85;--face:#101d2b;--face-hi:#243547;--sans:system-ui}body{background:#152331;margin:20px;color:var(--text)}main{display:grid;gap:24px;max-width:1250px;margin:auto}section{min-width:0}h1{font:24px system-ui}</style><h1>Run presentation</h1><main><div id="history"></div><div id="viewer"></div><div id="destination"></div></main>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser fixture unavailable'); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); if (temporary) await rm(temporary, { recursive: true, force: true }); });

test('copied SDK-only packages select, retain a paused window and render bounded desktop/mobile UI', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
  await page.evaluate(async () => {
    const viewerUrl = '/run-viewer/panel.js'; const historyUrl = '/run-history/panel.js';
    const viewerModule = (await import(viewerUrl)).default; const historyModule = (await import(historyUrl)).default;
    const lifetime = new AbortController(); let activity = new AbortController();
    const when = '2026-09-20T00:00:00Z'; const available = <T>(value: T) => ({ status: 'available', value });
    const target = { repo: 'org/a', runId: 'voyage-long-identity', expectedAttempt: 2 };
    const summary = { version: 1, id: target.runId, repo: target.repo, displayKey: 'WEB-2048: preserve streamed output and scope', status: 'running', attempt: 2, startedAt: when, endedAt: null, prNumber: 48, costUsd: null, review: null, sourceSettlement: { state: 'pending' } };
    const events = Array.from({ length: 50 }, (_, index) => ({ sequence: index + 51, at: when, kind: index % 3 ? 'log' : 'stage', text: `${index + 51}: Work item progress — Unicode 😀 preserved. ${'Bounded event text. '.repeat(8)}`, truncated: index === 0 }));
    const inspect = { version: 1, resolve: async () => available({ version: 1, target, observedAt: when }),
      history: async (query: RunReadListQueryV1) => available({ version: 1, repo: query.repo, items: [summary], nextCursor: null, total: 101, totalQuality: 'exact', observedAt: when, coverage: 'insertion-bounded-current-state' }),
      log: async (query: RunInspectLogQueryV1) => available({ version: 1, target, provenance: 'run-wide', observedAt: when, workerStatus: 'running', events: query.cursor === 'older' ? [{ ...events[0], sequence: 1, text: 'Earlier run-wide event' }] : query.direction === 'forward' ? [] : events,
        throughSequence: 100, hasEarlier: query.cursor !== 'older', hasLater: false, nextCursor: query.direction === 'forward' ? 'follow' : query.cursor === 'older' ? null : 'older', followCursor: query.cursor === null ? 'follow' : null }), exportLog: async () => { throw new Error('Unused export'); } };
    let state: PluginPanelState = { repo: 'org/a', visible: true, themeId: 'default', pirateMode: false, pane: null, instanceId: 'viewer', savedState: null, presentation: null,
      activity: { epoch: 1, repo: 'org/a', active: true, signal: activity.signal } };
    const services = { version: 1, runInspect: inspect, runs: { version: 1, load: async () => available({ version: 1, repo: target.repo, runId: target.runId, run: summary }) },
      runCommands: { version: 1, pending: async () => [], submit: async () => { throw new Error('Unused command'); } }, downloads: { version: 1, save: async () => ({ status: 'unavailable', reason: 'unsupported' }) } };
    let viewer: PluginPanelInstance;
    const context = { state, signal: lifetime.signal, activity: state.activity, services, saveState: async () => {}, onDispose: () => {}, navigate: () => {},
      selectPresentation: (presentation: PluginPanelState['presentation']) => { state = { ...state, presentation }; void viewer.update(state); } };
    viewer = await viewerModule.mount(document.querySelector('#viewer'), context); await historyModule.mount(document.querySelector('#history'), { ...context, state: { ...state, instanceId: 'history' } });
    (window as typeof window & { presentationProbe: { suspend(): void; resume(): void } }).presentationProbe = {
      suspend() { activity.abort(); state = { ...state, visible: false, activity: { ...state.activity, active: false } }; void viewer.update(state); },
      resume() { activity = new AbortController(); state = { ...state, visible: true, activity: { epoch: state.activity.epoch + 1, repo: 'org/a', active: true, signal: activity.signal } }; void viewer.update(state); },
    };
  });
  await page.getByRole('button', { name: 'WEB-2048: preserve streamed output and scope', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeEnabled();
  await expect(page.locator('#history')).toContainText('101 matching runs observed'); await expect(page.locator('#viewer')).toContainText('4,000 characters per event');
  await page.getByRole('button', { name: 'Earlier logs', exact: true }).click(); await expect(page.locator('#viewer pre')).toContainText('Earlier run-wide event');
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeEnabled();
  await page.evaluate(() => { const probe = (window as typeof window & { presentationProbe: { suspend(): void; resume(): void } }).presentationProbe; probe.suspend(); probe.resume(); });
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeEnabled(); await expect(page.locator('#viewer pre')).toContainText('Earlier run-wide event');
  await expect(page.getByRole('button', { name: 'Follow latest', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`run-presentation-${testInfo.project.name}.png`), fullPage: true }); expect(errors).toEqual([]);
});
