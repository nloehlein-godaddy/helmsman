import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const clarificationsManifest = JSON.parse(readFileSync(new URL('../../src/plugins/clarifications/plugin-package.json', import.meta.url), 'utf8')).manifest;

for (const width of [1440, 390]) test(`question attention chimes once and follows the selected tab at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install({ time: new Date('2026-10-01T12:00:00Z') });
  await page.addInitScript(() => {
    const state = window as typeof window & { questionChimes: number }; state.questionChimes = 0;
    class Audio {
      state = 'suspended'; currentTime = 0; destination = {};
      async resume() { this.state = 'running'; }
      async close() { this.state = 'closed'; }
      createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
      createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, start() { state.questionChimes++; }, stop() {} }; }
    }
    Object.defineProperty(window, 'AudioContext', { value: Audio });
  });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const now = '2026-10-01T12:00:00Z';
  const question = (id: string) => ({ version: 1, id, repo: 'org/a', runId: 'run', revision: 1, prompt: 'Which option should the agent use?', required: true,
    owner: 'local', contactId: null, state: 'pending', answer: null, createdAt: now, timeoutAt: null, answeredAt: null,
    provenance: { kind: 'legacy-unproven', attempt: null, channelId: null }, currentAttempt: null, blocksPublication: true,
    answerability: { available: false, reason: 'provenance-unknown' } });
  let rows = [question('first')]; const callers: string[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body: unknown = {};
    if (url.pathname === '/api/plugins/catalog') body = { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: [{ id: clarificationsManifest.id, version: clarificationsManifest.version, hash: 'a'.repeat(64), enabled: true }] };
    else if (url.pathname === '/api/context') body = { repos: ['org/a', 'org/b'], jiraEnabled: false, jiraBaseUrl: null };
    else if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: {} };
    else if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
    else if (url.pathname === '/api/clarification-read') {
      callers.push(route.request().headers()['x-helmsman-contribution'] ?? '');
      const repo = url.searchParams.get('repo'); const items = rows.filter(item => repo === null || item.repo === repo);
      body = { version: 1, repo, items, total: items.length, nextCursor: null, observedAt: now };
    } else return route.fulfill({ status: 503, json: { reason: 'service-unavailable' } });
    return route.fulfill({ json: body });
  });
  const chimes = () => page.evaluate(() => (window as typeof window & { questionChimes: number }).questionChimes);
  await page.goto('/config?repo=org/a'); const tab = page.locator('#page-tab-clarifications');
  await expect(tab).toHaveClass(/needs-attention/); expect(await chimes()).toBe(0);
  await page.locator('#page-tab-config').click(); await expect.poll(chimes).toBe(1);
  await page.clock.runFor(10_000); expect(await chimes()).toBe(1);
  rows.push(question('second')); await page.clock.runFor(5_000); await expect.poll(chimes).toBe(2);
  await expect(tab).toHaveCSS('animation-name', 'question-attention');
  await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(tab).toHaveCSS('animation-name', 'none');
  await tab.scrollIntoViewIfNeeded(); await tab.screenshot({ path: testInfo.outputPath(`question-attention-${width}.png`) });
  await tab.click(); await expect(tab).not.toHaveClass(/needs-attention/); await expect(page).toHaveURL(/\/clarifications\?/);
  rows.push(question('third')); await page.clock.runFor(5_000); expect(await chimes()).toBe(2);
  await page.locator('#page-tab-config').click(); await expect(tab).toHaveClass(/needs-attention/); expect(await chimes()).toBe(2);
  await page.locator('.repo-select').selectOption('org/b'); await expect(tab).not.toHaveClass(/needs-attention/);
  rows = []; await page.locator('.repo-select').selectOption('org/a'); await page.clock.runFor(5_000); await expect(tab).not.toHaveClass(/needs-attention/);
  expect(callers).toContain('helmsman.clarifications/page'); expect(errors).toEqual([]);
});
