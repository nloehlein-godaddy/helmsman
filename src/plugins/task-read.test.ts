import { describe, expect, it, vi } from 'vitest';
import { parseTaskReadGalleons, parseTaskReadItem, parseTaskReadListQueryV1, parseTaskReadLoadQueryV1, parseTaskReadLookupQueryV1, parseTaskReadLookupRef, parseTaskReadPage, parseTaskReadSources, TASK_READ_LIMITS } from './task-read';
import type { TaskReadListQueryV1 } from './task-read';
import type { TaskSnapshotV1 } from './tasks';

const sourceId = '11111111-1111-4111-8111-111111111111';
const query: TaskReadListQueryV1 = { version: 1, sourceId, instanceId: 'source-instance', instanceRevision: 3, repo: 'owner/project', state: 'ready', cursor: null, limit: 10 };
const task: TaskSnapshotV1 = { version: 1, ref: { sourceId, externalId: '10001' }, repo: query.repo, revision: 'r1', displayKey: 'TASK-2', title: 'Task', state: 'ready', priority: 1, url: 'https://jira.example/browse/TASK-2', requirements: { description: 'Implement', acceptanceCriteria: ['It works'], links: [] }, providerData: { version: 1, contactHints: { reporterId: 'private-account' } } };
const source = () => ({ id: query.instanceId, sourceId, revision: 3, label: 'Tasks', desiredEnabled: true, available: true, allowedRepos: [query.repo], settings: { private: 'not public' }, credentialHandle: 'private-handle' });

describe('public browser task read contract', () => {
  it('projects source metadata without configuration, credentials, or other galleon permissions', () => {
    expect(parseTaskReadSources({ instances: [source()] }, query.repo)).toEqual([{ version: 1, sourceId, instanceId: query.instanceId, instanceRevision: 3, repo: query.repo, label: 'Tasks', availability: 'available' }]);
    expect(parseTaskReadSources({ instances: [{ ...source(), available: false, desiredEnabled: false }] }, query.repo)[0]?.availability).toBe('disabled');
    expect(parseTaskReadSources({ instances: [{ ...source(), available: false }] }, query.repo)[0]?.availability).toBe('unavailable');
  });
  it('preserves canonical work identity and safe provider links while removing provider data', () => {
    const page = parseTaskReadPage({ items: [task], nextCursor: 'next' }, query);
    expect(page.items[0]).toMatchObject({ ref: task.ref, displayKey: task.displayKey, url: task.url });
    expect(page.items[0]).not.toHaveProperty('providerData');
    expect(page.selection).toEqual({ version: 1, sourceId, instanceId: query.instanceId, instanceRevision: 3, repo: query.repo });
    expect(Object.isFrozen(page.items[0]?.requirements.acceptanceCriteria)).toBe(true);
  });
  it.each([
    { repo: 'owner/other' }, { ref: { sourceId: '22222222-2222-4222-8222-222222222222', externalId: '10001' } },
    { state: 'done' }, { url: 'javascript:alert(1)' }, { requirements: null },
  ])('rejects mismatched or malformed tasks before presentation: %j', change => {
    expect(() => parseTaskReadPage({ items: [{ ...task, ...change }], nextCursor: null }, query)).toThrow();
  });
  it('rejects duplicate identities, excess pages, and repeated pagination cursors', () => {
    expect(() => parseTaskReadPage({ items: [task, task], nextCursor: null }, query)).toThrow();
    expect(() => parseTaskReadPage({ items: [task], nextCursor: null }, { ...query, limit: 0 })).toThrow();
    expect(() => parseTaskReadPage({ items: [], nextCursor: 'same' }, { ...query, cursor: 'same' })).toThrow();
  });
  it('loads only the requested immutable identity and preserves renamed display keys', () => {
    const input = { ...query, ref: task.ref };
    expect(parseTaskReadItem({ task: { ...task, displayKey: 'TASK-99' } }, input).task?.displayKey).toBe('TASK-99');
    expect(() => parseTaskReadItem({ task: { ...task, ref: { ...task.ref, externalId: '10002' } } }, input)).toThrow();
    expect(() => parseTaskReadLoadQueryV1({ ...input, sourceId: '22222222-2222-4222-8222-222222222222' })).toThrow();
  });
  it.each([{ instanceRevision: 0 }, { instanceId: '../private' }, { repo: null }, { version: 2 }, { limit: 101 }, { cursor: 'x'.repeat(2049) }, { state: 'todo' }])('rejects invalid query %j', change => {
    expect(() => parseTaskReadListQueryV1({ ...query, ...change })).toThrow();
  });
  it('bounds permitted galleons and rejects duplicates and sparse responses', () => {
    expect(() => parseTaskReadGalleons({ repos: ['owner/project', 'Owner/Project'] })).toThrow();
    expect(() => parseTaskReadGalleons({ repos: new Array(1) })).toThrow();
    expect(() => parseTaskReadGalleons({ repos: Array.from({ length: TASK_READ_LIMITS.galleons + 1 }, (_, index) => `owner/project-${index}`) })).toThrow();
    expect(() => parseTaskReadSources({ instances: [source(), source()] }, query.repo)).toThrow();
    expect(() => parseTaskReadSources({ instances: [{ ...source(), allowedRepos: ['owner/other'] }] }, query.repo)).toThrow();
  });
  it('rejects accessor-shaped data without invoking accessors', () => {
    const get = vi.fn(() => query.sourceId);
    const input = { ...query }; Object.defineProperty(input, 'sourceId', { get });
    expect(() => parseTaskReadListQueryV1(input)).toThrow(); expect(get).not.toHaveBeenCalled();
  });
});

it('never invokes supplied array methods while validating public data', () => {
  const ownMap = vi.fn(() => ['spoof/repo']); const own = ['owner/project'];
  Object.defineProperty(own, 'map', { value: ownMap });
  expect(() => parseTaskReadGalleons({ repos: own })).toThrow(); expect(ownMap).not.toHaveBeenCalled();
  const inheritedMap = vi.fn(() => ['spoof/repo']); const inherited = ['owner/project'];
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { map: inheritedMap }));
  expect(parseTaskReadGalleons({ repos: inherited })).toEqual(['owner/project']); expect(inheritedMap).not.toHaveBeenCalled();
});


describe('public display-key lookup', () => {
  it('validates bounded literal display keys and projects canonical same-source references', () => {
    const lookup = { ...query, displayKey: 'TASK-2' };
    expect(parseTaskReadLookupQueryV1(lookup).displayKey).toBe('TASK-2');
    expect(parseTaskReadLookupRef({ ref: task.ref }, lookup)).toEqual(task.ref);
    expect(parseTaskReadLookupRef({ ref: null }, lookup)).toBeNull();
    expect(() => parseTaskReadLookupRef({ ref: { ...task.ref, sourceId: '22222222-2222-4222-8222-222222222222' } }, lookup)).toThrow();
    expect(() => parseTaskReadLookupRef({}, lookup)).toThrow();
    for (const displayKey of ['', '  ', 'x'.repeat(513), 'TASK-2\nother', null]) expect(() => parseTaskReadLookupQueryV1({ ...lookup, displayKey })).toThrow();
  });
});
