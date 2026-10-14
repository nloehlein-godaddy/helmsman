import { expect, it, vi } from 'vitest';
import { AGENT_PROMPT_LIMITS_V1, parseAgentPromptSettingsSaveV1, parseAgentPromptSettingsSnapshotV1 } from './agent-prompts';
import { createHostAgentPromptSettingsService } from './agent-prompts-service';

const role = { id: 'coding.implement', label: 'Implementation', description: 'Build the requested change.', providerLabel: 'Coding workflow', defaultText: '- Keep changes scoped.\n- Verify the result.', text: '- Keep changes scoped.\n- Verify the result.', overridden: false };
const snapshot = { version: 1 as const, revision: 'a'.repeat(64), roles: [role] };
function fixture() {
  const lifetime = new AbortController();
  const scope = { repo: 'org/a', epoch: 1, signal: new AbortController().signal, active: true };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(snapshot));
  const service = createHostAgentPromptSettingsService(lifetime.signal, { caller: 'helmsman.agent-prompts/panel', scope: () => scope, fetch: fetcher });
  return { lifetime, scope, fetcher, service };
}
it('reads global role instructions and saves exact multiline text without interpolating user content', async () => {
  const f = fixture(); expect(await f.service.snapshot()).toEqual({ status: 'available', value: snapshot });
  const text = 'Use {{literal}} and `code` exactly.\n$(do-not-execute)';
  f.fetcher.mockResolvedValueOnce(Response.json({ ...snapshot, revision: 'b'.repeat(64), roles: [{ ...role, text, overridden: true }] }));
  const command = { version: 1 as const, expectedRevision: snapshot.revision, roleId: role.id, text };
  expect(await f.service.save(command)).toMatchObject({ status: 'available', value: { roles: [{ text }] } });
  expect(f.fetcher.mock.calls[0]?.[0]).toBe('/api/agent-prompts');
  expect(f.fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', headers: { 'X-Helmsman-Contribution': 'helmsman.agent-prompts/panel' }, body: JSON.stringify(command) });
});
it('resets through null and returns conflicts without retrying or modifying the original revision', async () => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(Response.json({ reason: 'conflict' }, { status: 409 }));
  const command = { version: 1 as const, expectedRevision: snapshot.revision, roleId: role.id, text: null };
  expect(await f.service.save(command)).toEqual({ status: 'unavailable', reason: 'conflict' }); expect(f.fetcher).toHaveBeenCalledTimes(1); expect(command.expectedRevision).toBe(snapshot.revision);
});
it.each(['', ' ', '\u0000', 'é'.repeat(AGENT_PROMPT_LIMITS_V1.textBytes / 2 + 1)])('rejects invalid or oversized UTF-8 instruction text before transport', text => {
  const f = fixture(); expect(() => f.service.save({ version: 1, expectedRevision: snapshot.revision, roleId: role.id, text })).toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
});
it('accepts the UTF-8 limit and rejects duplicate or inconsistent role snapshots', () => {
  expect(parseAgentPromptSettingsSaveV1({ version: 1, expectedRevision: snapshot.revision, roleId: role.id, text: 'é'.repeat(AGENT_PROMPT_LIMITS_V1.textBytes / 2) }).text).toBeTruthy();
  const escapedText = 'x' + '\n'.repeat(AGENT_PROMPT_LIMITS_V1.textBytes - 1);
  expect(parseAgentPromptSettingsSaveV1({ version: 1, expectedRevision: snapshot.revision, roleId: role.id, text: escapedText }).text).toBe(escapedText);
  expect(() => parseAgentPromptSettingsSnapshotV1({ ...snapshot, roles: [role, role] })).toThrow();
  expect(() => parseAgentPromptSettingsSnapshotV1({ ...snapshot, roles: [{ ...role, text: 'Different', overridden: false }] })).toThrow();
  expect(() => parseAgentPromptSettingsSaveV1({ version: 1, expectedRevision: snapshot.revision, roleId: '../unknown', text: 'valid' })).toThrow();
});
it('cancels a stale global response after a header scope change', async () => {
  const f = fixture(); f.fetcher.mockImplementationOnce(async () => { f.scope.epoch++; return Response.json(snapshot); });
  await expect(f.service.snapshot()).rejects.toMatchObject({ name: 'AbortError' });
});
it('fails malformed responses closed and leaves failed saves single-attempt', async () => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(Response.json({ ...snapshot, secret: 'unexpected' })); expect(await f.service.snapshot()).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  f.fetcher.mockRejectedValueOnce(new Error('offline')); expect(await f.service.save({ version: 1, expectedRevision: snapshot.revision, roleId: role.id, text: 'My instructions' })).toEqual({ status: 'unavailable', reason: 'connection-failed' }); expect(f.fetcher).toHaveBeenCalledTimes(2);
});
