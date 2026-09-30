import { describe, expect, it } from 'vitest';
import type { PluginJson, SourceCallContextV1, SourceClaimReceiptV1, SourceInstanceV1, SourceMutationHttpV1, SourceMutationPlanV1, SourceEffectResultV1 } from '@helmsman/plugin-sdk';
import { parseSourceIdentityEvidenceV1, parseSourceMutationPlanV1, parseTaskSnapshotV1 } from '../tasks';
import { jiraIssue } from './fixtures';
import { jiraProvider, jiraSettings, JIRA_AUTHORITY_PROTOCOL, JIRA_IDENTITY_FORMAT } from './provider';
import { jiraEffects } from './effects';
import { probeJiraSubject } from './http';
import { parseSourceRemoteActionPlanV1 } from '../task-actions';
import type { SourceRemoteActionInputV1 } from '../task-actions';

const sourceId = '11111111-1111-4111-8111-111111111111';
const repo = 'owner/repo';
const authority = { protocol: JIRA_AUTHORITY_PROTOCOL, authorityId: 'cloud-123', identityFormat: JIRA_IDENTITY_FORMAT };
const declaration = { identityFormats: [JIRA_IDENTITY_FORMAT], effectIds: ['assign', 'transition', 'retain-claim'], commandIds: [], access: ['connection-http'] as const };
function fixture() {
  const controller = new AbortController();
  const instance: SourceInstanceV1 = { version: 1, id: 'jira-main', sourceId, label: 'Jira', revision: 1, desiredEnabled: true, identityLevel: 'verified', authority,
    binding: { providerId: 'helmsman.jira/issues', pluginId: 'helmsman.jira', artifactHash: 'a'.repeat(64), contractVersion: 1, connectionId: 'connection', credentialHandle: 'jira-credentials' },
    allowedRepos: [repo, 'owner/other'], settings: { baseUrl: 'https://jira.example.com', project: 'TASK', assigneeAccountId: 'bot' } };
  const calls: { method: string; path: string; query?: Readonly<Record<string, string>>; body?: PluginJson }[] = [];
  let issue = jiraIssue();
  let search: { status: number; body: PluginJson } | null = null;
  let identity: { status: number; body: PluginJson } = { status: 200, body: { cloudId: authority.authorityId } };
  let subject: { status: number; body: PluginJson } = { status: 200, body: { accountId: 'bot' } };
  let issueStatus = 200;
  let sendStatus = 204;
  let dropResponse = false;
  let transitionOverride: PluginJson | undefined;
  let afterGet: ((path: string) => void) | null = null;
  const http: SourceMutationHttpV1 = {
    async get(input) {
      calls.push({ method: 'GET', ...input });
      let result: { status: number; body: PluginJson };
      if (input.path === '/rest/api/3/myself') result = subject;
      else if (input.path === '/_edge/tenant_info') result = identity;
      else if (input.path === '/rest/api/3/search/jql') result = search ?? { status: 200, body: { issues: [issue as PluginJson], isLast: true } };
      else if (input.path.endsWith('/transitions')) result = { status: 200, body: transitionOverride ?? { transitions: [
        { id: '11', to: { id: '2', name: 'In Progress' } }, { id: '21', to: { id: '3', name: 'In Review' } },
      ] } };
      else result = { status: issueStatus, body: issue as PluginJson };
      afterGet?.(input.path);
      return result;
    },
    async send(input) {
      calls.push(input);
      if (sendStatus === 204) {
        if (input.method === 'PUT') issue = { ...issue, fields: { ...issue.fields, assignee: { accountId: (input.body as { accountId: string }).accountId } } };
        else {
          const review = JSON.stringify(input.body).includes('21');
          issue = { ...issue, fields: { ...issue.fields, status: { id: review ? '3' : '2', name: review ? 'In Review' : 'In Progress', statusCategory: { key: 'indeterminate' } } } };
        }
      }
      if (dropResponse) throw new Error('Lost connection');
      return { status: sendStatus, body: null };
    },
  };
  const context: SourceCallContextV1 = { instance, repo, signal: controller.signal, local: null, http: { get: input => http.get(input) } };
  const effectContext = { instance, signal: controller.signal, operationId: 'operation-1', generation: 1, http };
  return { controller, instance, context, effectContext, calls, http, get issue() { return issue; }, set issue(value) { issue = value; },
    set search(value: { status: number; body: PluginJson }) { search = value; }, set identity(value: typeof identity) { identity = value; }, set subject(value: typeof subject) { subject = value; },
    set issueStatus(value: number) { issueStatus = value; }, set sendStatus(value: number) { sendStatus = value; }, set dropResponse(value: boolean) { dropResponse = value; },
    set transitionOverride(value: PluginJson) { transitionOverride = value; }, set afterGet(value: (path: string) => void) { afterGet = value; } };
}
function remote(plan: SourceMutationPlanV1) { expect(plan.kind).toBe('remote-effects'); if (plan.kind !== 'remote-effects') throw new Error('Expected remote effects'); return plan.effects; }

