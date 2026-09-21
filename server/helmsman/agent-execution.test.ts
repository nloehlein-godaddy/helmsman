// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { parseAgentSelectionV1 } from './agent-providers';
import { mergeExecutionArtifacts, verifyAgentExecution } from './agent-execution';
import { legacyExecutionSnapshot, restoreExecutionConfig } from './legacy-execution-snapshot';
import { createExecutionSnapshot, openExecutionStore } from './execution-store';
import { openPersistence } from './persistence';
import type { AgentTask } from './agents/adapter';
import type { RunRow } from './db';
import { prepareExecution } from './prepare-run';
import { selectReviewModel } from './review-policy';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tuning = { model: 'author/model-v1', effort: 'ultra' };
const metadata = { version: 1, label: 'Independent', defaults: tuning, review: { low: tuning, medium: tuning, high: tuning },
  reviewSkills: [], reviewDelegation: 'native-subagents', supportsPrePr: true, docker: null, costReporting: 'delta' };
function fixture() {
  const record = (name: string) => ({ version: 1, binding: { providerId: `example.${name}/agent`, pluginId: `example.${name}`, artifactHash: name === 'writer' ? 'a'.repeat(64) : 'b'.repeat(64), contractVersion: 1 }, origin: 'external', settings: { profile: 'original' }, metadata });
  const selection = parseAgentSelectionV1({ version: 1, writer: record('writer'), reviewers: [record('writer'), record('reviewer')] });
  const artifact = { pluginId: 'helmsman.runtime', artifactHash: 'c'.repeat(64), packageVersion: '1.0.0', requires: [] };
  const artifacts = [artifact, ...[selection.writer, selection.reviewers[1]!].map(record => ({ pluginId: record.binding.pluginId, artifactHash: record.binding.artifactHash, packageVersion: '1.0.0', requires: [] }))];
  const task: AgentTask = { repo: 'org/repo', ticketId: 'T-1', title: 'Retained agents', task: 'Implement task', jiraBaseUrl: '', agentSelection: selection,
    agentRuntime: { pluginsRoot: '/plugins', runtimeArtifactsRoot: '/runtime', artifacts } };
  const run = { id: 'run-1', attempt: 1, repo: task.repo, adapter: `pre-pr:${selection.writer.binding.providerId}` } as RunRow;
  const config = loadConfig({ AGENT_CMD: 'legacy-value' });
  return { task, run, config, artifact, artifacts };
}

describe('execution agent bindings', () => {
  it('persists distinct writer/reviewer bindings and restores without current command/default settings', () => {
    const f = fixture(); const persistence = openPersistence(':memory:'); openExecutionStore(persistence);
    try {
      const snapshot = createExecutionSnapshot(persistence, legacyExecutionSnapshot({ ...f, host: 'detached' }));
      expect(snapshot.bindings.filter(binding => binding.role === 'agent').map(binding => binding.contributionId)).toEqual(['example.writer/agent', 'example.reviewer/agent']);
      expect(verifyAgentExecution(f.task, snapshot)).toEqual(f.task.agentSelection);
      expect(() => restoreExecutionConfig(snapshot, loadConfig({ AGENT_CMD: 'different-current-command' }))).not.toThrow();
      expect(() => verifyAgentExecution({ ...f.task, agentSelection: { ...f.task.agentSelection!, reviewers: [] } }, snapshot)).toThrow('immutable execution snapshot');
      expect(() => verifyAgentExecution(f.task, { ...snapshot, bindings: snapshot.bindings.filter(binding => binding.contributionId !== 'example.reviewer/agent') })).toThrow('bindings differ');
      expect(() => mergeExecutionArtifacts(f.artifacts, [{ ...f.artifacts[1]!, artifactHash: 'd'.repeat(64) }])).toThrow('Conflicting execution artifact');
    } finally { persistence.close(); }
  });

  it('prepares provider metadata without inheriting Codex skills or model defaults', async () => {
    const f = fixture(); const root = await mkdtemp(join(tmpdir(), 'helmsman-agent-prepare-'));
    try {
      const prepared = await prepareExecution({ runId: f.run.id, runsDir: root, workflowDbPath: join(root, 'workflow.sqlite'), task: f.task,
        workflow: 'coding', reviewSettings: f.config.prePr, skillsRoots: [] });
      expect(prepared.task).toMatchObject(tuning);
      expect(prepared.skills).toEqual([]);
      expect(selectReviewModel(null, f.task.agentSelection!.writer.metadata)).toMatchObject(tuning);
      expect(selectReviewModel(null, f.task.agentSelection!.writer.metadata, { model: 'vendor/override:v2', effort: 'extreme' })).toMatchObject({ model: 'vendor/override:v2', effort: 'extreme' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
