import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PanelOpaqueStateV1, PluginPanelInstance, PluginPanelState } from '@helmsman/plugin-sdk';
const execute = promisify(execFile); const root = fileURLToPath(new URL('../../../', import.meta.url));
let temporary: string; let server: Server; let origin: string;
test.beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'helmsman-authored-questions-'));
  await cp(join(root, 'tests/distribution/deny-source.mjs'), join(temporary, 'deny-source.mjs'));
  for (const name of ['clarifications', 'suggested-contacts']) {
    const author = join(temporary, name); await cp(join(root, 'src/plugins', name), author, { recursive: true });
    await cp(process.env.HELMSMAN_CLARIFICATION_SDK ?? join(root, 'release/sdk'), join(author, 'node_modules/@helmsman/plugin-sdk'), { recursive: true });
    await cp(join(root, 'node_modules/typescript'), join(author, 'node_modules/typescript'), { recursive: true });
    await execute(process.execPath, ['build.mjs'], { cwd: author, env: { ...process.env, HELMSMAN_TEST_SOURCE: root, NODE_OPTIONS: `--import=${pathToFileURL(join(temporary, 'deny-source.mjs')).href}` } });
  }
  server = createServer((request, response) => {
    const match = /^\/(clarifications|suggested-contacts)\/(panel|state|saved-state|styles)\.js$/.exec(request.url ?? '');
    if (match) void readFile(join(temporary, match[1]!, 'dist', `${match[2]}.js`)).then(code => { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(code); }).catch(() => { response.writeHead(404); response.end(); });
    else { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--text:#e6edf3;--text-dim:#9daebf;--accent:#82c9ff;--bad:#ff9b9b;--line:#344658;--line-strong:#536c85;--face:#101d2b;--face-hi:#243547;--sans:system-ui}body{background:#152331;margin:20px;color:var(--text);font:14px system-ui}a{color:var(--accent)}main{display:grid;gap:32px;max-width:1000px;margin:auto}section{min-width:0}</style><main><div id="questions"></div><div id="contacts"></div></main>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Browser fixture unavailable'); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); if (temporary) await rm(temporary, { recursive: true, force: true }); });

test('copied public-SDK panels preserve drafts, save receipts and render independent global contacts', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
  await page.evaluate(async () => {
    const qpath = '/clarifications/panel.js'; const cpath = '/suggested-contacts/panel.js'; const questionModule = (await import(qpath)).default; const contactModule = (await import(cpath)).default;
    const time = '2026-09-20T00:00:00Z'; const requestId = '00000000-0000-4000-8000-000000000001'; const contactRequestId = '00000000-0000-4000-8000-000000000002'; const channel = '00000000-0000-4000-8000-000000000003';
    const lifetime = new AbortController(); let activity = new AbortController();
    const base: PluginPanelState = { repo: 'org/a', themeId: 'dark', pirateMode: false, visible: true, pane: null, instanceId: 'questions', savedState: null, activity: { repo: 'org/a', epoch: 1, active: true, signal: activity.signal } };
    let qstate = base; let cstate = { ...base, instanceId: 'contacts' }; let qsaved: PanelOpaqueStateV1 | null = null; let csaved: PanelOpaqueStateV1 | null = null;
    let questionPanel: PluginPanelInstance; let contactPanel: PluginPanelInstance;
    let questionPending: unknown[] = []; let contactPending: unknown[] = [];
    const available = <T>(value: T) => ({ status: 'available', value });
    const question = { version: 1, id: 'question-1', repo: 'org/a', runId: 'run-1', revision: 1, prompt: 'Preserve the existing API while the replacement plugin is installed?', required: true, owner: 'local', contactId: null, state: 'pending', answer: null, createdAt: time, timeoutAt: null, answeredAt: null, provenance: { kind: 'attempt-channel', attempt: 2, channelId: channel }, currentAttempt: 2, blocksPublication: true, answerability: { available: true, reason: null } };
    const questionService = { version: 1, pending: async () => questionPending, submit: async (input: Record<string, unknown>) => { const receipt = { version: 1, requestId, input, status: 'succeeded', result: { questionId: input.questionId, revision: 2, answer: input.answer, answeredAt: time }, reason: null }; questionPending = [{ command: { ...input, requestId }, receipt }]; return available(receipt); }, receipt: async () => available(null), acknowledge: async () => { if (!JSON.stringify(qsaved).includes(requestId)) throw new Error('Result missing'); questionPending = []; } };
    const contactService = { version: 1, list: async () => available({ version: 1, scope: 'global', items: [{ id: 'legacy-owner', revision: 1, name: 'Review owner', address: '#team-review-room', enabled: true, createdAt: time }], nextCursor: null, observedAt: time }), pending: async () => contactPending,
      submit: async (input: Record<string, unknown>) => { const intent = { ...input, id: input.id ?? channel }; const receipt = { version: 1, scope: 'global', requestId: contactRequestId, input: intent, status: 'succeeded', result: { id: intent.id, revision: 1, name: input.name, address: input.address, enabled: input.enabled, createdAt: time }, reason: null }; contactPending = [{ command: { ...intent, requestId: contactRequestId }, receipt }]; return available(receipt); }, receipt: async () => available(null), acknowledge: async () => { if (!JSON.stringify(csaved).includes(contactRequestId)) throw new Error('Result missing'); contactPending = []; } };
    const common = { signal: lifetime.signal, activity: base.activity, onDispose() {}, navigate() {}, saveState: async () => { throw new Error('Unconditional save forbidden'); } };
    questionPanel = await questionModule.mount(document.querySelector('#questions'), { ...common, state: qstate, services: { version: 1, clarifications: { version: 1, list: async () => available({ version: 1, repo: 'org/a', items: [question, { ...question, id: 'unknown', prompt: 'Retained question with unknown provenance', provenance: { kind: 'legacy-unproven', attempt: null, channelId: null }, answerability: { available: false, reason: 'provenance-unknown' } }], nextCursor: null, total: 2, observedAt: time }) }, clarificationCommands: questionService },
      compareAndSetState: async (expected: PanelOpaqueStateV1 | null, next: PanelOpaqueStateV1 | null) => { if (JSON.stringify(expected) !== JSON.stringify(qsaved)) throw new Error('Conflict'); qsaved = structuredClone(next); qstate = { ...qstate, savedState: qsaved }; await questionPanel.update(qstate); }, selectPresentation() {} });
    contactPanel = await contactModule.mount(document.querySelector('#contacts'), { ...common, state: cstate, services: { version: 1, suggestedContacts: contactService },
      compareAndSetState: async (expected: PanelOpaqueStateV1 | null, next: PanelOpaqueStateV1 | null) => { if (JSON.stringify(expected) !== JSON.stringify(csaved)) throw new Error('Conflict'); csaved = structuredClone(next); cstate = { ...cstate, savedState: csaved }; await contactPanel.update(cstate); } });
    (window as typeof window & { panelProbe: { suspend(): void; resume(): void } }).panelProbe = {
      suspend() { activity.abort(); qstate = { ...qstate, visible: false, activity: { ...qstate.activity, active: false } }; void questionPanel.update(qstate); },
      resume() { activity = new AbortController(); qstate = { ...qstate, visible: true, activity: { repo: 'org/a', epoch: qstate.activity.epoch + 1, active: true, signal: activity.signal } }; void questionPanel.update(qstate); },
    };
  });
  const questions = page.locator('#questions'); const contacts = page.locator('#contacts'); const row = questions.locator('[data-question-id="question-1"]');
  await row.getByLabel('Answer', { exact: true }).fill('Keep the old API until the compatibility requests are reconciled. 🛟');
  await row.getByRole('button', { name: 'Accept answer', exact: true }).click(); await expect(questions.locator('[data-request-id]')).toHaveCount(1);
  await row.getByLabel('Answer', { exact: true }).fill('A newer unsent draft survives result storage.');
  await questions.getByRole('button', { name: 'Save result and dismiss request', exact: true }).click(); await expect(questions.locator('[data-request-id]')).toHaveCount(0); await expect(row.getByLabel('Answer', { exact: true })).toHaveValue('A newer unsent draft survives result storage.');
  await expect(questions.locator('[data-question-id="unknown"]')).toContainText('Read-only: provenance-unknown');
  const create = contacts.getByRole('form', { name: 'Create global contact', exact: true }); await create.getByLabel('Name', { exact: true }).fill('Global escalation owner'); await create.getByLabel('Address', { exact: true }).fill('#team-help-room');
  await create.getByRole('button', { name: 'Create global contact', exact: true }).click(); await expect(contacts.locator('[data-request-id]')).toHaveCount(1); await contacts.getByRole('button', { name: 'Save result and dismiss request', exact: true }).click(); await expect(contacts.locator('[data-request-id]')).toHaveCount(0);
  await expect(contacts).toContainText('No message was sent');
  await page.evaluate(() => { (window as typeof window & { panelProbe: { suspend(): void } }).panelProbe.suspend(); }); await expect(row.getByLabel('Answer', { exact: true })).toBeDisabled(); await expect(create.getByLabel('Name', { exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as typeof window & { panelProbe: { resume(): void } }).panelProbe.resume(); }); await expect(row.getByLabel('Answer', { exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`authored-clarifications-${testInfo.project.name}.png`), fullPage: true }); expect(errors).toEqual([]);
});
