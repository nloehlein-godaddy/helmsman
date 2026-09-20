import type { PluginJson, SourceCallContextV1, SourceIdentityEvidenceV1, SourceMutationPlanV1, TaskSnapshotV1, TaskSourceProviderV1, WorkRefV1 } from '@helmsman/plugin-sdk';
import { jiraRecord, jiraText, normalizeJiraIssue } from './normalize.js';
import { findJiraTransition, jiraArray, jiraGet, jiraIssueId, probeJiraIdentity, probeJiraSubject } from './http.js';
import { jiraEffects } from './effects.js';

export const JIRA_IDENTITY_FORMAT = 'jira.issue-id/v1';
export const JIRA_AUTHORITY_PROTOCOL = 'jira.cloud';
interface JiraSettings {
  baseUrl: string; project: string; projectByRepo: Record<string, string>; assigneeAccountId: string;
  progressStatus: string; reviewStatus: string; readyStatuses: string[]; jql: string; assignee: string;
}
export function jiraSettings(input: Readonly<Record<string, PluginJson>>): JiraSettings {
  const settings = jiraRecord(input);
  if (!settings || !jiraText(settings.baseUrl, 2048) || !jiraText(settings.project, 128) || !/^[a-z][a-z\d_]*$/i.test(settings.project)
    || !jiraText(settings.assigneeAccountId, 320)) throw new Error('Invalid Jira source settings');
  if (Object.keys(settings).some(key => /password|secret|token|credential|email|authorization/i.test(key))) throw new Error('Jira source settings must not contain credentials');
  const url = new URL(settings.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Jira display URL must be an HTTPS origin');
  const projectByRepo: Record<string, string> = Object.create(null) as Record<string, string>;
  const mapping = settings.projectByRepo === undefined ? {} : jiraRecord(settings.projectByRepo);
  if (!mapping || Object.keys(mapping).length > 100) throw new Error('Invalid Jira project mapping');
  for (const [repo, project] of Object.entries(mapping)) {
    if (!jiraText(repo, 240) || !jiraText(project, 128) || !/^[a-z][a-z\d_]*$/i.test(project)) throw new Error('Invalid Jira project mapping');
    projectByRepo[repo] = project;
  }
  const progressStatus = settings.progressStatus ?? 'In Progress';
  const reviewStatus = settings.reviewStatus ?? 'In Review';
  const readyStatuses = settings.readyStatuses === undefined ? ['Backlog', 'To Do'] : jiraArray(settings.readyStatuses, 20);
  const jql = settings.jql ?? '';
  const assignee = settings.assignee ?? '';
  if (!jiraText(progressStatus, 240) || !jiraText(reviewStatus, 240) || !readyStatuses.length || readyStatuses.some(value => !jiraText(value, 240))
    || typeof jql !== 'string' || jql.length > 8192 || /[\x00-\x1f\x7f]/.test(jql)
    || typeof assignee !== 'string' || assignee.length > 320 || /[\x00-\x1f\x7f]/.test(assignee)) throw new Error('Invalid Jira source policy');
  return { baseUrl: url.origin, project: settings.project, projectByRepo, assigneeAccountId: settings.assigneeAccountId,
    progressStatus, reviewStatus, readyStatuses: readyStatuses as string[], jql, assignee };
}
function access(context: SourceCallContextV1, repo = context.repo) {
  context.signal.throwIfAborted();
  if (!context.http) throw new Error('Jira connection is unavailable');
  if (!repo || context.repo !== null && context.repo !== repo || !context.instance.allowedRepos.includes(repo)) throw new Error('Jira repository scope is unavailable');
  const settings = jiraSettings(context.instance.settings);
  return { http: context.http, settings, repo, project: settings.projectByRepo[repo] ?? settings.project };
}
function assertRef(ref: WorkRefV1, context: SourceCallContextV1): void {
  if (!ref || ref.sourceId !== context.instance.sourceId || !jiraIssueId(ref.externalId)) throw new Error('Jira work identity does not match its source');
}
function snapshot(body: PluginJson, context: SourceCallContextV1, repo: string): TaskSnapshotV1 {
  const { settings, project } = access(context, repo);
  const issue = normalizeJiraIssue(body);
  if (issue.providerData.projectKey.toLowerCase() !== project.toLowerCase()) throw new Error('Jira issue is outside the configured project scope');
  return { version: 1, ref: { sourceId: context.instance.sourceId, externalId: issue.externalId }, revision: issue.revision,
    displayKey: issue.displayKey, title: issue.title, repo, url: `${settings.baseUrl}/browse/${encodeURIComponent(issue.displayKey)}`,
    state: settings.readyStatuses.some(status => status.toLowerCase() === issue.providerData.statusName.toLowerCase()) ? 'ready'
      : issue.providerData.statusName.toLowerCase() === settings.reviewStatus.toLowerCase() ? 'review'
        : issue.providerData.statusName.toLowerCase() === settings.progressStatus.toLowerCase() ? 'in_progress' : issue.state, priority: issue.priority, requirements: issue.requirements, providerData: issue.providerData };
}
async function loadIssue(id: string, context: SourceCallContextV1): Promise<TaskSnapshotV1 | null> {
  const { http, repo } = access(context);
  const response = await jiraGet(http, context.signal, `/rest/api/3/issue/${encodeURIComponent(id)}`, { fields: '*all', expand: 'names' });
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error(`Jira issue lookup failed (${response.status})`);
  return snapshot(response.body, context, repo);
}
function metadata(task: TaskSnapshotV1) {
  const value = jiraRecord(task?.providerData);
  if (value?.version !== 1 || value.issueId !== task.ref.externalId || !jiraText(value.statusId, 128) || !jiraText(value.statusName, 240)
    || value.assigneeAccountId !== null && !jiraText(value.assigneeAccountId, 320)) throw new Error('Jira task evidence is unavailable');
  return { statusId: value.statusId, statusName: value.statusName, accountId: value.assigneeAccountId };
}
function sameTask(a: TaskSnapshotV1, b: TaskSnapshotV1): boolean {
  return a.ref.sourceId === b.ref.sourceId && a.ref.externalId === b.ref.externalId && a.repo === b.repo && a.revision === b.revision
    && JSON.stringify(a.requirements) === JSON.stringify(b.requirements) && a.title === b.title;
}
const quote = (value: string) => JSON.stringify(value);
function splitJql(value: string): { filter: string; order: string } {
  let quoted: string | null = null;
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted) {
      if (char === '\\') index++;
      else if (char === quoted) quoted = null;
    } else if (char === '"' || char === "'") quoted = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth === 0 && (index === 0 || /\s/.test(value[index - 1]!)) && /^order\s+by\s+/i.test(value.slice(index))) {
      const match = /^order\s+by\s+/i.exec(value.slice(index))!;
      const order = value.slice(index + match[0].length).trim();
      if (!order || order.length > 1024) throw new Error('Invalid Jira JQL ordering');
      return { filter: value.slice(0, index).trim(), order };
    }
  }
  return { filter: value.trim(), order: 'priority ASC, created ASC, id ASC' };
}
function queryFor(settings: JiraSettings, project: string, state: TaskSnapshotV1['state'] | null): string {
  const clauses = [`project = ${quote(project)}`];
  const configured = splitJql(settings.jql);
  if (configured.filter) clauses.push(`(${configured.filter})`);
  if (settings.assignee) clauses.push(settings.assignee === 'currentUser()' ? 'assignee = currentUser()' : `assignee = ${quote(settings.assignee)}`);
  if (state === 'ready') clauses.push(`status in (${settings.readyStatuses.map(quote).join(', ')})`);
  else if (state === 'in_progress') clauses.push(`status = ${quote(settings.progressStatus)}`);
  else if (state === 'review') clauses.push(`status = ${quote(settings.reviewStatus)}`);
  else if (state === 'done') clauses.push('statusCategory = Done');
  else if (state === 'blocked') clauses.push('status = "Blocked"');
  return `${clauses.join(' AND ')} ORDER BY ${configured.order}`;
}
async function identify(context: SourceCallContextV1): Promise<SourceIdentityEvidenceV1> {
  context.signal.throwIfAborted();
  if (!context.http) throw new Error('Jira connection is unavailable');
  const subject = await probeJiraSubject(context.http, context.signal);
  const cloud = await probeJiraIdentity(context.http, context.signal);
  const authority = cloud ? { protocol: JIRA_AUTHORITY_PROTOCOL, authorityId: cloud.cloudId, identityFormat: JIRA_IDENTITY_FORMAT } : null;
  const expected = context.instance.authority;
  if (expected && (!authority || expected.protocol !== authority.protocol || expected.authorityId !== authority.authorityId || expected.identityFormat !== authority.identityFormat)) throw new Error('Pinned Jira authority could not be verified');
  return { version: 1, level: authority ? 'verified' : 'operator-seeded', authority, verifiedAt: new Date().toISOString(), proof: { accountId: subject.accountId, cloudId: cloud?.cloudId ?? null } };
}
export const jiraProvider: TaskSourceProviderV1 = {
  identify,
  async list(input, context) {
    const { settings, http, repo, project } = access(context, input?.repo);
    if (!input || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
      || input.cursor !== null && !jiraText(input.cursor, 2048)) throw new Error('Invalid Jira listing request');
    const query: Record<string, string> = { jql: queryFor(settings, project, input.state), fields: '*all', expand: 'names', maxResults: String(input.limit) };
    if (input.cursor) query.nextPageToken = input.cursor;
    const response = await jiraGet(http, context.signal, '/rest/api/3/search/jql', query);
    if (response.status !== 200) throw new Error(`Jira search failed (${response.status})`);
    const page = jiraRecord(response.body);
    const issues = jiraArray(page?.issues, input.limit);
    const cursor = page?.nextPageToken ?? null;
    if (cursor !== null && !jiraText(cursor, 2048) || cursor !== null && cursor === input.cursor
      || page?.isLast !== undefined && typeof page.isLast !== 'boolean' || page?.isLast === false && cursor === null
      || page?.isLast === true && cursor !== null) throw new Error('Malformed Jira pagination');
    const seen = new Set<string>();
    const items = issues.map(issue => {
      const record = jiraRecord(issue);
      const task = snapshot({ ...record, ...(record?.names === undefined && page?.names !== undefined ? { names: page.names } : {}) } as PluginJson, context, repo);
      if (seen.has(task.ref.externalId)) throw new Error('Duplicate Jira issue in page');
      seen.add(task.ref.externalId);
      return task;
    }).filter(task => input.state === null || task.state === input.state);
    return { items, nextCursor: cursor as string | null };
  },
  async lookup(input, context) {
    if (!jiraText(input?.displayKey, 128) || !/^[a-z][a-z\d_]*-\d+$/i.test(input.displayKey)) throw new Error('Invalid Jira display key');
    return (await loadIssue(input.displayKey, context))?.ref ?? null;
  },
  async load(ref, context) {
    assertRef(ref, context);
    const task = await loadIssue(ref.externalId, context);
    if (task && task.ref.externalId !== ref.externalId) throw new Error('Jira immutable issue identity changed');
    return task;
  },
  async planClaim(input, context) {
    const { settings, http, repo } = access(context);
    assertRef(input?.task?.ref, context);
    if (input.expectedInstanceRevision !== context.instance.revision || input.task.repo !== repo) throw new Error('Jira source instance changed before claim');
    const task = await jiraProvider.load(input.task.ref, context);
    if (!task || !sameTask(task, input.task)) throw new Error('Jira task changed or is no longer ready');
    const state = metadata(task);
    const retryClaimed = Boolean(input.retryOf) && task.state === 'in_progress' && state.accountId === settings.assigneeAccountId && state.statusName.toLowerCase() === settings.progressStatus.toLowerCase();
    if (task.state !== 'ready' && !retryClaimed) throw new Error('Jira task changed or is no longer ready');
    const target = { sourceId: task.ref.sourceId, issueId: task.ref.externalId };
    const effects: Extract<SourceMutationPlanV1, { kind: 'remote-effects' }>['effects'][number][] = [];
    if (state.accountId !== settings.assigneeAccountId) effects.push({ localId: 'assign', handler: 'assign', target,
      payload: { accountId: settings.assigneeAccountId, expectedAccountId: state.accountId, expectedStatusId: state.statusId }, after: [] });
    const transition = retryClaimed ? { id: 'already-current', statusId: state.statusId, statusName: state.statusName }
      : await findJiraTransition(http, context.signal, task.ref.externalId, settings.progressStatus);
    effects.push({ localId: 'progress', handler: 'transition', target, payload: { expectedAccountId: settings.assigneeAccountId,
      expectedStatusId: state.statusId, transitionId: transition.id, statusId: transition.statusId, statusName: transition.statusName }, after: effects.length ? ['assign'] : [] });
    return { kind: 'remote-effects', effects };
  },
  async planCompletion(input, context) {
    const { settings, http, repo } = access(context);
    assertRef(input?.task?.ref, context);
    if (input.task.repo !== repo || input.claimReceipt?.ref.sourceId !== input.task.ref.sourceId || input.claimReceipt.ref.externalId !== input.task.ref.externalId
      || input.claimReceipt.runId !== input.runId) throw new Error('Jira completion ownership does not match');
    if (input.outcome !== 'succeeded' || !input.publication) return { kind: 'none', reason: 'Jira review requires a successful publication.' };
    if (input.publication.repo !== repo || !Number.isSafeInteger(input.publication.prNumber) || input.publication.prNumber < 1) throw new Error('Jira publication scope does not match');
    const progress = input.claimReceipt.operations.map(operation => jiraRecord(operation.receipt)).filter(receipt => receipt?.kind === 'transition');
    if (progress.length !== 1 || !jiraText(progress[0]?.statusId, 128) || progress[0]?.issueId !== input.task.ref.externalId
      || progress[0]?.accountId !== settings.assigneeAccountId) throw new Error('Acknowledged Jira progress claim is unavailable');
    const task = await jiraProvider.load(input.task.ref, context);
    if (!task) throw new Error('Claimed Jira issue is unavailable');
    const state = metadata(task);
    if (state.accountId !== settings.assigneeAccountId) throw new Error('Jira assignment changed after claim');
    if (state.statusName.toLowerCase() === settings.reviewStatus.toLowerCase()) return { kind: 'none', reason: 'Jira is already in review.' };
    if (state.statusId !== progress[0]?.statusId) throw new Error('Jira status changed after claim');
    const transition = await findJiraTransition(http, context.signal, task.ref.externalId, settings.reviewStatus);
    return { kind: 'remote-effects', effects: [{ localId: 'review', handler: 'transition', target: { sourceId: task.ref.sourceId, issueId: task.ref.externalId },
      payload: { expectedAccountId: settings.assigneeAccountId, expectedStatusId: state.statusId, transitionId: transition.id, statusId: transition.statusId, statusName: transition.statusName }, after: [] }] };
  },
  async planAbort(input, context) {
    access(context);
    assertRef(input?.task?.ref, context);
    if (input.task.repo !== context.repo) throw new Error('Jira abort scope does not match');
    if (!input.claimReceipt && input.claimSteps.every(step => step.state === 'unsent')) return { kind: 'none', reason: 'No Jira claim step was sent.' };
    return { kind: 'remote-effects', effects: [{ localId: 'retain', handler: 'retain-claim', target: { sourceId: input.task.ref.sourceId, issueId: input.task.ref.externalId },
      payload: { admissionId: input.admissionId, runId: input.runId, reason: input.reason }, after: [] }] };
  },
  async validateAdoption(input, context) {
    const authority = await identify(context);
    const matchesAuthority = authority.level === 'verified' && authority.authority?.protocol === input.expectedAuthority.protocol
      && authority.authority.authorityId === input.expectedAuthority.authorityId && authority.authority.identityFormat === input.expectedAuthority.identityFormat;
    const compatible = matchesAuthority && input.sourceId === context.instance.sourceId && input.identityFormat === JIRA_IDENTITY_FORMAT && input.storageSchema === null;
    const probeResults = [];
    if (compatible) for (const probe of input.probes) {
      assertRef(probe.ref, context);
      const settings = jiraSettings(context.instance.settings);
      const response = await jiraGet(context.http!, context.signal, `/rest/api/3/issue/${probe.ref.externalId}`, { fields: '*all', expand: 'names' });
      if (response.status !== 200 && response.status !== 404) throw new Error(`Jira adoption probe failed (${response.status})`);
      const task = response.status === 200 ? normalizeJiraIssue(response.body) : null;
      const projects = context.instance.allowedRepos.map(repo => settings.projectByRepo[repo] ?? settings.project);
      const matches = task?.externalId === probe.ref.externalId && task.revision === probe.revision && projects.some(project => project.toLowerCase() === task.providerData.projectKey.toLowerCase());
      probeResults.push({ ref: probe.ref, matches, evidence: { observedRevision: task?.revision ?? null } });
    }
    return { compatible: compatible && probeResults.every(probe => probe.matches), authority, identityFormat: JIRA_IDENTITY_FORMAT, readableSchemas: [], probeResults,
      diagnostic: compatible && probeResults.every(probe => probe.matches) ? null : 'Jira adoption requires matching verified authority, issue identities, and revisions.' };
  },
  effects: jiraEffects,
};
