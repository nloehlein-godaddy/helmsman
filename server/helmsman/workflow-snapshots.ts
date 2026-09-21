import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { storeConnection } from './store-connection';
import { isContributionId } from '../../src/plugins/manifest';
import { parseWorkflowRetainedProviderV1, type WorkflowRetainedProviderV1 } from './workflow-providers';

export type FixedWorkflowId = 'coding' | 'review';

export interface SkillDeclaration {
  name: string;
  contentHash: string;
}

export interface WorkflowDefinition {
  id: string;
  version: number;
  promptRevision: string;
  prompt: string;
  provider?: WorkflowRetainedProviderV1;
}

export interface WorkflowSnapshotInput {
  workflowId: string;
  definition?: WorkflowDefinition;
  version?: number;
  model?: string;
  effort?: string;
  promptCodeHash: string;
  reviewSettings?: Record<string, unknown>;
  skills: readonly SkillDeclaration[];
}

export interface WorkflowSnapshot extends WorkflowSnapshotInput {
  id: string;
  definition: WorkflowDefinition;
  createdAt: string;
  contentHash: string;
}

export interface WorkflowStore {
  seedFixedWorkflows(): void;
  createSnapshot(input: WorkflowSnapshotInput): WorkflowSnapshot;
  resolveSnapshot(id: string): WorkflowSnapshot | null;
  getDefinition(id: FixedWorkflowId, version?: number): WorkflowDefinition | null;
  close(): void;
}

const FIXED: readonly WorkflowDefinition[] = [
  { id: 'coding', version: 1, promptRevision: 'helmsman-coding-v1', prompt: 'Helmsman fixed coding workflow.' },
  { id: 'review', version: 1, promptRevision: 'helmsman-review-v1', prompt: 'Helmsman fixed review workflow.' },
];

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

function validSkill(skill: SkillDeclaration): boolean {
  return typeof skill?.name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(skill.name)
    && typeof skill.contentHash === 'string' && /^[a-f\d]{64}$/i.test(skill.contentHash);
}

function validate(input: WorkflowSnapshotInput): void {
  if (!input || (!['coding', 'review'].includes(input.workflowId) && !isContributionId(input.workflowId)) || (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 1))
    || (input.model !== undefined && (!input.model || input.model.length > 128))
    || (input.effort !== undefined && (!input.effort || input.effort.length > 64)) || !/^[a-f\d]{64}$/i.test(input.promptCodeHash)
    || !Array.isArray(input.skills) || input.skills.some(skill => !validSkill(skill))
    || new Set(input.skills.map(skill => skill.name)).size !== input.skills.length) throw new Error('Invalid immutable workflow snapshot');
}

function validateDefinition(definition: WorkflowDefinition, input: WorkflowSnapshotInput): void {
  if (!definition || definition.id !== input.workflowId || !Number.isSafeInteger(definition.version) || definition.version < 1
    || input.version !== undefined && definition.version !== input.version || typeof definition.promptRevision !== 'string'
    || !definition.promptRevision || definition.promptRevision.length > 256 || typeof definition.prompt !== 'string' || definition.prompt.length > 256 * 1024) throw new Error('Invalid workflow definition');
  if (isContributionId(definition.id)) {
    const record = parseWorkflowRetainedProviderV1(definition.provider);
    if (record.binding.providerId !== definition.id || record.binding.artifactHash !== definition.promptRevision || definition.version !== 1) throw new Error('Invalid retained workflow definition');
  } else if (definition.provider !== undefined) throw new Error('Legacy workflow cannot acquire a provider binding');
}

function validSnapshot(snapshot: WorkflowSnapshot, id: string): boolean {
  try {
    validate(snapshot); validateDefinition(snapshot.definition, snapshot);
    const { definition, workflowId, version, model, effort, promptCodeHash, reviewSettings, skills } = snapshot;
    return snapshot.id === id && snapshot.contentHash === id
      && hash({ definition, workflowId, version, model, effort, promptCodeHash, reviewSettings, skills }) === id;
  } catch { return false; }
}

