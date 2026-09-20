// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { todosProvider } from '../../src/plugins/todos/provider';
import { jiraProvider } from '../../src/plugins/jira/provider';
import { jiraIssue } from '../../src/plugins/jira/fixtures';
import type { AgentTask } from './agents/adapter';
import { openDb, type RunRow } from './db';
import { openPersistence, type Persistence } from './persistence';
import { openExecutionStore } from './execution-store';
import { openAdmissionStore } from './admission-store';
import { openOperationStore } from './operations';
import { openTaskSourceStore, writeTaskSource } from './task-sources/store';
import { openSourceConnectionStore } from './task-source-connections';
import { createTaskSourceRegistry } from './task-sources/registry';
import { createTaskSourceRuntime } from './task-source-runtime';
import { sourceExecutionSettings, sourceExecutionSnapshot } from './task-source-execution';
import { createRunnerDurability } from './runner-durability';
import { retryIntent, type LaunchIntent } from './retry';

const opened: Persistence[] = [];
afterEach(() => { for (const persistence of opened.splice(0)) persistence.close(); });
const repo = 'owner/project';
const hash = 'a'.repeat(64);
const runtimeArtifact = { pluginId: 'helmsman.legacy-runtime', artifactHash: hash, packageVersion: '1.0.0', requires: [] };
function setup() {
  const persistence = openPersistence(':memory:'); opened.push(persistence);
  const db = openDb(persistence.sql); const executions = openExecutionStore(persistence); const admissions = openAdmissionStore(persistence, executions);
  const operations = openOperationStore(persistence, executions); const store = openTaskSourceStore(persistence); const connections = openSourceConnectionStore(persistence);
  const config = loadConfig({ JIRA_ENABLED: 'true', REPO_PROJECT_MAP: `${repo}=TASK`, JIRA_BASE_URL: 'https://jira.example.com', JIRA_EMAIL: 'bot@example.com', JIRA_API_TOKEN: 'private', JIRA_PROJECT: 'TASK' });
  const registry = createTaskSourceRegistry({ eligible: () => true });
  const localBinding = { pluginId: 'example.todos', providerId: 'example.todos/todos', artifactHash: hash, contractVersion: 1 as const, connectionId: null, credentialHandle: null };
  const jiraBinding = { ...localBinding, pluginId: 'example.jira', providerId: 'example.jira/issues' };
  registry.publish([
    registry.stage(localBinding, { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: ['create', 'update', 'delete'], access: ['local-records'] }, todosProvider),
    registry.stage(jiraBinding, { identityFormats: ['jira.issue-id/v1'], effectIds: ['assign', 'transition', 'retain-claim'], commandIds: [], access: ['connection-http'] }, jiraProvider),
  ]);
  const connection = connections.pin({ kind: 'jira', provisioningKey: 'jira', credentialHandle: 'jira-primary', origin: 'https://jira.example.com', email: 'bot@example.com', subject: 'bot', authorityId: 'tenant', verifiedAt: new Date().toISOString() });
  const local = store.provision({ provisioningKey: 'local', label: 'Todos', storageLayout: 'documents', binding: localBinding, settings: {}, allowedRepos: [repo],
    identityEvidence: { version: 1, level: 'verified', authority: { protocol: 'helmsman.local-collection/v1', authorityId: 'collection', identityFormat: 'helmsman.local-task/v1' }, verifiedAt: new Date().toISOString(), proof: null } });
  const jira = store.provision({ provisioningKey: 'jira', label: 'Jira', storageLayout: 'remote', binding: { ...jiraBinding, connectionId: connection.id, credentialHandle: connection.credentialHandle },
    settings: { baseUrl: connection.origin, project: 'TASK', assigneeAccountId: 'bot' }, allowedRepos: [repo], identityEvidence: { version: 1, level: 'verified', authority: { protocol: 'jira.cloud', authorityId: 'tenant', identityFormat: 'jira.issue-id/v1' }, verifiedAt: new Date().toISOString(), proof: null } });
  for (const value of [local, jira]) persistence.transaction(() => writeTaskSource(store, { ...value.source, conversionReady: true }));
  let issue = jiraIssue(); let failReview = false; let loseAssignResponse = false; let stopped = false;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/rest/api/3/myself') return new Response('{"accountId":"bot"}');
    if (path === '/_edge/tenant_info') return new Response('{"cloudId":"tenant"}');
    if (init?.method === 'PUT') {
      issue = { ...issue, fields: { ...issue.fields, assignee: { accountId: 'bot' } } };
      if (loseAssignResponse) throw new Error('Response lost');
      return new Response(null, { status: 204 });
    }
    if (init?.method === 'POST') {
      const review = String(init.body).includes('21');
      if (review && failReview) return new Response('{}', { status: 503 });
      issue = { ...issue, fields: { ...issue.fields, status: { id: review ? '3' : '2', name: review ? 'In Review' : 'In Progress', statusCategory: { key: 'indeterminate' } } } };
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/transitions')) return new Response(JSON.stringify({ transitions: [{ id: '11', to: { id: '2', name: 'In Progress' } }, { id: '21', to: { id: '3', name: 'In Review' } }] }));
    if (path.endsWith('/search/jql')) return new Response(JSON.stringify({ issues: [issue], isLast: true }));
    return new Response(JSON.stringify(issue));
  });
  const report = vi.fn();
  const options = { store, registry, connections, executions, admissions, operations, db, todoSourceId: local.source.id, jiraSourceId: jira.source.id,
    config: () => config, jiraCredentials: () => config.jira, artifacts: (instance: typeof local.instance) => [{ pluginId: instance.binding.pluginId, artifactHash: hash, packageVersion: '1.0.0', requires: [] }],
    verifyArtifacts: async () => {}, isStopped: () => stopped, fetcher, report };
  const runtime = createTaskSourceRuntime(options);
  function reserve(runId: string, intent: LaunchIntent, retryOf?: string) {
    const selection = runtime.selection(intent, retryOf)!;
    const canonical = runtime.canonical(intent, selection);
    runtime.reserve(runId, intent.repo, selection, () => { admissions.admit({ runId, repo: intent.repo, request: JSON.parse(JSON.stringify(canonical)), settings: sourceExecutionSettings(config), artifacts: [runtimeArtifact, ...options.artifacts(selection.instance)] }, 4); }, retryOf);
    return selection;
  }
  function durability() {
    return createRunnerDurability({ persistence, db, executions, admissions, operations, runsDir: '/tmp/source-runtime-tests', maxConcurrency: 4,
      snapshot(run, task) { const claim = store.claim(task.source!.claimId)!; const source = store.taskSnapshot(task.source!.taskSnapshotHash)!;
        return sourceExecutionSnapshot({ run, task, claim, source, artifact: runtimeArtifact, sourceArtifacts: options.artifacts(claim.instance), host: 'detached', config }); },
      verify: async () => {}, finalize: row => runtime.finalize(row) });
  }
  async function start(runId: string, task: AgentTask, adapter = 'command') {
    const row: RunRow = { id: runId, repo, ticketId: task.ticketId, adapter, status: 'running', attempt: 1, prNumber: null, startedAt: new Date().toISOString(), endedAt: null, costUsd: null, worktreePath: null, taskJson: JSON.stringify(task) };
    const durable = await durability().prepare(row, task); durable.ready('/tmp/source-runtime-tests/work'); return { durable, row: db.getRun(runId)! };
  }
  async function complete(value: Awaited<ReturnType<typeof start>>, status: 'succeeded' | 'failed' = 'succeeded', prNumber: number | null = 42) {
    value.durable.terminal({ status, exitCode: status === 'succeeded' ? 0 : 1, evidence: { exited: true } });
    const row = { ...db.getRun(value.row.id)!, status, prNumber, endedAt: new Date().toISOString() };
    await runtime.prepareFinalization(row); value.durable.finalize(row); value.durable.close(); return row;
  }
  return { ...options, options, persistence, config, localSource: local, jiraSource: jira, runtime, reserve, start, complete, durability,
    get issue() { return issue; }, get failReview() { return failReview; }, get loseAssignResponse() { return loseAssignResponse; }, set failReview(value: boolean) { failReview = value; }, set loseAssignResponse(value: boolean) { loseAssignResponse = value; }, set stopped(value: boolean) { stopped = value; } };
}
describe('application source runtime', () => {
  it('creates and launches a Todo while Jira is enabled, commits completion with the actual run, and preserves source history', async () => {
    const f = setup(); expect(f.runtime.jiraEnabled()).toBe(true);
    const todo = await f.runtime.todoApi!.create({ repo, title: 'Local', description: 'Do local work' }, 'create-local');
    const selection = f.reserve('local-run', { mode: 'todo', todoId: todo.id, repo });
    expect(f.runtime.claimForRun('local-run')?.state).toBe('reserved');
    await expect(f.runtime.todoApi!.update(todo.id, { title: 'Race' }, 'edit')).rejects.toThrow('Todo change was not applied');
    const prepared = await f.runtime.prepare('local-run', repo, selection, new AbortController().signal);
    expect(prepared.task.task).toContain('Do local work'); expect(prepared.task.source).toBeDefined(); expect(prepared.task.todoId).toBeUndefined();
    const run = await f.start('local-run', prepared.task);
    expect(f.admissions.get('local-run')?.state).toBe('started');
    await f.complete(run);
    expect(f.db.getRun('local-run')?.status).toBe('succeeded');
    expect(await f.runtime.todoApi!.get(todo.id)).toMatchObject({ state: 'in_review', runId: 'local-run' });
    expect(f.runtime.claimForRun('local-run')?.state).toBe('settled');
    expect(f.executions.pins().filter(pin => pin.kind === 'dependency')).toHaveLength(0);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('reserves capacity before Jira alias lookup and canonical work before authoritative load/claim', async () => {
    const f = setup(); const selection = f.reserve('jira-run', { mode: 'ticket', ticketId: 'TASK-1', repo });
    expect(f.admissions.get('jira-run')?.state).toBe('pending'); expect(f.executions.reservations()).toHaveLength(1);
    expect(f.runtime.claimForRun('jira-run')).toBeNull(); expect(f.fetcher).not.toHaveBeenCalled();
    const prepared = await f.runtime.prepare('jira-run', repo, selection, new AbortController().signal);
    expect(prepared.selection.ref).toEqual({ sourceId: f.jiraSource.source.id, externalId: '10001' });
    expect(f.runtime.claimForRun('jira-run')?.state).toBe('claimed');
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method !== 'GET').map(([, init]) => init?.method)).toEqual(['PUT', 'POST']);
    expect(f.runtime.canonical({ mode: 'ticket', ticketId: 'TASK-1', repo }, prepared.selection)).toMatchObject({ mode: 'source', workRef: prepared.selection.ref });
  });
  it('keeps actual worker success independent of unavailable Jira completion and drains through its disabled binding', async () => {
    const f = setup(); const selection = f.reserve('jira-run', { mode: 'ticket', ticketId: 'TASK-1', repo });
    const prepared = await f.runtime.prepare('jira-run', repo, selection, new AbortController().signal); const run = await f.start('jira-run', prepared.task);
    f.store.configureInstance({ instanceId: f.jiraSource.instance.id, expectedRevision: 1, desiredEnabled: false });
    f.failReview = true; await f.complete(run); await f.runtime.drain();
    expect(f.db.getRun('jira-run')?.status).toBe('succeeded'); expect(f.runtime.claimForRun('jira-run')?.state).toBe('settling');
    expect(f.executions.pins().some(pin => pin.kind === 'dependency')).toBe(true);
    expect(f.operations.list({ runId: 'jira-run' }).some(operation => operation.status === 'uncertain')).toBe(true);
    expect(f.runtime.jiraEnabled()).toBe(false);
  });
  it('releases local preflight claims after abort without inventing a worker outcome', async () => {
    const f = setup(); const todo = await f.runtime.todoApi!.create({ repo, title: 'Task', description: 'Do it' }, 'create');
    const selection = f.reserve('preflight', { mode: 'todo', todoId: todo.id, repo });
    await f.runtime.prepare('preflight', repo, selection, new AbortController().signal);
    await f.runtime.abort('preflight', 'preflight-failed');
    f.admissions.fail('preflight', 'No worker attempt exists');
    expect(f.executions.attempt({ runId: 'preflight', attempt: 1 })).toBeNull();
    expect(f.db.getRun('preflight')).toBeNull(); expect(await f.runtime.todoApi!.get(todo.id)).toMatchObject({ state: 'todo' });
    expect(f.runtime.claimForRun('preflight')?.state).toBe('settled'); expect(f.executions.reservations()).toHaveLength(0);
  });
  it('retains partially applied remote abort obligations while releasing proven-unstarted capacity on restart', async () => {
    const f = setup(); const selection = f.reserve('jira-run', { mode: 'ticket', ticketId: 'TASK-1', repo }); f.loseAssignResponse = true;
    await expect(f.runtime.prepare('jira-run', repo, selection, new AbortController().signal)).rejects.toThrow('not acknowledged');
    const restarted = createTaskSourceRuntime(f.options); await restarted.recoverAdmissions();
    expect(f.admissions.get('jira-run')?.state).toBe('failed'); expect(f.executions.reservations()).toHaveLength(0);
    expect(restarted.claimForRun('jira-run')?.settlement?.disposition).toBe('retained-for-operator');
    expect(f.executions.pins().some(pin => pin.kind === 'dependency')).toBe(true);
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method !== 'GET')).toHaveLength(1);
  });
  it('does not touch original C pending admissions during source restart recovery', async () => {
    const f = setup();
    f.admissions.admit({ runId: 'legacy', repo, request: { mode: 'todo', todoId: 'TODO-1', repo }, settings: sourceExecutionSettings(f.config), artifacts: [runtimeArtifact] }, 4);
    await f.runtime.recoverAdmissions(); expect(f.admissions.get('legacy')?.state).toBe('pending');
  });
  it('retains source ownership while a failed execution can resume, and settles after explicit checkpoint retirement', async () => {
    const f = setup(); const todo = await f.runtime.todoApi!.create({ repo, title: 'Task', description: 'Do it' }, 'create');
    const selection = f.reserve('resumable', { mode: 'todo', todoId: todo.id, repo });
    const prepared = await f.runtime.prepare('resumable', repo, selection, new AbortController().signal);
    const run = await f.start('resumable', prepared.task, 'pre-pr:codex'); await f.complete(run, 'failed', null);
    expect(f.executions.checkpoint('resumable:1:pre-pr')?.state).toBe('resumable');
    await f.runtime.drain(); expect(f.runtime.claimForRun('resumable')?.state).toBe('claimed');
    expect(f.executions.pins().some(pin => pin.kind === 'dependency')).toBe(true);
    expect(() => f.reserve('racing-retry', { mode: 'todo', todoId: todo.id, repo }, 'resumable')).toThrow();
    f.executions.retireCheckpoint('resumable:1:pre-pr', { actor: 'operator', reason: 'Choose a fresh retry' }); await f.runtime.drain();
    expect(f.runtime.claimForRun('resumable')?.state).toBe('settled'); expect(await f.runtime.todoApi!.get(todo.id)).toMatchObject({ state: 'blocked' });
    const retry = f.reserve('fresh-retry', { mode: 'todo', todoId: todo.id, repo }, 'resumable');
    await expect(f.runtime.prepare('fresh-retry', repo, retry, new AbortController().signal, 'resumable')).resolves.toHaveProperty('task.source');
  });
  it('preserves actual local worker outcome when its provider fails to prepare settlement', async () => {
    const f = setup(); const todo = await f.runtime.todoApi!.create({ repo, title: 'Task', description: 'Do it' }, 'create');
    const selection = f.reserve('local-run', { mode: 'todo', todoId: todo.id, repo }); const prepared = await f.runtime.prepare('local-run', repo, selection, new AbortController().signal);
    const run = await f.start('local-run', prepared.task); f.registry.removePlugin('example.todos');
    await f.complete(run);
    expect(f.db.getRun('local-run')?.status).toBe('succeeded'); expect(f.runtime.claimForRun('local-run')?.state).toBe('settling');
    expect(f.executions.pins().some(pin => pin.kind === 'dependency')).toBe(true); expect(f.report).toHaveBeenCalled();
  });
  it.each(['rename', 'disable and re-enable'])('retries a failed source voyage after %s without changing its canonical owner', async change => {
    const f = setup(); const todo = await f.runtime.todoApi!.create({ repo, title: 'Task', description: 'Do it' }, 'create');
    const intent = { mode: 'todo', todoId: todo.id, repo };
    const selected = f.reserve('original-run', intent);
    const prepared = await f.runtime.prepare('original-run', repo, selected, new AbortController().signal);
    const failed = await f.complete(await f.start('original-run', prepared.task), 'failed', null);
    const retry = retryIntent({ ...failed, launchJson: JSON.stringify(f.runtime.canonical(intent, selected)) });
    let current = f.runtime.service.configure({ instanceId: selected.instance.id, instanceRevision: selected.instance.revision,
      ...(change === 'rename' ? { label: 'Renamed tasks' } : { desiredEnabled: false }) });
    if (change !== 'rename') {
      expect(() => f.runtime.selection(retry, failed.id)).toThrow('disabled');
      current = f.runtime.service.configure({ instanceId: current.id, instanceRevision: current.revision, desiredEnabled: true });
    }
    expect(() => f.runtime.selection(retry)).toThrow('selection changed');
    const retrySelection = f.reserve('fresh-retry', retry, failed.id);
    expect(retrySelection.instance.revision).toBe(current.revision);
    const retried = await f.runtime.prepare('fresh-retry', repo, retrySelection, new AbortController().signal, failed.id);
    expect(retried.task.source?.instanceId).toBe(prepared.task.source?.instanceId);
    expect(f.runtime.claimForRun('fresh-retry')?.ref).toEqual(f.runtime.claimForRun('original-run')?.ref);
    expect(f.runtime.claimForRun('original-run')?.state).toBe('settled');
    expect(f.runtime.claimForRun('fresh-retry')?.retryOf).toBe('original-run');
  });
  it('rejects fresh retries with another owner or a changed provider binding', async () => {
    const f = setup(); const todo = await f.runtime.todoApi!.create({ repo, title: 'Task', description: 'Do it' }, 'create');
    const intent = { mode: 'todo', todoId: todo.id, repo };
    const selected = f.reserve('original-run', intent);
    const retry = f.runtime.canonical(intent, selected);
    expect(() => f.runtime.selection(retry, 'another-run')).toThrow('owner or provider changed');
    expect(() => f.runtime.selection({ ...retry, workRef: { ...retry.workRef!, externalId: 'TODO-2' } }, 'original-run')).toThrow('owner or provider changed');
    const instance = selected.instance;
    const lookup = vi.spyOn(f.store, 'instance').mockReturnValue({ ...instance, revision: instance.revision + 1,
      binding: { ...instance.binding, artifactHash: 'b'.repeat(64) } });
    try { expect(() => f.runtime.selection(retry, 'original-run')).toThrow('owner or provider changed'); }
    finally { lookup.mockRestore(); }
  });
  it('commits staged remote completion from durable receipts without invoking the planner again', async () => {
    const f = setup(); const selection = f.reserve('jira-run', { mode: 'ticket', ticketId: 'TASK-1', repo });
    const prepared = await f.runtime.prepare('jira-run', repo, selection, new AbortController().signal); const run = await f.start('jira-run', prepared.task);
    await f.complete(run);
    const planner = vi.spyOn(jiraProvider, 'planCompletion').mockRejectedValue(new Error('Staged settlement must not be replanned'));
    try { await f.runtime.drain(); expect(planner).not.toHaveBeenCalled(); expect(f.runtime.claimForRun('jira-run')?.state).toBe('settled'); }
    finally { planner.mockRestore(); }
  });
  it('drains explicitly resolved no-worker aborts after their capacity admission has failed', async () => {
    const f = setup(); const selection = f.reserve('jira-run', { mode: 'ticket', ticketId: 'TASK-1', repo }); f.loseAssignResponse = true;
    await expect(f.runtime.prepare('jira-run', repo, selection, new AbortController().signal)).rejects.toThrow('not acknowledged');
    await f.runtime.recoverAdmissions();
    const claim = f.runtime.claimForRun('jira-run')!;
    const abortOperation = f.operations.list().find(operation => operation.origin.kind === 'source-abort')!;
    f.operations.resolve(abortOperation.id, { actor: 'operator', reason: 'Remote claim manually settled', evidence: { settled: true }, outcome: 'acknowledged' });
    const claimOperation = f.operations.list().find(operation => operation.origin.kind === 'source-claim' && operation.status === 'uncertain')!;
    expect(f.runtime.effects.acknowledged({ claimId: claim.id, purpose: 'abort', requestHash: abortOperation.origin.revision }).ready).toBe(false);
    f.operations.resolve(claimOperation.id, { actor: 'operator', reason: 'Assignment did not apply', evidence: { inspected: true }, outcome: 'definitely-not-applied' });
    await f.runtime.retrySettlement(claim.id);
    expect(f.runtime.claimForRun('jira-run')?.state).toBe('settled'); expect(f.admissions.get('jira-run')?.state).toBe('failed');
    expect(f.operations.list().every(operation => operation.status === 'completed')).toBe(true);
    expect(f.executions.pins().filter(pin => pin.kind === 'dependency')).toHaveLength(0);
  });
  it('preserves terminal worker status when a source CAS or provider fails after finalization planning', async () => {
    const f = setup(); const todo = await f.runtime.todoApi!.create({ repo, title: 'Task', description: 'Do it' }, 'create');
    const selected = f.reserve('local-run', { mode: 'todo', todoId: todo.id, repo });
    const prepared = await f.runtime.prepare('local-run', repo, selected, new AbortController().signal); const run = await f.start('local-run', prepared.task);
    run.durable.terminal({ status: 'succeeded', exitCode: 0, evidence: { exited: true } });
    const final = { ...f.db.getRun('local-run')!, status: 'succeeded' as const, prNumber: 42, endedAt: new Date().toISOString() };
    await f.runtime.prepareFinalization(final);
    f.registry.removePlugin('example.todos');
    run.durable.finalize(final); run.durable.close();
    expect(f.db.getRun('local-run')?.status).toBe('succeeded'); expect(f.runtime.claimForRun('local-run')?.state).toBe('settling');
    expect(f.executions.pins().some(pin => pin.kind === 'dependency')).toBe(true); expect(f.report).toHaveBeenCalled();
  });

});
