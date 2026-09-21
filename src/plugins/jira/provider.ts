import type { TaskHistoryQueryV1, TaskHistoryV1, TaskHistoryEventV1, PluginJson, SourceCallContextV1, SourceIdentityEvidenceV1, SourceMutationPlanV1, TaskSnapshotV1, TaskSourceProviderV1, WorkRefV1 } from '@helmsman/plugin-sdk';
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
function assignedTo(fields: Record<string, unknown> | null, task: TaskSnapshotV1, assignee: string, accountId: string): boolean {
  const actor = metadata(task).accountId;
  if (actor === null) return false;
  if (actor === accountId) return true;
  if (assignee === 'currentUser()') return false;
  const person = jiraRecord(fields?.assignee);
  const identities = [person?.name, person?.key, person?.emailAddress].filter((value): value is string => jiraText(value, 320));
  if (!identities.length) throw new Error('The configured Jira assignee cannot be verified from the available account identity');
  return identities.some(value => value.toLowerCase() === assignee.toLowerCase());
}
function historyTime(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new Error('Jira history timestamp unavailable');
  return new Date(value).toISOString();
}
async function jiraHistory(input: TaskHistoryQueryV1, context: SourceCallContextV1): Promise<TaskHistoryV1> {
  const { settings, http, repo, project } = access(context, input?.repo);
  const from = historyTime(input?.from); const until = historyTime(input?.until);
  if (from !== new Date(Date.parse(`${until.slice(0, 10)}T00:00:00.000Z`) - 6 * 86_400_000).toISOString()
    || !Number.isSafeInteger(input.eventLimit) || input.eventLimit < 1 || input.eventLimit > 50) throw new Error('Invalid Jira history query');
  const assignee = settings.assignee || 'currentUser()';
  const accountId = assignee === 'currentUser()' ? (await probeJiraSubject(http, context.signal)).accountId : assignee;
  const earliest = new Date(Date.parse(from) - 86_400_000).toISOString().slice(0, 10);
  const jql = `project = ${quote(project)} AND assignee = ${assignee === 'currentUser()' ? assignee : quote(assignee)} AND (status in (${quote(settings.progressStatus)}, ${quote(settings.reviewStatus)}) OR statusCategory = Done) AND updated >= ${quote(earliest)} ORDER BY updated DESC, id ASC`;
  const events: TaskHistoryEventV1[] = []; const days = Array.from({ length: 7 }, (_, index) => ({ date: new Date(Date.parse(from) + index * 86_400_000).toISOString().slice(0, 10), completed: 0 }));
  const issues: TaskSnapshotV1[] = []; const seen = new Set<string>(); const cursors = new Set<string>(); let cursor: string | null = null; let countsComplete = true; let historiesComplete = true;
  for (let index = 0; index < 10; index++) {
    const response = await jiraGet(http, context.signal, '/rest/api/3/search/jql', { jql, fields: '*all', expand: 'names', maxResults: '100', ...(cursor ? { nextPageToken: cursor } : {}) });
    if (response.status !== 200) throw new Error('Jira history search unavailable');
    const page = jiraRecord(response.body); const values = jiraArray(page?.issues, 100); const next = page?.nextPageToken ?? null;
    if (next !== null && (!jiraText(next, 2048) || cursors.has(next)) || page?.isLast !== undefined && typeof page.isLast !== 'boolean'
      || page?.isLast === false && next === null || page?.isLast === true && next !== null) throw new Error('Malformed Jira history pagination');
    for (const raw of values) {
      const issue = jiraRecord(raw); const fields = jiraRecord(issue?.fields);
      const task = snapshot({ ...issue, ...(issue?.names === undefined && page?.names !== undefined ? { names: page.names } : {}) } as PluginJson, context, repo);
      if (seen.has(task.ref.externalId)) throw new Error('Duplicate Jira history identity'); seen.add(task.ref.externalId);
      if (!assignedTo(fields, task, assignee, accountId) || !['in_progress', 'review', 'done'].includes(task.state)) continue;
      const updated = historyTime(fields?.updated); if (updated < from) continue;
      issues.push(task);
      if (task.state === 'done') {
        if (fields?.resolutiondate === null || fields?.resolutiondate === undefined) countsComplete = false;
        else {
          const completedAt = historyTime(fields.resolutiondate);
          if (completedAt >= from && completedAt <= until) { const day = days.find(day => day.date === completedAt.slice(0, 10)); if (day) day.completed++; }
        }
      }
    }
    cursor = next as string | null; if (cursor === null) break; cursors.add(cursor);
  }
  if (cursor !== null) { countsComplete = false; historiesComplete = false; }
  if (issues.length > 50) historiesComplete = false;
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, issues.length) }, async () => {
    while (index < Math.min(50, issues.length)) {
      const task = issues[index++]!;
      try {
        const response = await jiraGet(http, context.signal, `/rest/api/3/issue/${task.ref.externalId}`, { fields: 'summary,project,assignee,status,updated', expand: 'changelog' });
        if (response.status !== 200) throw new Error('Jira task history unavailable');
        const issue = jiraRecord(response.body); const fields = jiraRecord(issue?.fields); const projectKey = jiraRecord(fields?.project)?.key;
        if (issue?.id !== task.ref.externalId || typeof projectKey !== 'string' || projectKey.toLowerCase() !== project.toLowerCase()) throw new Error('Jira task history scope changed');
        const actor = jiraRecord(fields?.assignee)?.accountId;
        const taskActor = metadata(task).accountId;
        if (actor !== taskActor || historyTime(fields?.updated) !== historyTime(task.revision)) throw new Error('Jira task changed during history read');
        const changelog = jiraRecord(issue?.changelog); const histories = jiraArray(changelog?.histories, 100);
        if (typeof changelog?.total !== 'number' || !Number.isSafeInteger(changelog.total) || changelog.total < histories.length
          || changelog.startAt !== 0 || changelog.total !== histories.length) historiesComplete = false;
        const ids = new Set<string>();
        for (const raw of histories) {
          const history = jiraRecord(raw); const at = historyTime(history?.created);
          if (!jiraText(history?.id, 128) || ids.has(history.id)) throw new Error('Malformed Jira history identity'); ids.add(history.id);
          const changes = jiraArray(history.items, 100);
          for (let item = 0; item < changes.length; item++) {
            const change = jiraRecord(changes[item]); if (change?.field !== 'status') continue;
            if (!jiraText(change.toString, 240)) throw new Error('Malformed Jira status history');
            if (at < from || at > until) continue;
            events.push({ id: `${history.id}:${item}`, ref: task.ref, displayKey: task.displayKey, title: task.title, url: task.url, at, kind: 'status-changed', status: change['toString'] as string });
            if (events.length > input.eventLimit) { historiesComplete = false; events.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).pop(); }
          }
        }
      } catch { context.signal.throwIfAborted(); historiesComplete = false; }
    }
  }));
  context.signal.throwIfAborted();
  if (events.length > input.eventLimit) historiesComplete = false;
  return { version: 1, repo, from, until, events: events.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, input.eventLimit),
    historyQuality: historiesComplete ? 'complete' : 'partial', days: days.map(day => ({ ...day, completed: countsComplete ? day.completed : null })), throughputQuality: countsComplete ? 'complete' : 'partial' };
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
  identify, readHistory: jiraHistory,
  async listUnderway(input, context) {
    const { settings, http, repo, project } = access(context, input?.repo);
    if (!input || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
      || input.cursor !== null && !jiraText(input.cursor, 2048)) throw new Error('Invalid Jira Underway query');
    const assignee = settings.assignee || 'currentUser()';
    const accountId = assignee === 'currentUser()' ? (await probeJiraSubject(http, context.signal)).accountId : assignee;
    let token: string | null = null;
    if (input.cursor !== null) {
      let cursor: Record<string, unknown> | null;
      try { cursor = jiraRecord(JSON.parse(input.cursor)); } catch { throw new Error('Invalid Jira Underway cursor'); }
      if (!cursor || cursor.view !== 'underway' || cursor.repo !== repo || cursor.instance !== context.instance.id
        || cursor.revision !== context.instance.revision || cursor.accountId !== accountId || !jiraText(cursor.token, 2048)) throw new Error('Jira Underway selection changed');
      token = cursor.token;
    }
    const jql = `project = ${quote(project)} AND assignee = ${assignee === 'currentUser()' ? assignee : quote(assignee)} AND statusCategory != Done ORDER BY status ASC, priority ASC`;
    const response = await jiraGet(http, context.signal, '/rest/api/3/search/jql', { jql, fields: '*all', expand: 'names', maxResults: String(input.limit), ...(token ? { nextPageToken: token } : {}) });
    if (response.status !== 200) throw new Error(`Jira Underway search failed (${response.status})`);
    const page = jiraRecord(response.body); const issues = jiraArray(page?.issues, input.limit); const next = page?.nextPageToken ?? null;
    if (next !== null && (!jiraText(next, 2048) || next === token) || page?.isLast !== undefined && typeof page.isLast !== 'boolean'
      || page?.isLast === false && next === null || page?.isLast === true && next !== null) throw new Error('Malformed Jira Underway pagination');
    const seen = new Set<string>();
    const items = issues.flatMap(issue => {
      const record = jiraRecord(issue); const fields = jiraRecord(record?.fields); const status = jiraRecord(fields?.status);
      const category = jiraRecord(status?.statusCategory)?.key;
      const task = snapshot({ ...record, ...(record?.names === undefined && page?.names !== undefined ? { names: page.names } : {}) } as PluginJson, context, repo);
      if (seen.has(task.ref.externalId)) throw new Error('Duplicate Jira issue in Underway page'); seen.add(task.ref.externalId);
      if (category === 'done' || task.state === 'done') return [];
      return assignedTo(fields, task, assignee, accountId) ? [task] : [];
    });
    const nextCursor = next === null ? null : JSON.stringify({ view: 'underway', repo, instance: context.instance.id, revision: context.instance.revision, accountId, token: next });
    if (nextCursor && nextCursor.length > 2048) throw new Error('Jira Underway cursor exceeds its limit');
    return { items, nextCursor };
  },
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