function row(value: unknown): WorkflowSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { json?: string };
  try { return record.json ? JSON.parse(record.json) as WorkflowSnapshot : null; } catch { return null; }
}

export function openWorkflowStore(path: string | Database.Database, now: () => string = () => new Date().toISOString()): WorkflowStore {
  const connection = storeConnection(path);
  const { sql } = connection;
  connection.migrate({ owner: 'compat.workflows', ddl: `CREATE TABLE IF NOT EXISTS workflow_definitions (id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, contentHash TEXT NOT NULL, PRIMARY KEY (id, version));
    CREATE TABLE IF NOT EXISTS workflow_snapshots (id TEXT PRIMARY KEY, json TEXT NOT NULL, contentHash TEXT NOT NULL, createdAt TEXT NOT NULL);` });

  const getDefinition = (id: FixedWorkflowId, version?: number): WorkflowDefinition | null => {
    const result = version === undefined
      ? sql.prepare('SELECT json, contentHash FROM workflow_definitions WHERE id = ? ORDER BY version DESC LIMIT 1').get(id)
      : sql.prepare('SELECT json, contentHash FROM workflow_definitions WHERE id = ? AND version = ?').get(id, version);
    const parsed = row(result) as unknown as WorkflowDefinition | null;
    return parsed?.id === id && Number.isSafeInteger(parsed.version) && hash(parsed) === (result as { contentHash?: unknown } | undefined)?.contentHash ? parsed : null;
  };
  const seedFixedWorkflows = () => {
    for (const definition of FIXED) {
      const contentHash = hash(definition);
      const existing = sql.prepare('SELECT contentHash FROM workflow_definitions WHERE id = ? AND version = ?').get(definition.id, definition.version) as { contentHash: string } | undefined;
      if (existing && existing.contentHash !== contentHash) throw new Error(`Workflow definition ${definition.id}@${definition.version} changed`);
      if (!existing) sql.prepare('INSERT INTO workflow_definitions (id, version, json, contentHash) VALUES (?, ?, ?, ?)')
        .run(definition.id, definition.version, JSON.stringify(definition), contentHash);
    }
  };
  seedFixedWorkflows();
  return {
    seedFixedWorkflows,
    getDefinition,
    createSnapshot(input) {
      validate(input);
      const definition = input.definition ?? getDefinition(input.workflowId as FixedWorkflowId, input.version);
      if (input.definition) validateDefinition(input.definition, input);
      if (!definition) throw new Error('Requested fixed workflow version is unavailable');
      const stableInput = { workflowId: input.workflowId, version: definition.version, model: input.model, effort: input.effort, promptCodeHash: input.promptCodeHash,
        reviewSettings: input.reviewSettings ?? {}, skills: [...input.skills].sort((a, b) => a.name.localeCompare(b.name)) };
      const contentHash = hash({ definition, ...stableInput });
      const snapshot: WorkflowSnapshot = { id: contentHash, ...stableInput, definition, createdAt: now(), contentHash };
      const existing = row(sql.prepare('SELECT json FROM workflow_snapshots WHERE id = ?').get(snapshot.id));
      if (existing) { if (!validSnapshot(existing, snapshot.id)) throw new Error('Stored workflow snapshot was modified'); return existing; }
      sql.prepare('INSERT INTO workflow_snapshots (id, json, contentHash, createdAt) VALUES (?, ?, ?, ?)')
        .run(snapshot.id, JSON.stringify(snapshot), snapshot.contentHash, snapshot.createdAt);
      return snapshot;
    },
    resolveSnapshot(id) {
      if (typeof id !== 'string' || !/^[a-f\d]{64}$/i.test(id)) return null;
      const snapshot = row(sql.prepare('SELECT json FROM workflow_snapshots WHERE id = ?').get(id));
      return snapshot && validSnapshot(snapshot, id) ? snapshot : null;
    },
    close() { connection.close(); },
  };
}
