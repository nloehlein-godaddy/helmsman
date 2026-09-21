import { expect, test } from '@playwright/test';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitBin } from '../../server/test-support/platform';
import { fixture, run, sourceRoot } from './isolated-fixture';

const pluginId = 'example.retained-host';
const providerId = `${pluginId}/detached`;

test('installed execution hosts own launch, discovery and stop across provider disablement and application restart', async ({ request }) => {
  test.setTimeout(120_000);
  const host = await fixture();
  Object.assign(host.env, { REPO_PROJECT_MAP: 'org/a=TASK', RUN_HOST: 'detached', PRE_PR_REVIEWER_COUNT: '1', AGENT_MAX_ATTEMPTS: '1' });
  let origin = ''; let runId = ''; let cleanupReference: { identity: { runId: string; launchId: string; attempt: number; receiptPath: string }; state: { pid: number; processStart: string } } | undefined;
  try {
    await expect(host.script('deny-host-source.mjs', `import {readFileSync} from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/host-local/provider.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await cp(join(sourceRoot, 'node_modules/@types/node'), join(host.root, 'node_modules/@types/node'), { recursive: true });
    await cp(join(sourceRoot, 'node_modules/undici-types'), join(host.root, 'node_modules/undici-types'), { recursive: true });
    await host.installAuthorPackage('plugin-sources/host-local', pluginId, { buildScript: true });
    await host.installAuthorPackage('plugin-sources/host-docker', 'example.docker-host', { buildScript: true });
    const dockerFixture = join(host.root, 'execution-host-docker-fixture.mjs');
    const dockerFixtureInput = join(host.root, 'execution-host-docker-input.json');
    await cp(new URL('./execution-host-docker-fixture.mjs', import.meta.url), dockerFixture);
    await writeFile(dockerFixtureInput, JSON.stringify({
      providerPath: join(host.root, 'author-plugin-sources-host-docker', 'dist/provider.js'),
      wrapperPath: join(host.app, 'server/helmsman/run-wrapper.mjs'),
    }));
    expect(await run(process.execPath, [dockerFixture, dockerFixtureInput], host.cwd, host.env)).toContain('DOCKER_HOST_ACCEPTED');
    await host.cli('configure', pluginId, JSON.stringify({ weztermRunWorkspace: 'original-workspace' }));
    await host.cli('select-execution-host', providerId);
    await cp(join(host.app, 'sdk'), join(host.root, 'node_modules/@helmsman/plugin-sdk'), { recursive: true });
    const agent = join(host.root, 'waiting-agent'); await mkdir(agent);
    const marker = join(host.root, 'worker-started.json'); const worker = join(host.root, 'waiting-worker.mjs');
    await writeFile(worker, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,input:JSON.parse(process.argv[2])})); console.log(JSON.stringify({kind:'phase',text:'Installed execution host worker running'})); setInterval(()=>{},1000);`);
    await writeFile(join(agent, 'backend.js'), `export default {activate(context){const models={model:null,effort:null};context.registerAgent('worker',{
metadata:{version:1,label:'Waiting fixture agent',defaults:models,review:{low:models,medium:models,high:models},reviewSkills:[],reviewDelegation:'native-subagents',supportsPrePr:true,docker:null,costReporting:'delta'},
buildCommand(input){return {cmd:${JSON.stringify(process.execPath)},args:[${JSON.stringify(worker)},JSON.stringify(input)]};},parseLine(line){try{return JSON.parse(line);}catch{return null;}}});}};`);
    await writeFile(join(agent, 'plugin-package.json'), JSON.stringify({ packageVersion: 1,
      manifest: { manifestVersion: 1, id: 'example.waiting-agent', version: '0.1.0', sdkVersion: 1, pages: [] }, entries: {}, node: { minMajor: 22, maxMajorExclusive: 30 },
      backend: { entry: 'backend.js', provides: [{ id: 'helmsman/agent', version: 1, localId: 'worker' }], agents: { worker: { access: ['process-description'] } }, settings: {}, storageVersion: 1 } }));
    const agentArchive = join(host.root, 'waiting-agent.hmp'); await host.cli('pack', agent, agentArchive); await host.cli('install', agentArchive); await host.cli('enable', 'example.waiting-agent');
    await host.cli('select-agent', 'example.waiting-agent/worker'); await host.cli('select-agent-reviewers', 'example.waiting-agent/worker');
    const checkout = join(host.cwd, 'a'); const bare = join(host.root, 'remote.git'); const git = gitBin(); await mkdir(checkout);
    for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Host acceptance']]) await run(git, args, checkout, host.env);
    await writeFile(join(checkout, 'code.txt'), 'initial\n');
    for (const args of [['add', '.'], ['commit', '-m', 'initial'], ['clone', '--bare', checkout, bare], ['remote', 'add', 'origin', 'https://github.com/org/a.git']]) await run(git, args, checkout, host.env);
    await writeFile(join(host.root, 'commands/git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='fetch')args[args.indexOf('origin')]=${JSON.stringify(bare)};const result=spawnSync(${JSON.stringify(git)},args,{stdio:'inherit'});process.exit(result.status??1);`, { mode: 0o755 });
    await writeFile(join(host.root, 'commands/gh'), `#!${process.execPath}\nif(process.argv[2]==='repo'&&process.argv[3]==='view')console.log(JSON.stringify({nameWithOwner:'org/a',defaultBranchRef:{name:'main'}}));else process.exit(1);`, { mode: 0o755 });
    const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(join(host.app, relative)).href);
    origin = await host.start();
    const response = await request.post(`${origin}/api/agents/launch`, { data: { mode: 'freeform', repo: 'org/a', task: 'Keep this isolated fixture worker active until the operator stops it.' } });
    expect(response.ok(), await response.text()).toBe(true); runId = (await response.json()).runId;
    const inspect = () => host.script('inspect-host.mjs', `import Database from ${moduleUrl('node_modules/better-sqlite3/lib/index.js')};const db=new Database(process.env.HELMSMAN_DB,{readonly:true});try{console.log(JSON.stringify({attempt:db.prepare('SELECT leaseExpiresAt,leaseGeneration FROM execution_attempts WHERE runId=?').get(${JSON.stringify(runId)}),run:db.prepare('SELECT * FROM runs WHERE id=?').get(${JSON.stringify(runId)}),snapshots:db.prepare('SELECT json FROM execution_snapshots WHERE runId=?').all(${JSON.stringify(runId)}).map(row=>JSON.parse(row.json)),events:db.prepare('SELECT kind,text FROM run_events WHERE runId=?').all(${JSON.stringify(runId)})}));}finally{db.close();}`).then(value => JSON.parse(value));
    try { await expect.poll(() => readFile(marker, 'utf8').then(JSON.parse).catch(() => null), { timeout: 25_000 }).toMatchObject({ input: { stage: 'implement' } }); }
    catch (error) {
      const state = await inspect();
      cleanupReference = state.run?.hostRef ? JSON.parse(state.run.hostRef)?.reference : undefined;
      const output = state.run?.logPath ? await readFile(state.run.logPath, 'utf8').catch(() => '') : '';
      throw new Error(`${String(error)}\nRun: ${JSON.stringify(state)}\nWorker: ${output}\nServer: ${host.output()}`);
    }
    const initial = await inspect(); expect(initial.run.status).toBe('running'); expect(initial.run.hostKind).toBe('plugin');
    const task = JSON.parse(initial.run.taskJson); const hostRef = JSON.parse(initial.run.hostRef); cleanupReference = hostRef.reference;
    expect(hostRef).toMatchObject({ kind: 'plugin', providerId });
    expect(task.executionHost).toMatchObject({ binding: { providerId }, settings: { weztermRunWorkspace: 'original-workspace' } });
    expect(initial.snapshots).toHaveLength(1);
    expect(initial.snapshots[0].settings.host).toEqual({ provider: task.executionHost, configuration: task.hostConfiguration });
    expect(initial.snapshots[0].bindings).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'host', capability: 'helmsman/execution-host', contributionId: providerId, artifactHash: task.executionHost.binding.artifactHash })]));
    const saved = { task, hostRef, specPath: initial.run.specPath }; const savedPath = join(host.root, 'saved-host.json'); await writeFile(savedPath, JSON.stringify(saved));
    const discoveryScript = `import {readFileSync} from 'node:fs';import {readExecutionHostLaunchReceipt,isExecutionHostProcessOwned} from '@helmsman/plugin-sdk/node';
const saved=JSON.parse(readFileSync(${JSON.stringify(savedPath)},'utf8'));const {loadRetainedExecutionHostProvider}=await import(${moduleUrl('server/helmsman/execution-host-retained-loader.js')});
const receipt=await readExecutionHostLaunchReceipt(saved.hostRef.reference.identity);if(!receipt||!await isExecutionHostProcessOwned(receipt.pid,receipt.processStart))throw new Error('Unverified running receipt');
const handle=await loadRetainedExecutionHostProvider({...saved.task.hostRuntime,record:saved.task.executionHost});try{const spec={...JSON.parse(readFileSync(saved.specPath,'utf8')),version:1,specPath:saved.specPath,wrapperPath:${JSON.stringify(join(host.app, 'server/helmsman/run-wrapper.mjs'))},coordinator:true,configuration:saved.task.hostConfiguration};const discovery=await handle.provider.discover(spec,saved.hostRef.reference);console.log(JSON.stringify({discovery,alive:await handle.provider.isAlive(saved.hostRef.reference),receipt}));}finally{await handle.dispose();}`;
    const firstDiscovery = JSON.parse(await host.script('discover-host.mjs', discoveryScript));
    expect(firstDiscovery).toMatchObject({ alive: true, discovery: { status: 'found', ref: hostRef.reference, evidence: { state: 'running', runId } } });
    await host.stop(); await host.cli('configure', pluginId, JSON.stringify({ weztermRunWorkspace: 'changed-default' })); await host.cli('disable', pluginId); await host.cli('select-execution-host', 'helmsman.host-local/detached');
    origin = await host.start();
    const afterRestart = JSON.parse(await host.script('discover-host-after-restart.mjs', discoveryScript)); expect(afterRestart).toEqual(firstDiscovery);
    await expect.poll(() => host.output(), { timeout: 10_000 }).toContain('reattached 1 run(s)');
    const restored = await inspect(); expect(restored.run.status).toBe('running'); expect(restored.snapshots).toEqual(initial.snapshots);
    expect(JSON.parse(restored.run.hostRef)).toEqual(hostRef); expect(JSON.parse(restored.run.taskJson).executionHost).toEqual(task.executionHost);
    const stopped = await request.post(`${origin}/api/agents/${runId}/stop`, { data: {} }); expect(stopped.ok()).toBe(true); const stopResult = await stopped.json(); expect(stopResult).toEqual({ stopped: true });
    try { await expect.poll(async () => (await inspect()).run.status, { timeout: 25_000 }).toBe('stopped'); }
    catch (error) { throw new Error(`${String(error)}\nStop response: ${JSON.stringify(stopResult)}\nAttempt: ${JSON.stringify((await inspect()).attempt)}\nNow: ${new Date().toISOString()}\nRun events: ${JSON.stringify((await inspect()).events)}\nServer: ${host.output()}`); }
    const stoppedState = await inspect(); expect(stoppedState.snapshots).toEqual(initial.snapshots);
    await host.stop(); await host.cli('select-execution-host', providerId); origin = await host.start();
    const unavailable = await request.post(`${origin}/api/agents/launch`, { data: { mode: 'freeform', repo: 'org/a', task: 'Disabled execution host must remain unavailable.' } }); expect(unavailable.ok()).toBe(false);
    await host.stop();
    const artifactPath = join(host.env.HELMSMAN_PLUGINS_DIR!, 'artifacts', `${task.executionHost.binding.artifactHash}.json`); await writeFile(artifactPath, '{}');
    await expect(host.script('corrupt-host.mjs', `import {readFileSync} from 'node:fs';const saved=JSON.parse(readFileSync(${JSON.stringify(savedPath)},'utf8'));const {loadRetainedExecutionHostProvider}=await import(${moduleUrl('server/helmsman/execution-host-retained-loader.js')});await loadRetainedExecutionHostProvider({...saved.task.hostRuntime,record:saved.task.executionHost});`)).rejects.toThrow();
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally {
    if (runId && origin) await request.post(`${origin}/api/agents/${runId}/stop`, { data: {} }).catch(() => {});
    await host.stop();
    if (cleanupReference) await host.script('cleanup-owned-host.mjs', `import {readExecutionHostLaunchReceipt,isExecutionHostProcessOwned} from '@helmsman/plugin-sdk/node';
const ref=${JSON.stringify(cleanupReference)};
if(await isExecutionHostProcessOwned(ref.state.pid,ref.state.processStart)){
  const receipt=await readExecutionHostLaunchReceipt(ref.identity);
  if(receipt?.pid!==ref.state.pid||receipt.processStart!==ref.state.processStart)throw new Error('Fixture wrapper ownership changed; retaining fixture files');
  try{process.kill(receipt.pid,'SIGTERM');}catch(error){if(error?.code!=='ESRCH')throw error;}
  for(let attempt=0;attempt<200&&await isExecutionHostProcessOwned(receipt.pid,receipt.processStart);attempt++)await new Promise(resolve=>setTimeout(resolve,50));
  if(await isExecutionHostProcessOwned(receipt.pid,receipt.processStart))throw new Error('Fixture wrapper did not settle; retaining fixture files');
}`);
    await host.close();
  }
});
