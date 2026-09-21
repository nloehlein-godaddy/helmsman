import { expect, test } from '@playwright/test';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, run } from './isolated-fixture';

const replacementId = 'example.priority-scheduling';

test('independent scheduling chooses work, records admission provenance and stays unavailable after disable/restart', async ({ page, request }) => {
  const host = await fixture(); host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER'; host.env.AUTO_CLAIM_INTERVAL_MS = '750';
  try {
    await host.installAuthorPackage('plugin-sources/scheduling', 'example.round-robin', { buildScript: true });
    const author = join(host.root, 'priority-author'); const output = join(author, 'dist');
    await mkdir(output, { recursive: true });
    await cp(join(host.app, 'sdk'), join(author, 'node_modules/@helmsman/plugin-sdk'), { recursive: true });
    await writeFile(join(author, 'package.json'), '{"type":"module"}');
    await writeFile(join(author, 'backend.ts'), `import type { PluginBackendModule, SchedulingCandidateV1 } from '@helmsman/plugin-sdk';
const plugin: PluginBackendModule = { activate(context) {
 let selected = false;
 context.registerScheduling('round-robin', { intervalMs: 500, async select(input, discovery) {
  if (selected) return null;
  let choice: SchedulingCandidateV1 | null = null;
  for (const source of [...input.sources].reverse()) {
   let cursor: string | null = null;
   do {
    discovery.signal.throwIfAborted();
    const page = await discovery.list({ instanceId: source.instanceId, cursor, limit: 1 });
    for (const candidate of page.items) if (!choice || (candidate.priority ?? -1) > (choice.priority ?? -1)) choice = candidate;
    cursor = page.nextCursor;
   } while (cursor !== null);
  }
  selected = choice !== null;
  return choice ? { candidateId: choice.candidateId } : null;
 } });
} }; export default plugin;`);
    await run(process.execPath, [join(host.root, 'toolchain/typescript/bin/tsc'), '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--outDir', output, '--noEmitOnError', join(author, 'backend.ts')], author, host.env);
    const descriptor = JSON.parse(await readFile(join(host.app, 'plugin-sources/scheduling/plugin-package.json'), 'utf8'));
    descriptor.manifest.id = replacementId;
    await writeFile(join(output, 'plugin-package.json'), JSON.stringify(descriptor));
    const archive = join(author, 'policy.hmp'); await host.cli('pack', output, archive); await host.cli('install', archive); await host.cli('enable', replacementId);
    await host.cli('select-scheduling', `${replacementId}/round-robin`);
    let origin = await host.start();
    const create = async (repo: string, title: string, priority: string) => {
      const response = await request.post(`${origin}/api/todos?requestId=${encodeURIComponent(title)}`, { data: { repo, title, priority, description: 'Isolated scheduling fixture; no real external commands.' } });
      expect(response.ok()).toBe(true); return (await response.json()).todo;
    };
    await create('org/a', 'Normally first', 'P1');
    const chosen = await create('org/a', 'Chosen by replacement', 'P3');
    await create('org/b', 'Outside enabled galleon', 'P4');
    await page.goto(`${origin}/config?repo=org/a`);
    await expect(page.locator('#boot')).toHaveCount(0);
    await expect(page.locator('#config-AGENT_ADAPTER')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Config', exact: true })).toBeVisible();
    await expect(page.locator('[data-key="AUTO_CLAIM_INTERVAL_MS"]')).toHaveCount(0);
    for (const [label, width] of [['desktop', 1440], ['mobile', 390]] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: `/tmp/helmsman-scheduling-config-${label}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    const config = await (await request.get(`${origin}/api/config`)).json(); expect(config.config).not.toHaveProperty('AUTO_CLAIM_INTERVAL_MS');
    expect((await request.put(`${origin}/api/config`, { data: { key: 'AUTO_CLAIM_INTERVAL_MS', value: '500' } })).status()).toBe(410);
    const database = JSON.stringify(pathToFileURL(join(host.app, 'node_modules/better-sqlite3/lib/index.js')).href);
    const inspect = () => host.script('inspect-scheduling.mjs', `import Database from ${database};
const sql = new Database(process.env.HELMSMAN_DB, { readonly: true });
try { console.log(JSON.stringify(sql.prepare('SELECT json FROM execution_admissions').all().map(row => JSON.parse(row.json)))); } finally { sql.close(); }`).then(value => JSON.parse(value) as Array<{ request: { ticketId: string; scheduling: unknown }; artifacts: Array<{ pluginId: string }> }>);
    expect((await request.post(`${origin}/api/repos/org%2Fa/auto-claim`, { data: { enabled: true } })).ok()).toBe(true);
    await expect.poll(async () => (await inspect()).length).toBe(1);
    await request.post(`${origin}/api/repos/org%2Fa/auto-claim`, { data: { enabled: false } });
    const admitted = await inspect();
    expect(admitted[0]?.request.ticketId).toBe(chosen.id);
    expect(JSON.stringify(admitted[0]?.request.scheduling)).toContain(`${replacementId}/round-robin`);
    expect(admitted[0]?.artifacts.some(value => value.pluginId === replacementId)).toBe(false);
    await host.stop(); await host.cli('disable', replacementId);
    const application = JSON.stringify(pathToFileURL(join(host.app, 'server/helmsman/application.js')).href);
    const blocked = await host.script('disabled-scheduling.mjs', `const { taskSourceRuntime } = await import(${application});
try { await taskSourceRuntime.schedule.next('org/a', AbortSignal.timeout(3000)); console.log('UNEXPECTED_AVAILABLE'); process.exit(1); }
catch (error) { console.log('EXPECTED_UNAVAILABLE:' + error.message); process.exit(0); }`);
    expect(blocked).toContain('EXPECTED_UNAVAILABLE:');
    expect(await inspect()).toEqual(admitted);
    await host.cli('select-scheduling', 'example.round-robin/round-robin');
    const restored = await host.script('replacement-scheduling.mjs', `const { taskSourceRuntime } = await import(${application});
const candidate = await taskSourceRuntime.schedule.next('org/a', AbortSignal.timeout(3000));
console.log('SCHEDULED:' + JSON.stringify(candidate)); process.exit(0);`);
    expect(restored).toContain('Normally first');
    origin = await host.start();
    const sourceState = await (await request.get(`${origin}/api/source-admin?repo=org/a`, { headers: { 'X-Helmsman-Contribution': 'helmsman.source-settings/panel' } })).json();
    expect(sourceState.runtimes[0].enabled).toBe(false);
  } finally { await host.close(); }
});
