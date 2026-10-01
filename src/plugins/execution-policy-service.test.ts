import { expect, it, vi } from 'vitest';
import { createHostExecutionPolicyService } from './execution-policy-service';
import type { RunReadScopeV1 } from './run-read-service';
const value = { version: 1, repo: 'org/a', revision: 1, maxConcurrentRuns: 2 };
const command = { version: 1 as const, repo: 'org/a', requestId: 'stable-1', expectedRevision: 0, maxConcurrentRuns: 2 };
function fixture() {
  let scope: RunReadScopeV1 = { repo: 'org/a', epoch: 1, active: true, signal: new AbortController().signal };
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value)));
  const service = createHostExecutionPolicyService(new AbortController().signal, { caller: 'example.settings/panel', scope: () => scope, fetch: fetcher });
  return { service, fetcher, changeScope: () => { scope = { ...scope, repo: 'org/b', epoch: 2 }; } };
}
it('sends the exact request and effective scope with contribution authorization', async () => {
  const f = fixture(); expect(await f.service.set(command)).toEqual({ status: 'available', value });
  const init = f.fetcher.mock.calls[0]?.[1]; expect(init?.method).toBe('POST'); expect(init?.headers).toMatchObject({ 'X-Helmsman-Contribution': 'example.settings/panel' });
  expect(JSON.parse(String(init?.body))).toEqual({ command, scopeRepo: 'org/a' });
  expect(await f.service.set({ ...command, repo: 'org/b' })).toEqual({ status: 'unavailable', reason: 'forbidden' }); expect(f.fetcher).toHaveBeenCalledOnce();
});
it.each([{ ...value, repo: 'org/b' }, { ...value, revision: 9 }, { ...value, maxConcurrentRuns: 3 }])('rejects a changed receipt: %j', async receipt => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
  expect(await f.service.set(command)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
});
it('drops late responses when the mounted panel changes scope', async () => {
  const f = fixture(); let resolve!: (value: Response) => void; f.fetcher.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const pending = f.service.set(command); f.changeScope(); resolve(new Response(JSON.stringify(value)));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
