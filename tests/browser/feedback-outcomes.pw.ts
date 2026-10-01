import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) for (const pirateMode of [false, true]) {
  test(`feedback outcomes remain distinct and readable at ${width}px (pirate=${pirateMode})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(pirate => localStorage.setItem('helmsman.pirateMode', String(pirate)), pirateMode);
    const enabled = ['helmsman.run-viewer', 'helmsman.run-history'];
    const at = '2026-09-20T12:00:00.000Z';
    const row = { version: 1, id: 'feedback-run', repo: 'org/a', displayKey: 'AIROBUILD-6827 feedback completion', status: 'running',
      attempt: 1, startedAt: at, endedAt: null as string | null, prNumber: null, costUsd: null, review: null, sourceSettlement: null,
      feedbackOutcome: { state: 'awaiting_decision', headSha: 'a'.repeat(40), summary: '<img src=x onerror=alert(1)> Decision required.' } };
    const target = { repo: row.repo, runId: row.id, expectedAttempt: 1 };
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://127.0.0.1:4175') return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      let body: unknown = {};
      if (url.pathname === '/api/plugins/catalog') body = { version: 1, safeMode: false, plugins: [], bindings: {}, builtins: enabled.map(id => ({ id, version: '0.1.0', hash: 'a'.repeat(64), enabled: true })) };
      if (url.pathname === '/api/context') body = { repos: ['org/a'], jiraEnabled: false, jiraBaseUrl: null };
      if (url.pathname === '/api/agents') body = { runs: [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } };
      if (url.pathname === '/api/config') body = { config: {}, overridden: [] };
      if (url.pathname === '/api/task-sources') body = { instances: [] };
      if (url.pathname === '/api/run-read/feedback-run') body = { version: 1, repo: row.repo, runId: row.id, run: row };
      if (url.pathname === '/api/run-inspect/resolve') body = { version: 1, target, observedAt: at };
      if (url.pathname === '/api/run-inspect/feedback-run/log') body = { version: 1, target, provenance: 'run-wide', observedAt: at,
        workerStatus: row.status, events: [], throughSequence: 0, hasEarlier: false, hasLater: false, nextCursor: url.searchParams.get('direction') === 'forward' ? 'follow' : null, followCursor: url.searchParams.has('cursor') ? null : 'follow' };
      if (url.pathname === '/api/run-inspect/history') body = { version: 1, repo: row.repo, items: [row], nextCursor: null, total: 1,
        totalQuality: 'exact', observedAt: at, coverage: 'insertion-bounded-current-state' };
      await route.fulfill({ json: body });
    });
    await page.goto('/run-viewer?repo=org/a&run=feedback-run&runRepo=org/a');
    const status = page.locator('.run-tab-status');
    await expect(status).toHaveText('Awaiting decision');
    await expect(page.getByText('Worker: running · Spend unknown', { exact: true })).toBeVisible();
    await expect(page.locator('.run-feedback-outcome')).toHaveText('Awaiting decision');
    expect(await status.evaluate(el => { const own = el.getBoundingClientRect(); const parent = el.parentElement!.getBoundingClientRect(); return own.left >= parent.left && own.right <= parent.right && el.scrollWidth <= el.clientWidth; })).toBe(true);
    await expect(page.locator('#boot')).toHaveCount(0);
    await expect(status).toHaveText('Awaiting decision');
    await expect(page.getByText('Log is unavailable', { exact: false })).toHaveCount(0);
    await testInfo.attach('awaiting-decision', { body: await page.screenshot({ path: testInfo.outputPath('awaiting-decision.png'), fullPage: true }), contentType: 'image/png' });
    row.feedbackOutcome.state = 'completed';
    await page.reload(); await expect(status).toHaveText('running');
    await expect(page.locator('.run-feedback-outcome')).toHaveCount(0);
    row.status = 'failed'; row.endedAt = at;
    await page.reload(); await expect(status).toHaveText('Feedback remaining');
    await expect(page.getByText('Worker: failed · Spend unknown', { exact: true })).toBeVisible();
    row.status = 'succeeded';
    await page.reload(); await expect(status).toHaveText('Feedback completed');
    await expect(page.getByText('Worker: succeeded · Spend unknown', { exact: true })).toBeVisible();
    await expect(page.locator('#boot')).toHaveCount(0);
    await expect(status).toHaveText('Feedback completed');
    await expect(page.getByText('Log is unavailable', { exact: false })).toHaveCount(0);
    await testInfo.attach('feedback-completed', { body: await page.screenshot({ path: testInfo.outputPath('feedback-completed.png'), fullPage: true }), contentType: 'image/png' });
    await page.goto('/run-history?repo=org/a');
    await expect(page.locator('.run-feedback-outcome')).toHaveText('Feedback completed');
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
