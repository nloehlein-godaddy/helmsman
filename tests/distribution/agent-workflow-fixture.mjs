import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function executable(name, env) {
  for (const directory of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error(`${name} is unavailable`);
}

async function command(file, args, cwd, env) {
  return (await exec(file, args, { cwd, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
}

async function publicationServer(token) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/publication/v1');
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, prNumber: 42 }));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Publication fixture did not bind');
  return { requests, url: `http://127.0.0.1:${address.port}/publication/v1`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

function workerSource(statePath, realGit) {
  return `import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const input=JSON.parse(process.argv[2]);
const statePath=${JSON.stringify(statePath)};
const git=${JSON.stringify(realGit)};
const state=JSON.parse(readFileSync(statePath,'utf8'));
(state.prompts??=[]).push(input.prompt.split('\\n')[0]);
const paths=[...input.prompt.matchAll(/"(\\/[^"\\n]+)"/g)].map(match=>JSON.parse(match[0]));
const reportPath=paths.at(-1);
if(!reportPath)throw new Error('Missing report path');
const match=input.prompt.match(/Base revision: ([a-f0-9]{40,64})[\\s\\S]*?Round: (\\d+)/);
if(!match)throw new Error('Missing revision context');
const baseSha=match[1];const round=Number(match[2]);
const headSha=input.prompt.match(/Head revision: ([a-f0-9]{40,64})/)?.[1];
const emit=(event)=>process.stdout.write(JSON.stringify(event)+'\\n');
const commit=(contents,message)=>{writeFileSync('workflow.txt',contents);execFileSync(git,['add','workflow.txt']);execFileSync(git,['commit','-m',message]);};
if(input.stage==='implement'){
 state.implement++;commit('implemented\\n','Implement fixture');
 writeFileSync(reportPath,JSON.stringify({title:'T-1 implement retained agents',body:'Implements the retained agent workflow.'}));
}else if(input.stage==='fix'){
 state.fixAttempts++;
 if(state.fixAttempts===1){writeFileSync(statePath,JSON.stringify(state));emit({kind:'result',outcome:'failure',text:'fixture checkpoint'});process.exit(0);}
 commit('implemented\\nfixed\\n','Fix review finding');
 writeFileSync(reportPath,JSON.stringify({title:'T-1 fix retained agents',body:'Fixes the retained review finding.'}));
}else if(input.stage==='review'&&input.summaryCorrection){
 state.corrections++;
 const prior=JSON.parse(readFileSync(paths.at(-2),'utf8'));
 writeFileSync(reportPath,JSON.stringify({...prior,summary:'Material fixture review.'}));
}else if(input.stage==='review'){
 state.reviews[String(round)]=(state.reviews[String(round)]??0)+1;
 (state.order??=[]).push(input.testProvider??'legacy');
 const approved=round>1;
 writeFileSync(reportPath,JSON.stringify({baseSha,headSha,verdict:approved?'APPROVE':'REQUEST_CHANGES',summary:approved?'Approved fixture revision.':'x'.repeat(2100),findings:approved?[]:[{title:'Fixture defect',body:'The implementation requires the retained fix.',path:'workflow.txt',line:1}]}));
}else throw new Error('Unexpected fixture stage');
writeFileSync(statePath,JSON.stringify(state));emit({kind:'result',outcome:'success',text:'fixture stage complete'});`;
}

export async function runAgentWorkflowFixture(input) {
  const { app, root, selection, artifacts, pluginsRoot, runtimeArtifactsRoot } = input;
  const env = { ...process.env, ...(input.env ?? {}) };
  assert.equal(typeof app, 'string');
  assert.equal(typeof root, 'string');
  assert.ok(selection?.writer?.binding?.providerId);
  assert.ok(Array.isArray(selection.reviewers) && selection.reviewers.length > 0);
  assert.ok(Array.isArray(artifacts) && artifacts.length > 0);
  const runtime = await import(pathToFileURL(join(app, 'server/helmsman/pre-pr-runtime.js')).href);
  const continuation = await import(pathToFileURL(join(app, 'server/helmsman/resume.js')).href);
  const realGit = input.realGit ?? await executable('git', env);
  const fixtureRoot = join(root, 'agent-workflow-fixture');
  const bin = join(fixtureRoot, 'bin');
  const seed = join(fixtureRoot, 'seed');
  const remote = join(fixtureRoot, 'workflow-remote.git');
  const repo = join(fixtureRoot, 'workflow-run');
  const runsDir = join(fixtureRoot, 'runs');
  const statePath = join(fixtureRoot, 'agent-workflow-state.json');
  const workerScript = join(root, 'agent-worker.mjs');
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(seed, { recursive: true }), mkdir(runsDir, { recursive: true })]);
  await writeFile(statePath, JSON.stringify({ implement: 0, fixAttempts: 0, corrections: 0, reviews: {} }));
  await writeFile(workerScript, workerSource(statePath, realGit), { mode: 0o700 });
  await writeFile(join(bin, 'git'), `#!/usr/bin/env node\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);if(args[0]==='remote'&&args[1]==='get-url'){console.log('https://github.com/org/repo.git');process.exit(0);}const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env});process.exit(result.status??1);`, { mode: 0o700 });
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node\nconst args=process.argv.slice(2);if(args[0]==='repo'&&args[1]==='view'){console.log(JSON.stringify({nameWithOwner:'org/repo',defaultBranchRef:{name:'main'}}));}else{console.error('Unexpected gh fixture command');process.exitCode=2;}`, { mode: 0o700 });
  const gitEnv = { ...env, PATH: `${bin}${delimiter}${env.PATH ?? ''}` };
  await command(realGit, ['init', '--initial-branch=main'], seed, env);
  await command(realGit, ['config', 'user.name', 'Fixture'], seed, env);
  await command(realGit, ['config', 'user.email', 'fixture@example.invalid'], seed, env);
  await writeFile(join(seed, 'README.md'), 'fixture\n');
  await command(realGit, ['add', 'README.md'], seed, env);
  await command(realGit, ['commit', '-m', 'Initial fixture'], seed, env);
  await command(realGit, ['init', '--bare', remote], fixtureRoot, env);
  await command(realGit, ['remote', 'add', 'origin', remote], seed, env);
  await command(realGit, ['push', 'origin', 'main'], seed, env);
  await command(realGit, ['symbolic-ref', 'HEAD', 'refs/heads/main'], remote, env);
  await command(realGit, ['clone', remote, repo], fixtureRoot, env);
  await command(realGit, ['config', 'user.name', 'Fixture'], repo, env);
  await command(realGit, ['config', 'user.email', 'fixture@example.invalid'], repo, env);
  await command(realGit, ['switch', '-c', 'agent/workflow-run'], repo, env);
  const token = 'a'.repeat(64);
  const publication = await publicationServer(token);
  const reviewerIds = selection.reviewers.map(record => record.binding.providerId);
  const task = { ...(input.workflow ? { workflow: input.workflow, workflowRuntime: { pluginsRoot, runtimeArtifactsRoot, artifacts: input.workflowArtifacts } } : {}), agentSelection: selection, agentRuntime: { pluginsRoot, runtimeArtifactsRoot, artifacts }, ticketId: 'T-1', title: 'Exercise retained agents',
    repo: 'org/repo', jiraBaseUrl: '', task: 'Exercise every retained pre-PR stage and continuation.' };
  const settings = { reviewerCount: reviewerIds.length, maxRounds: 3, stageTimeoutMinutes: 5 };
  const events = [];
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  process.chdir(repo);
  process.env.PATH = gitEnv.PATH;
  try {
    await assert.rejects(runtime.runPrePrRuntime({ task, runsDir, settings, publication: { url: publication.url, token } }, event => events.push(event)), /unsuccessful result|fixture checkpoint/);
    assert.equal(publication.requests.length, 0);
    const specPath = join(runsDir, 'workflow-run.json');
    const logPath = join(runsDir, 'workflow-run.log');
    const exitPath = join(runsDir, 'workflow-run.exit');
    const log = 'failed retained workflow\n';
    await writeFile(specPath, JSON.stringify({ cwd: repo, cmd: process.execPath, args: [JSON.stringify({ task, runsDir, settings, publication: { url: publication.url, token } })] }));
    await writeFile(logPath, log);
    await writeFile(exitPath, '1');
    const row = { id: 'workflow-run', ticketId: task.ticketId, repo: task.repo, adapter: `pre-pr:${selection.writer.binding.providerId}`,
      status: 'failed', attempt: 1, prNumber: null, worktreePath: repo, logPath, exitPath, specPath, logOffset: Buffer.byteLength(log), taskJson: JSON.stringify(task) };
    const checkpoint = await continuation.inspectPrePrContinuation(row, runsDir);
    assert.ok(Object.values(checkpoint.task.prePrResume.reviewerReports).every(path => path.endsWith('.corrected.json')));
    const resumedTask = checkpoint.task;
    const prNumber = await runtime.runPrePrRuntime({ task: resumedTask, runsDir, settings, publication: { url: publication.url, token } }, event => events.push(event));
    assert.equal(prNumber, 42);
    assert.equal(publication.requests.length, 1);
    assert.deepEqual(publication.requests[0].approved.reviewers, reviewerIds);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.implement, 1);
    assert.equal(state.fixAttempts, 2);
    assert.equal(state.reviews['1'], reviewerIds.length);
    assert.equal(state.reviews['2'], reviewerIds.length);
    assert.equal(state.corrections, reviewerIds.length);
    if (input.expectedPromptMarker) assert.ok(state.prompts.length > 0 && state.prompts.every(prompt => prompt === input.expectedPromptMarker));
    if (input.expectedReviewOrder) assert.deepEqual(state.order, [...input.expectedReviewOrder, ...input.expectedReviewOrder]);
    assert.equal(await command(realGit, ['status', '--porcelain', '--untracked-files=all'], repo, env), '');
    assert.match(await readFile(join(repo, 'workflow.txt'), 'utf8'), /fixed/);
    assert.ok(events.some(event => event.kind === 'result' && event.outcome === 'failure'));
  } finally {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await publication.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('Fixture input path is required');
  await runAgentWorkflowFixture(JSON.parse(await readFile(inputPath, 'utf8')));
  process.stdout.write('WORKFLOW_ACCEPTED\n');
}
