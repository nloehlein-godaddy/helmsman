import type { CommunicationConnectionSnapshotV1 } from './communication-connection';
import type { ClarificationReadResultV1 } from "./clarification-read";
import {
  clarificationArray,
  clarificationBoolean,
  clarificationFields,
  clarificationInteger,
  clarificationJson,
  clarificationObject,
  clarificationText,
  clarificationTime,
  clarificationVersion,
  invalidClarification,
} from "./clarification-validation";
import {
  parseCommunicationDestinationV1,
  type CommunicationDestinationV1,
} from "./communication-command";
import { parseTaskRepo } from "./tasks";

export interface CommunicationHealthV1 {
  readonly enabled: boolean;
  readonly status:
    "disabled" | "healthy" | "scanning" | "partial" | "unavailable";
  readonly channelName: string;
  readonly intervalMs: number;
  readonly lastSuccessAt: string | null;
  readonly error: string | null;
}

export interface CommunicationReviewNotificationV1 {
  readonly kind?: "review-request";
  readonly id: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly sourceUrl: string;
  readonly author: string;
  readonly channelName: string;
  readonly status: "queued" | "launched" | "failed" | "blocked";
  readonly runId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly readAt: string | null;
  readonly error: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly complexity?: "low" | "medium" | "high" | null;
}

export interface CommunicationVoyageNotificationV1 extends Omit<
  CommunicationReviewNotificationV1,
  "kind" | "prNumber" | "status" | "runId" | "error" | "complexity"
> {
  readonly kind: "voyage-completed";
  readonly title: string;
  readonly prNumber: number | null;
  readonly status: "succeeded" | "failed" | "stopped";
  readonly runId: string;
  readonly error: null;
}

export type CommunicationNotificationV1 =
  CommunicationReviewNotificationV1 | CommunicationVoyageNotificationV1;

export interface CommunicationNotificationsV1 {
  readonly version: 1;
  readonly quality: "complete" | "partial";
  readonly clearToken?: string;
  readonly unread: number | null;
  readonly health: CommunicationHealthV1;
  readonly githubHealth: CommunicationHealthV1 | null;
  readonly notifications: readonly CommunicationNotificationV1[];
}

export interface CommunicationSettingsValuesV1 {
  readonly enabled: boolean;
  readonly watchEnabled: boolean;
  readonly clientId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly browserSurface: string;
  readonly reviewChannel: string;
  readonly reviewMention: string;
}

export interface CommunicationSettingsSnapshotV1 {
  readonly version: 1;
  readonly revision: string;
  readonly values: CommunicationSettingsValuesV1;
  readonly destination: CommunicationDestinationV1 | null;
}

export interface CommunicationClearInputV1 {
  readonly version: 1;
  readonly repo: string | null;
  readonly clearToken: string;
}

export interface CommunicationClearReceiptV1 extends CommunicationClearInputV1 {
  readonly cleared: number;
}

export interface CommunicationServiceV1 {
  clearNotifications?(input: CommunicationClearInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<CommunicationClearReceiptV1>>;
  connectionStatus?(signal?: AbortSignal): Promise<ClarificationReadResultV1<CommunicationConnectionSnapshotV1>>;
  connect?(input: { readonly expectedRevision: string }, signal?: AbortSignal): Promise<ClarificationReadResultV1<{ readonly version: 1; readonly authorizationUrl: string }>>;
  disconnect?(input: { readonly expectedRevision: string }, signal?: AbortSignal): Promise<ClarificationReadResultV1<CommunicationConnectionSnapshotV1>>;
  checkConnection?(input: { readonly expectedRevision: string }, signal?: AbortSignal): Promise<ClarificationReadResultV1<CommunicationConnectionSnapshotV1>>;
  readonly version: 1;
  notifications(
    input: {
      readonly version: 1;
      readonly repo: string | null;
      readonly limit: number;
    },
    signal?: AbortSignal,
  ): Promise<ClarificationReadResultV1<CommunicationNotificationsV1>>;
  markRead(
    input: { readonly repo: string; readonly id: string },
    signal?: AbortSignal,
  ): Promise<
    ClarificationReadResultV1<{
      readonly version: 1;
      readonly id: string;
      readonly readAt: string;
    }>
  >;
  settings(
    signal?: AbortSignal,
  ): Promise<ClarificationReadResultV1<CommunicationSettingsSnapshotV1>>;
  saveSettings(
    input: {
      readonly expectedRevision: string;
      readonly values: CommunicationSettingsValuesV1;
    },
    signal?: AbortSignal,
  ): Promise<ClarificationReadResultV1<CommunicationSettingsSnapshotV1>>;
}

export const COMMUNICATION_LIMITS: Readonly<{ responseBytes: number; notifications: number; text: number }> = Object.freeze({
  responseBytes: 512 * 1024,
  notifications: 256,
  text: 2_048,
});

function optionalTime(value: unknown): string | null {
  return value === null ? null : clarificationTime(value);
}

function optionalText(value: unknown, maximum: number): string | null {
  return value === null ? null : clarificationText(value, maximum);
}

function settingsText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    invalidClarification();
  return value;
}

