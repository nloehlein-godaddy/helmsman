import { expect, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, run, sourceRoot } from './isolated-fixture';

const pluginId = 'example.independent-triggers';

test('installed trigger policies stay source-isolated and retain authenticated decisions across disable and restart', async ({ request }) => {
  test.setTimeout(120_000);
  const host = await fixture();
  Object.assign(host.env, { REPO_PROJECT_MAP: 'org/a=TASK', RUN_HOST: 'detached', AGENT_MAX_ATTEMPTS: '1' });
  try {
    await expect(host.script('deny-trigger-source.mjs', `import {readFileSync} from 'node:fs';readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/trigger.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    for (const name of ['trigger-campaign', 'trigger-slack-review', 'trigger-github-review', 'trigger-github-webhook']) {
      await host.installAuthorPackage(`plugin-sources/${name}`, `example.${name}`, { buildScript: true });
    }

    const author = join(host.root, 'independent-triggers');
    const output = join(author, 'dist');
    await mkdir(output, { recursive: true });
    await cp(join(host.app, 'sdk'), join(author, 'node_modules/@helmsman/plugin-sdk'), { recursive: true });
    await writeFile(join(author, 'package.json'), '{"type":"module"}');
    await writeFile(join(author, 'backend.ts'), `import type {CommunicationReviewTriggerContextV1,PullRequestReviewTriggerContextV1,ReviewTriggerInputV1,TriggerBackendModuleV1,WebhookTriggerInputV1} from '@helmsman/plugin-sdk';
const record=(value:unknown):Record<string,unknown>|null=>typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:null;
const plugin:TriggerBackendModuleV1={activate(context){
 if(Object.keys(context).sort().join(',')!=='onDispose,pluginId,registerTrigger,settings,signal')throw new Error('Unexpected trigger authority');
 context.registerTrigger('campaign',{metadata:{version:1,label:'Reverse campaign',kind:'campaign',intervalMs:1000},select(input){const value=input.candidates.at(-1);return value?{candidateId:value.candidateId}:null;}});
 context.registerTrigger('slack',{metadata:{version:1,label:'Priority Slack',kind:'review-watch',intervalMs:1000,source:'communication'},async scan(input:ReviewTriggerInputV1,source:CommunicationReviewTriggerContextV1){const batch=await source.messages({since:input.cursor});const proposals=[];for(const event of batch.items){for(const url of event.prUrls){if(!url.includes('/priority/'))continue;const match=/github\\.com\\/([^/]+\\/[^/]+)\\/pull\\/(\\d+)/.exec(url);if(!match)continue;const target=await source.detail({repo:match[1],number:Number(match[2])});if(target&&target.status==='open'&&!target.draft)proposals.push({eventId:event.eventId,targetId:target.targetId,workflowRef:input.defaultWorkflowRef,sourceUrl:event.permalink,author:event.author,channelName:event.channelId});}}return{proposals,nextCursor:batch.complete?(batch.items.at(-1)?.ts??input.cursor):input.cursor,complete:batch.complete};}});
 context.registerTrigger('github',{metadata:{version:1,label:'Requested reviews',kind:'review-watch',intervalMs:1000,source:'pull-request'},async scan(input:ReviewTriggerInputV1,source:PullRequestReviewTriggerContextV1){const batch=await source.requested();const proposals=[];for(const item of [...batch.items].reverse()){const target=await source.detail(item);if(target&&target.status==='open'&&!target.draft){proposals.push({eventId:null,targetId:target.targetId,workflowRef:input.defaultWorkflowRef,sourceUrl:target.url,author:'GitHub',channelName:'Requested reviews'});break;}}return{proposals,nextCursor:null,complete:batch.quality==='complete'&&!batch.truncated};}});
 context.registerTrigger('webhook',{metadata:{version:1,label:'Mapped webhook',kind:'webhook',ingress:{signatureHeader:'x-hub-signature-256',deliveryHeader:'x-github-delivery',eventHeader:'x-github-event',algorithm:'hmac-sha256',signaturePrefix:'sha256='}},parse(input:WebhookTriggerInputV1){const body=record(input.body);if(!body||input.event!=='issues'||body.action!=='opened')return null;const repository=record(body.repository);const issue=record(body.issue);if(repository?.full_name!=='org/a'||typeof issue?.title!=='string')return null;return{workflowRef:'coding@1',intent:{mode:'freeform',repo:'org/a',title:String(context.settings.prefix)+issue.title,task:issue.title}};}});
}};export default plugin;`);
    await run(process.execPath, [join(host.root, 'toolchain/typescript/bin/tsc'), '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--outDir', output, '--noEmitOnError', join(author, 'backend.ts')], author, host.env);
    await writeFile(join(output, 'plugin-package.json'), JSON.stringify({ packageVersion: 1,
      manifest: { manifestVersion: 1, id: pluginId, version: '0.1.0', sdkVersion: 1, pages: [] }, node: { minMajor: 22, maxMajorExclusive: 30 }, entries: {},
      backend: { entry: 'backend.js', provides: [
        { id: 'helmsman/trigger', version: 1, localId: 'campaign' }, { id: 'helmsman/trigger', version: 1, localId: 'slack' },
        { id: 'helmsman/trigger', version: 1, localId: 'github' }, { id: 'helmsman/trigger', version: 1, localId: 'webhook' },
      ], triggers: { campaign: { access: ['campaign-candidates'] }, slack: { access: ['review-discovery'] }, github: { access: ['review-discovery'] }, webhook: { access: ['authenticated-event'] } },
      settings: { enabled: { type: 'boolean', default: true }, prefix: { type: 'string', default: 'Mapped: ', maxLength: 128 } }, storageVersion: 1 } }));
    const archive = join(author, 'triggers.hmp');
    await host.cli('pack', output, archive); await host.cli('install', archive); await host.cli('enable', pluginId);
    for (const [role, localId] of [['campaign', 'campaign'], ['slack-review', 'slack'], ['github-review', 'github'], ['github-webhook', 'webhook']]) {
      await host.cli('select-trigger', role, `${pluginId}/${localId}`);
    }

    const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(join(host.app, relative)).href);
    const proof = JSON.parse(await host.script('trigger-policy-proof.mjs', `const {loadPluginSnapshot}=await import(${moduleUrl('server/helmsman/plugins/store.js')});
const {activateBackendPlugins}=await import(${moduleUrl('server/helmsman/plugins/backend.js')});const {resolveTriggerSelection,assertTriggerSelectionCurrent}=await import(${moduleUrl('server/helmsman/trigger-selection.js')});const {runCampaignTrigger,runReviewTrigger,triggerSource}=await import(${moduleUrl('server/helmsman/trigger-runtime.js')});
const root=process.env.HELMSMAN_PLUGINS_DIR;const snapshot=await loadPluginSnapshot(root);const runtime=await activateBackendPlugins({root,snapshot,usage:{async query(){throw new Error('Unexpected usage access')}}});
function capture(kind){const selection=resolveTriggerSelection({root,registry:runtime.triggers,kind});if(!selection.record)throw new Error('Missing selected trigger');const registration=runtime.triggers.resolve(selection.record.binding);const artifact=[...snapshot.artifacts.values()].find(value=>value.package.manifest.id===selection.record.binding.pluginId);return{instanceId:kind,selectionRevision:selection.revision,record:selection.record,provider:registration.provider,artifacts:[{pluginId:artifact.package.manifest.id,artifactHash:artifact.hash,packageVersion:artifact.package.manifest.version,requires:[]}],assertCurrent(){assertTriggerSelectionCurrent({root,registry:runtime.triggers},selection);}};}
try{const candidates=['older','newer'].map((candidateId,index)=>({candidateId,repo:'org/a',campaignId:'campaign',phaseId:'phase',taskId:'task-'+index,attempt:1,workflowRef:'coding@1',title:candidateId,mode:'ticket',createdAt:'2026-09-21T00:0'+index+':00Z'}));const campaign=runCampaignTrigger({capture:capture('campaign'),candidates,truncated:false,source:()=>({source:triggerSource('campaign:test','1')}),capturedAt:'2026-09-21T00:02:00Z'});
const slack=await runReviewTrigger({capture:capture('slack-review'),source:{kind:'communication',channelId:'C1',channelName:'reviews',source:triggerSource('slack:test','1'),artifacts:[],assertCurrent(){},async messages(){return{complete:true,items:[{channelId:'C1',ts:'1760000001.000000',permalink:'https://slack.test/1',author:'Ada',prUrls:['https://github.com/org/ignored/pull/1','https://github.com/org/priority/pull/7']}]};},async detail(value){return{repo:value.repo,number:value.number,headSha:'a'.repeat(40),title:'PR',url:'https://github.com/'+value.repo+'/pull/'+value.number,status:'open',draft:false};}},activatedAt:'2025-01-01T00:00:00Z',cursor:'1760000000.000000',defaultWorkflowRef:'review@1',capturedAt:'2026-09-21T00:02:00Z'});
const github=await runReviewTrigger({capture:capture('github-review'),source:{kind:'pull-request',source:triggerSource('github:test','1'),artifacts:[],assertCurrent(){},async requested(){return{items:[{repo:'org/a',number:1},{repo:'org/a',number:2}],quality:'complete',truncated:false};},async detail(value){return{repo:value.repo,number:value.number,headSha:String(value.number).repeat(40),title:'PR',url:'https://github.com/'+value.repo+'/pull/'+value.number,status:'open',draft:false};}},activatedAt:'2025-01-01T00:00:00Z',cursor:null,defaultWorkflowRef:'review@1',capturedAt:'2026-09-21T00:02:00Z'});
console.log(JSON.stringify({campaign:campaign?.candidate.candidateId,campaignProvider:campaign?.trigger.provider.binding.providerId,slack:slack.captures.map(value=>value.proposal.repo),github:github.captures.map(value=>value.proposal.number)}));}finally{await runtime.dispose();}`));
    expect(proof).toEqual({ campaign: 'newer', campaignProvider: `${pluginId}/campaign`, slack: ['org/priority'], github: [2] });

    const queueFixture = join(host.root, 'trigger-queue-fixture.mjs');
    await cp(new URL('./trigger-queue-fixture.mjs', import.meta.url), queueFixture);
    const queueInputPath = join(host.root, 'trigger-queue-input.json');
    const queueLaunchOutput = join(host.root, 'trigger-queue-launch.json');
    const queueInput = { app: host.app, pluginsRoot: host.env.HELMSMAN_PLUGINS_DIR, database: join(host.root, 'trigger-queue.sqlite'),
      secret: 'queued-secret', launchOutput: queueLaunchOutput,
      body: { action: 'opened', repository: { full_name: 'org/a' }, issue: { number: 70, title: 'Queued trigger', body: 'Retain this decision.' } } };
    const queueRun = async (action: 'enqueue' | 'poll') => {
      await writeFile(queueInputPath, JSON.stringify({ ...queueInput, action }));
      return JSON.parse(await run(process.execPath, [queueFixture, queueInputPath], host.cwd, host.env));
    };
    expect(await queueRun('enqueue')).toMatchObject({ row: { state: 'pending' }, admission: null });
    await host.cli('disable', pluginId);
    expect(await queueRun('poll')).toMatchObject({ row: { state: 'pending' }, admission: null });
    await host.cli('enable', pluginId); await host.cli('configure', pluginId, JSON.stringify({ enabled: true, prefix: 'Changed: ' }));
    expect(await queueRun('poll')).toMatchObject({ row: { state: 'launched' }, admission: { state: 'pending' } });
    const queuedLaunch = JSON.parse(await readFile(queueLaunchOutput, 'utf8'));
    expect(queuedLaunch).toMatchObject({ title: 'Mapped: Queued trigger', task: 'Queued trigger', trigger: {
      provider: { binding: { providerId: `${pluginId}/webhook` }, settings: { enabled: true, prefix: 'Mapped: ' } },
    } });

    let origin = await host.start();
    const secret = 'acceptance-webhook-secret';
    const credential = await request.put(`${origin}/api/webhooks/github/credential`, { data: { secret } });
    expect(credential.ok(), await credential.text()).toBe(true);
    const post = async (delivery: string, body: Record<string, unknown>, signingSecret = secret) => {
      const raw = JSON.stringify(body);
      return request.post(`${origin}/api/webhooks/github`, { data: raw, headers: {
        'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': delivery,
        'x-hub-signature-256': `sha256=${createHmac('sha256', signingSecret).update(raw).digest('hex')}`,
      } });
    };
    const ignoredBody = { action: 'closed', repository: { full_name: 'org/a' }, issue: { number: 6, title: 'Ignored' } };
    const ignored = await post('ignored-delivery', ignoredBody); expect(ignored.status(), await ignored.text()).toBe(202);
    const ignoredDuplicate = await post('ignored-delivery', ignoredBody); expect(ignoredDuplicate.status(), await ignoredDuplicate.text()).toBe(202);
    expect(await ignoredDuplicate.json()).toMatchObject({ duplicate: true });
    const mismatch = await post('ignored-delivery', { ...ignoredBody, action: 'reopened' }); expect(mismatch.status()).toBe(409);
    const acceptedBody = { action: 'opened', repository: { full_name: 'org/a' }, issue: { number: 7, title: 'Accepted trigger', body: 'Run it.' } };
    const accepted = await post('accepted-delivery', acceptedBody); expect(accepted.status(), await accepted.text()).toBe(202);
    const acceptedResult = await accepted.json() as { runId: string; duplicate: boolean };
    expect(acceptedResult).toMatchObject({ duplicate: false });
    const inspect = () => host.script('inspect-trigger.mjs', `import Database from ${moduleUrl('node_modules/better-sqlite3/lib/index.js')};const db=new Database(process.env.HELMSMAN_DB,{readonly:true});try{const deliveries=db.prepare('SELECT * FROM webhook_deliveries ORDER BY delivery').all();const admission=db.prepare('SELECT json FROM execution_admissions WHERE runId=?').get(${JSON.stringify(acceptedResult.runId)});console.log(JSON.stringify({deliveries,admission:admission?JSON.parse(admission.json):null}));}finally{db.close();}`).then(value => JSON.parse(value));
    await expect.poll(async () => (await inspect()).admission?.request?.trigger?.provider?.binding?.providerId, { timeout: 20_000 }).toBe(`${pluginId}/webhook`);
    const captured = await inspect();
    expect(captured.deliveries.find((value: { delivery: string }) => value.delivery === 'ignored-delivery')).toMatchObject({ state: 'ignored' });
    expect(captured.deliveries.find((value: { delivery: string }) => value.delivery === 'accepted-delivery').triggerJson).toContain(`${pluginId}/webhook`);
    expect(captured.admission.request.trigger.provider.settings).toMatchObject({ enabled: true, prefix: 'Changed: ' });
    expect(JSON.stringify(captured.deliveries)).not.toContain(secret);

    const clearedCredential = await request.put(`${origin}/api/webhooks/github/credential`, { data: { secret: '' } });
    expect(clearedCredential.ok(), await clearedCredential.text()).toBe(true);
    const cleared = await post('cleared-delivery', acceptedBody); expect(cleared.status()).toBe(503);
    await host.stop();
    const bootstrapSecret = 'must-not-restore-cleared-secret'; host.env.HELMSMAN_WEBHOOK_SECRET = bootstrapSecret; origin = await host.start();
    const bootstrapDenied = await post('bootstrap-delivery', acceptedBody, bootstrapSecret); expect(bootstrapDenied.status()).toBe(503);
    const rotatedSecret = 'rotated-webhook-secret';
    const rotatedCredential = await request.put(`${origin}/api/webhooks/github/credential`, { data: { secret: rotatedSecret } });
    expect(rotatedCredential.ok(), await rotatedCredential.text()).toBe(true);
    const rotated = await post('rotated-delivery', ignoredBody, rotatedSecret); expect(rotated.status(), await rotated.text()).toBe(202);
    expect(JSON.stringify(await inspect())).not.toContain(rotatedSecret);

    await host.stop(); await host.cli('select-trigger', 'github-webhook', 'disabled'); origin = await host.start();
    const disabled = await post('disabled-delivery', acceptedBody, rotatedSecret); expect(disabled.status()).toBe(503);
    const retained = await inspect();
    expect(retained.admission.request.trigger.provider.binding.providerId).toBe(`${pluginId}/webhook`);
    expect(retained.deliveries.some((value: { delivery: string }) => value.delivery === 'disabled-delivery')).toBe(false);
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally { await host.close(); }
});
