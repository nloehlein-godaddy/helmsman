import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, sourceRoot } from './isolated-fixture';

const pluginId = 'example.pr-source-proof';
const headSha = 'a'.repeat(40);

test('manual PR preparation and Costs honor an independent source through disable and restart', async ({ request }) => {
  test.setTimeout(120_000);
  const host = await fixture();
  Object.assign(host.env, { REPO_PROJECT_MAP: 'org/a=TASK,org/b=OTHER,org/c=THIRD', GITHUB_TOKEN: 'fixture-token',
    GITHUB_PR_AUTHOR: 'author', RUN_HOST: 'detached', AGENT_MAX_ATTEMPTS: '1' });
  const privateCalls = join(host.root, 'private-pr-calls.log');
  try {
    await expect(host.script('deny-pr-source.mjs', `import {readFileSync} from 'node:fs';readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/sdk.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    const preload = join(host.root, 'deny-private-pr.mjs');
    await writeFile(preload, `import {appendFileSync} from 'node:fs';const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.hostname==='127.0.0.1'||url.hostname==='localhost')return original(input,init);appendFileSync(${JSON.stringify(privateCalls)},url.href+'\\n');throw new Error('Private integration access denied by independent source proof');};`);
    host.env.NODE_OPTIONS += ` --import=${pathToFileURL(preload).href}`;
    const author = join(host.app, 'plugin-sources/pr-source-proof'); await mkdir(author);
    await writeFile(join(author, 'package.json'), '{"type":"module"}');
    await writeFile(join(author, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: [], noEmitOnError: true }, include: ['backend.ts'] }));
    await writeFile(join(author, 'plugin-package.json'), JSON.stringify({ packageVersion: 1,
      manifest: { manifestVersion: 1, id: pluginId, version: '1.0.0', sdkVersion: 1, pages: [] },
      node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {}, backend: { entry: 'backend.js',
        provides: [{ id: 'helmsman/pull-request', version: 1, localId: 'source' }], pullRequests: { source: { access: ['core-http'] } },
        settings: { marker: { type: 'string', default: 'original-source', maxLength: 128 } }, storageVersion: 1 } }));
    await writeFile(join(author, 'backend.ts'), `import type {PluginBackendModule,PullRequestProviderV1} from '@helmsman/plugin-sdk';
const plugin:PluginBackendModule={activate(context){const provider:PullRequestProviderV1={
async list(){return {items:[],quality:'complete',truncated:false,browseUrl:null};},
async detail(input){return {version:1,target:{repo:input.repo,number:input.number,headSha:'${headSha}',baseSha:'${'b'.repeat(40)}'},observedAt:'2026-09-21T12:00:00Z',title:String(context.settings.marker),url:'https://github.com/'+input.repo+'/pull/'+input.number,status:'open',draft:input.number===7,authorLogin:'author',isOwnPr:true,headRefName:String(context.settings.marker),updatedAt:'2026-09-21T12:00:00Z',comments:0,checks:{quality:'complete',passed:1,failed:0,pending:0},reviews:{quality:'complete',approved:1,changesRequested:0,commented:0,requested:0,viewerReview:null,viewerReviewedAt:null,viewerReviewedCommitId:null}};},
async diff(input){return {version:1,target:input.target,observedAt:'2026-09-21T12:00:00Z',coverage:'immutable-comparison-preview',quality:'complete',truncated:false,files:[]};},
async prepareReview(){throw new Error('No publication in source proof');},async invokeReview(){throw new Error('No publication in source proof');},async reconcileReview(){throw new Error('No publication in source proof');}
};context.registerPullRequest('source',provider);}};export default plugin;`);
    await host.installAuthorPackage('plugin-sources/pr-source-proof');
    await host.cli('select-pull-request', `${pluginId}/source`);
    await host.cli('select-agent', 'helmsman.agent-claude/claude-code');
    let origin = await host.start();
    const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(join(host.app, relative)).href);
    const inspect = () => host.script('inspect-pr-source.mjs', `import Database from ${moduleUrl('node_modules/better-sqlite3/lib/index.js')};const db=new Database(process.env.HELMSMAN_DB,{readonly:true});try{console.log(JSON.stringify({runs:db.prepare('SELECT id,repo,status,taskJson FROM runs').all(),events:db.prepare("SELECT runId,text FROM run_events WHERE kind='error'").all(),snapshots:db.prepare('SELECT json FROM execution_snapshots').all().map(row=>JSON.parse(row.json)),admissions:db.prepare('SELECT json FROM execution_admissions').all().map(row=>JSON.parse(row.json))}));}finally{db.close();}`).then(value => JSON.parse(value));
    const submit = async (repo: string, launch: Record<string, unknown>) => {
      const response = await request.post(`${origin}/api/run-commands`, { headers: { 'x-helmsman-contribution': 'helmsman.compat-pr/panel' },
        data: { version: 1, requestId: randomUUID(), repo, action: 'launch', launch } });
      expect(response.ok(), await response.text()).toBe(true); return response.json();
    };
    const changed = await submit('org/c', { mode: 'review', prNumber: 7, headSha: 'f'.repeat(40) });
    expect(changed.status).toBe('accepted');
    await expect.poll(async () => (await inspect()).runs.find((row: { id: string }) => row.id === changed.runId)?.status).toBe('failed');
    expect((await inspect()).snapshots.some((snapshot: { runId: string }) => snapshot.runId === changed.runId)).toBe(false);

    const review = await submit('org/a', { mode: 'review', prNumber: 7, headSha }); expect(review.status).toBe('accepted');
    const rerun = await submit('org/b', { mode: 'rerun', prNumber: 8, feedback: 'Independent branch preparation' }); expect(rerun.status).toBe('accepted');
    await expect.poll(async () => { const state = await inspect(); return state.snapshots.length === 2 ? 2 : state.events; }, { timeout: 20_000 }).toBe(2);
    const before = await inspect();
    for (const id of [review.runId, rerun.runId]) {
      const row = before.runs.find((value: { id: string }) => value.id === id);
      expect(JSON.parse(row.taskJson)).toMatchObject({ prBranch: 'original-source', prHeadSha: headSha,
        pullRequestSource: { binding: { contributionId: `${pluginId}/source` }, settings: { marker: 'original-source' }, target: { headSha } } });
      const snapshot = before.snapshots.find((value: { runId: string }) => value.runId === id);
      expect(snapshot.settings.pullRequestSource.settings).toEqual({ marker: 'original-source' });
      expect(snapshot.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ pluginId })]));
    }
    const costs = await request.get(`${origin}/api/reports/outcomes/v1?repo=org/a&days=7`);
    expect(costs.ok(), await costs.text()).toBe(true); expect(await costs.json()).toMatchObject({ reviewedPrs: 1, unavailablePrs: 0 });
    await host.cli('disable', pluginId);
    await expect.poll(async () => (await (await request.get(`${origin}/api/reports/outcomes/v1?repo=org/a&days=7`)).json()).unavailablePrs).toBe(1);
    const denied = await submit('org/c', { mode: 'review', prNumber: 9, headSha }); expect(denied.status).not.toBe('accepted');
    expect((await inspect()).admissions.some((admission: { runId: string }) => admission.runId === denied.runId)).toBe(false);
    await host.stop(); await host.cli('enable', pluginId); await host.cli('configure', pluginId, JSON.stringify({ marker: 'replacement-source' }));
    origin = await host.start();
    const after = await inspect();
    expect(after.snapshots.map((snapshot: { settings: { pullRequestSource: { settings: unknown } } }) => snapshot.settings.pullRequestSource.settings)).toEqual([{ marker: 'original-source' }, { marker: 'original-source' }]);
    const replacement = await request.get(`${origin}/api/pull-request-inspect/detail?repo=org/c&number=9`);
    expect(replacement.ok(), await replacement.text()).toBe(true); expect(await replacement.json()).toMatchObject({ headRefName: 'replacement-source' });
    expect((await readFile(privateCalls, 'utf8').catch(() => '')).trim()).toBe('');
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});
