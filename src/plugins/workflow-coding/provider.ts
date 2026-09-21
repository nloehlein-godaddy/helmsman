import type { WorkflowActionV1, WorkflowProviderV1, WorkflowStepInputV1 } from '@helmsman/plugin-sdk';
import { renderBranchPrompt, renderCodingPrompt } from './prompt.js';

export interface CodingWorkflowSettings {
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
    renderPrompt: renderCodingPrompt,
    next: codingNext,
  };
}

export function branchWorkflowProvider(settings: { readonly stageTimeoutMinutes: number }): WorkflowProviderV1 {
  return {
    metadata: { version: 1, label: 'Branch update', modes: ['branch'], execution: 'direct', requiredSkills: [], maxRounds: 1, stageTimeoutMinutes: settings.stageTimeoutMinutes },
    renderPrompt: renderBranchPrompt,
    next: () => ({ kind: 'stop', reason: 'Direct branch workflows do not execute guarded stages' }),
  };
}
