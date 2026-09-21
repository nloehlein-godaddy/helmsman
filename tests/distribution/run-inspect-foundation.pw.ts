import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, sourceRoot } from './isolated-fixture';

test.use({ serviceWorkers: 'allow', acceptDownloads: true });

test('independent run inspection uses compiled scoped APIs and streams an actual full log through the production download worker', async ({ page, request }) => {
  test.setTimeout(90_000); const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const at = '2026-09-20T12:00:00.000Z'; const text = 'Unicode 🛟 and boundaries\n'.repeat(100000);
  try {
    await expect(host.script('prove-run-foundation-isolation.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/sdk.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    const author = join(host.app, 'plugin-sources/run-inspect-proof'); await mkdir(author);
    await writeFile(join(author, 'package.json'), '{"type":"module"}');
    await writeFile(join(author, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: [], noEmitOnError: true }, include: ['page.ts'] }));
    await writeFile(join(author, 'plugin-package.json'), JSON.stringify({ packageVersion: 1,
      manifest: { manifestVersion: 2, sdkVersion: 1, id: 'example.run-inspect-proof', version: '1.0.0',
        pages: [{ id: 'page', title: 'Independent run inspection', slots: [], panes: [], requires: [{ id: 'helmsman/run-inspect', version: 1 }, { id: 'helmsman/download', version: 1 }] }], panels: [] },
      node: { minMajor: 22, maxMajorExclusive: 30 }, entries: { page: 'page.js' }, panelEntries: {} }));
    await writeFile(join(author, 'page.ts'), `import type { PluginPageModule, RunInspectTargetV1 } from '@helmsman/plugin-sdk';
const page: PluginPageModule = { mount(container, context) {
  const inspect = context.services?.runInspect; const downloads = context.services?.downloads;
  if (!inspect || !downloads) throw new Error('Inspection services unavailable');
  const heading = document.createElement('h1'); heading.textContent = 'Independent run inspection';
  const details = document.createElement('pre'); details.dataset.inspection = '';
  const result = document.createElement('p'); result.dataset.downloadResult = '';
  const button = document.createElement('button'); button.textContent = 'Download full inspected log'; button.disabled = true;
  container.replaceChildren(heading, details, button, result); let target: RunInspectTargetV1 | null = null; let operation = new AbortController();
  async function refresh() {
    const resolved = await inspect!.resolve({ version: 1, runId: 'run-proof' }, operation.signal);
    if (resolved.status !== 'available') { details.textContent = JSON.stringify(resolved); return; }
    target = resolved.value.target;
    const history = await inspect!.history({ version: 1, repo: target.repo, kind: 'all', cursor: null, limit: 10 }, operation.signal);
    const preview = await inspect!.log({ version: 1, target, direction: 'backward', cursor: null, limit: 50 }, operation.signal);
    details.textContent = JSON.stringify({ resolved, history, preview }); button.disabled = false;
  }
  button.addEventListener('click', () => {
    const selected = target; if (!selected) return;
    void downloads.save({ filename: 'run-proof.log', contentType: 'text/plain; charset=utf-8', open: async signal => {
      const exported = await inspect.exportLog({ version: 1, target: selected }, signal);
      if (exported.status !== 'available') throw new Error('Export unavailable'); return exported.value.stream;
    } }, operation.signal).then(value => { result.textContent = JSON.stringify(value); });
  });
  void refresh(); return { update(state) { if (state.repo !== context.state.repo) { operation.abort(); button.disabled = true; } },
    refresh, dispose() { operation.abort(); container.replaceChildren(); } };
} }; export default page;
`);
    await host.installAuthorPackage('plugin-sources/run-inspect-proof');
    const dbUrl = pathToFileURL(join(host.app, 'server/helmsman/db.js')).href;
    await host.script('seed-inspection.mjs', `import { openDb } from ${JSON.stringify(dbUrl)};
const db=openDb(process.env.HELMSMAN_DB); try {
  for (const [id,repo] of [['run-proof','org/a'],['foreign-proof','org/b']]) db.insertRun({id,repo,ticketId:id,adapter:'codex',status:'succeeded',attempt:3,prNumber:null,startedAt:${JSON.stringify(at)},endedAt:${JSON.stringify(at)},costUsd:null,worktreePath:'/private/not-public'});
  db.appendEvent('run-proof','log',${JSON.stringify(text)},${JSON.stringify(at)});
  db.appendEvent('run-proof','log','tail',${JSON.stringify(at)});
} finally { db.close(); }`);
    const origin = await host.start();
    const worker = await request.get(`${origin}/plugin-download/worker.js`); expect(worker.ok()).toBe(true);
    expect(worker.headers()['content-type']).toMatch(/javascript/); expect(await worker.text()).toContain("'/plugin-download/file/'"); expect(await worker.text()).not.toContain('<!doctype html>');
    const resolved = await request.get(`${origin}/api/run-inspect/resolve?repo=org%2Fa&runId=run-proof`); expect(resolved.ok()).toBe(true);
    expect(await resolved.json()).toMatchObject({ version: 1, target: { repo: 'org/a', runId: 'run-proof', expectedAttempt: 3 } });
    const foreign = await request.get(`${origin}/api/run-inspect/resolve?repo=org%2Fa&runId=foreign-proof`); expect(foreign.status()).toBe(404); expect(await foreign.text()).not.toContain('org/b');
    const params = 'repo=org%2Fa&scopeRepo=org%2Fa&expectedAttempt=3';
    const stale = await request.get(`${origin}/api/run-inspect/run-proof/log?${params.replace('expectedAttempt=3', 'expectedAttempt=2')}&direction=backward&limit=10`);
    expect(stale.status()).toBe(409); expect(await stale.json()).toEqual({ error: 'attempt-changed' });
    const deniedExport = await request.get(`${origin}/api/run-inspect/run-proof/export?${params.replace('scopeRepo=org%2Fa', 'scopeRepo=org%2Fb')}`); expect(deniedExport.status()).toBe(404);
    const staleExport = await request.get(`${origin}/api/run-inspect/run-proof/export?${params.replace('expectedAttempt=3', 'expectedAttempt=2')}`); expect(staleExport.status()).toBe(409);
    await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }));
    await page.goto(`${origin}/plugins/example.run-inspect-proof/page?repo=org/a`); await expect(page.getByRole('heading', { name: 'Independent run inspection', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download full inspected log', exact: true })).toBeEnabled();
    const details = JSON.parse(await page.locator('[data-inspection]').innerText());
    expect(details.history).toMatchObject({ status: 'available', value: { total: 1, totalQuality: 'exact', coverage: 'insertion-bounded-current-state' } });
    expect(details.preview).toMatchObject({ status: 'available', value: { target: { expectedAttempt: 3 }, provenance: 'run-wide', events: [{ truncated: true }, { text: 'tail', truncated: false }] } });
    expect(JSON.stringify(details)).not.toContain('/private/not-public');
    const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download full inspected log', exact: true }).click(); const download = await downloading;
    const path = await download.path(); if (!path) throw new Error('No completed log'); const actual = await readFile(path, 'utf8');
    const expected = `[${at}] log: ${text}\n[${at}] log: tail\n`; expect(actual).toBe(expected);
    await expect(page.locator('[data-download-result]')).toHaveText(JSON.stringify({ status: 'delivered-to-browser', bytesWritten: Buffer.byteLength(expected) }));
    expect(download.suggestedFilename()).toBe('run-proof.log');
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(value => new URL(value.scope).pathname))).toEqual(['/plugin-download/']);
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});
