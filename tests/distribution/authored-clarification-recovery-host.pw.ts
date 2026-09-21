import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { fixture, sourceRoot } from './isolated-fixture';
import { seedClarificationProof } from './clarification-fixture';

const originalCaller = 'helmsman.compat-clarifications/page';
const copyPackage = 'example.clarification-recovery';
const copyCaller = `${copyPackage}/page`;
const originalPrefix = 'helmsman.compat-clarifications.drafts.v2:';
const copyPrefix = `helmsman.clarification-recovery.drafts.v2:${copyCaller}:`;
const answerDatabase = 'helmsman.clarification-commands';
const contactDatabase = 'helmsman.suggested-contact-commands';
const savedResultId = '00000000-0000-4000-8000-000000000099';
interface JournalEntry { caller: string; command: { requestId: string; [key: string]: unknown }; receipt: { status: string } | null; }

async function journal(page: Page, database: string, caller: string): Promise<JournalEntry[]> {
  return page.evaluate(async ({ database, caller }) => {
    if (!(await indexedDB.databases()).some(value => value.name === database)) return [];
    return new Promise<JournalEntry[]>((resolve, reject) => {
      const opening = indexedDB.open(database, 1); opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result; const tx = db.transaction('pending', 'readonly'); const read = tx.objectStore('pending').getAll();
        tx.oncomplete = () => { db.close(); resolve((read.result as JournalEntry[]).filter(entry => entry.caller === caller)); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, { database, caller });
}
const evidence = (page: Page, prefix: string) => page.evaluate(prefix => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith(prefix))), prefix);

test('copied clarification recovery compiles against the SDK and isolates cleanup from original drafts and requests', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const host = await fixture({ distribution: process.env.HELMSMAN_RECOVERY_DISTRIBUTION }); host.env.REPO_PROJECT_MAP = 'org/a=TASK';
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const answerWrites: unknown[] = []; const contactWrites: unknown[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/clarification-command') answerWrites.push(request.postDataJSON());
    if (path === '/api/suggested-contact-admin/commands') contactWrites.push(request.postDataJSON());
  });
  try {
    await expect(host.script('deny-recovery-source.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/sdk.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await host.start(); await host.stop(); await seedClarificationProof(host, { extraQuestionIds: ['copy-proof'] });
    const origin = await host.start();
    await page.goto(`${origin}/plugins/${originalCaller}?repo=org/a`);
    const recovery = page.locator('.clarification-page'); const originalQuestion = recovery.locator('[data-question="question-proof"]');
    await originalQuestion.locator('textarea').fill('Original submitted answer');
    await page.route('**/api/clarification-command', route => route.abort('failed'), { times: 1 });
    await originalQuestion.getByRole('button', { name: 'Accept answer', exact: true }).click();
    await expect(recovery.locator('[data-pending-kind="answer"]')).toBeVisible();
    await originalQuestion.locator('textarea').fill('Newer original answer draft');
    await recovery.getByText('Optional contact settings', { exact: true }).click();
    await recovery.getByRole('textbox', { name: 'Name', exact: true }).fill('Original submitted contact');
    await recovery.getByRole('textbox', { name: 'Jira account ID or address' }).fill('original-contact-address');
    await page.route('**/api/suggested-contact-admin/commands', route => route.abort('failed'), { times: 1 });
    await recovery.getByRole('button', { name: 'Save contact', exact: true }).click();
    await expect(recovery.locator('[data-pending-kind="contact"]')).toBeVisible();
    await recovery.getByRole('textbox', { name: 'Name', exact: true }).fill('Newer original contact draft');
    await page.evaluate(({ prefix, requestId }) => localStorage.setItem(`${prefix}result:${requestId}`, JSON.stringify({ requestId, repo: 'org/a', message: 'Original saved recovery result' })), { prefix: originalPrefix, requestId: savedResultId });
    const originalDrafts = await evidence(page, originalPrefix);
    const originalAnswers = await journal(page, answerDatabase, originalCaller); const originalContacts = await journal(page, contactDatabase, originalCaller);
    expect(originalAnswers).toHaveLength(1); expect(originalContacts).toHaveLength(1);
    expect(originalAnswers[0]?.receipt).toBeNull(); expect(originalContacts[0]?.receipt).toBeNull();

    const descriptor = await host.installAuthorPackage('plugin-sources/compat-clarifications', copyPackage);
    expect(descriptor.manifest.pages).toHaveLength(1); expect(descriptor.manifest.pages[0]?.slots).toEqual([]);
    expect(descriptor.manifest.pages[0]?.requires).toEqual(expect.arrayContaining([
      { id: 'helmsman/clarification-read', version: 1 }, { id: 'helmsman/clarification-command', version: 1 }, { id: 'helmsman/suggested-contact-admin', version: 1 },
    ]));
    await page.goto(`${origin}/plugins/${copyCaller}?repo=org/a`);
    await expect(page.locator(`[data-plugin-page="${copyCaller}"] .clarification-page`)).toBeVisible();
    await expect(recovery.locator('[data-pending-kind]')).toHaveCount(0);
    await expect(recovery.locator('[data-question="question-proof"] textarea')).toHaveValue('');
    const copyQuestion = recovery.locator('[data-question="copy-proof"]');
    await copyQuestion.locator('textarea').fill('Copied recovery own draft');
    await expect.poll(async () => JSON.stringify(await evidence(page, copyPrefix))).toContain('Copied recovery own draft');
    await page.evaluate(({ prefix, requestId }) => localStorage.setItem(`${prefix}result:${requestId}`, JSON.stringify({ requestId, repo: 'org/a', message: 'Copied recovery own result' })), { prefix: copyPrefix, requestId: savedResultId });
    await page.reload(); await expect(copyQuestion.locator('textarea')).toHaveValue('Copied recovery own draft');
    await recovery.getByText('Saved drafts and results', { exact: true }).click();
    await expect(recovery.getByText('Copied recovery own result', { exact: true })).toBeVisible();
    await expect(recovery.getByText('Original saved recovery result', { exact: true })).toHaveCount(0);
    await recovery.locator(`[data-remove-result="${savedResultId}"]`).click();
    await recovery.getByRole('button', { name: 'Discard this saved draft', exact: true }).click();
    await expect(copyQuestion.locator('textarea')).toHaveValue('');
    expect(await evidence(page, originalPrefix)).toEqual(originalDrafts);
    expect(await journal(page, answerDatabase, originalCaller)).toEqual(originalAnswers);
    expect(await journal(page, contactDatabase, originalCaller)).toEqual(originalContacts);
    expect(await journal(page, answerDatabase, copyCaller)).toEqual([]); expect(await journal(page, contactDatabase, copyCaller)).toEqual([]);
    expect(answerWrites).toHaveLength(1); expect(contactWrites).toHaveLength(1);
    await copyQuestion.locator('textarea').fill('Independent copy remains usable');
    await expect(page.locator('#boot')).toBeHidden({ timeout: 15_000 });
    await page.screenshot({ path: testInfo.outputPath('authored-recovery-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await copyQuestion.locator('textarea').scrollIntoViewIfNeeded(); await expect(copyQuestion.locator('textarea')).toHaveValue('Independent copy remains usable');
    await page.screenshot({ path: testInfo.outputPath('authored-recovery-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.goto(`${origin}/plugins/${originalCaller}?repo=org/a`);
    await expect(originalQuestion.locator('textarea')).toHaveValue('Newer original answer draft');
    await expect(recovery.locator('[data-pending-kind="answer"]')).toBeVisible(); await expect(recovery.locator('[data-pending-kind="contact"]')).toBeVisible();
    await recovery.getByText('Optional contact settings', { exact: true }).click();
    await expect(recovery.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Newer original contact draft');
    await recovery.locator('[data-pending-kind="answer"]').getByRole('button', { name: 'Retry original submission', exact: true }).click();
    await expect.poll(async () => (await journal(page, answerDatabase, originalCaller)).length).toBe(0);
    await recovery.locator('[data-pending-kind="contact"]').getByRole('button', { name: 'Retry original submission', exact: true }).click();
    await expect.poll(async () => (await journal(page, contactDatabase, originalCaller)).length).toBe(0);
    expect(answerWrites).toHaveLength(2); expect(answerWrites[1]).toEqual(answerWrites[0]);
    expect(contactWrites).toHaveLength(2); expect(contactWrites[1]).toEqual(contactWrites[0]);
    const retained = await evidence(page, originalPrefix);
    expect(retained[`${originalPrefix}answer:${JSON.stringify(['org/a', 'run-proof', 'question-proof'])}`]).toBe(JSON.stringify('Newer original answer draft'));
    expect(retained[`${originalPrefix}contact`]).toContain('Newer original contact draft');
    expect(retained[`${originalPrefix}result:${savedResultId}`]).toBe(originalDrafts[`${originalPrefix}result:${savedResultId}`]);
    expect(retained[`${originalPrefix}result:${originalAnswers[0]!.command.requestId}`]).toContain('Answer accepted');
    expect(retained[`${originalPrefix}result:${originalContacts[0]!.command.requestId}`]).toContain('Contact saved');
    expect(JSON.stringify(await evidence(page, copyPrefix))).toContain('Independent copy remains usable');
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});
