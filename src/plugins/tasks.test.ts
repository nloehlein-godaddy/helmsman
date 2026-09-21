import { describe, expect, it } from 'vitest';
import { parseLocalTaskDocumentV1, parseSourceBindingV1, parseSourceMutationPlanV1, parseTaskPageV1, parseTaskSnapshotV1, validateTaskSourceProvider, type TaskSnapshotV1 } from './tasks';
const ref = { sourceId: '00000000-0000-4000-8000-000000000001', externalId: 'TODO-1' };
const task: TaskSnapshotV1 = { version: 1, ref, revision: '1', displayKey: 'TODO-1', title: 'Work', repo: 'owner/project', url: null, state: 'ready', priority: 2, requirements: { description: 'Do it', acceptanceCriteria: [], links: [] }, providerData: { version: 1 } };
describe('public task source protocol', () => {
  it('requires an implemented read view when declared while allowing legacy providers', () => {
    const provider = Object.fromEntries(['identify', 'list', 'lookup', 'load', 'planClaim', 'planCompletion', 'planAbort', 'validateAdoption'].map(name => [name, () => {}]));
    const declaration = { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: [], access: [] };
    expect(() => validateTaskSourceProvider({ ...provider, effects: {} }, declaration)).not.toThrow();
    expect(() => validateTaskSourceProvider({ ...provider, effects: {} }, { ...declaration, readViews: ['underway'] })).toThrow();
    expect(() => validateTaskSourceProvider({ ...provider, effects: {}, listUnderway() {} }, { ...declaration, readViews: ['underway'] })).not.toThrow();
    expect(() => validateTaskSourceProvider({ ...provider, effects: {} }, { ...declaration, readViews: ['history'] })).toThrow();
    expect(() => validateTaskSourceProvider({ ...provider, effects: {}, readHistory() {} }, { ...declaration, readViews: ['history'] })).not.toThrow();
  });
  it('copies and freezes accepted values while rejecting malformed or secret data', () => {
    const parsed = parseTaskSnapshotV1(task); expect(Object.isFrozen(parsed.requirements)).toBe(true); expect(parsed).toEqual(task);
    for (const input of [null, { ...task, ref: null }, { ...task, priority: NaN }, { ...task, providerData: { version: 1, token: 'secret' } }, { ...task, repo: '../escape' }, { ...task, url: 'javascript:alert(1)' }, { ...task, requirements: { ...task.requirements, acceptanceCriteria: new Array(1) } }]) expect(() => parseTaskSnapshotV1(input)).toThrow();
    let reads = 0; const malicious = { ...task }; Object.defineProperty(malicious, 'title', { get() { reads++; return 'oops'; } });
    expect(() => parseTaskSnapshotV1(malicious)).toThrow(); expect(reads).toBe(0);
  });
  it('preserves maximum legacy Unicode requirements and enforces page and source bounds', () => {
    const wide = { ...task, requirements: { description: '語'.repeat(20000), acceptanceCriteria: ['語'.repeat(20000)], links: [] } };
    expect(parseTaskSnapshotV1(wide).requirements.description).toHaveLength(20000);
    expect(() => parseTaskSnapshotV1(task, { sourceId: 'another' })).toThrow();
    expect(() => parseTaskPageV1({ items: [task, task], nextCursor: null })).toThrow();
    expect(() => parseTaskPageV1({ items: [], nextCursor: 'x'.repeat(2049) })).toThrow();
  });
  it('rejects source binding disagreement and malformed local documents', () => {
    const binding = { providerId: 'example.tasks/local', pluginId: 'example.tasks', artifactHash: 'a'.repeat(64), contractVersion: 1, connectionId: null, credentialHandle: null };
    expect(parseSourceBindingV1(binding)).toEqual(binding); expect(() => parseSourceBindingV1({ ...binding, providerId: 'other.tasks/local' })).toThrow();
    expect(() => parseLocalTaskDocumentV1({ version: 1, title: 'a' })).toThrow();
  });
  it('validates a bounded dependency graph and rejects forged targets', () => {
    const effect = (localId: string, after: string[]) => ({ localId, handler: 'write', target: null, payload: null, after });
    const expected = { ref, repo: task.repo, effectIds: ['write'] };
    expect(parseSourceMutationPlanV1({ kind: 'remote-effects', effects: [effect('a', []), effect('b', ['a'])] }, expected).kind).toBe('remote-effects');
    for (const effects of [[effect('a', ['b']), effect('b', ['a'])], [effect('a', ['missing'])], [effect('a', []), effect('a', [])], [{ ...effect('a', []), handler: 'undeclared' }]]) expect(() => parseSourceMutationPlanV1({ kind: 'remote-effects', effects }, expected)).toThrow();
    expect(() => parseSourceMutationPlanV1({ kind: 'local-record', ref: { ...ref, externalId: 'TODO-2' }, expectedRevision: '1', next: { schema: 'x', repo: task.repo, data: null } }, expected)).toThrow();
  });
});

it('rejects nested credential-like source settings without rejecting opaque binding handles', async () => {
  const { parseSourceInstanceV1 } = await import('./tasks');
  const instance = { version: 1, id: 'instance', sourceId: ref.sourceId, label: 'Source', revision: 1, desiredEnabled: true, identityLevel: 'operator-seeded', authority: null,
    binding: { providerId: 'example.tasks/local', pluginId: 'example.tasks', artifactHash: 'a'.repeat(64), contractVersion: 1, connectionId: 'connection', credentialHandle: 'opaque-handle' }, settings: {}, allowedRepos: ['owner/project'] };
  expect(parseSourceInstanceV1(instance).binding.credentialHandle).toBe('opaque-handle');
  for (const key of ['apiToken', 'JIRA_API_TOKEN', 'privateKey', 'credentials', 'client_secret', 'githubAuthorization', 'credentialHandle']) expect(() => parseSourceInstanceV1({ ...instance, settings: { nested: [{ [key]: 'forbidden' }] } })).toThrow();
  expect(parseSourceInstanceV1({ ...instance, settings: { botAccountId: 'bot', tokenBudget: 100 } }).settings.tokenBudget).toBe(100);
});
