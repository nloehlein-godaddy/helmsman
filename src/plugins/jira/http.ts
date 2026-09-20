import type { PluginJson, SourceReadHttpV1 } from '@helmsman/plugin-sdk';
import { jiraRecord, jiraText, normalizeJiraCloudIdentity, normalizeJiraSubject } from './normalize.js';

export async function jiraGet(http: SourceReadHttpV1, signal: AbortSignal, path: string, query: Readonly<Record<string, string>> = {}) {
  signal.throwIfAborted();
  const response = await http.get({ path, query });
  signal.throwIfAborted();
  if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new Error('Malformed Jira HTTP response');
  return response;
}
export async function probeJiraSubject(http: SourceReadHttpV1, signal: AbortSignal): Promise<{ accountId: string }> {
  const response = await jiraGet(http, signal, '/rest/api/3/myself');
  if (response.status !== 200) throw new Error(`Jira subject lookup failed (${response.status})`);
  return normalizeJiraSubject(response.body);
}
export async function probeJiraIdentity(http: SourceReadHttpV1, signal: AbortSignal): Promise<{ cloudId: string } | null> {
  try {
    const response = await jiraGet(http, signal, '/_edge/tenant_info');
    return response.status === 200 ? normalizeJiraCloudIdentity(response.body) : null;
  } catch { signal.throwIfAborted(); return null; }
}
export interface JiraState { issueId: string; statusId: string; statusName: string; accountId: string | null; }
export function jiraIssueId(value: unknown): value is string { return jiraText(value, 64) && /^[1-9]\d*$/.test(value); }
export async function readJiraState(http: SourceReadHttpV1, signal: AbortSignal, issueId: string): Promise<JiraState> {
  if (!jiraIssueId(issueId)) throw new Error('Invalid Jira issue ID');
  const response = await jiraGet(http, signal, `/rest/api/3/issue/${issueId}`, { fields: 'assignee,status' });
  if (response.status !== 200) throw new Error(`Jira state lookup failed (${response.status})`);
  const issue = jiraRecord(response.body);
  const fields = jiraRecord(issue?.fields);
  const status = jiraRecord(fields?.status);
  const accountId = fields?.assignee === null ? null : jiraRecord(fields?.assignee)?.accountId;
  if (issue?.id !== issueId || !jiraText(status?.id, 128) || !jiraText(status?.name, 240)
    || accountId !== null && !jiraText(accountId, 320)) throw new Error('Malformed Jira issue state');
  return { issueId, statusId: status.id, statusName: status.name, accountId };
}
export interface JiraTransition { id: string; statusId: string; statusName: string; }
export function jiraArray(value: unknown, maximum: number): readonly PluginJson[] {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length) throw new Error('Malformed or oversized Jira page');
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw new Error('Malformed Jira page item');
  }
  return value as PluginJson[];
}
export async function findJiraTransition(http: SourceReadHttpV1, signal: AbortSignal, issueId: string, statusName: string): Promise<JiraTransition> {
  if (!jiraIssueId(issueId) || !jiraText(statusName, 240)) throw new Error('Invalid Jira transition target');
  const response = await jiraGet(http, signal, `/rest/api/3/issue/${issueId}/transitions`);
  if (response.status !== 200) throw new Error(`Jira transition lookup failed (${response.status})`);
  const candidates = jiraArray(jiraRecord(response.body)?.transitions, 200).map(value => {
    const transition = jiraRecord(value);
    const to = jiraRecord(transition?.to);
    if (!jiraText(transition?.id, 128) || !jiraText(to?.id, 128) || !jiraText(to?.name, 240)) throw new Error('Malformed Jira transition');
    return { id: transition.id, statusId: to.id, statusName: to.name };
  }).filter(value => value.statusName.toLowerCase() === statusName.toLowerCase());
  if (candidates.length !== 1) throw new Error('Jira transition is unavailable or ambiguous');
  return candidates[0]!;
}
