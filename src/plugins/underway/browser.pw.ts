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
  temporary = await mkdtemp(join(tmpdir(), 'underway-browser-'));
  await cp(join(root, 'src/plugins/underway'), temporary, { recursive: true });
  await cp(join(root, 'release/sdk'), join(temporary, 'node_modules/@helmsman/plugin-sdk'), { recursive: true });
  await cp(join(root, 'node_modules/typescript'), join(temporary, 'node_modules/typescript'), { recursive: true });
  await execute(process.execPath, ['build.mjs'], { cwd: temporary });
  server = createServer((req, res) => {
    const match = /^\/(panel|reviews)\.js$/.exec(req.url ?? '');
    if (match) void readFile(join(temporary, 'dist', `${match[1]}.js`)).then(bytes => { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bytes); });
    else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--text:#e6edf3;--text-dim:#abb9ca;--accent:#82c8ff;--face-hi:#24374c;--line:#44566c;--line-strong:#64768c;--bad:#ff9b9b}body{margin:16px;background:#101d2b;font:16px system-ui}main{max-width:1000px}</style><main></main>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture unavailable'); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (temporary) await rm(temporary, { recursive: true, force: true }); });
for (const uncertain of [false, true]) test(`canonical contextual review ${uncertain ? 'recovers original receipt' : 'sends once'} on desktop and mobile`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
  await page.evaluate(async uncertain => {
    const url = '/panel.js'; const panel = (await import(url)).default; const repo = 'org/selected';
    const activity = { epoch: 1, active: true, repo, signal: new AbortController().signal };
    const state = { repo, headerRepo: 'org/header', instanceId: 'underway', pirateMode: false, themeId: 'dark', visible: true, pane: null, savedState: null, activity };
    const source = { version: 1, repo, sourceId: '11111111-1111-4111-8111-111111111111', instanceId: 'source', instanceRevision: 1, label: 'Assigned tasks', availability: 'available', readViews: ['underway'] };
    const task = { version: 1, ref: { sourceId: source.sourceId, externalId: '1234' }, repo, revision: 'r1', displayKey: 'TASK-42', title: 'Contextual review request', state: 'in-progress', priority: 2, url: null, requirements: { description: '', acceptanceCriteria: [], links: [] } };
    const destination = { providerId: 'helmsman.slack/slack', artifactHash: 'a'.repeat(64), workspace: 'team', channel: 'reviews', mention: 'reviewers', connectionId: 'connection' };
    const input = { version: 1, repo, number: 42, expectedDestination: destination };
    const receipt = { version: 1, requestId: '22222222-2222-4222-8222-222222222222', input, status: 'succeeded', result: { repo, number: 42, destination, permalink: 'https://team.slack.com/archives/C123/p123456789' }, reason: null };
    let entries: Array<{ command: typeof input & { requestId: string }; receipt: typeof receipt | null }> = [];
    let sends = 0; let checks = 0;
    Object.assign(window, { reviewFixture: { sends: () => sends, checks: () => checks } });
    await panel.mount(document.querySelector('main'), { contributionId: 'helmsman.underway/panel', state, activity, signal: new AbortController().signal, onDispose() {}, navigate() { throw new Error('Header scope changed'); }, saveState: async () => {},
      services: { version: 1,
        tasks: { version: 1, discover: async () => ({ status: 'available', value: { version: 1, repo, galleons: [{ repo, sources: { status: 'available', value: [source] } }] } }), underway: async () => ({ status: 'available', value: { selection: source, items: [task], nextCursor: null } }) },
        taskContext: { version: 1, resolve: async () => ({ status: 'available', value: { version: 1, task: { selection: source, ref: task.ref, url: null }, claim: { id: 'claim', revision: 1, state: 'claimed' }, run: { repo, runId: 'run-one', expectedAttempt: 1 }, pullRequest: { repo, number: 42, sourceRunId: 'run-one' } } }) },
        runCommands: { version: 1, pending: async () => [] },
        pullRequests: { version: 1, list: async (query: { repo: string }) => { if (query.repo !== repo) throw new Error('Wrong PR scope'); return { status: 'available', value: { version: 1, repo, kind: 'authored-recent', quality: 'complete', items: [{ repo, number: 42, draft: false, status: 'open' }] } }; } },
        communication: { version: 1, settings: async () => ({ status: 'available', value: { version: 1, revision: 'r1', values: { enabled: true }, destination } }) },
        communicationCommands: { version: 1, pending: async () => entries,
          submit: async (submitted: typeof input) => { if (JSON.stringify(submitted) !== JSON.stringify(input)) throw new Error('Wrong canonical target or destination'); sends++; entries = [{ command: { ...input, requestId: receipt.requestId }, receipt: uncertain ? null : receipt }]; return uncertain ? { status: 'unavailable', reason: 'connection-failed' } : { status: 'available', value: receipt }; },
          receipt: async (query: { repo: string; requestId: string }) => { if (query.repo !== repo || query.requestId !== receipt.requestId) throw new Error('Wrong receipt'); checks++; entries = [{ command: { ...input, requestId: receipt.requestId }, receipt }]; return { status: 'available', value: receipt }; },
        },
      } });
  }, uncertain);
  const send = page.getByRole('button', { name: 'Request review in Slack', exact: true });
  await expect(send).toBeEnabled(); expect(await page.evaluate(() => (window as unknown as { reviewFixture: { sends(): number } }).reviewFixture.sends())).toBe(0);
  const link = page.getByRole('link', { name: 'Open pull request' }); expect(await link.getAttribute('href')).toContain('repo=org%2Fheader'); expect(await link.getAttribute('href')).toContain('prRepo=org%2Fselected');
  await page.screenshot({ path: info.outputPath('underway-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('underway-mobile.png'), fullPage: true }); await send.click();
  if (uncertain) { await expect(page.getByRole('button', { name: 'Retry original review request' })).toBeVisible(); await expect(send).toBeDisabled(); await page.getByRole('button', { name: 'Check review receipt' }).click(); }
  await expect(page.getByText('Review requested in #reviews.')).toBeVisible(); await expect(send).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { reviewFixture: { sends(): number } }).reviewFixture.sends())).toBe(1); expect(errors).toEqual([]);
});
