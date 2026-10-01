// @vitest-environment node
import { expect, it } from 'vitest';
import { localExecutionFootprint } from './execution-local-footprint';
import { executionFootprintsConflict } from './execution-footprint';
const input = { runId: 'one', repo: 'Org/Repo', checkout: { path: '/tmp/repo', commonDirectory: '/tmp/repo/.git', workspacePath: '/tmp/repo/.worktrees/one' },
  trustedLocalHost: true, mode: 'coding' as const, source: { sourceId: 'jira', externalId: 'T-1' }, unknownTask: false, retry: false };
it('derives task identity independent of source instance and protects publishing plus checkout branch names', () => {
  const value = localExecutionFootprint(input);
  expect(value).toMatchObject({ completeness: 'verified', repo: 'org/repo' });
  expect(value.resources).toContainEqual({ kind: 'task', namespace: 'jira', identity: 'T-1' });
  expect(value.resources.filter(item => item.kind === 'branch')).toEqual(expect.arrayContaining([
    { kind: 'branch', namespace: 'github.com/org/repo', identity: 'refs/heads/agent/one' },
    { kind: 'branch', namespace: 'git:/tmp/repo/.git', identity: 'refs/heads/agent/one' },
  ]));
});
it('does not use PR head revisions to evade exclusive PR review ownership', () => {
  const one = localExecutionFootprint({ ...input, mode: 'review', source: null, pullRequestNumber: 7 });
  const two = localExecutionFootprint({ ...input, runId: 'two', checkout: { ...input.checkout, workspacePath: '/tmp/repo/.worktrees/two' }, mode: 'review', source: null, pullRequestNumber: 7 });
  expect(executionFootprintsConflict(one, two)).toBe(true);
  expect(one.resources.some(resource => resource.kind === 'branch')).toBe(false);
});
it.each([{ trustedLocalHost: false }, { unknownTask: true }, { retry: true }, { mode: 'branch' as const }])('falls back to whole-checkout exclusion for incomplete authority %j', override => {
  const value = localExecutionFootprint({ ...input, ...override });
  expect(value.completeness).toBe('exclusive');
  expect(value.resources.map(resource => resource.kind)).toEqual(expect.arrayContaining(['galleon-exclusive', 'checkout-exclusive']));
});
