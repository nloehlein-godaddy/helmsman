import type { WorkflowActionV1, WorkflowProviderV1, WorkflowStepInputV1, WorkflowFeedbackStepInputV1, WorkflowFeedbackActionV1 } from '@helmsman/plugin-sdk';
import { renderBranchPrompt, renderCodingPrompt } from './prompt.js';

import type { CodingPromptSettings } from './prompt-instructions';

export interface CodingWorkflowSettings extends CodingPromptSettings {
  readonly maxRounds: number;
  readonly stageTimeoutMinutes: number;
}

export function codingNext(input: WorkflowStepInputV1): WorkflowActionV1 {
  if (!input.implemented) return { kind: 'author', stage: 'implement' };
  const comment = input.reviews.find(review => review.report.verdict === 'COMMENT');
  if (comment) return { kind: 'stop', reason: `${comment.reviewer} could not complete the required review: ${comment.report.summary}` };
  const reviewed = new Set(input.reviews.map(review => review.reviewer));
  const reviewerId = input.reviewerIds.find(id => !reviewed.has(id));
  if (reviewerId) return { kind: 'review', reviewerId };
  if (input.reviews.some(review => review.report.verdict === 'REQUEST_CHANGES')) {
    return input.round >= input.maxRounds
      ? { kind: 'stop', reason: `Unresolved material findings after ${input.maxRounds} review rounds` }
      : { kind: 'author', stage: 'fix' };
  }
  return { kind: 'publish' };
}

export function codingWorkflowProvider(settings: CodingWorkflowSettings): WorkflowProviderV1 {
  return {
    metadata: { version: 1, label: 'Coding', modes: ['coding'], execution: 'staged', requiredSkills: [], maxRounds: settings.maxRounds, stageTimeoutMinutes: settings.stageTimeoutMinutes },
    renderPrompt: input => renderCodingPrompt(input, settings),
    next: codingNext,
  };
}

export function feedbackNext(input: WorkflowFeedbackStepInputV1, maxRounds: number): WorkflowFeedbackActionV1 {
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5) throw new Error('Invalid feedback round limit');
  if (!input.outcomes.length) return { kind: 'stop', reason: 'Independent feedback audit is incomplete' };
  if (input.evidenceChanged) return input.repairAttempts + 1 >= maxRounds
    ? { kind: 'stop', reason: 'Feedback evidence kept changing through the final review round' } : { kind: 'repair' };
  if (input.outcomes.every(outcome => outcome === 'completed')) return { kind: 'complete' };
  if (input.outcomes.includes('awaiting_decision')) return input.decisionRounds >= maxRounds
    ? { kind: 'stop', reason: 'Required feedback decisions remain unresolved after clarification' } : { kind: 'decide' };
  return input.repairAttempts + 1 >= maxRounds
    ? { kind: 'stop', reason: `Unresolved feedback after ${maxRounds} repair rounds` } : { kind: 'repair' };
}

export function branchWorkflowProvider(settings: CodingWorkflowSettings): WorkflowProviderV1 {
  return {
    metadata: { version: 1, label: 'Branch update', modes: ['branch'], execution: 'direct', feedbackCompletion: true, requiredSkills: [], maxRounds: settings.maxRounds, stageTimeoutMinutes: settings.stageTimeoutMinutes },
    renderPrompt: input => renderBranchPrompt(input, settings),
    next: () => ({ kind: 'stop', reason: 'Branch feedback requires the feedback completion policy' }),
    nextFeedback: input => feedbackNext(input, settings.maxRounds),
  };
}
