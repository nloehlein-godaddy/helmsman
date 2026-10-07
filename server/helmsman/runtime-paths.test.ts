// @vitest-environment node
import { expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { applicationRoot, isHostCoordinatorCommand, runtimeModulePath, runtimeNodeArguments, retainedRuntimePath, joinInputArguments } from './runtime-paths';
import { feedbackUpdateAdapter } from './agents/feedback-update';
import { prePrAdapter } from './agents/pre-pr';
import { dockerReviewAdapter } from './agents/docker-review';
import { codexAdapter } from './agents/codex';
import type { AgentTask } from './agents/adapter';

it('resolves application assets independently of the working directory', () => {
  expect(applicationRoot()).toBe(fileURLToPath(new URL('../../', import.meta.url)));
});

it('selects compiled helpers beside their calling module without loading tsx', () => {
  const moduleUrl = pathToFileURL(join(applicationRoot(), 'release', 'server', 'helmsman', 'agents', 'pre-pr.js')).href;
  const entry = join(applicationRoot(), 'release', 'server', 'helmsman', 'pre-pr-cli.js');
  expect(runtimeModulePath('../pre-pr-cli.ts', moduleUrl)).toBe(entry);
  expect(runtimeNodeArguments('../pre-pr-cli.ts', moduleUrl)).toEqual([entry]);
  expect(runtimeModulePath('../run-wrapper.mjs', moduleUrl)).toBe(join(applicationRoot(), 'release', 'server', 'helmsman', 'run-wrapper.mjs'));
});

it('retains TypeScript helper execution for development', () => {
  const args = runtimeNodeArguments('./pre-pr-cli.ts', import.meta.url);
  expect(args[0]).toBe('--import');
  expect(args[1]).toContain('tsx');
  expect(args[2]).toBe(fileURLToPath(new URL('./pre-pr-cli.ts', import.meta.url)));
});

it.each(['pre-pr-cli', 'docker-review-cli', 'feedback-update-cli'].flatMap(name => ['ts', 'js'].flatMap(extension => [
  `/app/server/helmsman/${name}.${extension}`, `C:\\app\\server\\helmsman\\${name}.${extension}`,
  `${name}.${extension}`,
])))('routes host coordinator %s locally for source and compiled installations', path => {
  expect(isHostCoordinatorCommand({ cmd: 'node', args: [path, '{}'] })).toBe(true);
  expect(isHostCoordinatorCommand({ cmd: path, args: [] })).toBe(true);
});

it.each(['/app/worker.js', 'C:\\app\\worker.ts', '/app/pre-pr-cli.js.map', '/app/not-pre-pr-cli.js',
  '/app/docker-review-cli.ts/child.js', '/app/run-wrapper.mjs'])('leaves ordinary worker %s on its selected host', path => {
  expect(isHostCoordinatorCommand({ cmd: 'node', args: [path] })).toBe(false);
});

it('remaps both coordinator paths and file-URL loader dependencies into the retained runtime', () => {
  const original = applicationRoot();
  const retained = join(original, 'retained-runtime');
  const loader = import.meta.resolve('tsx');
  expect(retainedRuntimePath(loader, original, retained)).toBe(pathToFileURL(join(retained, 'node_modules/tsx/dist/loader.mjs')).href);
  expect(retainedRuntimePath(join(original, 'server/helmsman/pre-pr-cli.ts'), original, retained)).toBe(join(retained, 'server/helmsman/pre-pr-cli.ts'));
  expect(retainedRuntimePath(process.execPath, original, retained)).toBe(process.execPath);
  expect(retainedRuntimePath('unrelated-argument', original, retained)).toBe('unrelated-argument');
});

it('keeps every chunked launcher argument within the host exec limit and round-trips through the CLI join for a large task', () => {
  const title = 'x'.repeat(4000);
  const base = { ticketId: 'T-1', title, repo: 'org/repo', jiraBaseUrl: '' };
  const agentSelection = { version: 1, writer: codexAdapter, reviewers: [codexAdapter] } as unknown as AgentTask['agentSelection'];
  const feedbackTask: AgentTask = { ...base, prBranch: 'feature', prNumber: 42, agentSelection,
    pullRequestSource: {} as AgentTask['pullRequestSource'],
    workflow: { metadata: { feedbackCompletion: true } } as unknown as AgentTask['workflow'] };
  const prePrTask: AgentTask = { ...base };
  const dockerTask: AgentTask = { ...base, review: true,
    dockerExecution: { runId: 'run-1', image: 'test:1', gatewayUrl: 'http://host.docker.internal:8790', capability: 'a'.repeat(64) } };
  const commands = [
    feedbackUpdateAdapter(codexAdapter, '/runs').buildCommand(feedbackTask),
    prePrAdapter(codexAdapter, '/runs').buildCommand(prePrTask),
    dockerReviewAdapter(codexAdapter).buildCommand(dockerTask),
  ];
  for (const command of commands) {
    const chunks = command.args.slice(3);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.startsWith('--input=') && chunk.length <= 256)).toBe(true);
    expect(JSON.parse(joinInputArguments(chunks)).task.title).toBe(title);
  }
});

it('does not remap traversal escapes or similarly named runtime directories', () => {
  const root = applicationRoot();
  const retained = join(root, 'retained-runtime');
  for (const path of [`${root}server/helmsman/../../../outside.js`, join(root, 'server/helmsman-other/helper.js'), join(root, 'node_modules-other/loader.js')]) {
    expect(retainedRuntimePath(path, root, retained)).toBe(path);
    const url = pathToFileURL(path).href;
    expect(retainedRuntimePath(url, root, retained)).toBe(url);
  }
});
