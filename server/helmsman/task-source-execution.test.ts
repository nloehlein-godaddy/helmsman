import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import type { SourceInstanceV1, TaskSnapshotV1 } from '../../src/plugins/tasks';
import type { RunRow } from './db';
import { validateExecutionSnapshot } from './execution-store';
import { persistenceHash } from './persistence';
import { restoreExecutionConfig } from './legacy-execution-snapshot';
import type { StoredTaskSnapshot, WorkClaimRecord } from './task-sources/store';
import { sourceExecutionSettings, sourceExecutionSnapshot, sourceExecutionTask } from './task-source-execution';

const instance: SourceInstanceV1 = { version: 1, id: 'instance', sourceId: '11111111-1111-4111-8111-111111111111', label: 'Source', revision: 1,
  desiredEnabled: true, identityLevel: 'verified', authority: { protocol: 'local', authorityId: 'collection', identityFormat: 'helmsman.local-task/v1' },
  binding: { providerId: 'example.source/tasks', pluginId: 'example.source', artifactHash: 'b'.repeat(64), contractVersion: 1, connectionId: null, credentialHandle: null },
  settings: {}, allowedRepos: ['owner/project'] };
const task: TaskSnapshotV1 = { version: 1, ref: { sourceId: instance.sourceId, externalId: '100' }, revision: '1', displayKey: 'RENAMED-7', title: 'Do work', repo: 'owner/project', url: null, state: 'ready', priority: 2,
  requirements: { description: 'Preserve requirements', acceptanceCriteria: ['Keep behavior'], links: [{ title: 'Reference', url: 'https://example.com/item' }] }, providerData: { version: 1, contactHints: { assigneeId: 'account', reporterId: null } } };
const snapshot: StoredTaskSnapshot = { hash: persistenceHash({ task, instance }), task, instance };
const claim: WorkClaimRecord = { id: 'claim', ref: task.ref, admissionId: 'run', runId: 'run', instance, sourceRevision: 1, revision: 2, state: 'claimed', taskSnapshotHash: snapshot.hash,
  receipt: { version: 1, claimId: 'claim', ref: task.ref, admissionId: 'run', runId: 'run', revision: 2, binding: instance.binding, taskSnapshotHash: snapshot.hash, localRecordRevision: '2', operations: [] }, settlement: null };
const row: RunRow = { id: 'run', ticketId: task.displayKey, repo: task.repo, adapter: 'pre-pr:codex', status: 'running', attempt: 1, prNumber: null, startedAt: '2026-09-20T00:00:00Z', endedAt: null, costUsd: null, worktreePath: null };
const runtime = { pluginId: 'helmsman.legacy-runtime', artifactHash: 'a'.repeat(64), packageVersion: '1.0.0', requires: [] };
const sourceArtifact = { pluginId: instance.binding.pluginId, artifactHash: instance.binding.artifactHash, packageVersion: '1.0.0', requires: [] };

describe('source execution compatibility', () => {
  it('renders neutral requirements and contacts without enabling legacy Jira lifecycle heuristics', () => {
    const result = sourceExecutionTask(snapshot, claim);
    expect(result).toMatchObject({ ticketId: 'RENAMED-7', jiraBaseUrl: '', contactHints: { assigneeId: 'account' }, source: { claimId: 'claim', taskSnapshotHash: snapshot.hash } });
    expect(result.task).toContain('Preserve requirements');
    expect(result.task).toContain('Keep behavior');
    expect(result.task).toContain('https://example.com/item');
    expect(result.todoId).toBeUndefined();
    expect(() => sourceExecutionTask(snapshot, { ...claim, state: 'reserved' })).toThrow('not ready');
  });

  it('pins canonical identity and source artifact while preserving other controlled effects', () => {
    const result = sourceExecutionSnapshot({ run: row, task: sourceExecutionTask(snapshot, claim), artifact: runtime, host: 'detached', source: snapshot, claim, sourceArtifacts: [sourceArtifact],
      config: loadConfig({ JIRA_BASE_URL: 'https://jira.example', JIRA_EMAIL: 'operator@example.com', JIRA_API_TOKEN: 'private', GITHUB_TOKEN: 'private-github', GITHUB_PR_AUTHOR: 'operator' }) });
    expect(validateExecutionSnapshot(result).logicalWork).toEqual({ source: instance.sourceId, instance: instance.id, taskId: '100' });
    expect(result.bindings.filter(binding => binding.role === 'source')).toEqual([expect.objectContaining({ pluginId: 'example.source', artifactHash: sourceArtifact.artifactHash })]);
    expect(result.bindings.some(binding => binding.capability === 'jira')).toBe(false);
    expect(result.bindings.some(binding => binding.capability === 'github')).toBe(true);
    expect(result.artifacts).toEqual([runtime, sourceArtifact]);
    expect(JSON.stringify(result)).not.toContain('private');
    const restored = restoreExecutionConfig({ ...result, id: 'snapshot', contentHash: persistenceHash(result), createdAt: row.startedAt },
      loadConfig({ GITHUB_TOKEN: 'rotated-github', GITHUB_PR_AUTHOR: 'operator' }));
    expect(restored.jira).toBeNull();
    expect(restored.botAccountId).toBeNull();
    expect(result.settings.execution).toEqual(sourceExecutionSettings(restored));
  });

  it('rejects missing artifact closure and metadata drift', () => {
    const input = { run: row, task: sourceExecutionTask(snapshot, claim), artifact: runtime, host: 'detached' as const, source: snapshot, claim, sourceArtifacts: [sourceArtifact], config: loadConfig({}) };
    expect(() => sourceExecutionSnapshot({ ...input, sourceArtifacts: [] })).toThrow('closure');
    expect(() => sourceExecutionSnapshot({ ...input, claim: { ...claim, runId: 'different' } })).toThrow('binding');
    expect(() => sourceExecutionSnapshot({ ...input, sourceArtifacts: [sourceArtifact, { ...sourceArtifact, artifactHash: 'c'.repeat(64) }] })).toThrow('Conflicting');
  });
});
