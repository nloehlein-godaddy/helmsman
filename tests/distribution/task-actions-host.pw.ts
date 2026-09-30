import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture } from './isolated-fixture';

test('installed Jira and Triage assign the authenticated actor once and restore the receipt after response loss and restart', async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const host = await fixture(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const stateFile = join(host.root, 'jira-state.json');
  const initialIssue = { id: '10001', key: 'TASK-1', fields: { summary: 'Claim this task', updated: new Date(Date.now() - 60_000).toISOString(),
    status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } }, priority: { name: 'High' }, project: { key: 'TASK' },
    assignee: null, reporter: { accountId: 'reporter-id' }, description: 'Assignment acceptance' }, names: {} };
  try {
    await writeFile(stateFile, JSON.stringify({ issue: initialIssue, writes: [] }));
    const preload = join(host.root, 'jira-http-fixture.mjs');
    await writeFile(preload, `import { readFileSync, writeFileSync } from 'node:fs';
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(['127.0.0.1','localhost'].includes(url.hostname)) return original(input,init);
  if(url.origin!=='https://fixture.atlassian.net') throw new Error('Unexpected external request');
  const state=JSON.parse(readFileSync(${JSON.stringify(stateFile)},'utf8'));
  if(url.pathname==='/rest/api/3/myself') return Response.json({accountId:'authenticated-actor'});
  if(url.pathname==='/_edge/tenant_info') return Response.json({}, {status:404});
  if(url.pathname==='/rest/api/3/issue/10001/assignee' && init?.method==='PUT') {
    const body=JSON.parse(init.body); if(body.accountId!=='authenticated-actor') throw new Error('Wrong assignee');
    state.writes.push(body); state.issue.fields.assignee={accountId:body.accountId}; state.issue.fields.updated=new Date().toISOString();
    writeFileSync(${JSON.stringify(stateFile)},JSON.stringify(state)); return new Response(null,{status:204});
  }
  if(init?.method && init.method!=='GET') throw new Error('Unexpected Jira mutation');
  if(url.pathname==='/rest/api/3/issue/10001') return Response.json(state.issue);
  if(url.pathname==='/rest/api/3/search/jql') {
    const jql=url.searchParams.get('jql')??'';
    const included=jql.includes('project = "TASK"') && !jql.includes('Backlog') &&
      (jql.includes('assignee IS EMPTY') ? state.issue.fields.assignee===null : state.issue.fields.assignee?.accountId==='authenticated-actor');
    return Response.json({issues:included?[state.issue]:[],isLast:true});
  }
  return Response.json({}, {status:404});
};`);
    Object.assign(host.env, { JIRA_ENABLED: 'true', JIRA_BASE_URL: 'https://fixture.atlassian.net', JIRA_EMAIL: 'fixture@example.test',
      JIRA_API_TOKEN: 'fixture-token', JIRA_PROJECT: 'TASK', JIRA_ASSIGNEE: 'currentUser()', REPO_PROJECT_MAP: 'org/a=TASK,org/b=OTHER',
      NODE_OPTIONS: `${host.env.NODE_OPTIONS} --import=${pathToFileURL(preload).href}` });
    await host.installAuthorPackage('plugin-sources/jira', 'example.assignment-jira');
    await host.installAuthorPackage('plugin-sources/triage', 'example.assignment-triage');
    await host.start(); await host.stop();
    const inventory = JSON.parse(await host.cli('list'));
    const artifact = inventory.plugins.find((plugin: { id: string }) => plugin.id === 'example.assignment-jira');
    expect(artifact?.hash).toMatch(/^[a-f\d]{64}$/);
    const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(host.app, `server/helmsman/${name}.js`)).href);
    await host.script('seed-assignment-source.mjs', `import { openPersistence } from ${moduleUrl('persistence')};
import { openTaskSourceStore, writeTaskSource } from ${moduleUrl('task-sources/store')};
const persistence=openPersistence(process.env.HELMSMAN_DB);
try {
  const store=openTaskSourceStore(persistence); const original=store.instances().find(value=>value.binding.providerId==='helmsman.jira/issues');
  if(!original) throw new Error('Missing Jira fixture source');
  store.configureInstance({instanceId:original.id,expectedRevision:original.revision,desiredEnabled:false});
  const value=store.provision({provisioningKey:'independent-assignment',label:'Assignment Jira',storageLayout:'remote',distinctUnverifiedSource:true,
    identityEvidence:{version:1,level:'operator-seeded',authority:null,verifiedAt:new Date().toISOString(),proof:{}},
    binding:{...original.binding,providerId:'example.assignment-jira/issues',pluginId:'example.assignment-jira',artifactHash:${JSON.stringify(artifact.hash)}},
    settings:{...original.settings,assigneeAccountId:'configured-bot-not-the-actor'},allowedRepos:['org/a','org/b']});
  persistence.transaction(()=>writeTaskSource(store,{...value.source,conversionReady:true}));
} finally {persistence.close();}`);
    let origin = await host.start();
    await page.goto(`${origin}/plugins/example.assignment-triage/page?repo=org/a`);
    const triage = page.locator('.plugin-triage').last();
    await expect(triage).toContainText('Claim this task');
    const assign = triage.getByRole('button', { name: 'Assign TASK-1 to me', exact: true });
    await expect(assign).toHaveCount(1); await expect(assign).toBeEnabled();
    await expect(page.locator('#boot')).toBeHidden();
    await assign.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('assign-self-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await assign.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('assign-self-mobile.png') });
    let submitted: unknown;
    await page.route('**/api/task-action', async route => {
      submitted = route.request().postDataJSON(); await route.fetch(); await route.abort('failed');
    });
    await assign.click();
    await expect.poll(async () => JSON.parse(await readFile(stateFile, 'utf8')).writes.length).toBe(1);
    await page.unroute('**/api/task-action');
    await page.reload();
    const saved = triage.getByRole('region', { name: 'Saved assignment' });
    await expect(saved).toBeVisible();
    const check = saved.getByRole('button', { name: 'Check assignment receipt', exact: true });
    if (await check.isVisible()) await check.click();
    await expect(saved).toContainText('Assigned to you.');
    expect(submitted).toBeTruthy();
    const forbidden = await request.post(`${origin}/api/task-action`, {
      headers: { 'x-helmsman-contribution': 'helmsman.bugs/panel' }, data: submitted });
    expect(forbidden.status()).toBe(403);
    host.env.HELMSMAN_PORT = new URL(origin).port;
    origin = await host.start(); await page.goto(`${origin}/plugins/example.assignment-triage/page?repo=org/a`);
    await expect(saved).toContainText('Assigned to you.');
    await saved.getByRole('button', { name: 'Dismiss saved assignment', exact: true }).click();
    await expect(saved).toHaveCount(0); await expect(assign).toHaveCount(0);
    await page.goto(`${origin}/plugins/example.assignment-triage/page?repo=org/b`);
    await expect(triage).not.toContainText('Claim this task'); await expect(assign).toHaveCount(0);
    const final = JSON.parse(await readFile(stateFile, 'utf8'));
    expect(final.writes).toEqual([{ accountId: 'authenticated-actor' }]);
    expect(errors).toEqual([]); expect(host.output()).not.toContain('fixture-token');
  } finally { await host.close(); }
});
