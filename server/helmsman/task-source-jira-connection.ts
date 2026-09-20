import type { JiraConfig } from '../config';
import type { SourceIdentityEvidenceV1, SourceMutationHttpV1, SourceReadHttpV1 } from '../../src/plugins/tasks';
import { probeJiraIdentity, probeJiraSubject } from '../../src/plugins/jira/http';
import { JIRA_AUTHORITY_PROTOCOL, JIRA_IDENTITY_FORMAT } from '../../src/plugins/jira/provider';
import { createSourceHttp, type ResolvedSourceHttpConnection, type SourceHttpRequest } from './task-source-http';
import { sourceConnectionOrigin, type SourceConnectionRecord, type SourceConnectionStore } from './task-source-connections';

type JiraCredentials = Pick<JiraConfig, 'baseUrl' | 'email' | 'apiToken'>;
export type JiraSourceCredentialResolver = (signal: AbortSignal) => JiraCredentials | null | Promise<JiraCredentials | null>;
function credentials(input: JiraCredentials | null) {
  if (!input || typeof input.email !== 'string' || !input.email.trim() || input.email.length > 320 || !input.email.includes('@') || /[:\x00-\x20\x7f]/.test(input.email)
    || typeof input.apiToken !== 'string' || !input.apiToken.trim() || input.apiToken.length > 8192 || /[\x00-\x20\x7f]/.test(input.apiToken)) throw new Error('Jira source credentials are unavailable');
  return { origin: sourceConnectionOrigin(input.baseUrl), email: input.email, headers: { Authorization: `Basic ${Buffer.from(`${input.email}:${input.apiToken}`).toString('base64')}` } };
}
function probeHttp(input: ReturnType<typeof credentials>, signal: AbortSignal, fetcher: typeof fetch): SourceReadHttpV1 {
  const connection = { id: 'jira-identity-probe', credentialHandle: 'jira-identity-probe', origin: input.origin, subject: 'unverified', authorityId: null };
  return createSourceHttp({ connection, signal, fetcher, timeoutMs: 15_000, maxResponseBytes: 128 * 1024,
    resolve: async () => ({ ...connection, headers: input.headers }),
    authorize(request) {
      if (request.method !== 'GET' || !['/rest/api/3/myself', '/_edge/tenant_info'].includes(request.path) || Object.keys(request.query).length) throw new Error('Invalid Jira identity probe');
    },
  });
}
async function verify(input: ReturnType<typeof credentials>, signal: AbortSignal, fetcher: typeof fetch) {
  const http = probeHttp(input, signal, fetcher);
  const subject = await probeJiraSubject(http, signal);
  const authority = await probeJiraIdentity(http, signal);
  signal.throwIfAborted();
  return { subject: subject.accountId, authorityId: authority?.cloudId ?? null };
}
export async function bootstrapJiraSourceConnection(options: {
  store: SourceConnectionStore; provisioningKey: string; credentialHandle: string;
  resolveConfig: JiraSourceCredentialResolver; signal: AbortSignal; fetcher?: typeof fetch;
}): Promise<SourceConnectionRecord> {
  options.signal.throwIfAborted();
  const previous = options.store.byProvisioningKey(options.provisioningKey);
  const current = credentials(await options.resolveConfig(options.signal));
  options.signal.throwIfAborted();
  if (previous && (previous.origin !== current.origin || previous.email !== current.email || previous.credentialHandle !== options.credentialHandle)) throw new Error('Pinned Jira connection endpoint or credential identity changed');
  const verified = await verify(current, options.signal, options.fetcher ?? fetch);
  if (previous && (previous.subject !== verified.subject || previous.authorityId !== null && previous.authorityId !== verified.authorityId)) throw new Error('Pinned Jira connection subject or authority changed');
  return options.store.pin({ kind: 'jira', provisioningKey: options.provisioningKey, credentialHandle: options.credentialHandle,
    origin: current.origin, email: current.email, subject: verified.subject, authorityId: previous ? previous.authorityId : verified.authorityId, verifiedAt: new Date().toISOString() });
}
export function jiraConnectionIdentity(connection: SourceConnectionRecord): SourceIdentityEvidenceV1 {
  const authority = connection.authorityId === null ? null : { protocol: JIRA_AUTHORITY_PROTOCOL, authorityId: connection.authorityId, identityFormat: JIRA_IDENTITY_FORMAT };
  return { version: 1, level: authority ? 'verified' : 'operator-seeded', authority, verifiedAt: connection.verifiedAt,
    proof: { connectionId: connection.id, accountId: connection.subject, cloudId: connection.authorityId } };
}
export function createJiraSourceHttp(options: {
  connection: SourceConnectionRecord; resolveConfig: JiraSourceCredentialResolver; signal: AbortSignal;
  authorize(request: SourceHttpRequest): void; mutation?: boolean; fetcher?: typeof fetch;
}): SourceReadHttpV1 | SourceMutationHttpV1 {
  const pinned = Object.freeze({ ...options.connection });
  const fetcher = options.fetcher ?? fetch;
  return createSourceHttp({ connection: pinned, signal: options.signal, authorize: options.authorize, mutation: options.mutation, fetcher,
    async resolve(signal): Promise<ResolvedSourceHttpConnection> {
      signal.throwIfAborted();
      const current = credentials(await options.resolveConfig(signal));
      signal.throwIfAborted();
      if (current.origin !== pinned.origin || current.email !== pinned.email) throw new Error('Pinned Jira connection endpoint or credential identity changed');
      const verified = await verify(current, signal, fetcher);
      if (verified.subject !== pinned.subject || pinned.authorityId !== null && verified.authorityId !== pinned.authorityId) throw new Error('Pinned Jira connection subject or authority changed');
      return { ...pinned, headers: current.headers };
    },
  });
}
