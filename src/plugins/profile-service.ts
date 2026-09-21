import { createClarificationTransport, type ClarificationHostOptions } from './clarification-transport';
import { parseProfileSnapshotInputV1, parseProfileSnapshotV1, type ProfileServiceV1 } from './profile';

export function createHostProfileService(lifetime: AbortSignal, options: ClarificationHostOptions): ProfileServiceV1 {
  const operation = createClarificationTransport(lifetime, options, 4096);
  return Object.freeze<ProfileServiceV1>({ version: 1,
    async snapshot(value, signal) {
      const input = parseProfileSnapshotInputV1(value);
      return operation(signal).request(`/api/profile?version=${input.version}&scope=${input.scope}`, parseProfileSnapshotV1);
    },
  });
}
