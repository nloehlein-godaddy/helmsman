import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, sourceRoot } from './isolated-fixture';
import { seedClarificationProof } from './clarification-fixture';

test('SDK-only clarification and contact commands preserve receipts across response loss and production restart', async ({ page, request }) => {
  test.setTimeout(120_000);
  const host = await fixture({ distribution: process.env.HELMSMAN_CLARIFICATION_TEST_DISTRIBUTION });
  host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  const caller = 'example.clarification-proof/page'; const headers = { 'X-Helmsman-Contribution': caller };
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(host.app, `server/helmsman/${name}.js`)).href);
  try {
    await expect(host.script('prove-clarification-isolation.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/sdk.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    const author = join(host.app, 'plugin-sources/clarification-proof'); await mkdir(author);
    await writeFile(join(author, 'package.json'), '{"type":"module"}');
    await writeFile(join(author, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: [], noEmitOnError: true }, include: ['page.ts'] }));
    await writeFile(join(author, 'plugin-package.json'), JSON.stringify({ packageVersion: 1,
      manifest: { manifestVersion: 2, sdkVersion: 1, id: 'example.clarification-proof', version: '1.0.0', pages: [{ id: 'page', title: 'Independent clarification proof', slots: [], panes: [],
        requires: ['clarification-read', 'clarification-command', 'suggested-contact-admin'].map(name => ({ id: `helmsman/${name}`, version: 1 })) }], panels: [] },
      node: { minMajor: 22, maxMajorExclusive: 30 }, entries: { page: 'page.js' }, panelEntries: {} }));
    await writeFile(join(author, 'page.ts'), `import type { PluginPageModule, ClarificationReadItemV1, SuggestedContactAdminContactV1 } from '@helmsman/plugin-sdk';
const page: PluginPageModule = { mount(container, context) {
  const reads = context.services?.clarifications; const commands = context.services?.clarificationCommands; const contacts = context.services?.suggestedContacts;
  if (!reads || !commands || !contacts) throw new Error('Clarification services unavailable');
  const heading = document.createElement('h1'); heading.textContent = 'Independent clarification proof';
  const output = document.createElement('pre'); output.dataset.proof = ''; const status = document.createElement('p'); status.dataset.status = '';
  const state: Record<string, unknown> = {}; let question: ClarificationReadItemV1 | null = null; let contact: SuggestedContactAdminContactV1 | null = null;
  const operation = new AbortController(); container.replaceChildren(heading, output, status);
  const show = () => { output.textContent = JSON.stringify(state); };
  async function pending() { state.answerPending = await commands!.pending(); state.contactPending = await contacts!.pending(); show(); }
  const add = (name: string, action: () => Promise<void>) => { const button = document.createElement('button'); button.textContent = name;
    button.onclick = () => { button.disabled = true; status.textContent = 'Working'; void action().then(() => { status.textContent = name + ' finished'; }).catch(error => { status.textContent = String(error); }).finally(() => { button.disabled = false; show(); }); }; container.append(button); };
  async function refresh() {
    const result = await reads!.load({ version: 1, repo: 'org/a', runId: 'run-proof', questionId: 'question-proof' }, operation.signal);
    state.question = result; if (result.status === 'available') question = result.value;
    state.questions = await reads!.list({ version: 1, repo: 'org/a', runId: 'run-proof', states: [], limit: 10, cursor: null }, operation.signal); await pending();
  }
  add('Answer question', async () => { const selected = question; if (!selected || selected.provenance.kind !== 'attempt-channel') throw new Error('Question unavailable');
    state.answerResult = await commands!.submit({ version: 1, repo: selected.repo, runId: selected.runId, questionId: selected.id,
      expectedAttempt: selected.provenance.attempt, expectedChannelId: selected.provenance.channelId, expectedQuestionRevision: selected.revision, answer: '  Ship it 🛟  ' }, operation.signal); await pending(); });
  add('Reconcile answer', async () => { const entry = (await commands!.pending())[0]; if (!entry) throw new Error('Missing original answer');
    state.answerResult = await commands!.receipt({ repo: entry.command.repo, requestId: entry.command.requestId }, operation.signal); await pending(); });
  add('Create contact', async () => { state.contactResult = await contacts!.submit({ version: 1, scope: 'global', kind: 'create', name: '  Reviewer  ', address: 'slack:reviewer', enabled: false }, operation.signal); await pending(); });
  add('Reconcile contact', async () => { const entry = (await contacts!.pending())[0]; if (!entry) throw new Error('Missing original contact');
    const result = await contacts!.receipt({ scope: 'global', requestId: entry.command.requestId }, operation.signal); state.contactResult = result;
    if (result.status === 'available' && result.value?.status === 'succeeded') contact = result.value.result; await pending(); });
  add('Update contact', async () => { if (!contact) throw new Error('Contact unavailable'); state.contactResult = await contacts!.submit({ version: 1, scope: 'global', kind: 'update', id: contact.id,
    expectedRevision: contact.revision, name: contact.name, address: 'phone:+15551234567', enabled: true }, operation.signal); await pending(); });
  add('Acknowledge answer', async () => { const entry = (await commands!.pending())[0]; if (!entry) throw new Error('Missing receipt');
    await commands!.acknowledge({ repo: entry.command.repo, requestId: entry.command.requestId }, operation.signal); await pending(); });
  add('Refresh proof', refresh);
  void refresh().catch(error => { status.textContent = String(error); });
  return { update() {}, refresh, dispose() { operation.abort(); container.replaceChildren(); } };
} }; export default page;
`);
    await host.installAuthorPackage('plugin-sources/clarification-proof');
    await host.start(); await host.stop();
    const seed = await seedClarificationProof(host);
    let origin = await host.start();
    const route = `${origin}/plugins/example.clarification-proof/page?repo=org/a`;
    await page.goto(route); await expect(page.getByRole('heading', { name: 'Independent clarification proof', exact: true })).toBeVisible();
    const state = async () => JSON.parse(await page.locator('[data-proof]').innerText() || '{}');
    await expect.poll(async () => (await state()).question?.value?.answerability?.available).toBe(true);
    expect((await state()).questions).toMatchObject({ status: 'available', value: { total: 2, items: expect.arrayContaining([
      expect.objectContaining({ id: 'legacy-proof', blocksPublication: true, provenance: { kind: 'legacy-unproven', attempt: null, channelId: null }, answerability: { available: false, reason: 'provenance-unknown' } }),
    ]) } });
    const denied = await request.get(`${origin}/api/clarification-read/question-proof?repo=org/a&runId=run-proof&scopeRepo=org/b`, { headers });
    expect(denied.status()).toBe(404);
    let answerCommand: Record<string, unknown> | undefined;
    await page.route('**/api/clarification-command', async intercepted => {
      answerCommand = intercepted.request().postDataJSON().command; const response = await intercepted.fetch(); expect(response.ok()).toBe(true); await intercepted.abort('failed');
    }, { times: 1 });
    await page.getByRole('button', { name: 'Answer question', exact: true }).click();
    await expect.poll(async () => (await state()).answerResult?.reason).toBe('connection-failed');
    expect(answerCommand).toMatchObject({ expectedAttempt: 1, expectedChannelId: seed.channelId, expectedQuestionRevision: 1, answer: 'Ship it 🛟' });
    const pendingAnswer = (await state()).answerPending[0]; expect(pendingAnswer.command).toEqual(answerCommand); expect(pendingAnswer.receipt).toBeNull();
    await page.reload(); await expect.poll(async () => (await state()).answerPending?.length).toBe(1);
    await page.getByRole('button', { name: 'Reconcile answer', exact: true }).click();
    await expect.poll(async () => (await state()).answerResult?.value?.status).toBe('succeeded');
    const accepted = (await state()).answerResult.value; expect(accepted).toMatchObject({ result: { questionId: 'question-proof', revision: 2, answer: 'Ship it 🛟' } });
    const replay = await request.post(`${origin}/api/clarification-command`, { headers, data: { command: answerCommand, scopeRepo: 'org/a' } }); expect(await replay.json()).toEqual(accepted);
    const stale = await request.post(`${origin}/api/clarification-command`, { headers, data: { command: { ...answerCommand, requestId: randomUUID(), answer: 'Different' }, scopeRepo: 'org/a' } });
    expect(await stale.json()).toMatchObject({ status: 'rejected', reason: 'revision-changed' });
    const changed = await request.post(`${origin}/api/clarification-command`, { headers, data: { command: { ...answerCommand, answer: 'Changed original' }, scopeRepo: 'org/a' } }); expect(changed.status()).toBe(409);
    let contactCommand: Record<string, unknown> | undefined;
    await page.route('**/api/suggested-contact-admin/commands', async intercepted => {
      contactCommand = intercepted.request().postDataJSON(); const response = await intercepted.fetch(); expect(response.ok()).toBe(true); await intercepted.abort('failed');
    }, { times: 1 });
    await page.getByRole('button', { name: 'Create contact', exact: true }).click();
    await expect.poll(async () => (await state()).contactResult?.reason).toBe('connection-failed');
    const pendingContact = (await state()).contactPending[0]; expect(pendingContact.command).toEqual(contactCommand); expect(pendingContact.receipt).toBeNull();
    await page.reload(); await expect.poll(async () => (await state()).contactPending?.length).toBe(1);
    await page.getByRole('button', { name: 'Reconcile contact', exact: true }).click();
    await expect.poll(async () => (await state()).contactResult?.value?.status).toBe('succeeded');
    const created = (await state()).contactResult.value;
    expect(created).toMatchObject({ result: { id: contactCommand?.id, revision: 1, name: 'Reviewer', address: 'slack:reviewer', enabled: false } });
    await page.getByRole('button', { name: 'Update contact', exact: true }).click();
    await expect.poll(async () => (await state()).contactResult?.value?.result?.revision).toBe(2);
    const updated = (await state()).contactResult.value; expect(updated.result).toMatchObject({ id: contactCommand?.id, enabled: true, address: 'phone:+15551234567', createdAt: created.result.createdAt });
    expect((await (await request.get(`${origin}/api/suggested-contact-admin?scope=global&limit=100`, { headers })).json()).items).toHaveLength(1);
    for (const path of ['/api/clarifications', '/api/clarifications/question-proof/answer', '/api/trusted-contacts']) {
      const response = await request.post(`${origin}${path}`, { data: { runId: 'run-proof', answer: 'Bypass', name: 'Bypass', address: 'Bypass' } }); expect(response.status()).toBe(410);
    }
    await page.getByRole('button', { name: 'Acknowledge answer', exact: true }).click(); await expect.poll(async () => (await state()).answerPending?.length).toBe(0);
    host.env.HELMSMAN_PORT = new URL(origin).port; origin = await host.start();
    const afterRestart = await request.get(`${origin}/api/clarification-command/receipts/${accepted.requestId}?repo=org/a&scopeRepo=org/a`, { headers }); expect(await afterRestart.json()).toEqual(accepted);
    const contactAfterRestart = await request.post(`${origin}/api/suggested-contact-admin/commands`, { headers, data: contactCommand }); expect(await contactAfterRestart.json()).toEqual(created);
    const currentContact = await request.get(`${origin}/api/suggested-contact-admin/${String(contactCommand?.id)}?scope=global`, { headers }); expect(await currentContact.json()).toEqual(updated.result);
    await host.stop();
    const stored = JSON.parse(await host.script('verify-clarification-proof.mjs', `
      import { openPersistence } from ${moduleUrl('persistence')};
      const persistence = openPersistence(process.env.HELMSMAN_DB);
      try { console.log(JSON.stringify({
        question: persistence.sql.prepare("SELECT q.state,q.answer,m.revision FROM clarifications q JOIN clarification_question_metadata m ON m.questionId=q.id WHERE q.id='question-proof'").get(),
        contacts: persistence.sql.prepare('SELECT COUNT(*) AS total FROM trusted_contacts').get().total,
        receiptSchemas: persistence.sql.prepare("SELECT owner,version FROM migration_ledger WHERE owner='core.public-clarification-receipts'").all(),
        answerReceipts: persistence.sql.prepare('SELECT COUNT(*) AS total FROM public_clarification_receipts').get().total,
        contactReceipts: persistence.sql.prepare('SELECT COUNT(*) AS total FROM public_suggested_contact_receipts').get().total
      })); } finally { persistence.close(); }
    `));
    expect(stored).toMatchObject({ question: { state: 'answered', answer: 'Ship it 🛟', revision: 2 }, contacts: 1, answerReceipts: 2, contactReceipts: 2,
      receiptSchemas: [{ owner: 'core.public-clarification-receipts', version: 1 }] });
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});
