import { clarificationFields, clarificationObject, clarificationText, invalidClarification } from './clarification-validation';

export interface CommunicationConnectionStatusV1 {
  readonly status: 'unsupported' | 'setup-required' | 'disconnected' | 'connected' | 'error';
  readonly message: string;
  readonly accountLabel: string | null;
  readonly redirectUri: string | null;
}

export interface CommunicationConnectionSnapshotV1 extends CommunicationConnectionStatusV1 {
  readonly version: 1;
  readonly providerId: string | null;
  readonly revision: string | null;
}

export interface CommunicationConnectionProviderV1 {
  status(signal: AbortSignal): Promise<CommunicationConnectionStatusV1>;
  begin(signal: AbortSignal): Promise<{ readonly authorizationUrl: string; readonly state: string }>;
  complete(query: URLSearchParams, cookieState: string, signal: AbortSignal, beforeCommit: () => void): Promise<void>;
  disconnect(signal: AbortSignal): Promise<void>;
  check(signal: AbortSignal): Promise<void>;
}

export function communicationConnectionUrl(value: unknown): string {
  const text = clarificationText(value, 8192);
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) invalidClarification();
    return url.href;
  } catch { return invalidClarification(); }
}

export function parseCommunicationConnectionStatusV1(input: unknown): CommunicationConnectionStatusV1 {
  const value = clarificationObject(input);
  clarificationFields(value, ['status', 'message', 'accountLabel', 'redirectUri']);
  if (!['unsupported', 'setup-required', 'disconnected', 'connected', 'error'].includes(String(value.status))) invalidClarification();
  const redirectUri = value.redirectUri === null ? null : communicationConnectionUrl(value.redirectUri);
  if (redirectUri && (new URL(redirectUri).pathname !== '/api/communication-connection/callback' || new URL(redirectUri).search)) invalidClarification();
  return Object.freeze({ status: value.status as CommunicationConnectionStatusV1['status'], message: clarificationText(value.message, 2048),
    accountLabel: value.accountLabel === null ? null : clarificationText(value.accountLabel, 256), redirectUri });
}

export function parseCommunicationConnectionSnapshotV1(input: unknown): CommunicationConnectionSnapshotV1 {
  const value = clarificationObject(input);
  clarificationFields(value, ['version', 'providerId', 'revision', 'status', 'message', 'accountLabel', 'redirectUri']);
  if (value.version !== 1 || value.providerId !== null && (typeof value.providerId !== 'string' || !/^[a-z][a-z0-9.-]*\/[a-z][a-z0-9_-]*$/.test(value.providerId))) invalidClarification();
  if (value.revision !== null && (typeof value.revision !== 'string' || !/^[a-f\d]{64}$/.test(value.revision))) invalidClarification();
  return Object.freeze({ version: 1, providerId: value.providerId as string | null, revision: value.revision as string | null,
    ...parseCommunicationConnectionStatusV1({ status: value.status, message: value.message, accountLabel: value.accountLabel, redirectUri: value.redirectUri }) });
}

export function parseCommunicationConnectionStartV1(input: unknown): { readonly version: 1; readonly authorizationUrl: string } {
  const value = clarificationObject(input);
  clarificationFields(value, ['version', 'authorizationUrl']);
  if (value.version !== 1) invalidClarification();
  return Object.freeze({ version: 1, authorizationUrl: communicationConnectionUrl(value.authorizationUrl) });
}
