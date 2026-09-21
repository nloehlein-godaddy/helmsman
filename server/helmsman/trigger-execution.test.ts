import { describe, expect, it } from 'vitest';
import { triggerExecutionSnapshot, verifyTriggerExecution } from './trigger-execution';
import { captureTriggerProvenanceV1 } from './trigger-provenance';
import type { ExecutionSnapshotInput } from './execution-store';

const artifact = { pluginId: 'example.trigger', artifactHash: 'a'.repeat(64), packageVersion: '1.0.0', requires: [] };
const trigger = captureTriggerProvenanceV1({ instanceId: 'campaign', selectionRevision: 'original',
  provider: { version: 1, origin: 'external', binding: { providerId: 'example.trigger/select', pluginId: artifact.pluginId,
    artifactHash: artifact.artifactHash, contractVersion: 1 }, settings: { priority: 'original' },
    metadata: { version: 1, kind: 'campaign', label: 'Independent priority', intervalMs: 1000 } }, artifacts: [artifact],
  source: { sourceKey: 'campaign:original', revision: 'original', bindings: [] }, input: { task: 'original' }, proposal: { task: 'original' }, capturedAt: '2026-09-21T00:00:00Z' });
const base: ExecutionSnapshotInput = { version: 1, runId: 'original-run', attempt: 1, repo: 'org/a', logicalWork: { source: 'freeform', instance: 'local', taskId: 'original' },
  task: {}, workflowSnapshotId: null, artifacts: [], bindings: [], settings: {}, schemas: [], provenance: { kind: 'admission', evidence: {} } };

describe('trigger execution provenance', () => {
  it('retains captured settings and artifact closure without inventing an execution role', () => {
    const snapshot = triggerExecutionSnapshot(base, { trigger });
    expect(snapshot.settings.trigger).toEqual(trigger); expect(snapshot.artifacts).toEqual([artifact]); expect(snapshot.bindings).toEqual([]);
    expect(() => verifyTriggerExecution({ trigger }, snapshot)).not.toThrow();
  });
  it('rejects missing, rebound or incomplete provenance during recovery', () => {
    const snapshot = triggerExecutionSnapshot(base, { trigger });
    expect(() => verifyTriggerExecution({}, snapshot)).toThrow('Saved trigger');
    expect(() => verifyTriggerExecution({ trigger: { ...trigger, selectionRevision: 'replacement' } }, snapshot)).toThrow('Saved trigger');
    expect(() => verifyTriggerExecution({ trigger }, { ...snapshot, artifacts: [] })).toThrow('artifact closure');
    expect(() => triggerExecutionSnapshot({ ...base, artifacts: [{ ...artifact, artifactHash: 'b'.repeat(64) }] }, { trigger })).toThrow('Conflicting');
  });
  it('leaves original legacy execution snapshots unchanged', () => {
    expect(triggerExecutionSnapshot(base, {})).toBe(base); expect(() => verifyTriggerExecution({}, base)).not.toThrow();
  });
});
