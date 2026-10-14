import type { WorkflowProviderV1 } from '@helmsman/plugin-sdk';
import { renderReviewPrompt } from './prompt.js';

import type { ReviewPromptSettings } from './prompt-instructions';

export function reviewWorkflowProvider(settings: ReviewPromptSettings = {}): WorkflowProviderV1 {
  return {
    metadata: { version: 1, label: 'Pull request review', modes: ['review'], execution: 'direct', requiredSkills: [], maxRounds: 1, stageTimeoutMinutes: 45 },
    renderPrompt: input => renderReviewPrompt(input, settings),
    next: () => ({ kind: 'stop', reason: 'Direct review workflows do not execute guarded stages' }),
  };
}
