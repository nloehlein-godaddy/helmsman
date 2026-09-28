import { parseCommunicationConnectionSnapshotV1, parseCommunicationConnectionStartV1 } from './communication-connection';
import {
  COMMUNICATION_LIMITS,
  parseCommunicationMarkReadReceiptV1,
  parseCommunicationNotificationsV1,
  parseCommunicationSettingsSnapshotV1,
  parseCommunicationSettingsValuesV1,
  type CommunicationServiceV1,
  type CommunicationSettingsValuesV1,
} from "./communication";
import {
  clarificationUnavailable,
  createClarificationTransport,
  type ClarificationHostOptions,
} from "./clarification-transport";
import { parseTaskRepo } from "./tasks";

export function createHostCommunicationService(
  lifetime: AbortSignal,
  options: ClarificationHostOptions,
): CommunicationServiceV1 {
  const operation = createClarificationTransport(
    lifetime,
    options,
    COMMUNICATION_LIMITS.responseBytes,
  );
  return Object.freeze<CommunicationServiceV1>({
    version: 1,
    async connectionStatus(signal) { return operation(signal).request('/api/communication-connection', parseCommunicationConnectionSnapshotV1); },
    async connect(input, signal) { return operation(signal).request('/api/communication-connection/start', parseCommunicationConnectionStartV1, input); },
    async disconnect(input, signal) { return operation(signal).request('/api/communication-connection/disconnect', parseCommunicationConnectionSnapshotV1, input); },
    async checkConnection(input, signal) { return operation(signal).request('/api/communication-connection/check', parseCommunicationConnectionSnapshotV1, input); },
    async notifications(input, signal) {
      const call = operation(signal);
      if (
        input.version !== 1 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > COMMUNICATION_LIMITS.notifications
      ) {
        return clarificationUnavailable("invalid-response");
      }
      const repo = input.repo === null ? null : parseTaskRepo(input.repo);
      if (repo !== null && !call.allowed(repo))
        return clarificationUnavailable("forbidden");
      const query = new URLSearchParams({
        version: "1",
        limit: String(input.limit),
      });
      if (repo !== null) query.set("repo", repo);
      if (call.scope.repo !== null) query.set("scopeRepo", call.scope.repo);
      return call.request(
        `/api/communication/notifications?${query}`,
        parseCommunicationNotificationsV1,
      );
    },
    async markRead(input, signal) {
      const call = operation(signal);
      const repo = parseTaskRepo(input.repo);
      if (!call.allowed(repo)) return clarificationUnavailable("forbidden");
      return call.request(
        `/api/communication/notifications/${encodeURIComponent(input.id)}/read`,
        (value) => parseCommunicationMarkReadReceiptV1(value, input),
        { repo, scopeRepo: call.scope.repo },
      );
    },
    async settings(signal) {
      const call = operation(signal);
      const query = new URLSearchParams();
      if (call.scope.repo !== null) query.set("scopeRepo", call.scope.repo);
      const path =
        query.size === 0
          ? "/api/communication/settings"
          : `/api/communication/settings?${query}`;
      return call.request(path, parseCommunicationSettingsSnapshotV1);
    },
    async saveSettings(input, signal) {
      const call = operation(signal);
      let values: CommunicationSettingsValuesV1;
      try {
        values = parseCommunicationSettingsValuesV1(input.values);
      } catch {
        return clarificationUnavailable("invalid-response");
      }
      if (
        typeof input.expectedRevision !== "string" ||
        !input.expectedRevision.trim() ||
        input.expectedRevision.length > 256 ||
        /[\x00-\x1f\x7f]/.test(input.expectedRevision)
      ) {
        return clarificationUnavailable("invalid-response");
      }
      return call.request(
        "/api/communication/settings",
        parseCommunicationSettingsSnapshotV1,
        {
          expectedRevision: input.expectedRevision,
          values,
          scopeRepo: call.scope.repo,
        },
      );
    },
  });
}
