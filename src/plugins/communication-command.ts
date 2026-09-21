import type { ClarificationReadResultV1 } from "./clarification-read";
import {
  clarificationFields,
  clarificationInteger,
  clarificationJson,
  clarificationObject,
  clarificationText,
  clarificationUuid,
  clarificationVersion,
  invalidClarification,
} from "./clarification-validation";
import type { CommunicationDestinationV1 } from "./communication-provider";
import { parseTaskRepo } from "./tasks";

export type { CommunicationDestinationV1 } from "./communication-provider";

export interface CommunicationCommandInputV1 {
  readonly version: 1;
  readonly repo: string;
  readonly number: number;
  readonly expectedDestination: CommunicationDestinationV1;
}
export interface CommunicationCommandV1 extends CommunicationCommandInputV1 {
  readonly requestId: string;
}
export interface CommunicationCommandReceiptQueryV1 {
  readonly repo: string;
  readonly requestId: string;
}
export interface CommunicationCommandOutcomeV1 {
  readonly repo: string;
  readonly number: number;
  readonly destination: CommunicationDestinationV1;
  readonly permalink: string | null;
}
export interface CommunicationCommandReceiptV1 {
  readonly version: 1;
  readonly requestId: string;
  readonly input: CommunicationCommandInputV1;
  readonly status: "succeeded" | "rejected" | "pending" | "recovery-required";
  readonly result: CommunicationCommandOutcomeV1 | null;
  readonly reason: string | null;
}
export interface CommunicationCommandPendingV1 {
  readonly command: CommunicationCommandV1;
  readonly receipt: CommunicationCommandReceiptV1 | null;
}
export type CommunicationCommandResultV1<T> = ClarificationReadResultV1<T>;
export interface CommunicationCommandServiceV1 {
  readonly version: 1;
  submit(
    input: CommunicationCommandInputV1,
    signal?: AbortSignal,
  ): Promise<CommunicationCommandResultV1<CommunicationCommandReceiptV1>>;
  retry(
    input: CommunicationCommandReceiptQueryV1,
    signal?: AbortSignal,
  ): Promise<CommunicationCommandResultV1<CommunicationCommandReceiptV1>>;
  receipt(
    input: CommunicationCommandReceiptQueryV1,
    signal?: AbortSignal,
  ): Promise<
    CommunicationCommandResultV1<CommunicationCommandReceiptV1 | null>
  >;
  pending(): Promise<readonly CommunicationCommandPendingV1[]>;
  acknowledge(
    input: CommunicationCommandReceiptQueryV1,
    signal?: AbortSignal,
  ): Promise<void>;
}

export const COMMUNICATION_COMMAND_LIMITS: Readonly<{ responseBytes: number; pending: number; aggregateBytes: number }> = Object.freeze({
  responseBytes: 512 * 1024,
  pending: 256,
  aggregateBytes: 8 * 1024 * 1024,
});

function text(value: unknown, maximum: number): string {
  const parsed = clarificationText(value, maximum);
  if (/[\x00-\x1f\x7f]/.test(parsed)) invalidClarification();
  return parsed;
}

export function parseCommunicationDestinationV1(
  input: unknown,
): CommunicationDestinationV1 {
  const value = clarificationObject(input);
  clarificationFields(value, [
    "providerId",
    "artifactHash",
    "workspace",
    "channel",
    "mention",
    "connectionId",
  ]);
  if (
    typeof value.providerId !== "string" ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(
      value.providerId,
    ) ||
    value.providerId.length > 192 ||
    typeof value.artifactHash !== "string" ||
    !/^[a-f\d]{64}$/i.test(value.artifactHash)
  )
    invalidClarification();
  return Object.freeze({
    providerId: value.providerId,
    artifactHash: value.artifactHash.toLowerCase(),
    workspace: text(value.workspace, 256),
    channel: text(value.channel, 256),
    mention: text(value.mention, 256),
    connectionId: text(value.connectionId, 256),
  });
}

