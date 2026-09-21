import { expect, test } from '@playwright/test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
else if(args[0]==='read-screen'){const surface=args[args.indexOf('--surface')+1];console.log({'surface:1':'org/a exact screen','surface:2':'org/b exact screen','surface:3':'unattached exact screen'}[surface]??'unknown screen');}
else if(args[0]==='send'||args[0]==='send-key'){const next=state();next.sends.push({kind:args[0],surface:args[args.indexOf('--surface')+1],value:args.at(-1)});save(next);}
else process.exit(1);
`, { mode: 0o755 });
    await chmod(cmuxPath, 0o755);
    host.env.TERM_BRIDGE = 'cmux';
    host.env.CMUX_SOCKET_PATH = cmuxSocket;
    host.env.REPO_PROJECT_MAP = 'org/a=TASK,org/b=OTHER';
    const descriptor = await host.installAuthorPackage('plugin-sources/terminal', 'example.authored-terminal', { buildScript: true });
    expect(descriptor.manifest.id).toBe('example.authored-terminal');
    await host.cli('select', 'helmsman/terminal-page', 'example.authored-terminal/page');

    let origin = await host.start();
    let lostCommand: { command: { requestId: string; target: { repo: string; surfaceRef: string }; operation: unknown } } | null = null;
    let loseResponse = true;
    await page.route('**/api/terminal/control', async route => {
      const submitted = route.request().postDataJSON() as { command: { requestId: string; target: { repo: string; surfaceRef: string }; operation: unknown } };
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
    expect((JSON.parse(await readFile(statePath, 'utf8')) as { sends: unknown[] }).sends).toHaveLength(3);
    await page.goto(`${origin}/terminal?repo=org/a`);
    await expect(terminal.getByRole('button', { name: /A terminal/ })).toBeVisible();

    await host.cli('disable', 'example.authored-terminal');
    await page.goto(`${origin}/terminal?repo=org/a`);
    await expect(page.getByRole('heading', { name: 'Page unavailable', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    expect(host.output()).not.toContain('Source checkout is unavailable');
  } finally {
    await host.close();
  }
});
