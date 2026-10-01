import type { FeedbackTrackerBackendContextV1 } from '@helmsman/plugin-sdk';
import { createGithubFeedbackTracker } from './provider.js';
export default { activate(context: FeedbackTrackerBackendContextV1) {
  if (!context.registerFeedbackTracker) throw new Error('Feedback tracker capability is unavailable');
  context.registerFeedbackTracker('issues', createGithubFeedbackTracker(context.settings));
} };
