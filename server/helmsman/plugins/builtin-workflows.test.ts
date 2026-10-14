import { describe, expect, it } from 'vitest';
import { codingPromptRoles } from '../../../src/plugins/workflow-coding/prompt-instructions';
import { reviewPromptRoles } from '../../../src/plugins/workflow-review/prompt-instructions';
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
    expect(review?.settings).toEqual({ promptReview: { type: 'string', default: reviewPromptRoles[0].defaultText, maxLength: 4096 } });
    for (const role of codingPromptRoles) expect(coding?.settings?.[role.settingKey]).toEqual({ type: 'string', default: role.defaultText, maxLength: 4096 });
  });
});
