import { describe, expect, it } from 'vitest';
import type { CompositionLayoutV1 } from '@helmsman/plugin-sdk';
import { addInstance, changeInstance, moveInstance, moveStack, removeInstance, stackInstance } from './layout';

function fixture(): CompositionLayoutV1 {
  return { version: 1, compositionId: 'helmsman/helm-page', revision: 7, instances: [
    { instanceId: 'first', contributionId: 'example.missing/panel', hidden: true, scope: { kind: 'galleon', repo: 'owner/project' }, state: { 'example.missing/panel': { version: 5, value: { draft: 'keep me' } } } },
    { instanceId: 'second', contributionId: 'helmsman.backlog/panel', hidden: false, scope: { kind: 'inherit' }, state: {} },
  ], columns: [[{ instances: ['first', 'second'], activeInstanceId: 'first', collapsed: true }], []] };
}
describe('authored Helm layout editing', () => {
  it('moves a whole stack into an existing empty column without changing tabs, hidden state, scopes or opaque data', () => {
    const original = fixture(); const stack = original.columns[0]![0]!;
    const moved = moveStack(original, 'second', 1, 0);
    expect(moved.columns).toEqual([[], [stack]]);expect(moved.columns[1]?.[0]).toBe(stack);
    expect(moved.instances).toBe(original.instances);expect(moved.revision).toBe(original.revision);
    expect(original.columns).toEqual([[stack], []]);
    for (const [column, position] of [[0,0],[0,1],[2,0],[1,-1],[1,1],[NaN,0],[1,.5]]) expect(moveStack(original,'second',column!,position!)).toBe(original);
    expect(moveStack(original,'missing',1,0)).toBe(original);
  });
  it('adjusts same-column insertion indices and leaves hidden stacks in their saved positions', () => {
    const original = fixture();const stack = original.columns[0]![0]!;
    const hidden = { instances:['hidden'],activeInstanceId:'hidden',collapsed:false };
    const other = { instances:['other'],activeInstanceId:'other',collapsed:false };
    const layout = {...original,columns:[[stack,hidden,other],[]]};
    expect(moveStack(layout,'first',0,3).columns[0]).toEqual([hidden,other,stack]);
    expect(moveStack(layout,'other',0,0).columns[0]).toEqual([other,stack,hidden]);
    expect(moveStack(layout,'first',0,2).columns[0]).toEqual([hidden,stack,other]);
  });
  it('retains unavailable implementation state when replacing, moving, or changing scope', () => {
    const original = fixture();
    const next = moveInstance(changeInstance(original, 'first', { contributionId: 'example.replacement/panel', scope: { kind: 'all' } }), 'first', 'right');
    expect(next.instances[0]?.state).toEqual(original.instances[0]?.state);
    expect(next.instances[0]?.scope).toEqual({ kind: 'all' }); expect(next.revision).toBe(7);
    expect(original.instances[0]?.contributionId).toBe('example.missing/panel');
    expect(next.columns[0]?.[0]).toEqual({ instances: ['second'], activeInstanceId: 'second', collapsed: true });
    expect(next.columns[1]?.[0]?.instances).toEqual(['first']);
  });
  it('duplicates presentation with a new identity without copying another instance draft', () => {
    const original = fixture(); const first = original.instances[0]!;
    const next = addInstance(original, first.contributionId, first.scope);
    expect(next.instances).toHaveLength(3); expect(next.instances[2]?.instanceId).not.toBe(first.instanceId);
    expect(next.instances[2]).toMatchObject({ contributionId: first.contributionId, hidden: false, scope: first.scope, state: {} });
    expect(next.instances[0]).toEqual(first);
  });
  it('removes only explicitly selected instances and keeps valid active stack membership', () => {
    const next = removeInstance(fixture(), 'first');
    expect(next.instances.map(instance => instance.instanceId)).toEqual(['second']);
    expect(next.columns[0]?.[0]).toEqual({ instances: ['second'], activeInstanceId: 'second', collapsed: true });
    expect(removeInstance(next, 'second').columns).toEqual([[], []]);
  });
  it('stacks selected instances once and preserves both opaque state and unrelated structure', () => {
    const original = fixture(); const moved = moveInstance(original, 'second', 'right');
    const next = stackInstance(moved, 'second', 'first');
    expect(next.columns).toEqual([[{ instances: ['first', 'second'], activeInstanceId: 'second', collapsed: false }], []]);
    expect(next.instances).toEqual(original.instances);
    expect(stackInstance(original, 'first', 'unknown')).toBe(original);
  });
  it('keeps a visible sibling selected when an operator hides or removes the active panel', () => {
    const original = fixture();
    expect(changeInstance(original, 'first', { hidden: true }).columns[0]?.[0]?.activeInstanceId).toBe('second');
    const third = { ...original.instances[1]!, instanceId: 'third' };
    const layout = { ...original, instances: [...original.instances, third], columns: [[{ instances: ['second', 'first', 'third'], activeInstanceId: 'second', collapsed: false }]] };
    expect(removeInstance(layout, 'second').columns[0]?.[0]?.activeInstanceId).toBe('third');
  });
});
