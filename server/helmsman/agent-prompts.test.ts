// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinWorkflows } from './plugins/builtin-workflows';
import { agentPromptPluginId, readAgentPromptSettings, writeAgentPromptSettings } from './plugins/data';
import { PersistenceConflictError } from './persistence';
import { handleAgentPromptSettingsApi } from './agent-prompts-routes';
import { ClarificationServiceError } from './clarification-service-common';
import { activateBackendPlugins, type BackendRuntime } from './plugins/backend';
import { codingWorkflowProvider } from '../../src/plugins/workflow-coding/provider';
import type { WorkflowPromptInputV1 } from '../../src/plugins/workflow';

const roots: string[] = [];
const runtimes: BackendRuntime[] = [];
const packages = builtinWorkflows.map(value => value.package);
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'helmsman-agent-prompts-')); roots.push(root); return root; }
function save(root: string, roleId: string, text: string | null, revision = readAgentPromptSettings(root, packages).revision) {
  return writeAgentPromptSettings(root, packages, { version: 1, expectedRevision: revision, roleId, text });
}

it('persists isolated role overrides and restores declared defaults with a revision checked reset', async () => {
  const root = await temporary();
  const original = readAgentPromptSettings(root, packages);
  expect(original.roles.map(value => value.id)).toEqual(['coding.implement', 'coding.fix', 'coding.review', 'branch.author', 'branch.audit', 'review.pull-request']);
  expect(original.roles.every(role => !role.overridden && role.text === role.defaultText && role.text.trim())).toBe(true);
  const changed = save(root, 'coding.implement', '- Prefer domain-specific observable checks.');
  expect(changed.revision).not.toBe(original.revision);
  expect(changed.roles.find(role => role.id === 'coding.implement')).toMatchObject({ text: '- Prefer domain-specific observable checks.', overridden: true });
  expect(changed.roles.filter(role => role.id !== 'coding.implement')).toEqual(original.roles.filter(role => role.id !== 'coding.implement'));
  expect(readAgentPromptSettings(root, packages)).toEqual(changed);
  expect(() => save(root, 'coding.fix', '- Use focused fixes.', original.revision)).toThrow(PersistenceConflictError);
  expect(save(root, 'coding.implement', null)).toEqual(original);
  expect(agentPromptPluginId('branch.audit')).toBe('helmsman.workflow-coding');
});

it('rejects undeclared roles, blank/control data, UTF-8 overflow and unavailable packages without writes', async () => {
  const root = await temporary(); const original = readAgentPromptSettings(root, packages);
  for (const [roleId, text] of [['unknown.role', 'Valid text'], ['coding.implement', ' '], ['coding.implement', 'hello\u0000'], ['coding.implement', 'é'.repeat(2049)]]) {
    expect(() => save(root, roleId!, text!)).toThrow();
  }
  expect(readAgentPromptSettings(root, packages)).toEqual(original);
  const empty = readAgentPromptSettings(root, []);
  expect(() => writeAgentPromptSettings(root, [], { version: 1, expectedRevision: empty.revision, roleId: 'coding.implement', text: 'Guidance' })).toThrow();
});

it('refreshes new workflow captures while preserving previously captured settings and prompts', async () => {
  const root = await temporary();
  const runtime = await activateBackendPlugins({ root, snapshot: { catalog: { version: 1, safeMode: false, plugins: [], bindings: {} }, artifacts: new Map(), errors: [] },
    builtins: builtinWorkflows.map(value => ({ ...value, artifactHash: 'a'.repeat(64) })), usage: { query: async () => { throw new Error('Not used'); } } });
  runtimes.push(runtime);
  expect(runtime.errors).toEqual([]);
  const previous = runtime.workflows.list().find(value => value.record.binding.providerId.endsWith('/coding'))!;
  const input: WorkflowPromptInputV1 = { version: 1, runtime: { providerId: 'helmsman.agent-codex/codex', model: null, effort: null, reviewDelegation: 'native-subagents' },
    byline: 'Captured attribution', clarificationInstructions: 'Captured clarification protocol', task: { ticketId: 'TEST-1', title: 'Implement task', repo: 'org/repo', jiraBaseUrl: '' },
    stage: { stage: 'implement', baseSha: 'a'.repeat(40), reportPath: '/reports/metadata.json' } };
  const oldPrompt = previous.provider.renderPrompt(input);
  save(root, 'coding.implement', '- Prefer focused observable checks.');
  expect(runtime.workflows.list()).toHaveLength(1);
  await runtime.refreshWorkflowSettings('helmsman.workflow-coding');
  const current = runtime.workflows.list().find(value => value.record.binding.providerId.endsWith('/coding'))!;
  expect(current.record.settings.promptImplement).toBe('- Prefer focused observable checks.');
  expect(previous.record.settings.promptImplement).not.toBe(current.record.settings.promptImplement);
  expect(() => runtime.workflows.assertCurrent(previous.record)).toThrow();
  const currentPrompt = current.provider.renderPrompt(input);
  expect(currentPrompt).toContain('- Prefer focused observable checks.');
  expect(currentPrompt).toContain('NEVER push, open a PR, request reviewers');
  expect(currentPrompt).toContain('/reports/metadata.json');
  expect(currentPrompt).toContain('Captured attribution');
  expect(codingWorkflowProvider({ ...previous.record.settings, maxRounds: 3, stageTimeoutMinutes: 45 }).renderPrompt(input)).toBe(oldPrompt);
});

it('requires an authorized caller, rejects query/method misuse, awaits save and maps revision conflicts', async () => {
  const root = await temporary();
  const service = { snapshot: (caller: string) => { if (caller !== 'helmsman.agent-prompts/config') throw new ClarificationServiceError(403, 'forbidden'); return readAgentPromptSettings(root, packages); },
    save: async (_caller: string, input: unknown) => writeAgentPromptSettings(root, packages, input) };
  const base = { method: 'GET', path: '/api/agent-prompts', query: new URLSearchParams(), service };
  expect((await handleAgentPromptSettingsApi(base))?.status).toBe(403);
  expect((await handleAgentPromptSettingsApi({ ...base, caller: 'unknown/page' }))?.status).toBe(403);
  expect((await handleAgentPromptSettingsApi({ ...base, caller: 'helmsman.agent-prompts/config', query: new URLSearchParams('repo=org/repo') }))?.status).toBe(400);
  expect((await handleAgentPromptSettingsApi({ ...base, caller: 'helmsman.agent-prompts/config', method: 'DELETE' }))?.status).toBe(400);
  const current = readAgentPromptSettings(root, packages);
  const post = { ...base, caller: 'helmsman.agent-prompts/config', method: 'POST', body: { version: 1, expectedRevision: current.revision, roleId: 'review.pull-request', text: '- Inspect real callers.' } };
  expect((await handleAgentPromptSettingsApi(post))?.status).toBe(200);
  expect((await handleAgentPromptSettingsApi(post))?.status).toBe(409);
  expect((await handleAgentPromptSettingsApi({ ...post, body: {} }))?.status).toBe(400);
});