function notificationId(value: unknown): string {
  const id = clarificationText(value, 128);
  if (!/^[a-z\d_-]{1,128}$/i.test(id)) invalidClarification();
  return id;
}

function safePrUrl(value: unknown, repo: string, number: number): string {
  const text = clarificationText(value, COMMUNICATION_LIMITS.text);
  try {
    const url = new URL(text);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== `/${repo}/pull/${number}` ||
      url.search ||
      url.hash
    )
      invalidClarification();
    return url.href;
  } catch {
    invalidClarification();
  }
}

export function parseCommunicationHealthV1(
  input: unknown,
): CommunicationHealthV1 {
  const value = clarificationObject(input);
  clarificationFields(value, [
    "enabled",
    "status",
    "channelName",
    "intervalMs",
    "lastSuccessAt",
    "error",
  ]);
  if (
    !["disabled", "healthy", "scanning", "partial", "unavailable"].includes(
      String(value.status),
    )
  )
    invalidClarification();
  const intervalMs = clarificationInteger(value.intervalMs, 86_400_000);
  if (intervalMs < 1) invalidClarification();
  return Object.freeze({
    enabled: clarificationBoolean(value.enabled),
    status: value.status as CommunicationHealthV1["status"],
    channelName: settingsText(value.channelName, 256),
    intervalMs,
    lastSuccessAt: optionalTime(value.lastSuccessAt),
    error: optionalText(value.error, COMMUNICATION_LIMITS.text),
  });
}

function parseReviewNotification(
  value: Record<string, unknown>,
): CommunicationReviewNotificationV1 {
  clarificationFields(
    value,
    [
      "id",
      "repo",
      "prNumber",
      "prUrl",
      "sourceUrl",
      "author",
      "channelName",
      "status",
      "runId",
      "createdAt",
      "updatedAt",
      "readAt",
      "error",
    ],
    ["kind", "model", "effort", "complexity"],
  );
  if (
    (value.kind !== undefined && value.kind !== "review-request") ||
    !["queued", "launched", "failed", "blocked"].includes(String(value.status))
  )
    invalidClarification();
  const repo = parseTaskRepo(value.repo);
  const prNumber = clarificationInteger(value.prNumber);
  const runId = value.runId === null ? null : notificationId(value.runId);
  if (
    value.complexity !== undefined &&
    value.complexity !== null &&
    !["low", "medium", "high"].includes(String(value.complexity))
  )
    invalidClarification();
  return Object.freeze({
    ...(value.kind === undefined ? {} : { kind: "review-request" as const }),
    id: notificationId(value.id),
    repo,
    prNumber,
    prUrl: safePrUrl(value.prUrl, repo, prNumber),
    sourceUrl: clarificationText(value.sourceUrl, COMMUNICATION_LIMITS.text),
    author: clarificationText(value.author, 256),
    channelName: settingsText(value.channelName, 256),
    status: value.status as CommunicationReviewNotificationV1["status"],
    runId,
    createdAt: clarificationTime(value.createdAt),
    updatedAt: clarificationTime(value.updatedAt),
    readAt: optionalTime(value.readAt),
    error: optionalText(value.error, COMMUNICATION_LIMITS.text),
    ...(value.model === undefined
      ? {}
      : { model: optionalText(value.model, 256) }),
    ...(value.effort === undefined
      ? {}
      : { effort: optionalText(value.effort, 256) }),
    ...(value.complexity === undefined
      ? {}
      : {
          complexity:
            value.complexity as CommunicationReviewNotificationV1["complexity"],
        }),
  });
}

function parseVoyageNotification(
  value: Record<string, unknown>,
): CommunicationVoyageNotificationV1 {
  clarificationFields(
    value,
    [
      "kind",
      "id",
      "repo",
      "title",
      "prNumber",
      "prUrl",
      "sourceUrl",
      "author",
      "channelName",
      "status",
      "runId",
      "createdAt",
      "updatedAt",
      "readAt",
      "error",
    ],
    ["model", "effort"],
  );
  if (
    value.kind !== "voyage-completed" ||
    !["succeeded", "failed", "stopped"].includes(String(value.status)) ||
    value.error !== null
  )
    invalidClarification();
  const repo = parseTaskRepo(value.repo);
  const runId = notificationId(value.runId);
  const prNumber =
    value.prNumber === null ? null : clarificationInteger(value.prNumber);
  if (
    value.sourceUrl !== `/runs?run=${runId}` ||
    (prNumber === null ? value.prUrl !== "" : false)
  )
    invalidClarification();
  return Object.freeze({
    kind: "voyage-completed",
    id: notificationId(value.id),
    repo,
    title: clarificationText(value.title, 512),
    prNumber,
    prUrl: prNumber === null ? "" : safePrUrl(value.prUrl, repo, prNumber),
    sourceUrl: value.sourceUrl,
    author: clarificationText(value.author, 256),
    channelName: settingsText(value.channelName, 256),
    status: value.status as CommunicationVoyageNotificationV1["status"],
    runId,
    createdAt: clarificationTime(value.createdAt),
    updatedAt: clarificationTime(value.updatedAt),
    readAt: optionalTime(value.readAt),
    error: null,
    ...(value.model === undefined
      ? {}
      : { model: optionalText(value.model, 256) }),
    ...(value.effort === undefined
      ? {}
      : { effort: optionalText(value.effort, 256) }),
  });
}

