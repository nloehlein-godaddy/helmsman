import { IMPLEMENTATION_GUIDANCE, REVIEW_CALIBRATION } from './guidance';

const implementation = IMPLEMENTATION_GUIDANCE.join('\n');
const review = REVIEW_CALIBRATION.join('\n');
export const codingPromptRoles = [
  { id: 'coding.implement', settingKey: 'promptImplement', label: 'Implementation', description: 'Guidance for implementing a task before independent review.', defaultText: implementation },
  { id: 'coding.fix', settingKey: 'promptFix', label: 'Review fixes', description: 'Guidance for repairing material findings before another review.', defaultText: implementation },
  { id: 'coding.review', settingKey: 'promptReview', label: 'Independent code review', description: 'Scope and calibration for the independent pre-PR reviewer.', defaultText: review },
  { id: 'branch.author', settingKey: 'promptBranchAuthor', label: 'PR feedback author', description: 'Guidance for implementing changes on an existing PR branch.', defaultText: implementation },
  { id: 'branch.audit', settingKey: 'promptFeedbackAudit', label: 'Feedback auditor', description: 'Scope and calibration for independently auditing PR feedback completion.', defaultText: review },
] as const;

export interface CodingPromptSettings {
  readonly promptImplement?: string;
  readonly promptFix?: string;
  readonly promptReview?: string;
  readonly promptBranchAuthor?: string;
  readonly promptFeedbackAudit?: string;
}

export function replacePromptGuidance(lines: readonly string[], count: number, text?: string): string[] {
  return text === undefined ? [...lines] : [text, ...lines.slice(count)];
}
