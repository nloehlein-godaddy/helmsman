import { describe, expect, it, vi } from 'vitest';
import { isPluginAssetPath, parsePluginPackage } from './package';

function descriptor() {
  return { packageVersion: 1,
    manifest: { manifestVersion: 1, id: 'acme.example', version: '1.0.0', sdkVersion: 1,
      pages: [{ id: 'example', title: 'Example', slots: [], panes: [] }] },
    node: { minMajor: 22, maxMajorExclusive: 30 }, entries: { example: 'dist/page.js' } };
}

describe('plugin packages', () => {
  const backend = () => ({ entry: 'backend.js', storageVersion: 1,
    provides: [{ id: 'helmsman/pricing', version: 1, localId: 'rates' }],
    settings: { rateAmount: { type: 'number', default: 1, minimum: 0, maximum: 5 } } });

  const taskSource = () => ({ entry: 'source.js', storageVersion: 1, settings: {},
    provides: [{ id: 'helmsman/task-source', version: 1, localId: 'tasks' }],
    taskSources: { tasks: { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: ['create'], access: ['local-records'] } } });

  it('accepts task source declarations while preserving existing pricing packages', () => {
    const source = taskSource();
    const parsed = parsePluginPackage({ ...descriptor(), backend: source });
    source.taskSources.tasks.commandIds.push('delete');
    expect(parsed.backend?.taskSources?.tasks?.commandIds).toEqual(['create']);
    expect(Object.isFrozen(parsed.backend?.taskSources?.tasks?.access)).toBe(true);
    expect(Object.isFrozen(parsed.backend?.taskSources)).toBe(true);
    expect(parsePluginPackage({ ...descriptor(), backend: backend() }).backend?.taskSources).toBeUndefined();
  });

  it.each([
    {}, { tasks: {} }, { wrong: { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: [], access: [] } },
    { tasks: { identityFormats: [], effectIds: [], commandIds: [], access: [] } },
    { tasks: { identityFormats: ['bad'], effectIds: [], commandIds: [], access: [] } },
    { tasks: { identityFormats: ['jira.issue-id/v1'], effectIds: ['assign'], commandIds: [], access: [] } },
    { tasks: { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: ['create'], access: [] } },
    { tasks: { identityFormats: ['jira.issue-id/v1'], effectIds: [], commandIds: [], access: ['network'] } },
    { tasks: { identityFormats: ['jira.issue-id/v1'], effectIds: ['assign', 'assign'], commandIds: [], access: ['connection-http'] } },
    { tasks: { identityFormats: ['jira.issue-id/v1'], effectIds: [], commandIds: [], access: ['connection-http'], extra: true } },
  ])('rejects invalid task source declarations %j', taskSources => {
    expect(() => parsePluginPackage({ ...descriptor(), backend: { ...taskSource(), taskSources } })).toThrow();
  });

  it('requires source access declarations exactly when the capability is declared', () => {
    const { taskSources, ...missing } = taskSource();
    expect(() => parsePluginPackage({ ...descriptor(), backend: missing })).toThrow();
    expect(() => parsePluginPackage({ ...descriptor(), backend: { ...backend(), taskSources } })).toThrow();
  });

  it('accepts deeply frozen backend-only packages and explicitly trusted builtins', () => {
    const input = descriptor();
    const result = parsePluginPackage({ ...input, manifest: { ...input.manifest, pages: [] }, entries: {}, backend: backend() });
    expect(result.manifest.pages).toEqual([]);
    expect(Object.isFrozen(result.backend?.settings.rateAmount)).toBe(true);
    expect(Object.isFrozen(result.backend?.provides[0])).toBe(true);
    expect(() => parsePluginPackage({ ...input, manifest: { ...input.manifest, id: 'helmsman.pricing' } }, { allowBuiltin: true })).not.toThrow();
  });

  it.each([{ entry: '../host.js' }, { entry: 'backend.ts' }, { storageVersion: 2 },
    { provides: [{ id: 'helmsman/pricing', version: 2, localId: 'rates' }] },
    { provides: [{ id: 'helmsman/private', version: 1, localId: 'rates' }] },
    { settings: { rate: { type: 'number', default: 8, minimum: 0, maximum: 5 } } },
    { settings: { rate: { type: 'number', default: 1, minimum: 5, maximum: 0 } } },
    { settings: { title: { type: 'string', default: 'long', maxLength: 2 } } },
    { settings: { enabled: { type: 'boolean', default: 1 } } },
    { settings: { rate: { type: 'number', default: 1, minimum: 0, maximum: 5, secret: true } } },
    { settings: { '../escape': { type: 'boolean', default: true } } }, { extra: true },
  ])('rejects invalid backend metadata %j', override => {
    expect(() => parsePluginPackage({ ...descriptor(), backend: { ...backend(), ...override } })).toThrow();
  });
  it('copies and deeply freezes the descriptor', () => {
    const input = descriptor();
    const result = parsePluginPackage(input);
    input.entries.example = 'other.js';
    input.manifest.pages[0]!.title = 'Changed';
    expect(result.entries.example).toBe('dist/page.js');
    expect(result.manifest.pages[0]?.title).toBe('Example');
    for (const item of [result, result.node, result.entries, result.manifest, result.manifest.pages,
      result.manifest.pages[0], result.manifest.pages[0]?.slots]) expect(Object.isFrozen(item)).toBe(true);
  });

  it.each([null, [], undefined, 1, 'package', new Date()])('rejects invalid record %j', input => {
    expect(() => parsePluginPackage(input)).toThrow();
  });

  it.each([{ packageVersion: 2 }, { extra: 1 }, { node: {} }, { entries: {} },
    { entries: { example: 'page.ts' } }, { entries: { example: 'page.js', extra: 'other.js' } },
    { node: { minMajor: 22, maxMajorExclusive: 22 } }, { node: { minMajor: 0, maxMajorExclusive: 22 } },
    { node: { minMajor: 22.1, maxMajorExclusive: 30 } }, { node: { minMajor: 22, maxMajorExclusive: 1001 } },
    { node: { minMajor: 22, maxMajorExclusive: Infinity } }, { node: { minMajor: '22', maxMajorExclusive: 30 } },
    { node: { minMajor: 22, maxMajorExclusive: 30, other: true } }])('rejects invalid fields %j', override => {
    expect(() => parsePluginPackage({ ...descriptor(), ...override })).toThrow();
  });

  it('reserves the builtin namespace', () => {
    const input = descriptor();
    input.manifest.id = 'helmsman.example';
    expect(() => parsePluginPackage(input)).toThrow(/reserved/);
  });

  it('rejects getters at every depth without running them', () => {
    const getter = vi.fn(() => 'page.js');
    const input = descriptor();
    Object.defineProperty(input.entries, 'example', { get: getter });
    expect(() => parsePluginPackage(input)).toThrow();
    const arrayInput = descriptor();
    Object.defineProperty(arrayInput.manifest.pages, '0', { get: getter });
    expect(() => parsePluginPackage(arrayInput)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects sparse arrays, symbols, cycles, and missing fields', () => {
    expect(() => parsePluginPackage({ ...descriptor(), [Symbol('x')]: 1 })).toThrow();
    const input = descriptor();
    input.manifest.pages = new Array(1);
    expect(() => parsePluginPackage(input)).toThrow();
    const cycle: Record<string, unknown> = descriptor();
    cycle.node = cycle;
    expect(() => parsePluginPackage(cycle)).toThrow();
    const missing: Record<string, unknown> = descriptor();
    delete missing.node;
    expect(() => parsePluginPackage(missing)).toThrow();
  });

  it.each(['page.js', 'dist/page.mjs', 'assets/icon-2.svg', 'a_b/C0.css'])('accepts safe path %s', path => {
    expect(isPluginAssetPath(path)).toBe(true);
  });

  it.each(['', '.', '..', '/page.js', '../page.js', 'a/../page.js', 'a/./page.js', 'a//page.js',
    'a\\page.js', 'page.js?x=1', 'page.js#x', '%70age.js', 'c:/page.js', 'page\n.js', 'page.js\n', 'café.js',
    'a/'.repeat(260), 'a'.repeat(129), '.hidden', null, 1])('rejects unsafe path %j', path => {
    expect(isPluginAssetPath(path)).toBe(false);
  });
});
