import type { PullRequestFeedbackSnapshotV1 } from '../../src/plugins/pull-request-feedback';
export type FeedbackSnapshot = Omit<PullRequestFeedbackSnapshotV1, 'version' | 'quality'>;