export function parseCommunicationNotificationV1(
  input: unknown,
): CommunicationNotificationV1 {
  const value = clarificationObject(input);
  return value.kind === "voyage-completed"
    ? parseVoyageNotification(value)
    : parseReviewNotification(value);
}

export function parseCommunicationNotificationsV1(
  input: unknown,
): CommunicationNotificationsV1 {
  const value = clarificationVersion(
    clarificationJson(input, COMMUNICATION_LIMITS.responseBytes),
  );
  clarificationFields(value, [
    "version",
    "quality",
    "unread",
    "health",
    "githubHealth",
    "notifications",
  ], ["clearToken"]);
  if (!["complete", "partial"].includes(String(value.quality)))
    invalidClarification();
  let unread: number | null = null;
  if (value.unread !== null) {
    if (
      typeof value.unread !== "number" ||
      !Number.isSafeInteger(value.unread) ||
      value.unread < 0 ||
      value.unread > COMMUNICATION_LIMITS.notifications
    )
      invalidClarification();
    unread = value.unread;
  }
  return Object.freeze({
    version: 1,
    quality: value.quality as CommunicationNotificationsV1["quality"],
    ...(value.clearToken === undefined ? {} : { clearToken: parseCommunicationClearToken(value.clearToken) }),
    unread,
    health: parseCommunicationHealthV1(value.health),
    githubHealth:
      value.githubHealth === null
        ? null
        : parseCommunicationHealthV1(value.githubHealth),
    notifications: clarificationArray(
      value.notifications,
      parseCommunicationNotificationV1,
      COMMUNICATION_LIMITS.notifications,
    ),
  });
}

export function parseCommunicationSettingsValuesV1(
  input: unknown,
): CommunicationSettingsValuesV1 {
  const value = clarificationObject(input);
  clarificationFields(value, [
    "enabled",
    "watchEnabled",
    "clientId",
    "channelId",
    "channelName",
    "browserSurface",
    "reviewChannel",
    "reviewMention",
  ]);
  return Object.freeze({
    enabled: clarificationBoolean(value.enabled),
    watchEnabled: clarificationBoolean(value.watchEnabled),
    clientId: settingsText(value.clientId, 256),
    channelId: settingsText(value.channelId, 256),
    channelName: settingsText(value.channelName, 256),
    browserSurface: settingsText(value.browserSurface, 256),
    reviewChannel: settingsText(value.reviewChannel, 256),
    reviewMention: settingsText(value.reviewMention, 256),
  });
}

export function parseCommunicationSettingsSnapshotV1(
  input: unknown,
): CommunicationSettingsSnapshotV1 {
  const value = clarificationVersion(
    clarificationJson(input, COMMUNICATION_LIMITS.responseBytes),
  );
  clarificationFields(value, ["version", "revision", "values", "destination"]);
  return Object.freeze({
    version: 1,
    revision: clarificationText(value.revision, 256),
    values: parseCommunicationSettingsValuesV1(value.values),
    destination:
      value.destination === null
        ? null
        : parseCommunicationDestinationV1(value.destination),
  });
}

export function parseCommunicationMarkReadReceiptV1(
  input: unknown,
  expected: { readonly id: string },
): { readonly version: 1; readonly id: string; readonly readAt: string } {
  const value = clarificationVersion(
    clarificationJson(input, COMMUNICATION_LIMITS.responseBytes),
  );
  clarificationFields(value, ["version", "id", "readAt"]);
  if (value.id !== expected.id) invalidClarification();
  return Object.freeze({
    version: 1,
    id: notificationId(value.id),
    readAt: clarificationTime(value.readAt),
  });
}

export function parseCommunicationClearToken(input: unknown): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 512 || !/^[a-zA-Z0-9_:.-]+$/.test(input)) invalidClarification();
  return input as string;
}

export function parseCommunicationClearInputV1(input: unknown): CommunicationClearInputV1 {
  const value = clarificationVersion(input);
  clarificationFields(value, ['version', 'repo', 'clearToken']);
  return Object.freeze({ version: 1, repo: value.repo === null ? null : parseTaskRepo(value.repo), clearToken: parseCommunicationClearToken(value.clearToken) });
}

export function parseCommunicationClearReceiptV1(input: unknown, expected: CommunicationClearInputV1): CommunicationClearReceiptV1 {
  const value = clarificationVersion(input);
  clarificationFields(value, ['version', 'repo', 'clearToken', 'cleared']);
  if (value.repo !== expected.repo || value.clearToken !== expected.clearToken) invalidClarification();
  return Object.freeze({ ...expected, cleared: value.cleared === 0 ? 0 : clarificationInteger(value.cleared) });
}
