import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createWhiteboardClient, type WhiteboardDocument } from './client';

const directories: string[] = [];
const sessionId = '12345678-1234-1234-1234-123456789abc';
const document: WhiteboardDocument = { summary: 'Change explanation', requirements: ['Preserve state'], design: 'Single flow', implementation: ['Validate input'],
  diagram: { nodes: [{ id: 'input', label: 'Input' }, { id: 'result', label: 'Result' }], edges: [{ from: 'input', to: 'result', label: 'Validate' }] } };
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(body: string) {
  const directory = await mkdtemp(join(tmpdir(), 'helmsman-whiteboard-client-')); directories.push(directory);
  const command = join(directory, 'whiteboard');
  await writeFile(command, `#!${process.execPath}\nconst fs=require('node:fs');let args=process.argv.slice(2);if(args[0]==='api')args=['--state-dir',process.env.DEV_REVIEW_HOME,...args];const tool=args[3];const input=JSON.parse(fs.readFileSync(0,'utf8'));${body}\n`, { mode: 0o700 });
  return { command, directory, client: createWhiteboardClient({ command, home: directory }) };
}
it('creates an immutable background review and rejects changed source pins', async () => {
  const f = await fixture(`if(input.open!==false||input.target.kind!=='commits')process.exit(1);console.log(JSON.stringify({sessionId:'${sessionId}',session:{target:input.target,repositoryPath:input.target.repositoryPath}}));`);
  const input = { repositoryPath: f.directory, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), title: 'Review' };
  await expect(f.client.create(input)).resolves.toBe(sessionId);
  const changed = await fixture(`console.log(JSON.stringify({sessionId:'${sessionId}',session:{target:{...input.target,head:'wrong'},repositoryPath:input.target.repositoryPath}}));`);
  await expect(changed.client.create(input)).rejects.toThrow('different source pins');
});
it('reconciles a successful edit whose response was lost without inserting twice', async () => {
  const f = await fixture(`const file=args[1]+'/document.json';if(tool==='session_get'){console.log(JSON.stringify({sessionId:input.sessionId,document:fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[]}));}else{fs.writeFileSync(file,JSON.stringify([input.edit.content]));process.exit(1);}`);
  await expect(f.client.write(sessionId, document)).rejects.toThrow('CLI failed');
  await expect(f.client.write(sessionId, document)).resolves.toBeUndefined();
  expect(JSON.parse(await readFile(join(f.directory, 'document.json'), 'utf8'))).toHaveLength(1);
});
it('preserves user changes rather than replacing the existing explanation', async () => {
  const f = await fixture(`console.log(JSON.stringify({sessionId:input.sessionId,document:[{type:'section',title:'Helmsman review explanation',children:[{type:'markdown',markdown:'User edits'}]}]}));`);
  await expect(f.client.write(sessionId, document)).rejects.toThrow('preserve the existing document');
});
it('strips inherited credentials and disables telemetry for child processes', async () => {
  const f = await fixture(`if(process.env.GITHUB_TOKEN||process.env.OPENAI_API_KEY||process.env.NODE_OPTIONS||process.env.DO_NOT_TRACK!=='1'||process.env.DEV_REVIEW_HOME!==args[1]||process.env.DEV_REVIEW_SERVER_DIR!==args[1])process.exit(1);console.log('{}');`);
  const client = createWhiteboardClient({ command: f.command, home: f.directory, environment: { ...process.env, GITHUB_TOKEN: 'secret', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--invalid' } });
  await expect(client.check()).resolves.toBeUndefined();
});
it('reports unavailable Desktop before trying to open a review', async () => {
  const f = await fixture(`if(tool!=='session_capabilities')process.exit(1);console.log('{"desktopAvailable":false}');`);
  await expect(f.client.open(sessionId)).rejects.toThrow('Desktop is not attached');
});
it('checks Desktop has the same immutable session before opening it', async () => {
  const f = await fixture(`if(tool==='session_capabilities')console.log('{"desktopAvailable":true}');else if(tool==='session_get')console.log(JSON.stringify({sessionId:input.sessionId,target:{kind:'commits',repositoryId:'repo-one',base:'base',head:process.env.DEV_REVIEW_SERVER_DIR?'expected':'different'}}));else process.exit(1);`);
  await expect(f.client.open(sessionId)).rejects.toThrow('different review profile');
});
it('bounds malformed responses, command time, and cancelled requests', async () => {
  const bad = await fixture(`console.log('not-json');`);
  await expect(bad.client.check()).rejects.toThrow('Invalid Whiteboard response');
  const slow = await fixture(`setTimeout(()=>console.log('{}'),10000);`);
  await expect(createWhiteboardClient({ command: slow.command, home: slow.directory, timeoutMs: 20 }).check()).rejects.toThrow('CLI failed');
  const controller = new AbortController(); controller.abort();
  await expect(slow.client.check(controller.signal)).rejects.toThrow();
});
