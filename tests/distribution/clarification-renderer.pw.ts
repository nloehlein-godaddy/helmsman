import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { fixture, sourceRoot } from './isolated-fixture';
import { seedClarificationProof } from './clarification-fixture';

async function pendingAnswers(page: Page): Promise<{ command: { requestId: string; answer: string }; receipt: { status: string } | null }[]> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('helmsman.clarification-commands', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction('pending', 'readonly');
      const request = transaction.objectStore('pending').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => database.close();
    };
  }));
}

test('compatibility clarifications preserve drafts and durable results in the source-denied production shell', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const host = await fixture({ distribution: process.env.HELMSMAN_CLARIFICATION_TEST_DISTRIBUTION });
  host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(host.script('prove-renderer-isolation.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/compat-clarifications/render.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await host.start(); await host.stop(); await seedClarificationProof(host);
    const origin = await host.start();
    const contactReads = '**/api/suggested-contact-admin?*';
    await page.route(contactReads, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ reason: 'contact-proof-unavailable' }) }));
    await page.goto(`${origin}/plugins/helmsman.compat-clarifications/page?repo=org/a`);
    const renderer = page.locator('.clarification-page');
    const known = renderer.locator('[data-question="question-proof"]');
    const unknown = renderer.locator('[data-question="legacy-proof"]');
    await expect(known.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
    await expect(unknown).toContainText('Answer unavailable: provenance-unknown');
    await expect(unknown).toContainText('remains a publication blocker');
    await expect(unknown.locator('textarea')).toHaveCount(0);
    await renderer.getByText('Optional contact settings', { exact: true }).click();
    await expect(renderer).toContainText('Contacts could not be loaded. You can still answer questions.');
    await expect(renderer.getByRole('heading', { name: 'Suggested respondents · Global', exact: true })).toBeVisible();
    const answer = known.getByRole('textbox', { name: 'Your answer' });
    await answer.fill('Approve the voyage 🛟');
    await renderer.getByRole('textbox', { name: 'Name', exact: true }).fill('Reviewer');
    await renderer.getByRole('textbox', { name: 'Jira account ID or address' }).fill('slack:reviewer');
    await page.reload();
    await expect(answer).toHaveValue('Approve the voyage 🛟');
    await renderer.getByText('Optional contact settings', { exact: true }).click();
    await expect(renderer.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Reviewer');
    await expect(known.getByRole('button', { name: 'Accept answer', exact: true })).toBeEnabled();
    await renderer.locator('.clarification-heading').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('clarifications-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await renderer.locator('.clarification-heading').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('clarifications-mobile.png') });
    await known.getByRole('button', { name: 'Accept answer', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('clarifications-answer-mobile.png') });
    await renderer.locator('[data-contact-settings]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('clarifications-contacts-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    let requestId: string | undefined;
    await page.route('**/api/clarification-command', async route => {
      requestId = route.request().postDataJSON().command.requestId;
      expect((await route.fetch()).ok()).toBe(true); await route.abort('failed');
    }, { times: 1 });
    await known.getByRole('button', { name: 'Accept answer', exact: true }).click();
    await expect(renderer.getByRole('button', { name: 'Check receipt', exact: true })).toBeVisible();
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await pendingAnswers(page)).toMatchObject([{ command: { requestId, answer: 'Approve the voyage 🛟' }, receipt: null }]);
    await renderer.getByText('Saved drafts and results', { exact: true }).click();
    await expect(renderer.getByRole('button', { name: 'Discard this saved draft', exact: true })).toBeDisabled();
    await page.reload();
    await expect(renderer.getByRole('button', { name: 'Check receipt', exact: true })).toBeVisible();
    await page.evaluate(() => {
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('helmsman.compat-clarifications.drafts.v2:result:')) throw new DOMException('Proof storage unavailable', 'QuotaExceededError');
        return write.call(this, key, value);
      };
    });
    await renderer.getByRole('button', { name: 'Check receipt', exact: true }).click();
    await expect(renderer).toContainText('Draft or result storage unavailable');
    await expect(renderer.getByRole('button', { name: 'Save result', exact: true })).toBeVisible();
    expect(await pendingAnswers(page)).toMatchObject([{ command: { requestId }, receipt: { status: 'succeeded' } }]);
    await page.reload();
    await expect(renderer.getByRole('button', { name: 'Save result', exact: true })).toBeVisible();
    await page.evaluate(() => {
      const remove = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (key) {
        if (this.transaction.db.name === 'helmsman.clarification-commands') {
          const stored = Object.keys(localStorage).some(key => key.startsWith('helmsman.compat-clarifications.drafts.v2:result:'));
          if (!stored) throw new Error('Receipt acknowledged before durable result');
        }
        return remove.call(this, key);
      };
    });
    await renderer.getByRole('button', { name: 'Save result', exact: true }).click();
    await expect.poll(async () => (await pendingAnswers(page)).length).toBe(0);
    expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`helmsman.compat-clarifications.drafts.v2:result:${id}`) ?? 'null'), requestId)).toMatchObject({ requestId, repo: 'org/a', message: 'Answer accepted. Worker consumption is not confirmed.' });
    await renderer.getByText('Saved drafts and results', { exact: true }).click();
    await renderer.getByRole('button', { name: 'Discard this saved draft', exact: true }).click();
    await expect(renderer.getByRole('button', { name: 'Discard this saved draft', exact: true })).toHaveCount(0);
    await renderer.getByRole('button', { name: 'Dismiss saved result', exact: true }).click();
    await expect.poll(() => page.evaluate(id => localStorage.getItem(`helmsman.compat-clarifications.drafts.v2:result:${id}`), requestId)).toBeNull();
    expect(await pendingAnswers(page)).toEqual([]);
    await page.goto(`${origin}/plugins/helmsman.compat-clarifications/page?repo=org/b`);
    await expect(page.locator('[data-plugin-page="helmsman.compat-clarifications/page"]')).toBeVisible();
    await expect(known).toHaveCount(0);
    await renderer.getByText('Optional contact settings', { exact: true }).click();
    await expect(renderer.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Reviewer');
    await page.unroute(contactReads);
    await renderer.getByRole('button', { name: 'Save contact', exact: true }).click();
    await expect(renderer).toContainText('Contact saved. No notification was sent.');
    await expect(renderer.locator('.clarification-contacts')).toContainText('Reviewer · slack:reviewer · available');
    await page.goto(`${origin}/plugins/helmsman.compat-clarifications/page`);
    await expect(page.locator('.repo-select')).toHaveValue('');
    await expect(unknown).toBeVisible();
    const href = await unknown.getByRole('link', { name: /View .* run-proof/ }).getAttribute('href');
    expect(href).toBeTruthy();
    const target = new URL(href!, origin);
    expect(target.searchParams.get('repo')).toBeNull();
    expect(target.searchParams.get('runRepo')).toBe('org/a');
    await unknown.getByRole('link', { name: /View .* run-proof/ }).click();
    await expect(page.locator('.repo-select')).toHaveValue('');
    await expect(page).toHaveURL(/runRepo=org%2Fa/);
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});
