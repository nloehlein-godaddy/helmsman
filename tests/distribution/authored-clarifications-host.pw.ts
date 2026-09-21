import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, sourceRoot } from './isolated-fixture';
import { seedClarificationProof } from './clarification-fixture';

const questionPackage = 'example.authored-questions';
const contactPackage = 'example.authored-contacts';
const questionCaller = `${questionPackage}/panel`;
const contactCaller = `${contactPackage}/panel`;
const compatibilityCaller = 'helmsman.compat-clarifications/page';
const answerDatabase = 'helmsman.clarification-commands';
const contactDatabase = 'helmsman.suggested-contact-commands';
const compositionId = 'helmsman/clarifications-page';
interface JournalEntry { caller: string; command: { requestId: string; [key: string]: unknown }; receipt: { status: string } | null; }

async function browserRows(page: Page, database: string, table: string): Promise<unknown[]> {
  return page.evaluate(async ({ database, table }) => {
    if (!(await indexedDB.databases()).some(value => value.name === database)) return [];
    return new Promise<unknown[]>((resolve, reject) => {
      const opening = indexedDB.open(database, 1); opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result; const tx = db.transaction(table, 'readonly'); const read = tx.objectStore(table).getAll();
        tx.oncomplete = () => { db.close(); resolve(read.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, { database, table });
}
async function journal(page: Page, database: string, caller: string): Promise<JournalEntry[]> {
  return (await browserRows(page, database, 'pending') as JournalEntry[]).filter(entry => entry.caller === caller);
}
async function installQuestions(host: Awaited<ReturnType<typeof fixture>>) {
  const path = join(host.app, 'plugin-sources/clarifications/plugin-package.json');
  const descriptor = JSON.parse(await readFile(path, 'utf8'));
  for (const page of descriptor.manifest.pages ?? []) for (const instance of page.composition?.initialLayout?.instances ?? []) {
    if (instance.contributionId?.startsWith('helmsman.suggested-contacts/')) instance.contributionId = instance.contributionId.replace('helmsman.suggested-contacts/', `${contactPackage}/`);
  }
  await writeFile(path, JSON.stringify(descriptor));
  await host.installAuthorPackage('plugin-sources/clarifications', questionPackage);
}
async function guardResultBeforeAcknowledgment(page: Page, database: string, caller: string, requestId: string) {
  await page.evaluate(async ({ database, caller, requestId, compositionId }) => {
    const committed = new Set<string>();
    const containsResult = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false;
      if (Array.isArray(value)) return value.some(containsResult);
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.results) && record.results.some(result => result && typeof result === 'object' && 'requestId' in result && result.requestId === requestId)) return true;
      return Object.values(record).some(containsResult);
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('helmsman.composition-layouts', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('layouts', 'readonly'); const read = tx.objectStore('layouts').get(compositionId);
      tx.oncomplete = () => { if (containsResult(read.result)) committed.add(requestId); resolve(); }; tx.onerror = () => reject(tx.error);
    }); db.close();
    const put = IDBObjectStore.prototype.put; const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.transaction.db.name === 'helmsman.composition-layouts' && this.name === 'layouts' && value?.compositionId === compositionId && containsResult(value)) {
        this.transaction.addEventListener('complete', () => committed.add(requestId), { once: true });
      }
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
    IDBObjectStore.prototype.delete = function (key) {
      if (this.transaction.db.name === database && typeof key === 'string' && JSON.parse(key)?.[0] === caller && !committed.has(requestId)) throw new Error('Authored receipt acknowledged before durable result');
      return remove.call(this, key);
    };
  }, { database, caller, requestId, compositionId });
}

test('authored question panels preserve compatibility recovery, reject stale-tab saves and answer without contacts', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const host = await fixture({ distribution: process.env.HELMSMAN_AUTHORED_CLARIFICATION_DISTRIBUTION });
  host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(host.script('deny-authored-questions-source.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/sdk.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await host.start(); await host.stop(); await seedClarificationProof(host, { extraQuestionIds: ['authored-proof', 'authored-next'] });
    let origin = await host.start();
    await page.goto(`${origin}/plugins/helmsman.compat-clarifications/page?repo=org/a`);
    const compatibility = page.locator('.clarification-page');
    await compatibility.locator('[data-question="question-proof"] textarea').fill('Original compatibility answer');
    await page.route('**/api/clarification-command', async route => { expect((await route.fetch()).ok()).toBe(true); await route.abort('failed'); }, { times: 1 });
    await compatibility.locator('[data-question="question-proof"]').getByRole('button', { name: 'Accept answer', exact: true }).click();
    await expect(compatibility.locator('[data-pending-kind="answer"]')).toBeVisible();
    await compatibility.getByText('Optional contact settings', { exact: true }).click();
    await compatibility.getByRole('textbox', { name: 'Name', exact: true }).fill('Original compatibility contact');
    await compatibility.getByRole('textbox', { name: 'Jira account ID or address' }).fill('compatibility-account');
    await page.route('**/api/suggested-contact-admin/commands', async route => { expect((await route.fetch()).ok()).toBe(true); await route.abort('failed'); }, { times: 1 });
    await compatibility.getByRole('button', { name: 'Save contact', exact: true }).click();
    await expect(compatibility.locator('[data-pending-kind="contact"]')).toBeVisible();
    const originalAnswers = await journal(page, answerDatabase, compatibilityCaller);
    const originalContacts = await journal(page, contactDatabase, compatibilityCaller);
    expect(originalAnswers).toHaveLength(1); expect(originalContacts).toHaveLength(1);
    const originalDrafts = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('helmsman.compat-clarifications.drafts.v2:'))));
    await installQuestions(host);
    const url = `${origin}/plugins/${questionPackage}/page?repo=org/a`;
    await page.goto(url);
    const questions = page.locator('.plugin-clarifications-panel');
    const selected = questions.locator('[data-question-id="authored-proof"]');
    await expect(selected.getByRole('textbox', { name: 'Answer', exact: true })).toBeVisible();
    await expect(questions.locator('[data-question-id="legacy-proof"]')).toContainText('provenance-unknown');
    await expect(questions.locator('[data-question-id="legacy-proof"]').getByRole('button', { name: 'Accept answer', exact: true })).toBeDisabled();
    await expect(page.locator('.plugin-suggested-contacts')).toHaveCount(0);
    expect(await journal(page, answerDatabase, compatibilityCaller)).toEqual(originalAnswers);
    expect(await journal(page, contactDatabase, compatibilityCaller)).toEqual(originalContacts);
    expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('helmsman.compat-clarifications.drafts.v2:'))))).toEqual(originalDrafts);
    const stale = await page.context().newPage();
    await stale.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: undefined }); });
    await stale.goto(url);
    const staleQuestion = stale.locator('.plugin-clarifications-panel [data-question-id="authored-proof"]');
    await expect(staleQuestion.getByRole('textbox', { name: 'Answer', exact: true })).toBeVisible();
    await selected.getByRole('textbox', { name: 'Answer', exact: true }).fill('Newest saved browser draft');
    await expect.poll(async () => JSON.stringify(await browserRows(page, 'helmsman.composition-layouts', 'layouts'))).toContain('Newest saved browser draft');
    let staleCommands = 0; stale.on('request', request => { if (new URL(request.url()).pathname === '/api/clarification-command' && request.method() === 'POST') staleCommands++; });
    await staleQuestion.getByRole('textbox', { name: 'Answer', exact: true }).fill('Stale tab unsent edit');
    await expect(stale.locator('.plugin-clarifications-panel')).toContainText(/Saved state.*(?:changed|could not)/);
    await expect(staleQuestion.getByRole('button', { name: 'Accept answer', exact: true })).toBeDisabled();
    await expect(staleQuestion.getByRole('textbox', { name: 'Answer', exact: true })).toHaveValue('Stale tab unsent edit');
    expect(JSON.stringify(await browserRows(page, 'helmsman.composition-layouts', 'layouts'))).toContain('Newest saved browser draft');
    expect(JSON.stringify(await browserRows(page, 'helmsman.composition-layouts', 'layouts'))).not.toContain('Stale tab unsent edit');
    expect(staleCommands).toBe(0); await stale.close();
    const cleanStale = await page.context().newPage();
    await cleanStale.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: undefined }); });
    await cleanStale.goto(url);
    const cleanStaleQuestion = cleanStale.locator('.plugin-clarifications-panel [data-question-id="authored-proof"]');
    await expect(cleanStaleQuestion.getByRole('textbox', { name: 'Answer', exact: true })).toHaveValue('Newest saved browser draft');
    const finalAnswer = 'Newest saved browser draft after another tab loaded';
    await selected.getByRole('textbox', { name: 'Answer', exact: true }).fill(finalAnswer);
    await expect.poll(async () => JSON.stringify(await browserRows(page, 'helmsman.composition-layouts', 'layouts'))).toContain(finalAnswer);
    let cleanStaleCommands = 0;
    cleanStale.on('request', request => { if (new URL(request.url()).pathname === '/api/clarification-command' && request.method() === 'POST') cleanStaleCommands++; });
    await expect(cleanStaleQuestion.getByRole('textbox', { name: 'Answer', exact: true })).toHaveValue('Newest saved browser draft');
    await cleanStaleQuestion.getByRole('button', { name: 'Accept answer', exact: true }).click();
    await expect(cleanStale.locator('.plugin-clarifications-panel')).toContainText(/Saved state.*(?:changed|could not)/);
    expect(cleanStaleCommands).toBe(0);
    expect(await journal(page, answerDatabase, questionCaller)).toHaveLength(0);
    expect(JSON.stringify(await browserRows(page, 'helmsman.composition-layouts', 'layouts'))).toContain(finalAnswer);
    await cleanStale.close();
    await page.reload(); await expect(selected.getByRole('textbox', { name: 'Answer', exact: true })).toHaveValue(finalAnswer);
    await page.route('**/api/clarification-command', async route => { expect((await route.fetch()).ok()).toBe(true); await route.abort('failed'); }, { times: 1 });
    await selected.getByRole('button', { name: 'Accept answer', exact: true }).click();
    await expect(questions.getByRole('button', { name: 'Check receipt', exact: true })).toBeVisible();
    const authored = (await journal(page, answerDatabase, questionCaller))[0]; expect(authored?.receipt).toBeNull();
    expect(authored?.command).toMatchObject({ questionId: 'authored-proof', answer: finalAnswer });
    await host.installAuthorPackage('plugin-sources/suggested-contacts', contactPackage);
    await host.cli('disable', contactPackage); await page.reload();
    await expect(page.locator('.plugin-suggested-contacts')).toHaveCount(0);
    const next = questions.locator('[data-question-id="authored-next"]');
    await next.getByRole('textbox', { name: 'Answer', exact: true }).fill('Works with contacts disabled');
    await next.getByRole('button', { name: 'Accept answer', exact: true }).click();
    await expect.poll(async () => (await journal(page, answerDatabase, questionCaller)).find(entry => entry.command.questionId === 'authored-next')?.receipt?.status).toBe('succeeded');
    const nextRequest = (await journal(page, answerDatabase, questionCaller)).find(entry => entry.command.questionId === 'authored-next');
    await questions.getByRole('link', { name: 'Previous drafts and requests', exact: true }).click();
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await compatibility.locator('[data-pending-kind="answer"]').getByRole('button', { name: 'Check receipt', exact: true }).click();
    await expect.poll(async () => (await journal(page, answerDatabase, compatibilityCaller)).length).toBe(0);
    await compatibility.locator('[data-pending-kind="contact"]').getByRole('button', { name: 'Check receipt', exact: true }).click();
    await expect.poll(async () => (await journal(page, contactDatabase, compatibilityCaller)).length).toBe(0);
    expect((await journal(page, answerDatabase, questionCaller)).some(entry => entry.command.requestId === authored?.command.requestId)).toBe(true);
    host.env.HELMSMAN_PORT = new URL(origin).port; origin = await host.start();
    await host.cli('disable', questionPackage); await page.goto(`${origin}/plugins/${questionPackage}/page?repo=org/a`);
    await expect(questions).toHaveCount(0);
    expect((await journal(page, answerDatabase, questionCaller)).some(entry => entry.command.requestId === authored?.command.requestId)).toBe(true);
    await host.cli('enable', questionPackage);
    await page.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: undefined }); });
    await page.reload();
    const staleRetry = await page.context().newPage();
    await staleRetry.goto(`${origin}/plugins/${questionPackage}/page?repo=org/a`);
    const staleAnswer = staleRetry.locator(`.plugin-clarifications-panel [data-request-id="${authored!.command.requestId}"]`);
    await expect(staleAnswer.getByRole('button', { name: 'Retry original', exact: true })).toBeVisible();
    let staleAnswerCommands = 0;
    staleRetry.on('request', request => { if (new URL(request.url()).pathname === '/api/clarification-command' && request.method() === 'POST') staleAnswerCommands++; });
    const pending = questions.locator(`[data-request-id="${authored?.command.requestId}"]`);
    await pending.getByRole('button', { name: 'Check receipt', exact: true }).click();
    await expect.poll(async () => (await journal(page, answerDatabase, questionCaller)).find(entry => entry.command.requestId === authored?.command.requestId)?.receipt?.status).toBe('succeeded');
    const resultWriter = await page.context().newPage();
    await resultWriter.goto(`${origin}/plugins/${questionPackage}/page?repo=org/a`);
    await resultWriter.locator(`.plugin-clarifications-panel [data-request-id="${nextRequest?.command.requestId}"]`).getByRole('button', { name: 'Save result and dismiss request', exact: true }).click();
    await expect.poll(async () => (await journal(page, answerDatabase, questionCaller)).some(entry => entry.command.requestId === nextRequest?.command.requestId)).toBe(false);
    await pending.getByRole('button', { name: 'Save result and dismiss request', exact: true }).click();
    await expect(questions).toContainText(/Saved state.*(?:changed|could not)/);
    expect((await journal(page, answerDatabase, questionCaller)).find(entry => entry.command.requestId === authored?.command.requestId)?.receipt?.status).toBe('succeeded');
    expect(JSON.stringify(await browserRows(page, 'helmsman.composition-layouts', 'layouts'))).toContain(nextRequest!.command.requestId);
    await guardResultBeforeAcknowledgment(resultWriter, answerDatabase, questionCaller, authored!.command.requestId);
    await resultWriter.locator(`.plugin-clarifications-panel [data-request-id="${authored!.command.requestId}"]`).getByRole('button', { name: 'Save result and dismiss request', exact: true }).click();
    await expect.poll(async () => (await journal(page, answerDatabase, questionCaller)).some(entry => entry.command.requestId === authored?.command.requestId)).toBe(false);
    await expect(staleRetry.locator(`.plugin-clarifications-panel [data-saved-id="${authored!.command.requestId}"]`)).toHaveCount(1);
    await staleAnswer.getByRole('button', { name: 'Retry original', exact: true }).click();
    await expect(staleAnswer).toHaveCount(0);
    expect(staleAnswerCommands).toBe(0);
    expect(await journal(page, answerDatabase, questionCaller)).toHaveLength(0);
    expect(JSON.stringify(await browserRows(page, 'helmsman.composition-layouts', 'layouts'))).toContain(authored!.command.requestId);
    await resultWriter.close(); await staleRetry.close(); await page.reload();
    await expect(questions.getByRole('button', { name: 'Refresh questions', exact: true })).toBeEnabled();
    await expect(page.locator('#boot')).toBeHidden({ timeout: 15_000 });
    await questions.getByRole('heading', { name: 'Agent questions', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('authored-questions-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await questions.getByRole('heading', { name: 'Agent questions', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('authored-questions-mobile.png') });
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});

test('authored global contact panel reconciles create after restart and updates the same contact', async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const host = await fixture({ distribution: process.env.HELMSMAN_AUTHORED_CLARIFICATION_DISTRIBUTION });
  host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  const headers = { 'X-Helmsman-Contribution': contactCaller };
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await installQuestions(host); await host.installAuthorPackage('plugin-sources/suggested-contacts', contactPackage);
    let origin = await host.start();
    await page.goto(`${origin}/plugins/${questionPackage}/page?repo=org/a`);
    const contacts = page.locator('.plugin-suggested-contacts');
    const create = contacts.getByRole('form', { name: 'Create global contact', exact: true });
    await create.getByRole('textbox', { name: 'Name', exact: true }).fill('Authored reviewer');
    await create.getByRole('textbox', { name: 'Address', exact: true }).fill('reviewer-account');
    await page.route('**/api/suggested-contact-admin/commands', async route => { expect((await route.fetch()).ok()).toBe(true); await route.abort('failed'); }, { times: 1 });
    await create.getByRole('button', { name: 'Create global contact', exact: true }).click();
    await expect(contacts.getByRole('button', { name: 'Check receipt', exact: true })).toBeVisible();
    const original = (await journal(page, contactDatabase, contactCaller))[0]; expect(original?.receipt).toBeNull();
    expect(original?.command).toMatchObject({ scope: 'global', kind: 'create', name: 'Authored reviewer', address: 'reviewer-account' });
    host.env.HELMSMAN_PORT = new URL(origin).port; origin = await host.start();
    await page.goto(`${origin}/plugins/${questionPackage}/page?repo=org/b`);
    await expect(page.locator('.repo-select')).toHaveValue('org/b');
    const staleRetry = await page.context().newPage();
    await staleRetry.goto(`${origin}/plugins/${questionPackage}/page?repo=org/b`);
    const staleContact = staleRetry.locator(`.plugin-suggested-contacts [data-request-id="${original!.command.requestId}"]`);
    await expect(staleContact.getByRole('button', { name: 'Retry original', exact: true })).toBeVisible();
    let staleContactCommands = 0;
    staleRetry.on('request', request => { if (new URL(request.url()).pathname === '/api/suggested-contact-admin/commands' && request.method() === 'POST') staleContactCommands++; });
    await contacts.getByRole('button', { name: 'Check receipt', exact: true }).click();
    await expect.poll(async () => (await journal(page, contactDatabase, contactCaller))[0]?.receipt?.status).toBe('succeeded');
    await guardResultBeforeAcknowledgment(page, contactDatabase, contactCaller, original!.command.requestId);
    await contacts.getByRole('button', { name: 'Save result and dismiss request', exact: true }).click();
    await expect.poll(async () => (await journal(page, contactDatabase, contactCaller)).length).toBe(0);
    await expect(staleRetry.locator(`.plugin-suggested-contacts [data-saved-id="${original!.command.requestId}"]`)).toHaveCount(1);
    await staleContact.getByRole('button', { name: 'Retry original', exact: true }).click();
    await expect(staleContact).toHaveCount(0);
    expect(staleContactCommands).toBe(0);
    expect(await journal(page, contactDatabase, contactCaller)).toHaveLength(0);
    await staleRetry.close();
    const list = await request.get(`${origin}/api/suggested-contact-admin?scope=global&limit=100`, { headers });
    const created = (await list.json()).items; expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ id: original?.command.id, revision: 1, name: 'Authored reviewer' });
    await contacts.getByRole('button', { name: 'Edit contact', exact: true }).click();
    const update = contacts.getByRole('form', { name: 'Edit global contact', exact: true });
    await update.getByRole('textbox', { name: 'Name', exact: true }).fill('Updated authored reviewer');
    await update.getByRole('textbox', { name: 'Address', exact: true }).fill('updated-account');
    await update.getByRole('checkbox', { name: 'Enabled', exact: true }).uncheck();
    await update.getByRole('button', { name: 'Save global contact', exact: true }).click();
    await expect.poll(async () => (await journal(page, contactDatabase, contactCaller))[0]?.receipt?.status).toBe('succeeded');
    const updated = (await journal(page, contactDatabase, contactCaller))[0];
    expect(updated?.command).toMatchObject({ kind: 'update', id: original?.command.id, expectedRevision: 1, enabled: false });
    await guardResultBeforeAcknowledgment(page, contactDatabase, contactCaller, updated!.command.requestId);
    await contacts.getByRole('button', { name: 'Save result and dismiss request', exact: true }).click();
    await expect.poll(async () => (await journal(page, contactDatabase, contactCaller)).length).toBe(0);
    const current = await request.get(`${origin}/api/suggested-contact-admin/${String(original?.command.id)}?scope=global`, { headers });
    expect(await current.json()).toMatchObject({ id: original?.command.id, revision: 2, name: 'Updated authored reviewer', address: 'updated-account', enabled: false, createdAt: created[0].createdAt });
    await contacts.getByRole('heading', { name: 'Suggested contacts — global', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('authored-contacts-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await contacts.getByRole('heading', { name: 'Suggested contacts — global', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('authored-contacts-mobile.png') });
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});