describe('Jira Assign to me', () => {
  const request = (f: ReturnType<typeof fixture>): SourceRemoteActionInputV1 => ({ version: 1, action: 'assign-self', sourceRevision: 1,
    selection: { version: 1, sourceId, instanceId: f.instance.id, instanceRevision: 1, repo },
    target: { ref: { sourceId, externalId: '10001' }, repo, expectedRevision: f.issue.fields.updated } });
  async function prepare(f = fixture()) {
    f.subject = { status: 200, body: { accountId: 'signed-in-user' } };
    const input = request(f); const plan = await jiraProvider.prepareRemoteAction!(input, f.context);
    parseSourceRemoteActionPlanV1(plan, input);
    if (plan.kind !== 'effect') throw new Error('Expected assignment effect');
    return { f, plan };
  }
  it('uses the authenticated account and returns observed evidence after delivery', async () => {
    const { f, plan } = await prepare();
    expect(plan).toMatchObject({ effectId: 'assign', payload: { action: 'assign-self', accountId: 'signed-in-user', expectedAccountId: null, expectedStatusId: '1', expectedRevision: f.issue.fields.updated, repo, projectKey: 'TASK' }, receipt: { ref: request(f).target.ref, repo, accountId: 'signed-in-user' } });
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
    expect(await jiraEffects.assign!.invoke(plan, f.effectContext)).toMatchObject({ status: 'acknowledged', receipt: { result: { ref: request(f).target.ref, repo, revision: f.issue.fields.updated, accountId: 'signed-in-user' } } });
    expect(f.calls.filter(call => call.method !== 'GET')).toEqual([{ method: 'PUT', path: '/rest/api/3/issue/10001/assignee', body: { accountId: 'signed-in-user' } }]);
    expect((await jiraEffects.assign!.invoke(plan, f.effectContext)).status).toBe('acknowledged');
    expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
  });
  it('acknowledges already-self without writing and refuses another assignee', async () => {
    const f = fixture(); f.issue = jiraIssue({ assignee: { accountId: 'bot' } });
    expect(await jiraProvider.prepareRemoteAction!(request(f), f.context)).toMatchObject({ kind: 'acknowledged', result: { accountId: 'bot' } });
    f.issue = jiraIssue({ assignee: { accountId: 'someone-else' } });
    await expect(jiraProvider.prepareRemoteAction!(request(f), f.context)).rejects.toThrow('another user');
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('validates source, instance, repository, issue, project and revision before planning', async () => {
    const f = fixture(); const input = request(f);
    const invalid: SourceRemoteActionInputV1[] = [
      { ...input, sourceRevision: 2 },
      { ...input, selection: { ...input.selection, instanceId: 'another-instance' } },
      { ...input, selection: { ...input.selection, instanceRevision: 2 } },
      { ...input, selection: { ...input.selection, sourceId: 'another-source' } },
      { ...input, selection: { ...input.selection, repo: 'owner/other' } },
      { ...input, target: { ...input.target, ref: { sourceId: 'another-source', externalId: '10001' } } },
      { ...input, target: { ...input.target, ref: { sourceId, externalId: 'TASK-1' } } },
      { ...input, target: { ...input.target, repo: 'owner/other' } },
      { ...input, target: { ...input.target, expectedRevision: 'stale' } },
    ];
    for (const value of invalid) await expect(jiraProvider.prepareRemoteAction!(value, f.context)).rejects.toThrow();
    f.issue = { ...jiraIssue(), id: '10002' };
    await expect(jiraProvider.prepareRemoteAction!(input, f.context)).rejects.toThrow('changed');
    f.issue = jiraIssue({ project: { key: 'OTHER' } });
    await expect(jiraProvider.prepareRemoteAction!(input, f.context)).rejects.toThrow('project');
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('uses the mapped project during retained delivery', async () => {
    const f = fixture(); f.issue = jiraIssue({ project: { key: 'mapped' } });
    const instance = { ...f.instance, settings: { ...f.instance.settings, projectByRepo: { [repo]: 'MAPPED' } } };
    const plan = await jiraProvider.prepareRemoteAction!(request(f), { ...f.context, instance });
    if (plan.kind !== 'effect') throw new Error('Expected assignment effect');
    expect((await jiraEffects.assign!.invoke(plan, { ...f.effectContext, instance })).status).toBe('acknowledged');
    expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  });
  it('rejects changed actors without writing and leaves reconciliation uncertain', async () => {
    const { f, plan } = await prepare(); f.subject = { status: 200, body: { accountId: 'new-login' } };
    expect(await jiraEffects.assign!.invoke(plan, f.effectContext)).toMatchObject({ status: 'definitely-not-applied', retryable: false });
    expect((await jiraEffects.assign!.reconcile(plan, f.effectContext)).status).toBe('unknown');
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it.each([{ assignee: { accountId: 'another-user' } }, { updated: '2026-09-21T00:00:00.000Z' },
    { status: { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } } }, { project: { key: 'OTHER' } },
  ])('blocks changed task evidence before writing (%j)', async change => {
    const { f, plan } = await prepare(); f.issue = jiraIssue(change);
    expect(await jiraEffects.assign!.invoke(plan, f.effectContext)).toMatchObject({ status: 'definitely-not-applied', retryable: false });
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('reads fresh state after checking the actor', async () => {
    const { f, plan } = await prepare();
    f.afterGet = path => { if (path.endsWith('/myself')) f.issue = jiraIssue({ assignee: { accountId: 'another-user' } }); };
    expect(await jiraEffects.assign!.invoke(plan, f.effectContext)).toMatchObject({ status: 'definitely-not-applied', retryable: false });
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('reconciles lost write responses from observed state without replay', async () => {
    const { f, plan } = await prepare(); f.dropResponse = true;
    expect((await jiraEffects.assign!.invoke(plan, f.effectContext)).status).toBe('unknown');
    f.issue = jiraIssue({ updated: '2026-09-21T00:00:00.000Z', assignee: { accountId: 'signed-in-user' } });
    expect(await jiraEffects.assign!.reconcile(plan, f.effectContext)).toMatchObject({ status: 'acknowledged', receipt: { result: { revision: '2026-09-21T00:00:00.000Z', accountId: 'signed-in-user' } } });
    f.issue = jiraIssue(); expect((await jiraEffects.assign!.reconcile(plan, f.effectContext)).status).toBe('unknown');
    expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
  });
  it.each([[403, 'definitely-not-applied', false], [429, 'definitely-not-applied', true], [408, 'unknown', undefined], [503, 'unknown', undefined]])('classifies assignment HTTP %s', async (status, expected, retryable) => {
    const { f, plan } = await prepare(); f.sendStatus = Number(status);
    const result = await jiraEffects.assign!.invoke(plan, f.effectContext); expect(result.status).toBe(expected);
    if (result.status === 'definitely-not-applied') expect(result.retryable).toBe(retryable);
  });
  it('requires postwrite evidence and honors cancellation', async () => {
    const { f, plan } = await prepare(); const originalSend = f.http.send;
    f.http.send = async input => { const result = await originalSend(input); f.issueStatus = 503; return result; };
    expect((await jiraEffects.assign!.invoke(plan, f.effectContext)).status).toBe('unknown');
    const cancelled = await prepare(); cancelled.f.controller.abort();
    expect((await jiraEffects.assign!.invoke(cancelled.plan, cancelled.f.effectContext)).status).toBe('definitely-not-applied');
    await expect(jiraProvider.prepareRemoteAction!(request(cancelled.f), cancelled.f.context)).rejects.toThrow();
    expect(cancelled.f.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it.each([null, {}, { accountId: '' }, { accountId: 'signed-in-user', active: false }])('rejects invalid authenticated identity (%j)', async body => {
    const f = fixture(); f.subject = { status: 200, body: body as PluginJson };
    await expect(jiraProvider.prepareRemoteAction!(request(f), f.context)).rejects.toThrow();
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });
});

describe('Jira assigned unfinished view', () => {
  it('ignores queue JQL, includes assigned ready/blocked work, and excludes Done and other assignees', async () => {
    const f = fixture(); f.subject = { status: 200, body: { accountId: 'mine' } };
    const context = { ...f.context, instance: { ...f.instance, settings: { ...f.instance.settings, jql: 'status = Backlog ORDER BY updated DESC', assignee: 'currentUser()' } } };
    const issue = (id: string, name: string, category: string, actor = 'mine') => ({ ...jiraIssue({ assignee: { accountId: actor }, status: { id, name, statusCategory: { key: category } } }), id, key: `TASK-${id}` });
    f.search = { status: 200, body: { issues: [issue('1', 'To Do', 'new'), issue('2', 'Blocked', 'indeterminate'), issue('3', 'Done', 'done'), issue('4', 'In Progress', 'indeterminate', 'other')] as PluginJson, isLast: true } };
    const result = await jiraProvider.listUnderway!({ repo, cursor: null, limit: 10 }, context);
    expect(result.items.map(task => task.state)).toEqual(['ready', 'blocked']);
    expect(f.calls.at(-1)?.query?.jql).toBe('project = "TASK" AND assignee = currentUser() AND statusCategory != Done ORDER BY status ASC, priority ASC');
  });
  it.each([['emailAddress', 'person@example.com'], ['name', 'legacy-name'], ['key', 'legacy-key']])('preserves configured %s identity and fails explicitly when privacy prevents verification', async (field, value) => {
    const f = fixture(); const context = { ...f.context, instance: { ...f.instance, settings: { ...f.instance.settings, assignee: value } } };
    f.issue = jiraIssue({ assignee: { accountId: 'cloud-account', [field]: value } });
    expect((await jiraProvider.listUnderway!({ repo, cursor: null, limit: 10 }, context)).items).toHaveLength(1);
    f.issue = jiraIssue({ assignee: { accountId: 'cloud-account' } });
    await expect(jiraProvider.listUnderway!({ repo, cursor: null, limit: 10 }, context)).rejects.toThrow('cannot be verified');
  });
  it('binds cursors to the source revision and excludes normal-list tokens', async () => {
    const f = fixture(); const context = { ...f.context, instance: { ...f.instance, settings: { ...f.instance.settings, assignee: 'mine' } } };
    f.search = { status: 200, body: { issues: [jiraIssue({ assignee: { accountId: 'mine' } })] as PluginJson, isLast: false, nextPageToken: 'provider-token' } };
    const page = await jiraProvider.listUnderway!({ repo, cursor: null, limit: 10 }, context);
    await expect(jiraProvider.listUnderway!({ repo, cursor: 'provider-token', limit: 10 }, context)).rejects.toThrow('cursor');
    await expect(jiraProvider.listUnderway!({ repo, cursor: page.nextCursor, limit: 10 }, { ...context, instance: { ...context.instance, revision: 2 } })).rejects.toThrow('changed');
  });
  it('honors cancellation during actor resolution before searching any tasks', async () => {
    const f = fixture(); f.afterGet = path => { if (path === '/rest/api/3/myself') f.controller.abort(); };
    await expect(jiraProvider.listUnderway!({ repo, cursor: null, limit: 10 }, f.context)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls.some(call => call.path === '/rest/api/3/search/jql')).toBe(false);
  });
});
async function claim(f = fixture()) {
  const task = await jiraProvider.load({ sourceId, externalId: '10001' }, f.context);
  if (!task) throw new Error('Missing fixture task');
  const plan = await jiraProvider.planClaim({ admissionId: 'admission-1', runId: 'run-1', task, expectedInstanceRevision: 1, retryOf: null }, f.context);
  parseSourceMutationPlanV1(plan, { ref: task.ref, repo, effectIds: declaration.effectIds });
  return { f, task, plan, effects: remote(plan) };
}
function receipt(f: ReturnType<typeof fixture>, operations: { operationId: string; receipt: PluginJson }[]): SourceClaimReceiptV1 {
  return { version: 1, claimId: 'claim-1', ref: { sourceId, externalId: '10001' }, admissionId: 'admission-1', runId: 'run-1', revision: 1,
    binding: f.instance.binding, taskSnapshotHash: 'b'.repeat(64), localRecordRevision: null, operations };
}
async function applyClaim(value: Awaited<ReturnType<typeof claim>>) {
  const operations = [];
  for (const effect of value.effects) {
    const result = await jiraEffects[effect.handler]!.invoke(effect, value.f.effectContext);
    expect(result.status).toBe('acknowledged');
    if (result.status === 'acknowledged') operations.push({ operationId: effect.localId, receipt: result.receipt });
  }
  return receipt(value.f, operations);
}
describe('Jira public task source', () => {
  it('verifies cloud authority and authenticated subject without exposing credentials', async () => {
    const f = fixture();
    const evidence = await jiraProvider.identify(f.context);
    expect(parseSourceIdentityEvidenceV1(evidence)).toEqual(evidence);
    expect(evidence.authority).toEqual(authority);
    expect(evidence.proof).toEqual({ accountId: 'bot', cloudId: 'cloud-123' });
    expect(await probeJiraSubject(f.http, f.controller.signal)).toEqual({ accountId: 'bot' });
  });
  it('preserves operator-seeded sources when cloud identity is unavailable and refuses verified tenant drift', async () => {
    const f = fixture(); f.identity = { status: 404, body: null };
    const context = { ...f.context, instance: { ...f.instance, identityLevel: 'operator-seeded' as const, authority: null } };
    expect((await jiraProvider.identify(context)).level).toBe('operator-seeded');
    await expect(jiraProvider.identify(f.context)).rejects.toThrow('authority');
    f.identity = { status: 200, body: { cloudId: 'other-cloud' } };
    await expect(jiraProvider.identify(f.context)).rejects.toThrow('authority');
    f.subject = { status: 401, body: null };
    await expect(jiraProvider.identify(context)).rejects.toThrow('subject');
  });
  it('rejects malformed or disabled authenticated subjects', async () => {
    const f = fixture(); f.subject = { status: 200, body: { accountId: 'bot', active: false } };
    await expect(jiraProvider.identify(f.context)).rejects.toThrow('subject');
  });
  it('loads canonical numeric IDs and resolves renamed display aliases without changing work identity', async () => {
    const f = fixture(); const original = await jiraProvider.load({ sourceId, externalId: '10001' }, f.context);
    f.issue = { ...f.issue, key: 'TASK-99' };
    const task = await jiraProvider.load({ sourceId, externalId: '10001' }, f.context);
    expect(task?.ref).toEqual(original?.ref);
    expect(task?.displayKey).toBe('TASK-99');
    expect(parseTaskSnapshotV1(task)).toEqual(task);
    expect(await jiraProvider.lookup({ displayKey: 'TASK-99' }, f.context)).toEqual(task?.ref);
    expect(f.calls.at(-1)?.path).toBe('/rest/api/3/issue/TASK-99');
    await expect(jiraProvider.load({ sourceId, externalId: 'TASK-99' }, f.context)).rejects.toThrow('identity');
    f.issue = { ...f.issue, id: '10002' };
    await expect(jiraProvider.load({ sourceId, externalId: '10001' }, f.context)).rejects.toThrow('identity');
  });
  it('requires explicit allowed repository scope and checks project mappings on authoritative loads', async () => {
    const f = fixture(); const ref = { sourceId, externalId: '10001' };
    await expect(jiraProvider.load(ref, { ...f.context, repo: null })).rejects.toThrow('scope');
    await expect(jiraProvider.load(ref, { ...f.context, repo: 'owner/unallowed' })).rejects.toThrow('scope');
    const second = { ...f.context, repo: 'owner/other', instance: { ...f.instance, settings: { ...f.instance.settings, projectByRepo: { 'owner/other': 'OTHER' } } } };
    await expect(jiraProvider.load(ref, second)).rejects.toThrow('project scope');
    expect((await jiraProvider.load(ref, { ...f.context, repo: 'owner/other' }))?.repo).toBe('owner/other');
    await expect(jiraProvider.list({ repo: 'owner/other', state: null, cursor: null, limit: 10 }, f.context)).rejects.toThrow('scope');
  });
  it('carries pagination, normalizes global field names, and preserves configured JQL ordering', async () => {
    const f = fixture();
    f.search = { status: 200, body: { issues: [{ ...jiraIssue({ customfield_1: 'Must work' }), names: null } as PluginJson], nextPageToken: 'page-two', isLast: false } };
    const context = { ...f.context, instance: { ...f.instance, settings: { ...f.instance.settings, jql: 'summary ~ "order by relevance" ORDER BY updated DESC' } } };
    const first = await jiraProvider.list({ repo, state: 'ready', cursor: null, limit: 10 }, context);
    expect(first.nextCursor).toBe('page-two');
    expect(f.calls.at(-1)?.query?.jql).toBe('project = "TASK" AND (summary ~ "order by relevance") AND status in ("Backlog", "To Do") ORDER BY updated DESC');
    f.search = { status: 200, body: { issues: [], isLast: true } };
    expect(await jiraProvider.list({ repo, state: null, cursor: first.nextCursor, limit: 10 }, f.context)).toEqual({ items: [], nextCursor: null });
    expect(f.calls.at(-1)?.query?.nextPageToken).toBe('page-two');
  });
  it.each([
    null, {}, { issues: [null] }, { issues: [], isLast: false }, { issues: [], nextPageToken: 42 }, { issues: [], nextPageToken: 'x'.repeat(2049) },
    { issues: [jiraIssue(), jiraIssue()] }, { issues: [], isLast: true, nextPageToken: 'again' },
  ])('rejects malformed pages without partially returning work', async body => {
    const f = fixture(); f.search = { status: 200, body: body as PluginJson };
    await expect(jiraProvider.list({ repo, state: null, cursor: null, limit: 10 }, f.context)).rejects.toThrow();
  });
  it('rejects oversized/repeated pages, non-2xx, and missing identities', async () => {
    const f = fixture();
    f.search = { status: 200, body: { issues: [jiraIssue(), { ...jiraIssue(), id: '10002' }] as PluginJson } };
    await expect(jiraProvider.list({ repo, state: null, cursor: null, limit: 1 }, f.context)).rejects.toThrow();
    f.search = { status: 200, body: { issues: [], nextPageToken: 'again' } };
    await expect(jiraProvider.list({ repo, state: null, cursor: 'again', limit: 1 }, f.context)).rejects.toThrow('pagination');
    f.search = { status: 503, body: null };
    await expect(jiraProvider.list({ repo, state: null, cursor: null, limit: 1 }, f.context)).rejects.toThrow('503');
    f.issueStatus = 404; expect(await jiraProvider.load({ sourceId, externalId: '10001' }, f.context)).toBeNull();
    f.issueStatus = 403; await expect(jiraProvider.load({ sourceId, externalId: '10001' }, f.context)).rejects.toThrow('403');
  });
  it('rejects source credentials and does not expose mutation HTTP during planning', async () => {
    const f = fixture(); expect(() => jiraSettings({ ...f.instance.settings, apiToken: 'private' })).toThrow('credentials');
    await claim(f); expect(f.calls.every(call => call.method === 'GET')).toBe(true);
    expect('send' in f.context.http!).toBe(false);
  });
  it('honors cancellation before and after read results', async () => {
    const f = fixture(); f.afterGet = () => f.controller.abort();
    await expect(jiraProvider.load({ sourceId, externalId: '10001' }, f.context)).rejects.toThrow();
    const count = f.calls.length;
    await expect(jiraProvider.identify(f.context)).rejects.toThrow(); expect(f.calls).toHaveLength(count);
  });
  it('adopts only matching verified identity and exact numeric issue revisions across repository mappings', async () => {
    const f = fixture(); const input = { sourceId, expectedSourceRevision: 1, previousBinding: f.instance.binding, proposedBinding: f.instance.binding,
      expectedAuthority: authority, identityFormat: JIRA_IDENTITY_FORMAT, storageSchema: null, probes: [{ ref: { sourceId, externalId: '10001' }, revision: f.issue.fields.updated }] };
    expect((await jiraProvider.validateAdoption(input, { ...f.context, repo: null })).compatible).toBe(true);
    expect((await jiraProvider.validateAdoption({ ...input, probes: [{ ...input.probes[0]!, revision: 'old' }] }, f.context)).compatible).toBe(false);
    expect((await jiraProvider.validateAdoption({ ...input, expectedAuthority: { ...authority, authorityId: 'other' } }, f.context)).compatible).toBe(false);
    f.identity = { status: 404, body: null };
    expect((await jiraProvider.validateAdoption(input, { ...f.context, instance: { ...f.instance, authority: null, identityLevel: 'operator-seeded' } })).compatible).toBe(false);
  });
});
describe('Jira durable source effects', () => {
  it('acknowledges an explicitly retried bot-owned progress claim without another Jira mutation', async () => {
    const f = fixture();
    f.issue = jiraIssue({ assignee: { accountId: 'bot' }, status: { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } } });
    const task = await jiraProvider.load({ sourceId, externalId: '10001' }, f.context);
    if (!task) throw new Error('Missing fixture task');
    const input = { admissionId: 'retry-admission', runId: 'retry-run', task, expectedInstanceRevision: 1, retryOf: 'previous-run' };
    await expect(jiraProvider.planClaim({ ...input, retryOf: null }, f.context)).rejects.toThrow('no longer ready');
    const plan = await jiraProvider.planClaim(input, f.context);
    parseSourceMutationPlanV1(plan, { ref: task.ref, repo, effectIds: declaration.effectIds });
    const effects = remote(plan);
    expect(effects).toHaveLength(1);
    expect(await jiraEffects.transition!.invoke(effects[0]!, f.effectContext)).toMatchObject({ status: 'acknowledged', receipt: { kind: 'transition', issueId: '10001', statusId: '2', accountId: 'bot' } });
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
    f.issue = jiraIssue({ assignee: { accountId: 'another-user' }, status: { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } } });
    const otherTask = await jiraProvider.load(task.ref, f.context);
    if (!otherTask) throw new Error('Missing fixture task');
    await expect(jiraProvider.planClaim({ ...input, task: otherTask }, f.context)).rejects.toThrow('no longer ready');
  });
  it.each([['Queued', 'new', 'ready'], ['Building', 'indeterminate', 'in_progress'], ['Peer Review', 'indeterminate', 'review']])('uses configured %s status for normalized state', async (name, category, state) => {
    const f = fixture();
    f.issue = jiraIssue({ status: { id: 'custom', name, statusCategory: { key: category } } });
    const context = { ...f.context, instance: { ...f.instance, settings: { ...f.instance.settings, readyStatuses: ['Queued'], progressStatus: 'Building', reviewStatus: 'Peer Review' } } };
    expect((await jiraProvider.load({ sourceId, externalId: '10001' }, context))?.state).toBe(state);
  });
  it('plans assignment before transition, acknowledges receipts, and avoids duplicate delivery', async () => {
    const value = await claim(); const { f, effects } = value;
    expect(effects.map(effect => [effect.localId, effect.after])).toEqual([['assign', []], ['progress', ['assign']]]);
    const claimed = await applyClaim(value);
    expect(claimed.operations).toHaveLength(2);
    expect(f.calls.filter(call => call.method !== 'GET').map(call => call.method)).toEqual(['PUT', 'POST']);
    const transition = effects[1]!;
    expect((await jiraEffects.transition!.invoke(transition, f.effectContext)).status).toBe('acknowledged');
    expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(2);
  });
  it('reconciles remote success before local acknowledgment without a second write', async () => {
    const { f, effects } = await claim(); f.dropResponse = true;
    expect((await jiraEffects.assign!.invoke(effects[0]!, f.effectContext)).status).toBe('unknown');
    expect((await jiraEffects.assign!.reconcile(effects[0]!, { ...f.effectContext, http: f.context.http! })).status).toBe('acknowledged');
    expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
  });
  it('does not infer absence of an uncertain write from unchanged or conflicting Jira state', async () => {
    const { f, effects } = await claim();
    expect((await jiraEffects.assign!.reconcile(effects[0]!, { ...f.effectContext, http: f.context.http! })).status).toBe('unknown');
    f.issue = jiraIssue({ assignee: { accountId: 'another-user' } });
    const result = await jiraEffects.assign!.invoke(effects[0]!, f.effectContext);
    expect(result).toMatchObject({ status: 'definitely-not-applied', retryable: false });
    expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
  it('guards status and assignment again after preparing a transition', async () => {
    const { f, effects } = await claim();
    await jiraEffects.assign!.invoke(effects[0]!, f.effectContext);
    f.afterGet = path => { if (path.endsWith('/transitions')) f.issue = jiraIssue({ assignee: { accountId: 'another-user' } }); };
    expect(await jiraEffects.transition!.invoke(effects[1]!, f.effectContext)).toMatchObject({ status: 'definitely-not-applied', retryable: false });
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });
  it.each([[400, 'definitely-not-applied', false], [401, 'definitely-not-applied', false], [429, 'definitely-not-applied', true], [408, 'unknown', undefined], [503, 'unknown', undefined]])('classifies rejected and ambiguous writes (%s)', async (status, expected, retryable) => {
    const { f, effects } = await claim(); f.sendStatus = Number(status);
    const result: SourceEffectResultV1 = await jiraEffects.assign!.invoke(effects[0]!, f.effectContext);
    expect(result.status).toBe(expected);
    if (result.status === 'definitely-not-applied') expect(result.retryable).toBe(retryable);
  });
  it('blocks stale admissions and changed transition definitions before mutation', async () => {
    const { f, task, effects } = await claim();
    f.issue = jiraIssue({ updated: '2026-09-21T00:00:00.000Z' });
    await expect(jiraProvider.planClaim({ admissionId: 'a', runId: 'r', task, expectedInstanceRevision: 1, retryOf: null }, f.context)).rejects.toThrow('changed');
    await jiraEffects.assign!.invoke(effects[0]!, f.effectContext);
    f.transitionOverride = { transitions: [{ id: 'different', to: { id: '2', name: 'In Progress' } }] };
    expect(await jiraEffects.transition!.invoke(effects[1]!, f.effectContext)).toMatchObject({ status: 'definitely-not-applied', retryable: false });
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });
  it('releases only an unsent abort and retains partial or ambiguous claims without undoing external work', async () => {
    const { f, task, effects } = await claim();
    const input = { admissionId: 'admission-1', runId: 'run-1', task, claimReceipt: null, reason: 'preflight-failed' as const, claimSteps: [] };
    expect((await jiraProvider.planAbort(input, f.context)).kind).toBe('none');
    await jiraEffects.assign!.invoke(effects[0]!, f.effectContext);
    const plan = await jiraProvider.planAbort({ ...input, claimSteps: [{ operationId: 'assign', state: 'uncertain', evidence: null }] }, f.context);
    f.issue = jiraIssue({ assignee: { accountId: 'human' }, status: { id: '9', name: 'Done', statusCategory: { key: 'done' } } });
    const retained = remote(plan)[0]!;
    expect((await jiraEffects['retain-claim']!.invoke(retained, f.effectContext)).status).toBe('blocked');
    expect((await jiraEffects['retain-claim']!.reconcile(retained, { ...f.effectContext, http: f.context.http! })).status).toBe('blocked');
    expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
  });
  it('completes only successful published work with acknowledged claim evidence and replays safely when disabled', async () => {
    const value = await claim(); const claimReceipt = await applyClaim(value); const { f, task } = value;
    const input = { runId: 'run-1', attempt: 1, task, claimReceipt, outcome: 'succeeded' as const, publication: { repo, prNumber: 42 } };
    expect((await jiraProvider.planCompletion({ ...input, publication: null }, f.context)).kind).toBe('none');
    expect((await jiraProvider.planCompletion({ ...input, outcome: 'failed' }, f.context)).kind).toBe('none');
    const disabled = { ...f.context, instance: { ...f.instance, desiredEnabled: false } };
    const plan = await jiraProvider.planCompletion(input, disabled); const effect = remote(plan)[0]!;
    const retained = { ...f.effectContext, instance: disabled.instance };
    expect((await jiraEffects.transition!.invoke(effect, retained)).status).toBe('acknowledged');
    expect((await jiraEffects.transition!.reconcile(effect, { ...retained, http: f.context.http! })).status).toBe('acknowledged');
    expect((await jiraProvider.planCompletion(input, disabled)).kind).toBe('none');
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(2);
  });
  it('refuses completion when externally reassigned or missing immutable claim evidence', async () => {
    const value = await claim(); const claimReceipt = await applyClaim(value); const { f, task } = value;
    const input = { runId: 'run-1', attempt: 1, task, claimReceipt, outcome: 'succeeded' as const, publication: { repo, prNumber: 42 } };
    await expect(jiraProvider.planCompletion({ ...input, claimReceipt: { ...claimReceipt, operations: [] } }, f.context)).rejects.toThrow('claim');
    f.issue = jiraIssue({ assignee: { accountId: 'human' } });
    await expect(jiraProvider.planCompletion(input, f.context)).rejects.toThrow('assignment');
  });
});

describe('Jira history and source completion metrics', () => {
  const query = { repo, from: '2026-09-14T00:00:00.000Z', until: '2026-09-20T12:00:00.000Z', eventLimit: 50 };
  function historyFixture() {
    const f = fixture(); const at = '2026-09-20T10:00:00.000Z';
    f.issue = { ...jiraIssue({ updated: at, assignee: { accountId: 'bot' }, resolutiondate: at, status: { id: '3', name: 'Done', statusCategory: { key: 'done' } } }),
      changelog: { startAt: 0, total: 1, histories: [{ id: 'history-1', created: at, items: [{ field: 'status', toString: 'Done' }] }] } } as ReturnType<typeof jiraIssue>;
    return f;
  }
  it('counts source resolutions and uses exact project/assignee history independently of queue policy', async () => {
    const f = historyFixture(); const context = { ...f.context, instance: { ...f.instance, settings: { ...f.instance.settings, jql: 'status = Backlog', assignee: 'currentUser()' } } };
    const result = await jiraProvider.readHistory!(query, context);
    expect(result.throughputQuality).toBe('complete'); expect(result.days.map(day => day.completed)).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(result.historyQuality).toBe('complete'); expect(result.events[0]).toMatchObject({ at: '2026-09-20T10:00:00.000Z', kind: 'status-changed', status: 'Done', ref: { sourceId, externalId: f.issue.id } });
    const jql = f.calls.find(call => call.path.endsWith('/search/jql'))?.query?.jql;
    expect(jql).toContain('project = "TASK"'); expect(jql).toContain('assignee = currentUser()'); expect(jql).not.toContain('Backlog');
  });
  it('separates truncated status history from complete throughput and missing resolution dates from zero', async () => {
    const f = historyFixture(); f.issue = { ...f.issue, changelog: { startAt: 0, total: 200, histories: [] } } as ReturnType<typeof jiraIssue>;
    const result = await jiraProvider.readHistory!(query, f.context); expect(result.historyQuality).toBe('partial'); expect(result.throughputQuality).toBe('complete'); expect(result.days[6]?.completed).toBe(1);
    f.issue = { ...f.issue, fields: { ...f.issue.fields, resolutiondate: null } } as ReturnType<typeof jiraIssue>;
    const incomplete = await jiraProvider.readHistory!(query, f.context); expect(incomplete.throughputQuality).toBe('partial'); expect(incomplete.days.every(day => day.completed === null)).toBe(true);
  });
  it('does not count another assignee or future completion and does not infer completion from worker status', async () => {
    const f = historyFixture(); f.issue = { ...f.issue, fields: { ...f.issue.fields, resolutiondate: '2026-09-20T12:00:01.000Z' } } as ReturnType<typeof jiraIssue>;
    expect((await jiraProvider.readHistory!(query, f.context)).days[6]?.completed).toBe(0);
    f.issue = { ...f.issue, fields: { ...f.issue.fields, assignee: { accountId: 'another' }, resolutiondate: '2026-09-20T10:00:00.000Z' } } as ReturnType<typeof jiraIssue>;
    expect((await jiraProvider.readHistory!(query, f.context)).days[6]?.completed).toBe(0);
  });
  it('rejects repeated search cursors and honors cancellation before history detail reads', async () => {
    const f = historyFixture(); f.search = { status: 200, body: { issues: [], isLast: false, nextPageToken: 'repeat' } };
    await expect(jiraProvider.readHistory!(query, f.context)).rejects.toThrow('pagination');
    const cancelled = historyFixture(); cancelled.afterGet = path => { if (path.endsWith('/search/jql')) cancelled.controller.abort(); };
    await expect(jiraProvider.readHistory!(query, cancelled.context)).rejects.toMatchObject({ name: 'AbortError' }); expect(cancelled.calls.some(call => call.query?.expand === 'changelog')).toBe(false);
  });
});
