import { isContributionId, isPluginId } from '../../src/plugins/manifest';
import { sourceFields, sourceJson, sourceObject, sourceText } from '../../src/plugins/source-contract-validation';
import type { ArtifactBinding, ArtifactPin, ProviderBinding } from './execution-store';
import { persistenceHash } from './persistence';
import { parseTriggerRetainedProviderV1, type TriggerRetainedProviderV1 } from './trigger-providers';

export type TriggerPinStore = 'campaign' | 'review' | 'webhook';
export interface TriggerProvenanceV1 {
  readonly version: 1; readonly instanceId: string; readonly selectionRevision: string;
  readonly provider: TriggerRetainedProviderV1; readonly artifacts: readonly ArtifactBinding[];
  readonly source: { readonly sourceKey: string; readonly revision: string; readonly bindings: readonly ProviderBinding[] };
  readonly inputHash: string; readonly proposalHash: string; readonly capturedAt: string;
}
function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value)) throw new TypeError('Invalid trigger provenance hash'); return value; }
export function parseTriggerProvenanceV1(input: unknown): TriggerProvenanceV1 {
  const value = sourceObject(sourceJson(input, 4 * 1024 * 1024)); sourceFields(value, ['version', 'instanceId', 'selectionRevision', 'provider', 'artifacts', 'source', 'inputHash', 'proposalHash', 'capturedAt']);
  if (value.version !== 1 || !Array.isArray(value.artifacts) || !value.artifacts.length || value.artifacts.length > 256) throw new TypeError('Invalid trigger provenance');
  sourceText(value.instanceId, 512); sourceText(value.selectionRevision, 128); hash(value.inputHash); hash(value.proposalHash);
  if (!Number.isFinite(Date.parse(sourceText(value.capturedAt, 64)))) throw new TypeError('Invalid trigger capture time');
  const provider = parseTriggerRetainedProviderV1(value.provider); const artifacts = new Map<string, ArtifactBinding>();
  for (const input of value.artifacts) {
    const artifact = sourceObject(input); sourceFields(artifact, ['pluginId', 'artifactHash', 'packageVersion', 'requires']); hash(artifact.artifactHash); sourceText(artifact.packageVersion, 128);
    if (!isPluginId(artifact.pluginId) || artifacts.has(artifact.pluginId) || !Array.isArray(artifact.requires) || artifact.requires.length > 256 || artifact.requires.some(id => !isPluginId(id)) || new Set(artifact.requires).size !== artifact.requires.length) throw new TypeError('Invalid trigger artifact closure');
    artifacts.set(artifact.pluginId, artifact as unknown as ArtifactBinding);
  }
  if (artifacts.get(provider.binding.pluginId)?.artifactHash !== provider.binding.artifactHash) throw new Error('Trigger provider is absent from its artifact closure');
  const visited = new Set<string>(); const visiting = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error('Trigger artifact dependency cycle'); if (visited.has(id)) return;
    const artifact = artifacts.get(id); if (!artifact) throw new Error('Trigger artifact dependency is missing');
    visiting.add(id); artifact.requires.forEach(visit); visiting.delete(id); visited.add(id);
  }
  for (const id of artifacts.keys()) visit(id);
  const source = sourceObject(value.source); sourceFields(source, ['sourceKey', 'revision', 'bindings']); sourceText(source.sourceKey, 4096); sourceText(source.revision, 512);
  if (!Array.isArray(source.bindings) || source.bindings.length > 256) throw new TypeError('Invalid trigger source bindings');
  const seen = new Set<string>();
  for (const input of source.bindings) {
    const binding = sourceObject(input); sourceFields(binding, ['role', 'capability', 'contributionId', 'pluginId', 'artifactHash', 'contractVersion', 'connectionId', 'credentialHandle']);
    if (!['source', 'agent', 'host', 'workflow', 'effect'].includes(String(binding.role)) || !isPluginId(binding.pluginId) || !isContributionId(binding.contributionId)
      || String(binding.contributionId).split('/')[0] !== binding.pluginId || artifacts.get(binding.pluginId)?.artifactHash !== binding.artifactHash
      || !Number.isSafeInteger(binding.contractVersion) || Number(binding.contractVersion) < 1) throw new TypeError('Invalid trigger source binding');
    sourceText(binding.capability, 256); if (binding.connectionId !== null) sourceText(binding.connectionId, 4096); if (binding.credentialHandle !== null) { sourceText(binding.credentialHandle, 4096); if (binding.connectionId === null) throw new TypeError('Trigger credentials require a source connection'); }
    const key = JSON.stringify([binding.role, binding.capability, binding.contributionId]); if (seen.has(key)) throw new TypeError('Duplicate trigger source binding'); seen.add(key);
  }
  return Object.freeze({ ...value, provider }) as unknown as TriggerProvenanceV1;
}
export function captureTriggerProvenanceV1(input: {
  instanceId: string; selectionRevision: string; provider: TriggerRetainedProviderV1; artifacts: readonly ArtifactBinding[];
  source: TriggerProvenanceV1['source']; input: unknown; proposal: unknown; capturedAt: string;
}): TriggerProvenanceV1 {
  return parseTriggerProvenanceV1({ version: 1, instanceId: input.instanceId, selectionRevision: input.selectionRevision, provider: input.provider, artifacts: input.artifacts,
    source: input.source, inputHash: persistenceHash(sourceJson(input.input, 2 * 1024 * 1024)), proposalHash: persistenceHash(sourceJson(input.proposal, 1024 * 1024)), capturedAt: input.capturedAt });
}
export function triggerPinOwner(store: TriggerPinStore, rowId: string): string {
  if (!['campaign', 'review', 'webhook'].includes(store) || typeof rowId !== 'string' || !/^[a-z\d_-]{1,256}$/i.test(rowId)) throw new TypeError('Invalid trigger pin owner'); return `trigger:${store}:${rowId}`;
}
export function triggerDependencyPins(provenance: TriggerProvenanceV1, store: TriggerPinStore, rowId: string): readonly ArtifactPin[] {
  const record = parseTriggerProvenanceV1(provenance); const ownerId = triggerPinOwner(store, rowId);
  return Object.freeze(record.artifacts.map(artifact => Object.freeze({ kind: 'dependency' as const, ownerId, pluginId: artifact.pluginId, artifactHash: artifact.artifactHash })));
}
