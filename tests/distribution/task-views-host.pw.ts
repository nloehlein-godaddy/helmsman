import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, sourceRoot } from './isolated-fixture';

test('source-denied independent task views preserve scope, partial groups and metric quality across disablement and restart', async ({ page, request }) => {
  test.setTimeout(120_000); const host = await fixture(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
  try {
    await expect(host.script('deny-view-checkout.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/jira/views.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await host.installAuthorPackage('plugin-sources/jira', 'example.independent-jira');
    await host.installAuthorPackage('plugin-sources/triage', 'example.triage-view');
    await host.installAuthorPackage('plugin-sources/bugs', 'example.bugs-view');
    const author = join(host.app, 'plugin-sources/taskviews-proof'); await mkdir(author);
    await writeFile(join(author, 'package.json'), '{"type":"module"}');
    await writeFile(join(author, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: [], noEmitOnError: true }, include: ['backend.ts', 'page.ts'] }));
    await writeFile(join(author, 'plugin-package.json'), JSON.stringify({ packageVersion: 1,
      manifest: { manifestVersion: 2, id: 'example.taskviews', version: '0.1.0', sdkVersion: 1,
        pages: [{ id: 'page', title: 'Independent task views', slots: ['helmsman/costs-page'], panes: [], requires: [{ id: 'helmsman/task-read', version: 1 }, { id: 'helmsman/task-views-read', version: 1 }] }], panels: [] },
      node: { minMajor: 22, maxMajorExclusive: 30 }, entries: { page: 'page.js' }, panelEntries: {}, backend: { entry: 'backend.js',
        provides: [{ id: 'helmsman/task-source', version: 1, localId: 'tasks' }], taskSources: { tasks: { identityFormats: ['example.task/v1'], effectIds: [], commandIds: [], access: [], readViews: ['triage', 'bugs'] } }, settings: {}, storageVersion: 1 } }));
    await writeFile(join(author, 'backend.ts'), `import type { PluginBackendModule, TaskSourceProviderV1 } from '@helmsman/plugin-sdk';
const source: TaskSourceProviderV1 = {
  async identify() { return { version: 1, level: 'operator-seeded', authority: null, verifiedAt: new Date().toISOString(), proof: {} }; },
  async list() { return { items: [], nextCursor: null }; }, async lookup() { return null; },
  async load(ref, context) {
    const repo = context.repo; if (!repo || ref.externalId !== repo.replace('/', '-')) return null;
    return { version: 1, ref, revision: '1', displayKey: 'TASK-1', title: 'Scoped ' + repo, repo, url: null, state: 'ready', priority: 1,
      requirements: { description: 'Description for ' + repo + ' <img src=x onerror=alert(1)>', acceptanceCriteria: [], links: [] }, providerData: null };
  },
  async planClaim() { throw new Error('No effects'); }, async planCompletion() { throw new Error('No effects'); }, async planAbort() { throw new Error('No effects'); }, async validateAdoption() { throw new Error('No adoption'); }, effects: {},
  async listTriage(input, context) {
    const unavailable = input.group === 'unassigned-backlog'; const included = input.priorities.includes(1); const suffix = input.cursor ? '-second' : '';
    return { version: 1, repo: input.repo, group: input.group, items: unavailable || !included ? [] : [{ ref: { sourceId: context.instance.sourceId, externalId: input.repo.replace('/', '-') + suffix }, revision: '1', displayKey: 'TASK-1' + suffix, title: 'Scoped ' + input.repo + suffix, url: null, state: 'ready', priority: 1, updatedAt: input.until }], nextCursor: !unavailable && included && !input.cursor ? 'next-page' : null, quality: unavailable ? 'unavailable' : 'partial' };
  },
  async readBugs(input, context) {
    const known = { value: 25000, quality: 'approximate' as const }; const unknown = { value: null, quality: 'unavailable' as const };
    return { version: 1, repo: input.repo, asOf: input.asOf, open: known, createdLast7d: unknown, completedLast7d: known, pastSla: unknown,
      rows: [{ ref: { sourceId: context.instance.sourceId, externalId: 'bug-1' }, displayKey: 'BUG-1', title: 'Independent bug ' + input.repo, url: null, priority: 'P1', severity: 'S2 - Major', dueAt: '2026-09-19', createdAt: input.asOf }], rowsQuality: 'partial', oldest: null, oldestQuality: 'unavailable', resolutionP75: { days: 4.5, sampleSize: 100, population: known, quality: 'partial', capped: true } };
  }
}; const backend: PluginBackendModule = { activate(context) { context.registerTaskSource('tasks', source); } }; export default backend;
`);
    await writeFile(join(author, 'page.ts'), `import type { PluginPageModule, PluginPageState } from '@helmsman/plugin-sdk';
const page: PluginPageModule = { mount(container, context) {
  const heading = document.createElement('h1'); heading.textContent = 'Independent task views'; const output = document.createElement('pre'); output.dataset.views = '';
  const button = document.createElement('button'); button.textContent = 'Refresh views'; container.replaceChildren(heading, button, output); let sequence = 0;
  async function refresh() { const generation = ++sequence; try {
    const tasks = context.services?.tasks; const taskViews = context.services?.taskViews; if (!tasks || !taskViews) throw new Error('Required services unavailable');
    const discovery = await tasks.discover(); if (discovery.status !== 'available') throw new Error(discovery.reason);
    const candidates = discovery.value.galleons.flatMap(galleon => galleon.sources.status === 'available' ? galleon.sources.value : []);
    const selection = candidates.find(source => source.label === 'Independent views'); if (!selection) throw new Error('Source unavailable');
    const common = { ...selection, priorities: [1], updatedSince: null, until: new Date().toISOString(), cursor: null, limit: 10 };
    const results = await Promise.all([taskViews.triage({ ...common, group: 'unassigned-backlog' }), taskViews.triage({ ...common, group: 'mine-open' }), taskViews.bugs(selection)]);
    if (generation === sequence) output.textContent = JSON.stringify(results);
  } catch (error) { if (generation === sequence) output.textContent = error instanceof Error ? error.message : 'Unavailable'; } }
  button.addEventListener('click', () => void refresh()); void refresh(); return { update(_state: PluginPageState) { void refresh(); }, dispose() { sequence++; container.replaceChildren(); } };
} }; export default page;
`);
    await host.installAuthorPackage('plugin-sources/taskviews-proof'); await host.cli('select', 'helmsman/costs-page', 'example.taskviews/page');
    const inventory = JSON.parse(await host.cli('list')); const artifact = inventory.plugins.find((plugin: { id: string }) => plugin.id === 'example.taskviews'); expect(artifact?.hash).toMatch(/^[a-f\d]{64}$/);
    await host.start(); await host.stop();
    const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(host.app, `server/helmsman/${name}.js`)).href);
    const selected = JSON.parse(await host.script('seed-task-views.mjs', `import { openPersistence } from ${moduleUrl('persistence')}; import { openDb } from ${moduleUrl('db')}; import { openTaskSourceStore, writeTaskSource } from ${moduleUrl('task-sources/store')};
      const persistence=openPersistence(process.env.HELMSMAN_DB); try { const store=openTaskSourceStore(persistence);
      const value=store.provision({ provisioningKey:'independent-views',label:'Independent views',storageLayout:'remote',distinctUnverifiedSource:true,
        identityEvidence:{version:1,level:'operator-seeded',authority:null,verifiedAt:new Date().toISOString(),proof:{}},
        binding:{providerId:'example.taskviews/tasks',pluginId:'example.taskviews',artifactHash:${JSON.stringify(artifact.hash)},contractVersion:1,connectionId:null,credentialHandle:null},settings:{},allowedRepos:['org/a','org/b'] });
      persistence.transaction(()=>writeTaskSource(store,{...value.source,conversionReady:true}));
      const db=openDb(persistence.sql); db.insertRun({id:'related-a',repo:'org/a',ticketId:'Same display key is insufficient',adapter:'codex',status:'succeeded',attempt:1,prNumber:null,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),costUsd:null,worktreePath:null});
      for(const externalId of ['org-a','org-b']) store.reserveWork({ref:{sourceId:value.instance.sourceId,externalId},admissionId:'related-'+externalId,runId:'related-a',instanceId:value.instance.id,expectedSourceRevision:value.source.revision,expectedInstanceRevision:1});
      console.log(JSON.stringify(value.instance)); } finally { persistence.close(); }`));
    let origin = await host.start(); await page.goto(`${origin}/outcomes?repo=org/a`);
    const output = page.locator('[data-views]'); await expect(output).toContainText('Scoped org/a'); await expect(output).not.toContainText('Scoped org/b');
    let results = JSON.parse(await output.innerText()); expect(results[0]).toMatchObject({ status: 'available', value: { page: { quality: 'unavailable', items: [] } } });
    expect(results[1]).toMatchObject({ status: 'available', value: { page: { quality: 'partial' } } });
    expect(results[2]).toMatchObject({ status: 'available', value: { report: { open: { value: 25000, quality: 'approximate' }, createdLast7d: { value: null, quality: 'unavailable' }, resolutionP75: { sampleSize: 100, capped: true } } } });
    await page.clock.setFixedTime(new Date('2026-09-20T12:00:00.000Z'));
    await page.goto(`${origin}/plugins/example.triage-view/page?repo=org/a`);
    const triage = page.locator('.plugin-triage').last(); await expect(triage).toContainText('Scoped org/a');
    await expect(triage).toContainText('This group is unavailable.'); await expect(triage).toContainText('Partial coverage.');
    await expect(triage.getByRole('link', { name: /Open related (run|voyage)/ }).first()).toHaveAttribute('href', /repo=org%2Fa.*run=related-a/);
    await triage.getByRole('button', { name: 'Next page for Mine · Open', exact: true }).click(); await expect(triage).toContainText('Scoped org/a-second');
    await triage.getByRole('button', { name: 'Previous page for Mine · Open', exact: true }).click(); await expect(triage).not.toContainText('Scoped org/a-second');
    await triage.getByRole('checkbox', { name: 'Priority P1', exact: true }).uncheck(); await expect(triage).not.toContainText('Scoped org/a');
    await page.reload(); await expect(triage.getByRole('checkbox', { name: 'Priority P1', exact: true })).not.toBeChecked();
    await triage.getByRole('checkbox', { name: 'Priority P1', exact: true }).check(); await expect(triage).toContainText('Scoped org/a');
    const disclosure = triage.getByRole('button', { name: /description/i }).first();
    await disclosure.focus(); await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(triage).toContainText('Description for org/a <img src=x onerror=alert(1)>');
    await expect(triage.locator('img')).toHaveCount(0);
    await page.reload();
    await expect(triage).toContainText('Description for org/a <img src=x onerror=alert(1)>');
    await expect(triage).toHaveScreenshot('triage-authored-groups.png');
    await page.goto(`${origin}/plugins/example.triage-view/page?repo=org/b`); await expect(triage).toContainText('Scoped org/b');
    await expect(triage).not.toContainText('Description for org/a');
    await expect(triage.getByRole('link', { name: /Open related (run|voyage)/ })).toHaveCount(0);
    await page.goto(`${origin}/plugins/example.bugs-view/page?repo=org/b`);
    const bugs = page.locator('.plugin-bugs').last(); await expect(bugs).toContainText('Independent bug org/b');
    await expect(bugs).toContainText('≈ 25,000'); await expect(bugs).toContainText('Unavailable'); await expect(bugs).toContainText('100 sampled');
    await expect(bugs.getByLabel('Severity S2 - Major', { exact: true })).toHaveText('S2');
    await expect(bugs).toHaveScreenshot('bugs-authored-metrics.png', { mask: [bugs.getByText(/^Observed /)] });
    await page.goto(`${origin}/outcomes?repo=org/b`); await expect(output).toContainText('Scoped org/b'); await expect(output).not.toContainText('Scoped org/a');
    const disabled = await request.post(`${origin}/api/task-sources/${selected.id}/enablement`, { data: { instanceRevision: 1, desiredEnabled: false } }); expect(disabled.ok()).toBe(true);
    await page.getByRole('button', { name: 'Refresh views', exact: true }).click(); await expect(output).toContainText('disabled');
    results = JSON.parse(await output.innerText()); expect(results).toEqual(Array.from({ length: 3 }, () => ({ status: 'unavailable', reason: 'disabled' })));
    const enabled = await request.post(`${origin}/api/task-sources/${selected.id}/enablement`, { data: { instanceRevision: 2, desiredEnabled: true } }); expect(enabled.ok()).toBe(true);
    await page.getByRole('button', { name: 'Refresh views', exact: true }).click(); await expect(output).toContainText('Scoped org/b');
    host.env.HELMSMAN_PORT = new URL(origin).port; origin = await host.start(); await page.goto(`${origin}/outcomes?repo=org/b`); await expect(output).toContainText('25000');
    await host.cli('disable', 'example.taskviews'); await page.reload(); await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
    await host.cli('enable', 'example.taskviews'); origin = await host.start(); await page.goto(`${origin}/outcomes?repo=org/b`); await expect(output).toContainText('Scoped org/b');
    expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
    const commands = (await readFile(host.commandLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    expect(commands.every(command => command.endsWith(' worktree list --porcelain'))).toBe(true);
  } finally { await host.close(); }
});
