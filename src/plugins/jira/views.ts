import type { PluginJson, SourceCallContextV1, SourceReadHttpV1, TaskSnapshotV1, TaskTriageQueryV1, TaskTriagePageV1,
  TaskBugsQueryV1, TaskBugsReportV1, TaskBugCountV1, TaskBugRowV1 } from '@helmsman/plugin-sdk';
import { jiraArray, jiraGet, probeJiraSubject } from './http.js';
import { jiraRecord, jiraText } from './normalize.js';

export interface JiraViewSettings {
  baseUrl: string; assignee: string; backlogStatus: string | null; todoStatus: string | null;
  bugIssueType: string; bugSeverityField: string;
}
interface JiraViewsDependencies {
  access(context: SourceCallContextV1, repo: string): { http: SourceReadHttpV1; settings: JiraViewSettings; repo: string; project: string };
  snapshot(body: PluginJson, context: SourceCallContextV1, repo: string): TaskSnapshotV1;
  assignedTo(fields: Record<string, unknown> | null, task: TaskSnapshotV1, assignee: string, accountId: string): boolean;
}
const quote = (value: string) => JSON.stringify(value);
const missingCount = (): TaskBugCountV1 => ({ value: null, quality: 'unavailable' });
function timestamp(value: unknown): string {
  if (!jiraText(value, 128) || !Number.isFinite(Date.parse(value))) throw new Error('Jira timestamp is unavailable');
  return new Date(value).toISOString();
}
function searchResult(body: PluginJson, limit: number) {
  const value = jiraRecord(body); const issues = jiraArray(value?.issues, limit); const token = value?.nextPageToken ?? null;
  if (token !== null && !jiraText(token, 2048) || typeof value?.isLast !== 'boolean'
    || value?.isLast === false && token === null || value?.isLast === true && token !== null) throw new Error('Jira pagination evidence is invalid');
  return { issues, token: token as string | null };
}
async function parallel<T>(calls: readonly (() => Promise<T>)[], signal: AbortSignal): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = []; let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, calls.length) }, async () => {
    while (index < calls.length) {
      signal.throwIfAborted(); const current = index++;
      try { results[current] = { status: 'fulfilled', value: await calls[current]!() }; }
      catch (reason) { signal.throwIfAborted(); results[current] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}
export function createJiraViews(deps: JiraViewsDependencies) {
  async function listTriage(input: TaskTriageQueryV1, context: SourceCallContextV1): Promise<TaskTriagePageV1> {
    const { http, settings, project } = deps.access(context, input.repo);
    if (!['unassigned-backlog', 'unassigned-todo', 'mine-open'].includes(input.group) || !Array.isArray(input.priorities)
      || input.priorities.length > 5 || input.priorities.some(value => !Number.isInteger(value) || value < 0 || value > 4)
      || new Set(input.priorities).size !== input.priorities.length || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
      || timestamp(input.until) !== input.until || input.updatedSince !== null && (timestamp(input.updatedSince) !== input.updatedSince || input.updatedSince > input.until)) throw new Error('Invalid Triage query');
    const status = input.group === 'unassigned-backlog' ? settings.backlogStatus : settings.todoStatus;
    const empty = (quality: TaskTriagePageV1['quality']): TaskTriagePageV1 => ({ version: 1, repo: input.repo, group: input.group, items: [], nextCursor: null, quality });
    if (input.group !== 'mine-open' && !status) return empty('unavailable');
    if (!input.priorities.length) return empty('complete');
    const assignee = settings.assignee || 'currentUser()';
    const accountId = input.group === 'mine-open' && assignee === 'currentUser()' ? (await probeJiraSubject(http, context.signal)).accountId : assignee;
    const selection = { view: 'triage', instanceId: context.instance.id, revision: context.instance.revision, repo: input.repo, group: input.group,
      priorities: [...input.priorities].sort(), updatedSince: input.updatedSince, until: input.until, accountId };
    let token: string | null = null;
    if (input.cursor !== null) {
      if (!jiraText(input.cursor, 8192)) throw new Error('Invalid Triage cursor');
      const saved = jiraRecord(JSON.parse(input.cursor));
      if (!saved || JSON.stringify(saved.selection) !== JSON.stringify(selection) || !jiraText(saved.token, 2048)) throw new Error('Triage selection changed');
      token = saved.token;
    }
    const jql = `project = ${quote(project)} AND ${input.group === 'mine-open'
      ? `assignee = ${assignee === 'currentUser()' ? assignee : quote(assignee)} AND statusCategory != Done`
      : `assignee IS EMPTY AND status = ${quote(status!)}`} ORDER BY priority ASC, id ASC`;
    const items: TaskTriagePageV1['items'][number][] = []; const seen = new Set<string>(); const cursors = new Set<string>();
    let partial = false;
    for (let page = 0; page < 10; page++) {
      context.signal.throwIfAborted(); const remaining = input.limit - items.length;
      const response = await jiraGet(http, context.signal, '/rest/api/3/search/jql', { jql, fields: '*all', expand: 'names', maxResults: String(remaining), ...(token ? { nextPageToken: token } : {}) });
      if (response.status !== 200) throw new Error('Jira Triage search unavailable');
      const result = searchResult(response.body, remaining);
      if (result.token !== null && (result.token === token || cursors.has(result.token))) throw new Error('Jira Triage cursor repeated');
      for (const raw of result.issues) {
        const issue = jiraRecord(raw); const fields = jiraRecord(issue?.fields); const task = deps.snapshot(raw, context, input.repo);
        if (seen.has(task.ref.externalId)) throw new Error('Jira Triage task repeated'); seen.add(task.ref.externalId);
        const statusName = jiraRecord(fields?.status)?.name; const statusCategory = jiraRecord(jiraRecord(fields?.status)?.statusCategory)?.key;
        if (input.group === 'mine-open') {
          if (statusCategory === 'done' || !deps.assignedTo(fields, task, assignee, accountId)) throw new Error('Jira Triage assignment scope changed');
        } else if (fields?.assignee !== null || typeof statusName !== 'string' || statusName.toLowerCase() !== status!.toLowerCase()) throw new Error('Jira Triage status scope changed');
        const updatedAt = timestamp(fields?.updated);
        if (updatedAt > input.until || input.updatedSince !== null && updatedAt < input.updatedSince || !input.priorities.includes(task.priority ?? -1)) continue;
        items.push({ ref: task.ref, revision: task.revision, displayKey: task.displayKey, title: task.title, url: task.url,
          state: task.state, priority: task.priority!, updatedAt });
      }
      token = result.token;
      if (token === null || items.length === input.limit) break;
      cursors.add(token); if (page === 9) partial = true;
    }
    return { version: 1, repo: input.repo, group: input.group, items,
      nextCursor: token === null ? null : JSON.stringify({ selection, token }), quality: partial ? 'partial' : 'complete' };
  }
  async function readBugs(input: TaskBugsQueryV1, context: SourceCallContextV1): Promise<TaskBugsReportV1> {
    const { http, settings, project } = deps.access(context, input.repo);
    if (timestamp(input.asOf) !== input.asOf || !Number.isInteger(input.rowLimit) || input.rowLimit < 1 || input.rowLimit > 100) throw new Error('Invalid Bugs query');
    if (Math.abs(Date.now() - Date.parse(input.asOf)) > 300_000) throw new Error('Bugs observation time is stale');
    const base = `project = ${quote(project)} AND issuetype = ${quote(settings.bugIssueType)}`;
    const open = `${base} AND statusCategory != Done`;
    const recent = `${base} AND statusCategory = Done AND resolutiondate >= -90d`;
    const countQueries = [open, `${base} AND created >= -7d`, `${base} AND statusCategory = Done AND resolutiondate >= -7d`, `${open} AND duedate < now()`, recent];
    const counts = await parallel(countQueries.map(jql => async (): Promise<TaskBugCountV1> => {
      if (!http.query) return missingCount();
      const response = await http.query({ id: 'jira.approximate-count/v1', input: { jql } });
      context.signal.throwIfAborted(); const count = jiraRecord(response?.body)?.count;
      if (response?.status !== 200 || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Jira approximate count unavailable');
      return { value: count, quality: 'approximate' };
    }), context.signal);
    const countAt = (index: number) => { const result = counts[index]; return result?.status === 'fulfilled' ? result.value : missingCount(); };
    async function search(jql: string, limit: number) {
      const response = await jiraGet(http, context.signal, '/rest/api/3/search/jql', { jql,
        fields: `summary,project,issuetype,priority,duedate,created,resolutiondate,status,updated,${settings.bugSeverityField}`, maxResults: String(limit) });
      if (response.status !== 200) throw new Error('Jira Bugs search unavailable');
      const page = searchResult(response.body, limit); const seen = new Set<string>();
      const issues = page.issues.map(raw => {
        const issue = jiraRecord(raw); const fields = jiraRecord(issue?.fields);
        const projectKey = jiraRecord(fields?.project)?.key; const issueType = jiraRecord(fields?.issuetype)?.name;
        const category = jiraRecord(jiraRecord(fields?.status)?.statusCategory)?.key;
        if (!issue || !fields || !jiraText(issue.id, 64) || !/^[1-9]\d*$/.test(issue.id) || !jiraText(issue.key, 128) || !/^[a-z][a-z\d_]*-\d+$/i.test(issue.key)
          || !jiraText(fields.summary, 240) || typeof projectKey !== 'string' || projectKey.toLowerCase() !== project.toLowerCase()
          || typeof issueType !== 'string' || issueType.toLowerCase() !== settings.bugIssueType.toLowerCase()
          || typeof category !== 'string' || !['new', 'indeterminate', 'done'].includes(category)
          || seen.has(issue.id)) throw new Error('Jira Bugs issue is outside the configured scope');
        seen.add(issue.id);
        const createdAt = timestamp(fields.created); if (createdAt > input.asOf) throw new Error('Jira Bugs creation timestamp is invalid');
        return { fields, ref: { sourceId: context.instance.sourceId, externalId: issue.id }, displayKey: issue.key, title: fields.summary,
          url: `${settings.baseUrl}/browse/${encodeURIComponent(issue.key)}`, createdAt };
      });
      return { issues, token: page.token };
    }
    const details = await parallel<unknown>([
      async () => {
        const result = await search(`${open} ORDER BY priority DESC, duedate ASC, id ASC`, input.rowLimit);
        const rows: TaskBugRowV1[] = result.issues.map(issue => {
          if (jiraRecord(jiraRecord(issue.fields.status)?.statusCategory)?.key === 'done') throw new Error('Closed issue in open Bugs view');
          const dueAt = issue.fields.duedate ?? null; const priority = jiraRecord(issue.fields.priority)?.name ?? null;
          const severityValue = issue.fields[settings.bugSeverityField]; const severity = typeof severityValue === 'string' ? severityValue : jiraRecord(severityValue)?.value ?? null;
          if (dueAt !== null && (!jiraText(dueAt, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(dueAt) || !Number.isFinite(Date.parse(dueAt)) || new Date(dueAt).toISOString().slice(0, 10) !== dueAt)
            || priority !== null && !jiraText(priority, 128) || severity !== null && !jiraText(severity, 240)) throw new Error('Jira Bugs fields unavailable');
          return { ref: issue.ref, displayKey: issue.displayKey, title: issue.title, url: issue.url, createdAt: issue.createdAt,
            priority: priority as string | null, severity: severity as string | null, dueAt: dueAt as string | null };
        });
        return { rows, rowsQuality: result.token === null ? 'complete' : 'partial' };
      },
      async () => {
        const result = await search(`${open} ORDER BY created ASC, id ASC`, 1); const issue = result.issues[0];
        if (issue && jiraRecord(jiraRecord(issue.fields.status)?.statusCategory)?.key === 'done') throw new Error('Closed issue cannot be the oldest open bug');
        return { oldest: issue ? { ref: issue.ref, displayKey: issue.displayKey, url: issue.url, createdAt: issue.createdAt } : null,
          oldestQuality: !issue && result.token !== null ? 'partial' : 'complete' };
      },
      async () => {
        const result = await search(`${recent} ORDER BY resolutiondate DESC, id ASC`, 100); const durations: number[] = [];
        const population = countAt(4); const capped = result.token !== null || population.value !== null && population.value > result.issues.length;
        let partial = capped;
        for (const issue of result.issues) {
          try {
            const resolvedAt = timestamp(issue.fields.resolutiondate);
            if (resolvedAt > input.asOf || Date.parse(resolvedAt) < Date.parse(input.asOf) - 90 * 86_400_000 || resolvedAt < issue.createdAt
              || jiraRecord(jiraRecord(issue.fields.status)?.statusCategory)?.key !== 'done') throw new Error('Jira resolution evidence unavailable');
            durations.push(Math.round((Date.parse(resolvedAt) - Date.parse(issue.createdAt)) / 86_400_000));
          } catch { partial = true; }
        }
        durations.sort((a, b) => a - b); const rank = 0.75 * (durations.length - 1); const low = Math.floor(rank); const high = Math.ceil(rank);
        const days = durations.length ? Math.round((durations[low]! + (durations[high]! - durations[low]!) * (rank - low)) * 10) / 10 : null;
        return { days, sampleSize: durations.length, population, quality: partial ? 'partial' : 'complete', capped };
      },
    ], context.signal);
    const rows = details[0]?.status === 'fulfilled' ? details[0].value as Pick<TaskBugsReportV1, 'rows' | 'rowsQuality'> : { rows: [], rowsQuality: 'unavailable' as const };
    const oldest = details[1]?.status === 'fulfilled' ? details[1].value as Pick<TaskBugsReportV1, 'oldest' | 'oldestQuality'> : { oldest: null, oldestQuality: 'unavailable' as const };
    const resolutionP75 = details[2]?.status === 'fulfilled' ? details[2].value as TaskBugsReportV1['resolutionP75']
      : { days: null, sampleSize: 0, population: countAt(4), quality: 'unavailable' as const, capped: false };
    return { version: 1, repo: input.repo, asOf: input.asOf, open: countAt(0), createdLast7d: countAt(1), completedLast7d: countAt(2), pastSla: countAt(3), ...rows, ...oldest, resolutionP75 };
  }
  return { listTriage, readBugs };
}
