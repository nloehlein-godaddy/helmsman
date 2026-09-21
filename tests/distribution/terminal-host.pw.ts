import { expect, test } from '@playwright/test';
import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, sourceRoot } from './isolated-fixture';

test('source-denied authored terminal preserves scope and durable controls against an isolated cmux fixture', async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const host = await fixture();
  const statePath = join(host.root, 'terminal-fixture.json');
  const cmuxPath = join(host.root, 'commands', 'cmux');
  const cmuxSocket = join(host.root, 'cmux-fixture.sock');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(host.script('deny-terminal-source.mjs', `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(sourceRoot, 'src/plugins/terminal/page.ts'))});`)).rejects.toThrow('Source checkout is unavailable');
    await Promise.all([mkdir(join(host.cwd, 'a')), mkdir(join(host.cwd, 'b'))]);
    await Promise.all([writeFile(statePath, JSON.stringify({ sends: [] })), writeFile(cmuxSocket, 'isolated fixture socket identity')]);
    await writeFile(cmuxPath, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2);const statePath=${JSON.stringify(statePath)};
const state=()=>JSON.parse(readFileSync(statePath,'utf8'));const save=value=>writeFileSync(statePath,JSON.stringify(value));
const workspaces=[
  {ref:'workspace:a',title:'Org A workspace',current_directory:${JSON.stringify(join(host.cwd, 'a'))}},
  {ref:'workspace:b',title:'Org B workspace',current_directory:${JSON.stringify(join(host.cwd, 'b'))}},
  {ref:'workspace:unattached',title:'Scratch workspace',current_directory:null},
];
const surfaces={
  'workspace:a':[{ref:'surface:1',title:'A terminal',type:'terminal',selected:true}],
  'workspace:b':[{ref:'surface:2',title:'B terminal',type:'terminal',selected:false}],
  'workspace:unattached':[{ref:'surface:3',title:'Unattached terminal',type:'terminal',selected:false}],
};
if(args[0]==='events'){setInterval(()=>{},60_000);}
else if(args[0]==='list-windows'&&args.includes('--json'))console.log(JSON.stringify([{id:'window:fixture'}]));
else if(args[0]==='workspace'&&args[1]==='list')console.log(JSON.stringify({window_ref:'window:fixture',workspaces}));
else if(args[0]==='list-pane-surfaces'){const workspace=args[args.indexOf('--workspace')+1];console.log(JSON.stringify({surfaces:surfaces[workspace]??[]}));}
else if(args.includes('tree'))console.log(JSON.stringify({windows:[{workspaces:[{panes:[{surfaces:[{ref:'surface:9',type:'browser',url:'https://app.slack.com/client/T123/C123'}]}]}]}]}));
else if(args[0]==='rpc'&&args[1]==='surface.focus'){}
else if(args[0]==='browser'){if(args[2]==='eval')console.log(JSON.stringify('browser-result'));}
else if(args[0]==='read-screen'){const surface=args[args.indexOf('--surface')+1];console.log({'surface:1':'org/a exact screen','surface:2':'org/b exact screen','surface:3':'unattached exact screen'}[surface]??'unknown screen');}
else if(args[0]==='send'||args[0]==='send-key'){const next=state();next.sends.push({kind:args[0],surface:args[args.indexOf('--surface')+1],value:args.at(-1)});save(next);}
else process.exit(1);
`, { mode: 0o755 });
    await chmod(cmuxPath, 0o755);
    host.env.TERM_BRIDGE = 'cmux';
    host.env.CMUX_SOCKET_PATH = cmuxSocket;
    host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
    await cp(join(sourceRoot, 'node_modules/@types/node'), join(host.root, 'node_modules/@types/node'), { recursive: true });
    await cp(join(sourceRoot, 'node_modules/undici-types'), join(host.root, 'node_modules/undici-types'), { recursive: true });
    await host.installAuthorPackage('plugin-sources/terminal-cmux', 'example.native-cmux', { buildScript: true });
    await host.installAuthorPackage('plugin-sources/terminal-wezterm', 'example.native-wezterm', { buildScript: true });
    await host.cli('configure', 'example.native-cmux', JSON.stringify({ socketPath: cmuxSocket }));
    await host.cli('select-native-terminal', 'example.native-cmux/cmux');
    const nativeModule = (name: string) => JSON.stringify(pathToFileURL(join(host.root, `author-plugin-sources-${name}`, 'dist/backend.js')).href);
    const browserProof = await host.script('native-browser-proof.mjs', `
const cmux=await import(${nativeModule('terminal-cmux')});const wezterm=await import(${nativeModule('terminal-wezterm')});
let provider;const cleanups=[];const context={pluginId:'example.native-cmux',settings:{binary:'cmux',socketPath:${JSON.stringify(cmuxSocket)}},signal:new AbortController().signal,registerNativeTerminal(_id,value){provider=value;},onDispose(work){cleanups.push(work);}};
await cmux.default.activate(context);if(!provider?.metadata.browser||!provider.browser)throw new Error('Browser provider missing');
const browser=provider.browser;const tree=await browser.tree();if(!tree?.windows?.length)throw new Error('Browser tree missing');
await browser.focus({surface:'surface:9'});if(await browser.evaluate({surface:'surface:9',script:'JSON.stringify(true)'})!=='browser-result')throw new Error('Browser evaluation failed');
await browser.click({surface:'surface:9',selector:'button'});await browser.fill({surface:'surface:9',selector:'input',value:'fixture'});await browser.wait({surface:'surface:9',selector:'main',timeoutMs:100});
for(const work of cleanups.splice(0))await work();
await wezterm.default.activate({...context,pluginId:'example.native-wezterm',settings:{binary:'wezterm',socketPath:''}});
if(provider?.metadata.browser!==false||provider.browser!==undefined)throw new Error('WezTerm acquired an implicit browser');
for(const work of cleanups)await work();console.log('NATIVE_BROWSER_ACCEPTED');`);
    expect(browserProof).toContain('NATIVE_BROWSER_ACCEPTED');
    const descriptor = await host.installAuthorPackage('plugin-sources/terminal', 'example.authored-terminal', { buildScript: true });
    expect(descriptor.manifest.id).toBe('example.authored-terminal');
    await host.cli('select', 'helmsman/terminal-page', 'example.authored-terminal/page');

    let origin = await host.start();
    let lostCommand: { command: { requestId: string; target: { repo: string; surfaceRef: string }; operation: unknown } } | null = null;
    let loseResponse = true;
    let dropBeforeDelivery = false;
    let undelivered: unknown = null;
    await page.route('**/api/terminal/control', async route => {
      const submitted = route.request().postDataJSON() as { command: { requestId: string; target: { repo: string; surfaceRef: string }; operation: unknown } };
      if (dropBeforeDelivery) { undelivered = submitted; dropBeforeDelivery = false; await route.abort('failed'); return; }
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      if (loseResponse) { lostCommand = submitted; loseResponse = false; await route.abort('failed'); }
      else await route.fulfill({ response });
    });

    await page.goto(`${origin}/terminal?repo=org/a&pane=screen`);
    const terminal = page.locator('.plugin-terminal');
    await expect(page.locator('.repo-select')).toHaveValue('org/a');
    await expect(terminal).toContainText('Scope: org/a');
    await expect(terminal.getByRole('button', { name: /A terminal/ })).toBeVisible();
    await expect(terminal).not.toContainText('B terminal');
    await expect(terminal).not.toContainText('Unattached terminal');
    await terminal.getByRole('button', { name: /A terminal/ }).click();
    await expect(terminal.getByLabel('Screen output from A terminal')).toContainText('org/a exact screen');

    await terminal.getByLabel('Send text to A terminal').fill('lost exact text');
    await terminal.getByRole('button', { name: 'Send + Enter', exact: true }).click();
    await expect(terminal.getByRole('button', { name: 'Check original receipt', exact: true })).toBeVisible();
    await expect.poll(async () => (JSON.parse(await readFile(statePath, 'utf8')) as { sends: unknown[] }).sends.length).toBe(2);
    const afterLost = JSON.parse(await readFile(statePath, 'utf8')) as { sends: { kind: string; surface: string; value: string }[] };
    expect(afterLost.sends).toEqual([
      { kind: 'send', surface: 'surface:1', value: 'lost exact text' },
      { kind: 'send-key', surface: 'surface:1', value: 'Enter' },
    ]);
    await terminal.getByRole('button', { name: 'Check original receipt', exact: true }).click();
    await expect(terminal).toContainText('Control confirmed.');
    expect((JSON.parse(await readFile(statePath, 'utf8')) as { sends: unknown[] }).sends).toHaveLength(2);

    await terminal.getByRole('button', { name: 'Send right key', exact: true }).click();
    await expect.poll(async () => (JSON.parse(await readFile(statePath, 'utf8')) as { sends: unknown[] }).sends.length).toBe(3);
    const afterKey = JSON.parse(await readFile(statePath, 'utf8')) as { sends: { kind: string; surface: string; value: string }[] };
    expect(afterKey.sends.at(-1)).toEqual({ kind: 'send-key', surface: 'surface:1', value: 'right' });

    await expect(terminal.getByRole('button', { name: 'Send + Enter', exact: true })).toBeEnabled();
    dropBeforeDelivery = true;
    await terminal.getByLabel('Send text to A terminal').fill('never delivered');
    await terminal.getByRole('button', { name: 'Send + Enter', exact: true }).click();
    await expect(terminal.getByRole('button', { name: 'Check original receipt', exact: true })).toBeVisible();
    await terminal.getByRole('button', { name: 'Check original receipt', exact: true }).click();
    await expect(terminal.getByRole('button', { name: 'Resume controls after inspection', exact: true })).toBeEnabled();
    await terminal.getByRole('button', { name: 'Resume controls after inspection', exact: true }).click();
    await expect(terminal.getByRole('button', { name: 'Send + Enter', exact: true })).toBeEnabled();
    expect(undelivered).not.toBeNull();
    const delayed = await request.post(`${origin}/api/terminal/control`, {
      headers: { 'x-helmsman-contribution': 'example.authored-terminal/panel' }, data: undelivered,
    });
    expect(delayed.status()).toBe(200);
    expect(await delayed.json()).toMatchObject({ status: 'recovery-required', input: { operation: { text: 'never delivered' } } });
    expect((JSON.parse(await readFile(statePath, 'utf8')) as { sends: unknown[] }).sends).toHaveLength(3);
    await terminal.getByRole('button', { name: 'Send right key', exact: true }).click();
    await expect.poll(async () => (JSON.parse(await readFile(statePath, 'utf8')) as { sends: unknown[] }).sends.length).toBe(4);

    await terminal.getByRole('button', { name: 'Show all terminals', exact: true }).click();
    await expect(terminal).toContainText('Scope: All terminals');
    await expect(terminal.getByRole('button', { name: /Unattached terminal/ })).toBeVisible();
    await expect(terminal.getByRole('button', { name: /A terminal/ })).toBeVisible();
    await expect(terminal.getByRole('button', { name: /B terminal/ })).toBeVisible();
    await terminal.getByRole('button', { name: /Unattached terminal/ }).click();
    await expect(terminal.getByLabel('Screen output from Unattached terminal')).toContainText('unattached exact screen');
    await terminal.getByRole('button', { name: 'Use header scope', exact: true }).click();
    await expect(terminal).toContainText('Scope: org/a');
    await terminal.getByRole('button', { name: /A terminal/ }).click();
    await expect(terminal.getByLabel('Screen output from A terminal')).toContainText('org/a exact screen');

    await page.screenshot({ path: testInfo.outputPath('terminal-desktop.png'), fullPage: true });
    expect(await terminal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#page-content').evaluate(element => { element.scrollTop = 0; });
    expect(await terminal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(terminal.getByRole('heading', { name: 'Terminal', exact: true }).first()).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('terminal-mobile.png'), fullPage: true });
    await terminal.getByLabel('Send text to A terminal').scrollIntoViewIfNeeded();
    await expect(terminal.getByLabel('Send text to A terminal')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('terminal-mobile-controls.png'), fullPage: true });

    await page.unroute('**/api/terminal/control');
    expect(lostCommand).not.toBeNull();
    const requestId = lostCommand!.command.requestId;
    origin = await host.start();
    const receipt = await request.get(`${origin}/api/terminal/receipts/${requestId}?repo=org%2Fa&scopeRepo=org%2Fa`, { headers: { 'x-helmsman-contribution': 'example.authored-terminal/panel' } });
    expect(receipt.status()).toBe(200);
    expect(await receipt.json()).toMatchObject({ requestId, status: 'succeeded', input: { target: { repo: 'org/a', surfaceRef: 'surface:1' }, operation: { kind: 'text', text: 'lost exact text', enter: true } } });
    expect((JSON.parse(await readFile(statePath, 'utf8')) as { sends: unknown[] }).sends).toHaveLength(4);
    await page.goto(`${origin}/terminal?repo=org/a`);
    await expect(terminal.getByRole('button', { name: /A terminal/ })).toBeVisible();

    const headers = { 'x-helmsman-contribution': 'example.authored-terminal/panel' };
    const list = await request.get(`${origin}/api/terminal/tabs?version=1&repo=org%2Fa&scopeRepo=org%2Fa`, { headers });
    expect(list.ok()).toBe(true);
    const priorTarget = (await list.json()).tabs[0].target;
    await host.stop();
    await host.cli('configure', 'example.native-cmux', JSON.stringify({ socketPath: cmuxSocket, binary: cmuxPath }));
    origin = await host.start();
    const stale = await request.post(`${origin}/api/terminal/control`, { headers, data: { scopeRepo: 'org/a', command: {
      version: 1, requestId: '30000000-0000-4000-8000-000000000001', target: priorTarget, operation: { kind: 'text', text: 'stale provider target', enter: false },
    } } });
    expect(stale.ok()).toBe(true); expect(await stale.json()).toMatchObject({ status: 'rejected' });
    expect((JSON.parse(await readFile(statePath, 'utf8')) as { sends: unknown[] }).sends).toHaveLength(4);
    await host.stop(); await host.cli('disable', 'example.native-cmux'); origin = await host.start();
    expect((await request.get(`${origin}/api/terminal/tabs?version=1&repo=org%2Fa&scopeRepo=org%2Fa`, { headers })).status()).toBe(503);
    const retainedReceipt = await request.get(`${origin}/api/terminal/receipts/${requestId}?repo=org%2Fa&scopeRepo=org%2Fa`, { headers });
    expect(retainedReceipt.ok()).toBe(true); expect(await retainedReceipt.json()).toMatchObject({ requestId, status: 'succeeded' });
    expect((await request.post(`${origin}/api/cmux/send`, { data: { surface: 'surface:1', text: 'legacy bypass', enter: true } })).status()).toBe(410);
    expect((JSON.parse(await readFile(statePath, 'utf8')) as { sends: unknown[] }).sends).toHaveLength(4);
    await host.cli('disable', 'example.authored-terminal');
    await page.goto(`${origin}/terminal?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'Page unavailable', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally {
    await host.close();
  }
});
