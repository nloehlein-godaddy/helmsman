import { describe, expect, it } from 'vitest';
import { builtinWorkflows } from './builtin-workflows';

describe('builtin workflows', () => {
  it('publishes the coding, branch, and review workflow catalog with retained settings', () => {
    expect(builtinWorkflows.map(entry => entry.package.manifest.id)).toEqual([
      'helmsman.workflow-coding',
      'helmsman.workflow-review',
    ]);
    const [coding, review] = builtinWorkflows.map(entry => entry.package.backend);
    expect(coding?.provides.map(value => value.localId)).toEqual(['coding', 'branch']);
    expect(coding?.workflows).toEqual({
      coding: { access: ['workflow-policy'] },
      branch: { access: ['workflow-policy'] },
    });
    expect(coding?.settings).toMatchObject({
      maxRounds: { default: 3, minimum: 1, maximum: 5 },
      stageTimeoutMinutes: { default: 45, minimum: 5, maximum: 180 },
    });
    expect(review?.provides.map(value => value.localId)).toEqual(['review']);
    expect(review?.workflows).toEqual({ review: { access: ['workflow-policy'] } });
    expect(review?.settings).toEqual({});
  });
});
