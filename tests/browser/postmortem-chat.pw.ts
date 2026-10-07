import { expect, test, type Page } from '@playwright/test';
import { builtinCatalog } from './builtin-catalog';

const SID = '00000000-0000-4000-8000-000000000001';
const at = '2026-10-07T12:00:00.000Z';
const run = { version: 1, id: 'failed-run', repo: 'org/a', displayKey: 'TASK-41', status: 'failed', attempt: 1,
  startedAt: at, endedAt: at, prNumber: null, costUsd: null, review: null, sourceSettlement: null };
const target = { repo: run.repo, runId: run.id, expectedAttempt: 1 };
const session = { id: SID, runId: run.id, provider: 'codex', model: null, effort: 'high', status: 'ready', error: null, turns: 1, costUsd: 0.1 };
const initial = { session, activity: null, messages: [{ id: 1, clientId: null, role: 'agent', kind: 'text', text: 'The worker exited before producing output.', ts: at }], patches: [] };
const followup = { id: 2, clientId: null, role: 'agent', kind: 'text', text: 'Check the worker argument length before retrying.', ts: at };

async function mockPostmortem(page: Page) {
  const sent: Record<string, unknown>[] = [];
  let streams = 0;
  let streamReady = false;
  let releaseStream: (() => void) | undefined;
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    if (path === `/api/postmortem/${SID}/events`) {
      expect(url.searchParams.get('repo')).toBe('org/a');
      expect(url.searchParams.get('scopeRepo')).toBe('org/a');
      expect(request.headers()['x-helmsman-contribution']).toBe('helmsman.run-viewer/panel');
      streams += 1;
      if (streams > 2) return route.abort();
      if (streams === 2) {
        await new Promise<void>(resolve => { releaseStream = resolve; streamReady = true; });
      }
      const event = streams === 1 ? { type: 'snapshot', snapshot: initial } : { type: 'message', message: followup };
      return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(event)}\n\n` });
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(body.repo).toBe('org/a'); expect(body.scopeRepo).toBe('org/a');
      expect(request.headers()['x-helmsman-contribution']).toBe('helmsman.run-viewer/panel');
      if (path === `/api/runs/${run.id}/postmortem`) return route.fulfill({ json: initial });
      if (path === `/api/postmortem/${SID}/messages`) {
        sent.push(body);
        return route.fulfill({ json: { ...initial, session: { ...session, status: 'busy' }, activity: 'thinking',
          messages: [...initial.messages, followup, { id: 3, clientId: body.clientId, role: 'user', kind: 'text', text: body.text, ts: at }] } });
      }
      throw new Error(`Unexpected mutation: ${path}`);
    }
    const json = path === '/api/plugins/catalog' ? { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: builtinCatalog(['helmsman.run-viewer']) }
      : path === '/api/context' ? { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null }
      : path === '/api/config' ? { config: {}, overridden: [] }
      : path === '/api/agents' ? { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } }
      : path === '/api/task-sources' ? { instances: [] }
      : path === '/api/run-read' ? { version: 1, repo: 'org/a', items: [], nextCursor: null }
      : path === `/api/run-read/${run.id}` ? { version: 1, repo: run.repo, runId: run.id, run }
      : path === '/api/run-inspect/resolve' ? { version: 1, target, observedAt: at }
      : path === `/api/run-inspect/${run.id}/log` ? { version: 1, target, provenance: 'run-wide', observedAt: at, workerStatus: run.status,
        events: [], throughSequence: 0, hasEarlier: false, hasLater: false,
        nextCursor: url.searchParams.get('direction') === 'forward' ? 'follow' : null, followCursor: url.searchParams.has('cursor') ? null : 'follow' }
      : {};
    return route.fulfill({ json });
  });
  return { sent, ready: () => streamReady, release: () => releaseStream?.() };
}

for (const width of [1440, 390]) test.describe(`post-mortem at ${width}px`, () => {
  test.use({ viewport: { width, height: 1000 }, hasTouch: width === 390 });
  test('preserves a scoped draft and keyboard selection through streamed updates', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const fixture = await mockPostmortem(page);
    await page.goto(`/run-viewer?repo=org/a&run=${run.id}&runRepo=org/a`);
    await expect(page.locator('.run-tab-status')).toHaveText('failed');
    await page.getByRole('button', { name: 'Ask about this failure' }).click();
    await page.getByRole('button', { name: 'Start post-mortem', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Message to the post-mortem agent' });
    await expect(editor).toBeEnabled();
    await editor.click();
    await editor.pressSequentially('Why did the worker exit?', { delay: 20 });
    await expect(editor).toHaveValue('Why did the worker exit?');
    await expect(editor).toBeFocused();
    await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(4, 11));
    await expect.poll(fixture.ready).toBe(true);
    fixture.release();
    await expect(page.getByText(followup.text, { exact: true })).toBeVisible();
    await expect(editor).toBeFocused();
    expect(await editor.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([4, 11]);
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.run-postmortem').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    const screenshot = `/tmp/helmsman-postmortem-${width}.png`;
    await editor.scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`postmortem-${width}`, { path: screenshot, contentType: 'image/png' });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => fixture.sent.length).toBe(1);
    expect(fixture.sent[0]).toMatchObject({ repo: 'org/a', scopeRepo: 'org/a', text: 'Why did the worker exit?' });
    expect(fixture.sent[0]?.clientId).toMatch(/^[a-f\d-]{36}$/i);
    await expect(editor).toHaveValue('');
    await expect(editor).toBeDisabled();
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    expect(errors).toEqual([]);
  });
});
