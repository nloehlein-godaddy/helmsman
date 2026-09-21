import { clarificationAbortable } from '../../src/plugins/clarification-transport';
import { isContributionId } from '../../src/plugins/manifest';
import { parseProfileIdentityV1, parseProfileSnapshotInputV1, type ProfileIdentityV1, type ProfileSnapshotV1 } from '../../src/plugins/profile';
import { ClarificationServiceError } from './clarification-service-common';

export interface ProfileServerService { snapshot(caller: string, input: unknown, signal?: AbortSignal): Promise<ProfileSnapshotV1>; }
export function createProfileService(options: {
  authorize(caller: string): void; read(signal: AbortSignal): Promise<ProfileIdentityV1>; timeoutMs?: number;
}): ProfileServerService {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError('Invalid profile timeout');
  function authorize(caller: string) {
    if (!isContributionId(caller)) throw new ClarificationServiceError(403, 'forbidden');
    options.authorize(caller);
  }
  return Object.freeze<ProfileServerService>({ async snapshot(caller, input, callerSignal) {
    authorize(caller); parseProfileSnapshotInputV1(input);
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      signal.throwIfAborted();
      const profile = await clarificationAbortable(Promise.resolve().then(() => { signal.throwIfAborted(); return options.read(signal); }), signal);
      signal.throwIfAborted(); authorize(caller);
      return Object.freeze({ version: 1 as const, scope: 'global' as const, profile: parseProfileIdentityV1(profile) });
    } catch (error) {
      if (error instanceof ClarificationServiceError) throw error;
      throw new ClarificationServiceError(503, 'service-unavailable');
    } finally { clearTimeout(timer); }
  } });
}
