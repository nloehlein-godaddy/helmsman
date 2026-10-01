import { createClarificationTransport, type ClarificationHostOptions } from './clarification-transport';
import { parseFeedbackSettingsSaveV1, parseFeedbackSettingsSnapshotV1, type FeedbackSettingsServiceV1 } from './feedback-settings';
export function createHostFeedbackSettingsService(lifetime: AbortSignal, options: ClarificationHostOptions): FeedbackSettingsServiceV1 {
  const operation = createClarificationTransport(lifetime, options, 256 * 1024);
  return { version: 1,
    snapshot: signal => operation(signal).request('/api/feedback-settings', parseFeedbackSettingsSnapshotV1),
    save: (input, signal) => operation(signal).request('/api/feedback-settings', parseFeedbackSettingsSnapshotV1, parseFeedbackSettingsSaveV1(input)),
  };
}
