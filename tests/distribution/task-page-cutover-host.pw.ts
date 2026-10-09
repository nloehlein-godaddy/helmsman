import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture } from './isolated-fixture';

async function savedComposition(page: Page, compositionId: string) {
  return page.evaluate(id => new Promise<{ layout: { revision: number; instances: { contributionId: string; state: Record<string, { version: number; value: unknown }> }[] }; archive: unknown }>((resolve, reject) => {
    const opening = indexedDB.open('helmsman.composition-layouts', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result; const transaction = database.transaction(['layouts', 'migrations'], 'readonly');
      const layout = transaction.objectStore('layouts').get(id); const archive = transaction.objectStore('migrations').get(id);
      transaction.oncomplete = () => { database.close(); resolve({ layout: layout.result, archive: archive.result }); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }), compositionId);
}

test('default task pages use authored services, preserve legacy preferences and survive explicit replacement without fallback', async ({ page, request }) => {
  test.setTimeout(150_000);
  const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK';
  const errors: string[] = []; const legacyReads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', value => {
    const path = new URL(value.url()).pathname;
    if (value.method() === 'GET' && /^\/api\/(todos|triage|bugs)(\/|$)/.test(path)) legacyReads.push(path);
  });
  const raw = {
    'helmsman.triageFilters': ' {"priorities":["P1","P4"],"days":7,"retained":true} ',
    'helmsman.triagePageSize': '25',
    'helmsman.collapsed': '["triage:backlog","triage:todo","triage:mine","unknown:future"]',
  };
  try {
    const author = join(host.app, 'plugin-sources/cutover-triage-source'); await mkdir(author);
    await writeFile(join(author, 'package.json'), '{"type":"module"}');
    await writeFile(join(author, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: [], noEmitOnError: true }, include: ['backend.ts'] }));
    await writeFile(join(author, 'plugin-package.json'), JSON.stringify({ packageVersion: 1,
      manifest: { manifestVersion: 1, id: 'example.cutover-source', version: '0.1.0', sdkVersion: 1, pages: [] },
      node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {}, backend: { entry: 'backend.js',
        provides: [{ id: 'helmsman/task-source', version: 1, localId: 'tasks' }], settings: {}, storageVersion: 1,
        taskSources: { tasks: { identityFormats: ['example.cutover/v1'], effectIds: [], commandIds: [], access: [], readViews: ['triage'] } } } }));
    await writeFile(join(author, 'backend.ts'), `import type { PluginBackendModule, TaskSourceProviderV1 } from '@helmsman/plugin-sdk';
const provider: TaskSourceProviderV1 = {
  async identify() { return { version: 1, level: 'operator-seeded', authority: null, verifiedAt: new Date().toISOString(), proof: {} }; },
  async list() { return { items: [], nextCursor: null }; }, async load() { return null; }, async lookup() { return null; },
  async planClaim() { throw new Error('Read-only source'); }, async planCompletion() { throw new Error('Read-only source'); },
  async planAbort() { throw new Error('Read-only source'); }, async validateAdoption() { throw new Error('No adoption'); }, effects: {},
  async listTriage(input, context) { return { version: 1, repo: input.repo, group: input.group,
    items: input.priorities.includes(1) ? [{ ref: { sourceId: context.instance.sourceId, externalId: input.group }, revision: '1',
      displayKey: 'TASK-1', title: 'Cutover ' + input.group, url: null, state: 'ready', priority: 1, updatedAt: input.until }] : [],
    nextCursor: null, quality: 'complete' }; }
}; const backend: PluginBackendModule = { activate(context) { context.registerTaskSource('tasks', provider); } }; export default backend;
`);
    await host.installAuthorPackage('plugin-sources/cutover-triage-source');
    const inventory = JSON.parse(await host.cli('list'));
    const artifact = inventory.plugins.find((value: { id: string }) => value.id === 'example.cutover-source');
    expect(artifact?.hash).toMatch(/^[a-f\d]{64}$/);
    await host.start(); await host.stop();
    const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(host.app, `server/helmsman/${name}.js`)).href);
    await host.script('seed-cutover-source.mjs', `import { openPersistence } from ${moduleUrl('persistence')};
import { openTaskSourceStore, writeTaskSource } from ${moduleUrl('task-sources/store')};
const persistence = openPersistence(process.env.HELMSMAN_DB); try {
  const store = openTaskSourceStore(persistence); const value = store.provision({ provisioningKey: 'cutover-source', label: 'Cutover source', storageLayout: 'remote', distinctUnverifiedSource: true,
    identityEvidence: { version: 1, level: 'operator-seeded', authority: null, verifiedAt: new Date().toISOString(), proof: {} },
    binding: { providerId: 'example.cutover-source/tasks', pluginId: 'example.cutover-source', artifactHash: ${JSON.stringify(artifact.hash)}, contractVersion: 1, connectionId: null, credentialHandle: null },
    settings: {}, allowedRepos: ['org/a'] });
  persistence.transaction(() => writeTaskSource(store, { ...value.source, conversionReady: true }));
} finally { persistence.close(); }
`);
    let origin = await host.start(); host.env.HELMSMAN_PORT = new URL(origin).port;
    await page.addInitScript(values => {
      if (localStorage.getItem('cutover-preferences-seeded')) return;
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
      sessionStorage.setItem('helmsman.todos.pending-mutations.v1', '[]');
      localStorage.setItem('cutover-preferences-seeded', 'true');
    }, raw);
    await page.goto(`${origin}/triage?repo=org/a`);
    const triage = page.locator('[data-panel-instance="triage"] .plugin-triage');
    await expect(triage.getByRole('checkbox', { name: 'Priority P1', exact: true })).toBeChecked();
    await expect(triage.getByRole('checkbox', { name: 'Priority P0', exact: true })).not.toBeChecked();
    await expect(triage.getByRole('combobox', { name: 'Last updated', exact: true })).toHaveValue('7');
    await expect(triage.getByRole('combobox', { name: 'Tickets per column', exact: true })).toHaveValue('25');
    for (const title of ['Unassigned · Backlog', 'Unassigned · To Do', 'Mine · Open']) await expect(triage.getByRole('button', { name: `Expand group ${title}`, exact: true })).toBeVisible();
    const migrated = await savedComposition(page, 'helmsman/triage-page');
    expect(migrated.archive).toEqual({ compositionId: 'helmsman/triage-page', version: 1, raw });
    expect(migrated.layout.instances[0]?.state['helmsman.triage/panel']?.value).toMatchObject({ priorities: [1, 4], days: 7, pageSize: 25, legacyCollapsedGroups: ['unassigned-backlog', 'unassigned-todo', 'mine-open'] });
    for (const [pane, title] of [['backlog', 'Unassigned · Backlog'], ['todo', 'Unassigned · To Do'], ['mine', 'Mine · Open']]) {
      await page.goto(`${origin}/triage?repo=org/a&pane=${pane}`);
      await expect(triage.getByRole('button', { name: `Collapse group ${title}`, exact: true })).toBeVisible();
    }
    expect(await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), Object.keys(raw))).toEqual(raw);
    await page.goto(`${origin}/todos?repo=org/a&pane=new`);
    await expect(page.locator('[data-panel-instance="todos"] .plugin-todos').getByRole('textbox', { name: 'Title', exact: true })).toBeVisible();
    await page.goto(`${origin}/todos?repo=org/a&pane=list`);
    await expect(page.getByRole('searchbox', { name: 'Search Todos', exact: true })).toBeFocused();
    expect(await page.evaluate(() => sessionStorage.getItem('helmsman.todos.pending-mutations.v1'))).toBe('[]');
    await page.goto(`${origin}/bugs?repo=org/a`);
    await expect(page.locator('[data-panel-instance="bugs"] .plugin-bugs')).toContainText('No source provides bug metrics in this scope.');
    await page.goto(`${origin}/config?repo=org/a`);
    const settingsLink = page.getByRole('navigation', { name: 'Config pages' }).getByRole('link', { name: 'Task sources', exact: true });
    await expect(settingsLink).toHaveAttribute('href', '/source-settings?repo=org%2Fa'); await settingsLink.click();
    await expect(page.locator('[data-panel-instance="settings"] .plugin-source-settings')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Panel galleon', exact: true })).toHaveValue('org/a');
    for (const [id, route, marker] of [['helmsman.todos-ui', 'todos', '.plugin-todos'], ['helmsman.triage', 'triage', '.plugin-triage'], ['helmsman.bugs', 'bugs', '.plugin-bugs'], ['helmsman.source-settings', 'source-settings', '.plugin-source-settings']]) {
      await host.cli('disable', id!); await page.goto(`${origin}/${route}?repo=org/a`);
      await expect(page.getByRole('heading', { name: 'Page unavailable', exact: true })).toBeVisible(); await expect(page.locator(marker!)).toHaveCount(0);
      await host.cli('enable', id!); await page.reload(); await expect(page.locator(marker!).first()).toBeVisible();
    }
    const authorPage = join(host.app, 'plugin-sources/triage/page.ts');
    await writeFile(authorPage, (await readFile(authorPage, 'utf8')).replace("node('h1', 'Triage')", "node('h1', 'Independent Triage replacement')"));
    await host.installAuthorPackage('plugin-sources/triage', 'example.cutover-triage');
    await host.cli('select', 'helmsman/triage-page', 'example.cutover-triage/page');
    await page.goto(`${origin}/triage?repo=org/a`); await expect(page.getByRole('heading', { name: 'Independent Triage replacement', exact: true })).toBeVisible();
    await host.cli('disable', 'example.cutover-triage'); await page.reload();
    await expect(page.getByRole('heading', { name: 'Page unavailable', exact: true })).toBeVisible(); await expect(page.locator('.plugin-triage')).toHaveCount(0);
    const catalog = await (await request.get(`${origin}/api/plugins/catalog`)).json();
    expect(catalog.bindings['helmsman/triage-page']).toBe('example.cutover-triage/page');
    await host.cli('enable', 'example.cutover-triage'); await page.reload();
    await expect(page.getByRole('heading', { name: 'Independent Triage replacement', exact: true })).toBeVisible();
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open('helmsman.composition-layouts', 1); opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result; const transaction = database.transaction('layouts', 'readwrite'); const table = transaction.objectStore('layouts');
        const read = table.get('helmsman/triage-page'); read.onsuccess = () => table.put({ ...read.result, revision: read.result.revision + 1, instances: [], columns: [] });
        transaction.oncomplete = () => { database.close(); resolve(); }; transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    }));
    await page.reload(); await expect(page.getByText('No visible panels. Choose Edit page to add or show a panel.', { exact: true })).toBeVisible();
    await host.cli('select', 'helmsman/triage-page', 'default'); await page.reload();
    await expect(page.getByRole('heading', { name: 'Triage', exact: true })).toBeVisible(); await expect(page.getByRole('tabpanel', { name: 'Triage', exact: true }).locator('[data-panel-instance]')).toHaveCount(0);
    origin = await host.start(); await page.goto(`${origin}/triage?repo=org/a&pane=mine`);
    await expect(page.getByText('No visible panels. Choose Edit page to add or show a panel.', { exact: true })).toBeVisible();
    await expect(page.getByText(/The requested panel .* is not present in this layout/)).toBeVisible();
    const retained = await savedComposition(page, 'helmsman/triage-page');
    expect(retained.layout.instances).toEqual([]); expect(retained.archive).toEqual(migrated.archive);
    expect(legacyReads).toEqual([]); expect(errors).toEqual([]); expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});
