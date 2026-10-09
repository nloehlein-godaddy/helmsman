import { createClarificationTransport, type ClarificationHostOptions } from './clarification-transport';
import { notifyIntegrationSettingsChanged } from '../data/integration-status-events';
import { parseJiraSettingsRotateTokenInputV1, parseJiraSettingsSnapshotInputV1, parseJiraSettingsSnapshotV1, type JiraSettingsServiceV1 } from './jira-settings';
export function createHostJiraSettingsService(lifetime: AbortSignal, options: ClarificationHostOptions): JiraSettingsServiceV1 {
  const operation = createClarificationTransport(lifetime, options, 16_384);
  return Object.freeze<JiraSettingsServiceV1>({ version: 1,
    async snapshot(value, signal) {
      const input = parseJiraSettingsSnapshotInputV1(value); const call = operation(signal);
      return call.request(`/api/jira-settings?version=${input.version}&scope=${input.scope}`, parseJiraSettingsSnapshotV1);
    },
    async rotateToken(value, signal) {
      const input = parseJiraSettingsRotateTokenInputV1(value); const call = operation(signal);
      const result = await call.request('/api/jira-settings/token', parseJiraSettingsSnapshotV1, input);
      if (result.status === 'available') notifyIntegrationSettingsChanged();
      return result;
    },
  });
}
