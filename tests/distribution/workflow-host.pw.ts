import { expect, test } from '@playwright/test';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitBin } from '../../server/test-support/platform';
import { fixture, run, sourceRoot } from './isolated-fixture';

const pluginId = 'example.workflow-agent';
const workflowPluginId = 'example.independent-workflow';
const workflowProviderId = `${workflowPluginId}/flow`;
const providerId = `${pluginId}/worker`;

test('independent workflow owns prompts and sequencing with retained continuation and guarded publication', async ({ page, request }) => {
  test.setTimeout(120_000);
  const host = await fixture();
  Object.assign(host.env, { REPO_PROJECT_MAP: 'org/a=TASK', RUN_HOST: 'detached', PRE_PR_REVIEWER_COUNT: '1', AGENT_MAX_ATTEMPTS: '1' });
  try {
    await expect(host.script('prove-agent-isolation.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/workflow.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    for (const name of ['workflow-coding', 'workflow-review']) await host.installAuthorPackage(`plugin-sources/${name}`, `example.${name}`, { buildScript: true });
    const author = join(host.root, 'independent-agent'); const output = join(author, 'dist');
    await mkdir(output, { recursive: true });
    await cp(join(host.app, 'sdk'), join(author, 'node_modules/@helmsman/plugin-sdk'), { recursive: true });
    await writeFile(join(author, 'package.json'), '{"type":"module"}');
    await writeFile(join(author, 'backend.ts'), `import type { AgentBackendModuleV1, AgentEventV1 } from '@helmsman/plugin-sdk';
const plugin: AgentBackendModuleV1 = { activate(context) {
 if (Object.keys(context).sort().join(',') !== 'onDispose,pluginId,registerAgent,settings,signal') throw new Error('Unexpected host services');
 const models = { model: null, effort: null };
 for(const localId of ['worker','reviewer']) context.registerAgent(localId, {
  metadata: { version: 1, label: 'Independent worker', defaults: models, review: { low: models, medium: models, high: models }, reviewSkills: [], reviewDelegation: 'native-subagents', supportsPrePr: true, docker: null, costReporting: 'delta' },
  buildCommand(input) { return { cmd: String(context.settings.executable), args: [String(context.settings.workerScript), JSON.stringify({...input,testProvider:localId})] }; },
  parseLine(line) { try { const value: unknown = JSON.parse(line); if (!value || typeof value !== 'object' || !('kind' in value)) return null; return value as AgentEventV1; } catch { return null; } }
 });
} }; export default plugin;`);
    await run(process.execPath, [join(host.root, 'toolchain/typescript/bin/tsc'), '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--outDir', output, '--noEmitOnError', join(author, 'backend.ts')], author, host.env);
    const descriptor = { packageVersion: 1, manifest: { manifestVersion: 1, id: pluginId, version: '0.1.0', sdkVersion: 1, pages: [] }, node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
      backend: { entry: 'backend.js', provides: ['worker','reviewer'].map(localId => ({ id: 'helmsman/agent', version: 1, localId })), agents: { worker: { access: ['process-description'] }, reviewer: { access: ['process-description'] } }, storageVersion: 1,
        settings: { executable: { type: 'string', default: '', maxLength: 4096 }, workerScript: { type: 'string', default: '', maxLength: 4096 } } } };
    await writeFile(join(output, 'plugin-package.json'), JSON.stringify(descriptor));
    const archive = join(author, 'agent.hmp'); await host.cli('pack', output, archive); await host.cli('install', archive); await host.cli('enable', pluginId);
    const workerScript = join(host.root, 'agent-worker.mjs');
    await host.cli('configure', pluginId, JSON.stringify({ executable: process.execPath, workerScript }));
    await host.cli('select-agent', providerId); await host.cli('select-agent-reviewers', `${providerId},${pluginId}/reviewer`);
    const workflowAuthor = join(host.root, 'independent-workflow'); const workflowOutput=join(workflowAuthor,'dist');
    await mkdir(workflowOutput,{recursive:true}); await cp(join(host.app,'sdk'),join(workflowAuthor,'node_modules/@helmsman/plugin-sdk'),{recursive:true});
    await writeFile(join(workflowAuthor,'package.json'),'{"type":"module"}');
    await writeFile(join(workflowAuthor,'backend.ts'), `import type {WorkflowBackendModuleV1} from '@helmsman/plugin-sdk';
const plugin:WorkflowBackendModuleV1={activate(context){
 if(Object.keys(context).sort().join(',')!=='onDispose,pluginId,registerWorkflow,settings,signal')throw new Error('Unexpected workflow authority');
 context.registerWorkflow('flow',{
  metadata:{version:1,label:'Independent workflow',modes:['coding'],execution:'staged',requiredSkills:[],maxRounds:3,stageTimeoutMinutes:5},
  renderPrompt(input){const stage=input.stage;if(!stage)throw new Error('Expected guarded stage'); return [String(context.settings.marker),'Base revision: '+stage.baseSha,'Round: '+(stage.round??0),stage.headSha?'Head revision: '+stage.headSha:'',stage.summaryCorrection?JSON.stringify(stage.summaryCorrection.reportPath):'',JSON.stringify(stage.reportPath)].join('\\n');},
  next(input){if(context.settings.unsafe)return {kind:'publish'};if(!input.implemented)return {kind:'author',stage:'implement'};const reviewerId=[...input.reviewerIds].reverse().find(id=>!input.reviews.some(value=>value.reviewer===id));if(reviewerId)return {kind:'review',reviewerId};return input.reviews.every(value=>value.report.verdict==='APPROVE')?{kind:'publish'}:{kind:'author',stage:'fix'};}
 });}};export default plugin;`);
    await run(process.execPath,[join(host.root,'toolchain/typescript/bin/tsc'),'--strict','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','--outDir',workflowOutput,'--noEmitOnError',join(workflowAuthor,'backend.ts')],workflowAuthor,host.env);
    await writeFile(join(workflowOutput,'plugin-package.json'),JSON.stringify({packageVersion:1,manifest:{manifestVersion:1,id:workflowPluginId,version:'0.1.0',sdkVersion:1,pages:[]},node:{minMajor:22,maxMajorExclusive:30},entries:{},backend:{entry:'backend.js',provides:[{id:'helmsman/workflow',version:1,localId:'flow'}],workflows:{flow:{access:['workflow-policy']}},settings:{marker:{type:'string',default:'original-template',maxLength:128},unsafe:{type:'boolean',default:false}},storageVersion:1}}));
    const workflowArchive=join(workflowAuthor,'workflow.hmp');await host.cli('pack',workflowOutput,workflowArchive);await host.cli('install',workflowArchive);await host.cli('enable',workflowPluginId);await host.cli('select-workflow','coding',workflowProviderId);
    const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(join(host.app, relative)).href);
    const runtimeSetup = `const { loadPluginSnapshot } = await import(${moduleUrl('server/helmsman/plugins/store.js')});
const { activateBackendPlugins } = await import(${moduleUrl('server/helmsman/plugins/backend.js')});
const { resolveAgentSelection } = await import(${moduleUrl('server/helmsman/agent-selection.js')});
const root = process.env.HELMSMAN_PLUGINS_DIR;
const snapshot = await loadPluginSnapshot(root);
const runtime = await activateBackendPlugins({ root, snapshot, usage: { async query() { throw new Error('Unexpected usage access'); } } });
const select = () => resolveAgentSelection({ root, registry: runtime.agents, reviewerCount: 2, defaults: { writer: ${JSON.stringify(providerId)}, reviewers: [${JSON.stringify(providerId)},${JSON.stringify(`${pluginId}/reviewer`)}] } });`;
    const captured = JSON.parse(await host.script('capture-agent.mjs', `${runtimeSetup}
try { const selection = select().selection; const pkg = [...snapshot.artifacts.values()].find(value => value.package.manifest.id === ${JSON.stringify(pluginId)}); if (!pkg) throw new Error('Independent package unavailable');
console.log(JSON.stringify({ selection, artifacts: [{ pluginId: pkg.package.manifest.id, artifactHash: pkg.hash, packageVersion: pkg.package.manifest.version, requires: [] }] })); } finally { await runtime.dispose(); }`));
    expect(await host.script('direct-workflow-prompts.mjs', `${runtimeSetup}
const {loadExecutionAgents}=await import(${moduleUrl('server/helmsman/agent-execution.js')});
const agentSelection=${JSON.stringify(captured.selection)}; const agentRuntime={pluginsRoot:root,runtimeArtifactsRoot:${JSON.stringify(join(host.root,'runtime-artifacts'))},artifacts:${JSON.stringify(captured.artifacts)}};
try {for(const [id,review,heading] of [['example.workflow-review/review',true,'# Code-review PR #7'],['example.workflow-coding/branch',false,'# Update PR #7']]){
const record=runtime.workflows.list().find(value=>value.record.binding.providerId===id)?.record;if(!record)throw new Error('Missing direct workflow');
const pkg=[...snapshot.artifacts.values()].find(value=>value.package.manifest.id===record.binding.pluginId);const workflowRuntime={...agentRuntime,artifacts:[{pluginId:record.binding.pluginId,artifactHash:pkg.hash,packageVersion:pkg.package.manifest.version,requires:[]}]};
const task={workflow:record,workflowRuntime,agentSelection,agentRuntime,ticketId:'review',title:'Review',repo:'org/a',jiraBaseUrl:'',prNumber:7,prBranch:'feature',prHeadSha:'a'.repeat(40),review,task:'Resolve feedback'};
const loaded=await loadExecutionAgents({workflow:record,workflowRuntime,agentSelection,agentRuntime});try {const prompt=JSON.parse(loaded.writer.buildCommand(task).args[1]).prompt;if(!prompt.includes(heading))throw new Error('Direct workflow prompt was not rendered');}finally{await loaded.dispose();}
} console.log('DIRECT_WORKFLOWS_ACCEPTED');}finally{await runtime.dispose();}`)).toContain('DIRECT_WORKFLOWS_ACCEPTED');
    const workflowCapture = JSON.parse(await host.script('capture-workflow.mjs', `${runtimeSetup}
const {resolveWorkflowSelection}=await import(${moduleUrl('server/helmsman/workflow-selection.js')});
try {const selection=resolveWorkflowSelection({root,registry:runtime.workflows,mode:'coding'}); const pkg=[...snapshot.artifacts.values()].find(value=>value.package.manifest.id===${JSON.stringify(workflowPluginId)}); console.log(JSON.stringify({record:selection.record,artifacts:[{pluginId:pkg.package.manifest.id,artifactHash:pkg.hash,packageVersion:pkg.package.manifest.version,requires:[]}]}));}finally{await runtime.dispose();}`));
    const input = { workflow: workflowCapture.record, workflowArtifacts: workflowCapture.artifacts, expectedReviewOrder: ['reviewer','worker'], expectedPromptMarker: 'original-template', app: host.app, root: host.root, realGit: gitBin(), selection: captured.selection, artifacts: captured.artifacts, pluginsRoot: host.env.HELMSMAN_PLUGINS_DIR, runtimeArtifactsRoot: join(host.root, 'runtime-artifacts') };
    const inputPath = join(host.root, 'fixture-input.json'); await writeFile(inputPath, JSON.stringify(input));
    const checkout = join(host.cwd, 'a'); const bare = join(host.root, 'remote.git'); const git = gitBin();
    await mkdir(checkout);
    for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Acceptance']]) await run(git, args, checkout, host.env);
    await writeFile(join(checkout, 'code.txt'), 'initial\n');
    for (const args of [['add', '.'], ['commit', '-m', 'initial'], ['clone', '--bare', checkout, bare], ['remote', 'add', 'origin', 'https://github.com/org/a.git']]) await run(git, args, checkout, host.env);
    await writeFile(join(host.root, 'commands/git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'); const args=process.argv.slice(2); if(args[0]==='fetch') args[args.indexOf('origin')]=${JSON.stringify(bare)}; const result=spawnSync(${JSON.stringify(git)},args,{stdio:'inherit'}); process.exit(result.status??1);`, { mode: 0o755 });
    await writeFile(join(host.root, 'commands/gh'), `#!${process.execPath}\nif(process.argv[2]==='repo'&&process.argv[3]==='view') console.log(JSON.stringify({nameWithOwner:'org/a',defaultBranchRef:{name:'main'}})); else process.exit(1);`, { mode: 0o755 });
    const launchLog = join(host.root, 'independent-launches.jsonl');
    await writeFile(workerScript, `import {appendFileSync} from 'node:fs'; const input=JSON.parse(process.argv[2]); appendFileSync(${JSON.stringify(launchLog)},JSON.stringify(input)+'\\n'); console.log(JSON.stringify({kind:'result',outcome:'failure',text:'Independent agent deliberately failed'}));`);
    let origin = await host.start();
    await page.goto(`${origin}/config?repo=org/a`); await expect(page.locator('#boot')).toHaveCount(0); await expect(page.locator('#config-AGENT_MAX_ATTEMPTS')).toBeVisible();
    await expect(page.locator('[id^=config-PRE_PR_]')).toHaveCount(0);
    await expect(page.getByText('Workflows and reviewers', { exact: true })).toBeVisible();
    expect(await (await request.get(`${origin}/api/workflows`)).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: workflowProviderId, execution: 'staged' })]));
    await expect(page.locator('#config-AGENT_ADAPTER')).toHaveCount(0); await expect(page.locator('#config-AGENT_CMD')).toHaveCount(0);
    for (const [label, width] of [['desktop', 1440], ['mobile', 390]] as const) { await page.setViewportSize({ width, height: 1000 }); await page.getByRole('heading', { name: 'Workflows and reviewers', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: `/tmp/helmsman-workflow-config-${label}.png`, fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false); }
    const launch = await request.post(`${origin}/api/agents/launch`, { data: { mode: 'freeform', repo: 'org/a', task: 'Exercise the independent provider and report a deliberate failure.' } });
    expect(launch.ok(), await launch.text()).toBe(true); const { runId } = await launch.json();
    const inspect = () => host.script('inspect-agent.mjs', `import Database from ${moduleUrl('node_modules/better-sqlite3/lib/index.js')};
const db = new Database(process.env.HELMSMAN_DB, {readonly:true}); try { console.log(JSON.stringify({ run: db.prepare('SELECT * FROM runs WHERE id=?').get(${JSON.stringify(runId)}), snapshots: db.prepare('SELECT json FROM execution_snapshots WHERE runId=?').all(${JSON.stringify(runId)}).map(row=>JSON.parse(row.json)), admissions: db.prepare('SELECT json FROM execution_admissions').all().map(row=>JSON.parse(row.json)) })); } finally {db.close();}`).then(value => JSON.parse(value));
    await expect.poll(async () => (await inspect()).run?.status, { timeout: 25_000 }).toBe('failed');
    const admitted = await inspect(); expect(admitted.snapshots).toHaveLength(1);
    expect(admitted.snapshots[0].settings.agents.writer.binding.providerId).toBe(providerId);
    expect(admitted.snapshots[0].bindings).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'agent', contributionId: providerId, artifactHash: captured.selection.writer.binding.artifactHash })]));
    expect(admitted.admissions[0].request.agents).toEqual(captured.selection);
    expect(JSON.parse((await readFile(launchLog, 'utf8')).trim())).toMatchObject({ stage: 'implement', summaryCorrection: false });
    expect(admitted.snapshots[0].settings.workflow.binding.providerId).toBe(workflowProviderId);
    expect(admitted.admissions[0].request.workflow).toEqual(workflowCapture.record);
    expect(JSON.parse((await readFile(launchLog, 'utf8')).trim()).prompt).toContain('original-template');
    await host.stop(); await host.cli('configure', workflowPluginId, JSON.stringify({ marker: 'replacement-template', unsafe: true }));
    origin = await host.start();
    const unsafeLaunch=await request.post(`${origin}/api/agents/launch`,{data:{mode:'freeform',repo:'org/a',task:'Policy must not bypass publication guards'}});
    expect(unsafeLaunch.ok(),await unsafeLaunch.text()).toBe(true); const unsafeId=(await unsafeLaunch.json()).runId;
    await expect.poll(()=>host.script('unsafe-state.mjs',`import Database from ${moduleUrl('node_modules/better-sqlite3/lib/index.js')};const db=new Database(process.env.HELMSMAN_DB,{readonly:true});try{console.log(db.prepare('SELECT status FROM runs WHERE id=?').get(${JSON.stringify(unsafeId)})?.status??'missing');}finally{db.close();}`).then(value => value.trim()),{timeout:25000}).toBe('failed');
    expect((await readFile(launchLog,'utf8')).trim().split('\n')).toHaveLength(1);
    await host.stop(); await host.cli('disable', workflowPluginId); await host.cli('configure', pluginId, JSON.stringify({ executable: process.execPath, workerScript: '/unavailable/current-worker.mjs' })); await host.cli('disable', pluginId);
    origin = await host.start();
    const blocked = await request.post(`${origin}/api/agents/launch`, { data: { mode: 'freeform', repo: 'org/a', task: 'Must remain unavailable.' } }); expect(blocked.ok()).toBe(false);
    expect((await inspect()).admissions).toHaveLength(2); await host.stop();
    const retained = await host.script('retained-agent.mjs', `import {readFileSync} from 'node:fs'; const input=JSON.parse(readFileSync(${JSON.stringify(inputPath)},'utf8'));
const {loadRetainedAgentProvider}=await import(${moduleUrl('server/helmsman/agent-retained-loader.js')});
const handle=await loadRetainedAgentProvider({...input,record:input.selection.writer}); try { const command=handle.provider.buildCommand({version:1,prompt:'Retained direct prompt',model:null,effort:null,stage:'direct',summaryCorrection:false,task:{ticketId:'T-1',repo:'org/a',title:'Retained'}}); console.log(JSON.stringify(command)); } finally {await handle.dispose();}`);
    expect(JSON.parse(retained).args[0]).toBe(workerScript);
    await cp(new URL('./agent-workflow-fixture.mjs', import.meta.url), join(host.root, 'agent-workflow-fixture.mjs'));
    expect(await run(process.execPath, [join(host.root, 'agent-workflow-fixture.mjs'), inputPath], host.cwd, host.env)).toContain('WORKFLOW_ACCEPTED');
    const artifactPath = join(host.env.HELMSMAN_PLUGINS_DIR!, 'artifacts', `${captured.selection.writer.binding.artifactHash}.json`); await writeFile(artifactPath, '{}');
    await expect(host.script('corrupt-agent.mjs', `import {readFileSync} from 'node:fs'; const input=JSON.parse(readFileSync(${JSON.stringify(inputPath)},'utf8')); const {loadRetainedAgentProvider}=await import(${moduleUrl('server/helmsman/agent-retained-loader.js')}); await loadRetainedAgentProvider({...input,record:input.selection.writer});`)).rejects.toThrow();
    const workflowArtifactPath = join(host.env.HELMSMAN_PLUGINS_DIR!, 'artifacts', `${workflowCapture.record.binding.artifactHash}.json`); await writeFile(workflowArtifactPath, '{}');
    await expect(host.script('corrupt-workflow.mjs', `const {loadRetainedWorkflowProvider}=await import(${moduleUrl('server/helmsman/workflow-retained-loader.js')}); await loadRetainedWorkflowProvider({pluginsRoot:process.env.HELMSMAN_PLUGINS_DIR,runtimeArtifactsRoot:${JSON.stringify(input.runtimeArtifactsRoot)},artifacts:${JSON.stringify(workflowCapture.artifacts)},record:${JSON.stringify(workflowCapture.record)}});`)).rejects.toThrow();
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});
