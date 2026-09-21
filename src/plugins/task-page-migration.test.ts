import { describe, expect, it, vi } from 'vitest';
import type { CompositionLayoutV1 } from './composition';
import { initializeTaskPageLayout } from './task-page-migration';

function initial(contributionId = 'helmsman.triage/panel'): CompositionLayoutV1 {
  return { version: 1, compositionId: 'helmsman/triage-page', revision: 0,
    instances: [{ instanceId: 'triage', contributionId, hidden: false, scope: { kind: 'inherit' }, state: {} }],
    columns: [[{ instances: ['triage'], activeInstanceId: 'triage', collapsed: false }]] };
}
function migrate(raw: Record<string, string> = {}) {
  const getItem = vi.fn((key: string) => raw[key] ?? null);
  const result = initializeTaskPageLayout(initial(), { getItem });
  return { ...result, getItem, saved: result.layout.instances[0]?.state['helmsman.triage/panel']?.value };
}

describe('legacy task-page preference migration', () => {
  it('converts supported preferences and archives original bytes and unknown collapse IDs', () => {
    const raw = { 'helmsman.triageFilters': ' {"priorities":["P4","P0","P0","P9"],"days":7,"future":true} ',
      'helmsman.triagePageSize': '25', 'helmsman.collapsed': '["triage:mine","unknown:future","triage:backlog","runs:drawer"]' };
    const result = migrate(raw);
    expect(result.saved).toEqual({ source: null, priorities: [0, 4], days: 7, pageSize: 25, collapsed: [],
      legacyCollapsedGroups: ['unassigned-backlog', 'mine-open'], expanded: [] });
    expect(result.archive).toEqual({ version: 1, raw });
    expect(result.getItem.mock.calls.map(call => call[0])).toEqual(['helmsman.triageFilters', 'helmsman.triagePageSize', 'helmsman.collapsed']);
  });
  it('preserves an intentionally empty priority filter', () => {
    expect(migrate({ 'helmsman.triageFilters': '{"priorities":[],"days":30}' }).saved).toMatchObject({ priorities: [], days: 30 });
  });
  it('uses legacy defaults for malformed values without discarding their raw data', () => {
    const raw = { 'helmsman.triageFilters': '{broken', 'helmsman.triagePageSize': '0', 'helmsman.collapsed': '{"triage:mine":true}' };
    const result = migrate(raw);
    expect(result.saved).toMatchObject({ priorities: [0, 1, 2, 3, 4], days: 0, pageSize: 10, legacyCollapsedGroups: [] });
    expect(result.archive.raw).toEqual(raw);
    expect(migrate().archive.raw).toEqual({ 'helmsman.triageFilters': null, 'helmsman.triagePageSize': null, 'helmsman.collapsed': null });
  });
  it('does not change alternate contributions, retained opaque state or deliberately empty layouts', () => {
    const storage = { getItem: () => null };
    const alternate = initial('example.triage/panel');
    expect(initializeTaskPageLayout(alternate, storage).layout).toEqual(alternate);
    const retained = { ...initial(), instances: initial().instances.map(instance => ({ ...instance, state: { 'helmsman.triage/panel': { version: 99, value: 'future' } } })) };
    expect(initializeTaskPageLayout(retained, storage).layout).toEqual(retained);
    const empty = { ...initial(), instances: [], columns: [] };
    expect(initializeTaskPageLayout(empty, storage).layout).toEqual(empty);
  });
  it('rejects inaccessible or oversized input rather than treating it as absent', () => {
    expect(() => initializeTaskPageLayout(initial(), { getItem() { throw new DOMException('Denied', 'SecurityError'); } })).toThrow('Denied');
    expect(() => migrate({ 'helmsman.collapsed': '💡'.repeat(1024 * 1024) })).toThrow('migration limit');
    expect(() => initializeTaskPageLayout({ ...initial(), compositionId: 'example/other' }, { getItem: () => null })).toThrow('Unsupported');
  });
});