function sameDestination(
  left: CommunicationDestinationV1,
  right: CommunicationDestinationV1,
): boolean {
  return (
    left.providerId === right.providerId &&
    left.artifactHash === right.artifactHash &&
    left.workspace === right.workspace &&
    left.channel === right.channel &&
    left.mention === right.mention &&
    left.connectionId === right.connectionId
  );
}

function safeSlackPermalink(value: unknown): string {
  const permalink = clarificationText(value, 2_048);
  try {
    const url = new URL(permalink);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".slack.com") ||
      url.username ||
      url.password ||
      url.port ||
      !/^\/archives\/[A-Z0-9]+\/p\d+$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      invalidClarification();
    return url.href;
  } catch {
    invalidClarification();
  }
}

export function parseCommunicationCommandInputV1(
  input: unknown,
): CommunicationCommandInputV1 {
  const value = clarificationVersion(
    clarificationJson(input, COMMUNICATION_COMMAND_LIMITS.responseBytes),
  );
  clarificationFields(value, [
    "version",
    "repo",
    "number",
    "expectedDestination",
  ]);
  return Object.freeze({
    version: 1,
    repo: parseTaskRepo(value.repo),
    number: clarificationInteger(value.number),
    expectedDestination: parseCommunicationDestinationV1(
      value.expectedDestination,
    ),
  });
}

export function parseCommunicationCommandV1(
  input: unknown,
): CommunicationCommandV1 {
  const { requestId, ...intent } = clarificationObject(input);
  return Object.freeze({
    ...parseCommunicationCommandInputV1(intent),
    requestId: clarificationUuid(requestId),
  });
}

export function parseCommunicationCommandReceiptQueryV1(
  input: unknown,
): CommunicationCommandReceiptQueryV1 {
  const value = clarificationObject(input);
  clarificationFields(value, ["repo", "requestId"]);
  return Object.freeze({
    repo: parseTaskRepo(value.repo),
    requestId: clarificationUuid(value.requestId),
  });
}

export function parseCommunicationCommandReceiptV1(
  input: unknown,
  expected?: CommunicationCommandV1 | CommunicationCommandReceiptQueryV1,
): CommunicationCommandReceiptV1 {
  const value = clarificationVersion(
    clarificationJson(input, COMMUNICATION_COMMAND_LIMITS.responseBytes),
  );
  clarificationFields(value, [
    "version",
    "requestId",
    "input",
    "status",
    "result",
    "reason",
  ]);
  const intent = parseCommunicationCommandInputV1(value.input);
  const requestId = clarificationUuid(value.requestId);
  if (
    expected &&
    (expected.repo !== intent.repo || expected.requestId !== requestId)
  )
    invalidClarification();
  if (expected && "expectedDestination" in expected) {
    const retained = parseCommunicationCommandV1(expected);
    if (
      retained.number !== intent.number ||
      !sameDestination(retained.expectedDestination, intent.expectedDestination)
    )
      invalidClarification();
  }
  let result: CommunicationCommandOutcomeV1 | null = null;
  let reason: string | null = null;
  if (value.status === "succeeded") {
    const outcome = clarificationObject(value.result);
    clarificationFields(outcome, [
      "repo",
      "number",
      "destination",
      "permalink",
    ]);
    const destination = parseCommunicationDestinationV1(outcome.destination);
    if (
      value.reason !== null ||
      outcome.repo !== intent.repo ||
      outcome.number !== intent.number ||
      !sameDestination(destination, intent.expectedDestination)
    )
      invalidClarification();
    result = Object.freeze({
      repo: intent.repo,
      number: intent.number,
      destination,
      permalink:
        outcome.permalink === null
          ? null
          : safeSlackPermalink(outcome.permalink),
    });
  } else {
    if (
      !["rejected", "pending", "recovery-required"].includes(
        String(value.status),
      ) ||
      value.result !== null
    )
      invalidClarification();
    reason =
      value.reason === null ? null : clarificationText(value.reason, 2_000);
    if (value.status !== "pending" && reason === null) invalidClarification();
  }
  return Object.freeze({
    version: 1,
    requestId,
    input: intent,
    status: value.status as CommunicationCommandReceiptV1["status"],
    result,
    reason,
  });
}
