import type { WorkflowProviderV1 } from '@helmsman/plugin-sdk';
import { renderReviewPrompt } from './prompt.js';

export function reviewWorkflowProvider(): WorkflowProviderV1 {
  return {
    metadata: { version: 1, label: 'Pull request review', modes: ['review'], execution: 'direct', requiredSkills: [], maxRounds: 1, stageTimeoutMinutes: 45 },
    renderPrompt: renderReviewPrompt,
    next: () => ({ kind: 'stop', reason: 'Direct review workflows do not execute guarded stages' }),
  };
}
