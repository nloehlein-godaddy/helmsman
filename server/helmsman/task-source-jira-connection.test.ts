// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceMutationHttpV1 } from '../../src/plugins/tasks';
import { openPersistence, type Persistence } from './persistence';
import { schemaVersion } from './migrations';
import { openSourceConnectionStore, type SourceConnectionRecord } from './task-source-connections';
import { bootstrapJiraSourceConnection, createJiraSourceHttp, JiraSourceAccessError, jiraConnectionIdentity } from './task-source-jira-connection';

let directory: string;
let persistence: Persistence;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'helmsman-jira-connection-')); persistence = openPersistence(join(directory, 'state.sqlite')); });
afterEach(() => { persistence.close(); rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const store = openSourceConnectionStore(persistence);
  const controller = new AbortController();
  let config: { baseUrl: string; email: string; apiToken: string } | null = { baseUrl: 'https://jira.example.com', email: 'bot@example.com', apiToken: 'initial-private-key' };
  let accountId = 'bot-account';
  let cloudId = 'cloud-123';
  let cloudStatus = 200;
  let subjectStatus = 200;
  let cloudBody: unknown = undefined;
  let afterProbe: (() => void) | null = null;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://jira.example.com');
    expect(init?.redirect).toBe('error');
    if (url.pathname === '/rest/api/3/myself') return new Response(JSON.stringify({ accountId, active: true }), { status: subjectStatus });
    if (url.pathname === '/_edge/tenant_info') { afterProbe?.(); return new Response(JSON.stringify(cloudBody ?? { cloudId }), { status: cloudStatus }); }
    return init?.method === 'GET' ? new Response('{"id":"10001"}') : new Response(null, { status: 204 });
  });
  const resolveConfig = vi.fn(async () => config);
  const options = { store, provisioningKey: 'configured-jira', credentialHandle: 'env.jira', resolveConfig, signal: controller.signal, fetcher };
  return { store, controller, options, fetcher, resolveConfig,
    get config() { return config; }, set config(value: typeof config) { config = value; }, set accountId(value: string) { accountId = value; }, set cloudId(value: string) { cloudId = value; },
    set cloudStatus(value: number) { cloudStatus = value; }, set subjectStatus(value: number) { subjectStatus = value; }, set cloudBody(value: unknown) { cloudBody = value; }, set afterProbe(value: () => void) { afterProbe = value; } };
}
function client(f: ReturnType<typeof fixture>, connection: SourceConnectionRecord, mutation = false, authorize = () => {}) {
  return createJiraSourceHttp({ connection, resolveConfig: f.resolveConfig, signal: f.controller.signal, fetcher: f.fetcher, authorize, mutation });
}
const issue = { path: '/rest/api/3/issue/10001', query: { fields: 'status' } };
describe('pinned Jira source connections', () => {
  it('persists only non-secret endpoint, subject, authority and credential references through an owned migration', async () => {
    const f = fixture(); const pin = await bootstrapJiraSourceConnection(f.options);
    expect(pin).toMatchObject({ kind: 'jira', origin: 'https://jira.example.com', email: 'bot@example.com', subject: 'bot-account', authorityId: 'cloud-123', credentialHandle: 'env.jira' });
    expect(schemaVersion(persistence.sql, 'core.source-connections')).toBe(1);
    const stored = JSON.stringify(persistence.sql.prepare('SELECT * FROM source_connections').all());
    expect(stored).not.toContain('initial-private-key'); expect(stored).not.toContain('Authorization');
    expect(jiraConnectionIdentity(pin)).toMatchObject({ level: 'verified', authority: { protocol: 'jira.cloud', authorityId: 'cloud-123', identityFormat: 'jira.issue-id/v1' } });
    expect(f.store.get(pin.id)).toEqual(pin);
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('reopens the same connection identity and accepts token rotation only for the same subject', async () => {
    const f = fixture(); const pin = await bootstrapJiraSourceConnection(f.options);
    persistence.close(); persistence = openPersistence(join(directory, 'state.sqlite'));
    const store = openSourceConnectionStore(persistence);
    f.config = { ...f.config!, apiToken: 'rotated-private-key' };
    expect(await bootstrapJiraSourceConnection({ ...f.options, store })).toEqual(pin);
    f.fetcher.mockClear();
    const http = client(f, pin);
    expect('send' in http).toBe(false);
    expect(await http.get(issue)).toEqual({ status: 200, body: { id: '10001' } });
    expect(f.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/rest/api/3/myself', '/_edge/tenant_info', '/rest/api/3/issue/10001']);
    for (const [, init] of f.fetcher.mock.calls) expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${Buffer.from('bot@example.com:rotated-private-key').toString('base64')}`);
    f.accountId = 'different-account'; f.fetcher.mockClear();
    await expect(http.get(issue)).rejects.toThrow('subject');
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes('/issue/'))).toBe(false);
  });
  it('does not mask retained credentials when the plugin is disabled', async () => {
    const f = fixture(); const pin = await bootstrapJiraSourceConnection(f.options);
    const http = client(f, pin, true) as SourceMutationHttpV1;
    expect(await http.send({ method: 'PUT', path: '/rest/api/3/issue/10001/assignee', body: { accountId: 'bot-account' } })).toEqual({ status: 204, body: null });
  });
  it.each(['origin', 'email', 'credentialHandle'] as const)('blocks changed pinned %s before sending credentials to another endpoint', async field => {
    const f = fixture(); const pin = await bootstrapJiraSourceConnection(f.options); f.fetcher.mockClear();
    if (field === 'origin') f.config = { ...f.config!, baseUrl: 'https://different.example.com' };
    if (field === 'email') f.config = { ...f.config!, email: 'other@example.com' };
    await expect(bootstrapJiraSourceConnection({ ...f.options, ...(field === 'credentialHandle' ? { credentialHandle: 'other-credentials' } : {}) })).rejects.toThrow('identity changed');
    expect(f.fetcher).not.toHaveBeenCalled();
    if (field !== 'credentialHandle') await expect(client(f, pin).get(issue)).rejects.toThrow('identity changed');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('blocks changed tenant and loss of verified authority during both restart and live resolution', async () => {
    const f = fixture(); const pin = await bootstrapJiraSourceConnection(f.options);
    f.cloudId = 'different-cloud';
    await expect(bootstrapJiraSourceConnection(f.options)).rejects.toThrow('authority');
    await expect(client(f, pin).get(issue)).rejects.toThrow('authority');
    f.cloudStatus = 404;
    await expect(client(f, pin).get(issue)).rejects.toThrow('authority');
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes('/issue/'))).toBe(false);
  });
  it('persists operator-seeded identity when tenant endpoint is unavailable and does not silently replace it on restart', async () => {
    const f = fixture(); f.cloudStatus = 404;
    const pin = await bootstrapJiraSourceConnection(f.options);
    expect(jiraConnectionIdentity(pin)).toMatchObject({ level: 'operator-seeded', authority: null });
    expect(await client(f, pin).get(issue)).toMatchObject({ status: 200 });
    f.cloudStatus = 200;
    expect(await bootstrapJiraSourceConnection(f.options)).toEqual(pin);
    expect(f.store.byProvisioningKey('configured-jira')?.authorityId).toBeNull();
    f.accountId = 'other';
    await expect(client(f, pin).get(issue)).rejects.toThrow('subject');
  });
  it('does not infer tenant authority from an unrelated or malformed identity payload', async () => {
    const f = fixture(); f.cloudBody = { baseUrl: 'https://jira.example.com', serverTitle: 'Same name' };
    expect((await bootstrapJiraSourceConnection(f.options)).authorityId).toBeNull();
  });
  it('does not persist failed authentication, missing credentials, or aborted probes', async () => {
    const f = fixture(); f.subjectStatus = 401;
    await expect(bootstrapJiraSourceConnection(f.options)).rejects.toThrow(JiraSourceAccessError);
    expect(f.store.byProvisioningKey('configured-jira')).toBeNull();
    f.config = null;
    await expect(bootstrapJiraSourceConnection(f.options)).rejects.toThrow('credentials');
    f.controller.abort();
    await expect(bootstrapJiraSourceConnection(f.options)).rejects.toThrow();
    expect(f.store.byProvisioningKey('configured-jira')).toBeNull();
  });
  it.each([401, 403] as const)('classifies plain-text %s authentication failures without persisting or sending an issue request', async status => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => new Response('private remote diagnostic', { status }));
    await expect(bootstrapJiraSourceConnection(f.options)).rejects.toMatchObject({ name: 'JiraSourceAccessError', status });
    expect(f.store.byProvisioningKey('configured-jira')).toBeNull();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(new URL(String(f.fetcher.mock.calls[0]?.[0])).pathname).toBe('/rest/api/3/myself');
    expect(new JiraSourceAccessError(status).message).not.toContain('private remote diagnostic');
  });
  it('rechecks authorization after identity preparation and blocks revoked operations without mutation', async () => {
    const f = fixture(); const pin = await bootstrapJiraSourceConnection(f.options); f.fetcher.mockClear();
    let allowed = true;
    f.afterProbe = () => { allowed = false; };
    const http = client(f, pin, true, () => { if (!allowed) throw new Error('Operation disabled'); }) as SourceMutationHttpV1;
    await expect(http.send({ method: 'PUT', path: '/rest/api/3/issue/10001/assignee', body: { accountId: 'bot-account' } })).rejects.toThrow('disabled');
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('keeps the verified credential snapshot for delivery if configuration rotates during the probe', async () => {
    const f = fixture(); const pin = await bootstrapJiraSourceConnection(f.options); f.fetcher.mockClear();
    f.afterProbe = () => { f.config = { ...f.config!, apiToken: 'next-private-key' }; };
    await client(f, pin).get(issue);
    const authorization = new Headers(f.fetcher.mock.calls.at(-1)?.[1]?.headers).get('Authorization');
    expect(authorization).toBe(`Basic ${Buffer.from('bot@example.com:initial-private-key').toString('base64')}`);
  });
  it('honors cancellation during identity preparation without mutating or persisting a late result', async () => {
    const f = fixture(); f.afterProbe = () => f.controller.abort();
    await expect(bootstrapJiraSourceConnection(f.options)).rejects.toThrow();
    expect(f.store.byProvisioningKey('configured-jira')).toBeNull();
  });
  it('rejects changed durable identities and persisted secret-bearing fields', async () => {
    const f = fixture(); const pin = await bootstrapJiraSourceConnection(f.options);
    const { id: _id, version: _version, ...input } = pin;
    expect(() => f.store.pin({ ...input, subject: 'other' })).toThrow('identity');
    expect(() => f.store.pin({ ...input, apiToken: 'private' } as typeof input)).toThrow('record');
    persistence.sql.prepare('UPDATE source_connections SET json=? WHERE id=?').run(JSON.stringify({ ...pin, apiToken: 'private' }), pin.id);
    expect(() => f.store.get(pin.id)).toThrow('record');
  });
});
