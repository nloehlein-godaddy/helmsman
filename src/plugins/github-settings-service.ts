import { createClarificationTransport, type ClarificationHostOptions } from './clarification-transport';
import { parseGithubSettingsSaveInputV1, parseGithubSettingsSnapshotInputV1, parseGithubSettingsSnapshotV1, type GithubSettingsServiceV1 } from './github-settings';
export function createHostGithubSettingsService(lifetime: AbortSignal, options: ClarificationHostOptions): GithubSettingsServiceV1 {
  const operation = createClarificationTransport(lifetime, options, 16_384);
  return Object.freeze<GithubSettingsServiceV1>({ version: 1,
    async snapshot(value, signal) {
      const input = parseGithubSettingsSnapshotInputV1(value); const call = operation(signal);
      return call.request(`/api/github-settings?version=${input.version}&scope=${input.scope}`, parseGithubSettingsSnapshotV1);
    },
    async save(value, signal) {
      const input = parseGithubSettingsSaveInputV1(value); const call = operation(signal);
      return call.request('/api/github-settings', parseGithubSettingsSnapshotV1, input);
    },
  });
}
