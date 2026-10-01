import { isAbsolute, normalize } from 'node:path';
import { persistedJson, PersistenceValidationError, stableJson } from './persistence';

export interface ExecutionResource {
  kind: 'task' | 'branch' | 'pull-request' | 'workspace' | 'galleon-exclusive' | 'checkout-exclusive';
  namespace: string;
  identity: string;
}

export interface ExecutionFootprint {
  version: 1;
  runId: string;
  repo: string;
  completeness: 'verified' | 'exclusive';
  checkout: { path: string; commonDirectory: string } | null;
  resources: readonly ExecutionResource[];
}

const kinds = ['task', 'branch', 'pull-request', 'workspace', 'galleon-exclusive', 'checkout-exclusive'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
const path = (value: unknown): value is string => text(value) && isAbsolute(value) && normalize(value) === value;
export const executionResourceKey = (resource: ExecutionResource): string => stableJson([resource.kind, resource.namespace, resource.identity]);

export function parseExecutionFootprint(input: unknown): ExecutionFootprint {
  const value = persistedJson(input);
  if (!record(value) || value.version !== 1 || typeof value.runId !== 'string' || !/^[a-z\d][a-z\d_.:/@-]{0,255}$/i.test(value.runId)
    || typeof value.repo !== 'string' || !/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(value.repo)
    || !['verified', 'exclusive'].includes(String(value.completeness)) || !Array.isArray(value.resources)
    || !value.resources.length || value.resources.length > 32
    || value.checkout !== null && (!record(value.checkout) || !path(value.checkout.path) || !path(value.checkout.commonDirectory))) {
    throw new PersistenceValidationError('Invalid execution footprint');
  }
  const keys = new Set<string>();
  const resources = value.resources.map(item => {
    if (!record(item) || !kinds.includes(String(item.kind)) || !text(item.namespace) || !text(item.identity)
      || item.kind === 'workspace' && !path(item.identity)
      || item.kind === 'galleon-exclusive' && (item.namespace !== 'galleon' || item.identity !== String(value.repo).toLowerCase())
      || item.kind === 'checkout-exclusive' && (item.namespace !== 'git' || !path(item.identity))) {
      throw new PersistenceValidationError('Invalid execution resource');
    }
    const resource = { kind: item.kind as ExecutionResource['kind'], namespace: item.namespace, identity: item.identity };
    const key = executionResourceKey(resource);
    if (keys.has(key)) throw new PersistenceValidationError('Duplicate execution resource');
    keys.add(key);
    return resource;
  }).sort((a, b) => executionResourceKey(a).localeCompare(executionResourceKey(b)));
  if (value.completeness === 'exclusive' && !resources.some(resource => resource.kind === 'galleon-exclusive')
    || value.completeness === 'verified' && (value.checkout === null || !resources.some(resource => resource.kind === 'workspace')
      || resources.some(resource => resource.kind.endsWith('-exclusive')))) throw new PersistenceValidationError('Execution footprint lacks ownership evidence');
  return { version: 1, runId: value.runId, repo: value.repo.toLowerCase(), completeness: value.completeness as ExecutionFootprint['completeness'],
    checkout: value.checkout === null ? null : { path: String(value.checkout.path), commonDirectory: String(value.checkout.commonDirectory) }, resources };
}

export function exclusiveExecutionFootprint(runId: string, repo: string, checkout: ExecutionFootprint['checkout'] = null): ExecutionFootprint {
  return parseExecutionFootprint({ version: 1, runId, repo, completeness: 'exclusive', checkout,
    resources: [{ kind: 'galleon-exclusive', namespace: 'galleon', identity: repo.toLowerCase() },
      ...(checkout ? [{ kind: 'checkout-exclusive', namespace: 'git', identity: checkout.commonDirectory }] : [])] });
}

export function executionFootprintsConflict(left: ExecutionFootprint, right: ExecutionFootprint): boolean {
  if (left.runId === right.runId) return false;
  if (left.repo.toLowerCase() === right.repo.toLowerCase() && (left.completeness === 'exclusive' || right.completeness === 'exclusive')) return true;
  if (left.checkout && right.checkout && left.checkout.commonDirectory === right.checkout.commonDirectory
    && (left.completeness === 'exclusive' || right.completeness === 'exclusive')) return true;
  const keys = new Set(left.resources.map(executionResourceKey));
  return right.resources.some(resource => keys.has(executionResourceKey(resource)));
}
