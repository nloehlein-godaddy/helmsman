import { REVIEW_CALIBRATION } from './guidance';

export const reviewPromptRoles = [
  { id: 'review.pull-request', settingKey: 'promptReview', label: 'PR reviewer', description: 'Scope and calibration for the pinned pull request reviewer.', defaultText: REVIEW_CALIBRATION.join('\n') },
] as const;
export interface ReviewPromptSettings { readonly promptReview?: string; }
