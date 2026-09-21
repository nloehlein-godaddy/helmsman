import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginJson, SourceCallContextV1, SourceInstanceV1, TaskTriageQueryV1 } from '@helmsman/plugin-sdk';
import { jiraIssue } from './fixtures';
import { jiraProvider } from './provider';
import { parseTaskBugsReportV1, parseTaskTriagePageV1 } from '../task-views';

const repo = 'owner/repo'; const sourceId = '11111111-1111-4111-8111-111111111111'; const asOf = '2026-09-20T12:00:00.000Z';
const triage: TaskTriageQueryV1 = { repo, group: 'unassigned-todo', priorities: [0, 1, 2, 3, 4], updatedSince: null, until: asOf, cursor: null, limit: 2 };
const bugs = { repo, asOf, rowLimit: 2 };
function issue(id: number, fields: Record<string, unknown> = {}) {
  return { ...jiraIssue({ created: '2026-09-10T00:00:00.000Z', issuetype: { name: 'Bug' }, customfield_14808: { value: 'Critical' }, duedate: '2026-09-19', ...fields }), id: String(id), key: `TASK-${id}` } as PluginJson;
}
function fixture(settings: Record<string, PluginJson> = {}) {
  const instance: SourceInstanceV1 = { version: 1, id: 'jira-main', sourceId, label: 'Jira', revision: 1, desiredEnabled: true, identityLevel: 'operator-seeded', authority: null,
    binding: { providerId: 'example.jira/issues', pluginId: 'example.jira', artifactHash: 'a'.repeat(64), contractVersion: 1, connectionId: 'connection', credentialHandle: 'credential' },
    settings: { baseUrl: 'https://jira.example.com', project: 'TASK', assigneeAccountId: 'bot', ...settings }, allowedRepos: [repo] };
  const get = vi.fn(async (_input: { path: string; query: Readonly<Record<string, string>> }): Promise<{ status: number; body: PluginJson }> => ({ status: 200, body: { issues: [issue(1)], isLast: true } }));
  const query = vi.fn(async (_input: unknown): Promise<{ status: number; body: PluginJson }> => ({ status: 200, body: { count: 25000 } }));
  const controller = new AbortController();
  const context: SourceCallContextV1 = { instance, repo, signal: controller.signal, local: null, http: { get, query } };
  return { instance, context, controller, get, query };
}
describe('Jira Triage provider view', () => {
  it('separates configured statuses from queue JQL and filters before the returned page boundary', async () => {
    const f = fixture({ backlogStatus: 'Incoming', todoStatus: 'Approved', jql: 'labels = only-queue', readyStatuses: ['Incoming', 'Approved'] });
    const status = { id: '1', name: 'Approved', statusCategory: { key: 'new' } };
    f.get.mockResolvedValueOnce({ status: 200, body: { issues: [issue(1, { status, priority: { name: 'P4' } }), issue(2, { status, updated: '2026-08-01T00:00:00.000Z' })], isLast: false, nextPageToken: 'page2' } });
    f.get.mockResolvedValueOnce({ status: 200, body: { issues: [issue(3, { status }), issue(4, { status })], isLast: true } });
    const input = { ...triage, priorities: [1], updatedSince: '2026-09-19T00:00:00.000Z' };
    const result = parseTaskTriagePageV1(await jiraProvider.listTriage!(input, f.context), input, sourceId);
    expect(result.items.map(task => task.ref.externalId)).toEqual(['3', '4']); expect(result.quality).toBe('complete');
    expect(f.get.mock.calls[0]?.[0].query.jql).toContain('status = "Approved"');
    expect(f.get.mock.calls[0]?.[0].query.jql).not.toContain('only-queue'); expect(f.get).toHaveBeenCalledTimes(2);
  });
  it('binds continuation to scope, filters, actor and source revision', async () => {
    const f = fixture(); f.get.mockResolvedValue({ status: 200, body: { issues: [issue(1)], isLast: false, nextPageToken: 'more' } });
    const input = { ...triage, limit: 1 }; const page = await jiraProvider.listTriage!(input, f.context);
    for (const changed of [{ ...input, priorities: [2] }, { ...input, until: '2026-09-21T00:00:00.000Z' }, { ...input, group: 'unassigned-backlog' as const }]) {
      await expect(jiraProvider.listTriage!({ ...changed, cursor: page.nextCursor }, f.context)).rejects.toThrow('selection changed');
    }
    await expect(jiraProvider.listTriage!({ ...input, cursor: page.nextCursor }, { ...f.context, instance: { ...f.instance, revision: 2 } })).rejects.toThrow('selection changed');
    expect(f.get).toHaveBeenCalledOnce();
  });
  it('keeps a bounded continuation when filtered records exhaust the scan budget', async () => {
    const f = fixture(); let next = 0;
    f.get.mockImplementation(async () => ({ status: 200, body: { issues: [issue(++next, { priority: { name: 'P4' } })], isLast: false, nextPageToken: `page-${next}` } }));
    const result = await jiraProvider.listTriage!({ ...triage, priorities: [1] }, f.context);
    expect(result).toMatchObject({ items: [], quality: 'partial', nextCursor: expect.any(String) }); expect(f.get).toHaveBeenCalledTimes(10);
  });
  it('does not infer two named groups from an ambiguous custom readiness list', async () => {
    const f = fixture({ readyStatuses: ['One', 'Two', 'Three'] });
    expect(await jiraProvider.listTriage!(triage, f.context)).toMatchObject({ quality: 'unavailable', items: [] }); expect(f.get).not.toHaveBeenCalled();
  });
  it('retains independent group failure and validates assigned open ownership', async () => {
    const f = fixture({ assignee: 'mine' });
    f.get.mockImplementation(async input => input.query.jql?.includes('IS EMPTY') ? { status: 503, body: null }
      : { status: 200, body: { issues: [issue(1, { assignee: { accountId: 'mine' } })], isLast: true } });
    const results = await Promise.allSettled([jiraProvider.listTriage!(triage, f.context), jiraProvider.listTriage!({ ...triage, group: 'mine-open' }, f.context)]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
    f.get.mockResolvedValue({ status: 200, body: { issues: [issue(1, { assignee: { accountId: 'other', emailAddress: 'other' } })], isLast: true } });
    await expect(jiraProvider.listTriage!({ ...triage, group: 'mine-open' }, f.context)).rejects.toThrow('assignment scope');
  });
});
describe('Jira Bugs provider view', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date(asOf) }));
  afterEach(() => vi.useRealTimers());
  it('rejects historical query labels before reading current Jira counts', async () => {
    const f = fixture(); await expect(jiraProvider.readBugs!({ ...bugs, asOf: '2025-01-01T00:00:00.000Z' }, f.context)).rejects.toThrow('observation time');
    expect(f.query).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });
  it('does not call an unfinished empty oldest page complete', async () => {
    const f = fixture(); f.get.mockResolvedValue({ status: 200, body: { issues: [], isLast: false, nextPageToken: 'more' } });
    const result = parseTaskBugsReportV1(await jiraProvider.readBugs!(bugs, f.context), bugs, sourceId);
    expect(result.oldest).toBeNull(); expect(result.oldestQuality).toBe('partial');
  });
  it('does not coerce malformed provider scope fields into valid identities', async () => {
    const f = fixture(); f.get.mockResolvedValue({ status: 200, body: { issues: [issue(1, { project: { key: ['TASK'] } })], isLast: true } });
    const result = await jiraProvider.readBugs!(bugs, f.context); expect(result.rowsQuality).toBe('unavailable'); expect(result.oldestQuality).toBe('unavailable');
  });
  it('retains large-project approximate counts and independent actual rows, dates and sampled durations', async () => {
    const f = fixture();
    f.get.mockImplementation(async input => ({ status: 200, body: { issues: [issue(1, input.query.jql.includes('resolutiondate DESC')
      ? { status: { id: '9', name: 'Done', statusCategory: { key: 'done' } }, resolutiondate: '2026-09-20T00:00:00.000Z' } : {})], isLast: true } }));
    const result = parseTaskBugsReportV1(await jiraProvider.readBugs!(bugs, f.context), bugs, sourceId);
    expect(result.open).toEqual({ value: 25000, quality: 'approximate' }); expect(f.query).toHaveBeenCalledTimes(5);
    expect(result.rows[0]).toMatchObject({ ref: { sourceId, externalId: '1' }, severity: 'Critical', dueAt: '2026-09-19', url: 'https://jira.example.com/browse/TASK-1' });
    expect(result.resolutionP75).toMatchObject({ days: 10, sampleSize: 1, population: { value: 25000, quality: 'approximate' }, capped: true, quality: 'partial' });
  });
  it('preserves successful metrics when an independent count or detail read fails and never creates zeroes', async () => {
    const f = fixture(); f.query.mockResolvedValueOnce({ status: 200, body: {} });
    f.get.mockRejectedValue(new Error('Provider unavailable'));
    const result = parseTaskBugsReportV1(await jiraProvider.readBugs!(bugs, f.context), bugs, sourceId);
    expect(result.open).toEqual({ value: null, quality: 'unavailable' }); expect(result.completedLast7d).toEqual({ value: 25000, quality: 'approximate' });
    expect(result.rowsQuality).toBe('unavailable'); expect(result.oldestQuality).toBe('unavailable');
    expect(result.resolutionP75).toMatchObject({ days: null, sampleSize: 0, quality: 'unavailable' });
  });
  it('uses provider-owned bug type and severity policy and labels capped rows and samples', async () => {
    const f = fixture({ bugIssueType: 'Defect', bugSeverityField: 'customfield_123' });
    f.get.mockImplementation(async input => ({ status: 200, body: { issues: [issue(1, { issuetype: { name: 'Defect' }, customfield_123: 'Major',
      ...(input.query.jql.includes('resolutiondate DESC') ? { status: { id: '9', name: 'Done', statusCategory: { key: 'done' } }, resolutiondate: '2026-09-20T00:00:00.000Z' } : {}) })], isLast: false, nextPageToken: 'more' } }));
    const result = parseTaskBugsReportV1(await jiraProvider.readBugs!(bugs, f.context), bugs, sourceId);
    expect(result.rowsQuality).toBe('partial'); expect(result.rows[0]?.severity).toBe('Major');
    expect(result.resolutionP75).toMatchObject({ quality: 'partial', capped: true, sampleSize: 1 });
    expect(f.get.mock.calls.every(([input]) => input.query.jql.includes('issuetype = "Defect"'))).toBe(true);
  });
  it('rejects cross-project detail evidence without erasing other metric quality', async () => {
    const f = fixture(); f.get.mockResolvedValue({ status: 200, body: { issues: [issue(1, { project: { key: 'OTHER' } })], isLast: true } });
    const result = await jiraProvider.readBugs!(bugs, f.context); expect(result.rowsQuality).toBe('unavailable'); expect(result.oldest).toBe(null);
    expect(result.open.quality).toBe('approximate');
  });
  it('keeps cancellation observable rather than returning an unavailable empty report', async () => {
    const f = fixture(); f.query.mockImplementation(async () => { f.controller.abort(); throw new Error('Cancelled'); });
    await expect(jiraProvider.readBugs!(bugs, f.context)).rejects.toThrow();
  });
});
