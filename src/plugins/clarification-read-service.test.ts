import { afterEach, expect, it, vi } from 'vitest';
import { createHostClarificationReadService } from './clarification-read-service';
import { createHostSuggestedContactAdminService } from './suggested-contact-admin-service';
import type { ClarificationReadItemV1, ClarificationReadListQueryV1 } from './clarification-read';

const caller = 'example.questions/panel';
const time = '2026-01-01T00:00:00Z';
const item: ClarificationReadItemV1 = { version: 1, id: 'question', runId: 'run', repo: 'org/project', revision: 1, prompt: 'Proceed?', required: true, owner: 'local', contactId: null,
  state: 'pending', answer: null, createdAt: time, timeoutAt: null, answeredAt: null, provenance: { kind: 'legacy-unproven', attempt: null, channelId: null }, currentAttempt: 2,
  blocksPublication: true, answerability: { available: false, reason: 'provenance-unknown' } };
const input: ClarificationReadListQueryV1 = { version: 1, repo: 'org/project', runId: null, states: [], limit: 100, cursor: null };
function setup() {
  const lifetime = new AbortController(); const activity = new AbortController(); let scope = { repo: 'org/project', active: true, epoch: 1, signal: activity.signal };
  const fetcher = vi.fn<typeof fetch>(); const options = { caller, scope: () => scope, fetch: fetcher };
  const service = createHostClarificationReadService(lifetime.signal, options);
  return { lifetime, activity, fetcher, options, service, change() { scope = { ...scope, epoch: 2 }; } };
}
const page = () => ({ version: 1, repo: input.repo, items: [item], nextCursor: null, total: 1, observedAt: time });
const context = () => Response.json({ repos: ['org/project'] });
afterEach(() => vi.useRealTimers());
it('reads scoped unknown obligations without depending on contact availability', async () => {
  const f = setup();
  f.fetcher.mockImplementation(async (url, init) => {
    expect(new Headers(init?.headers).get('x-helmsman-contribution')).toBe(caller);
    if (url === '/api/context') return context();
    if (String(url).startsWith('/api/suggested-contact-admin')) return Response.json({ reason: 'service-unavailable' }, { status: 503 });
    const query = new URL(String(url), 'http://localhost').searchParams;
    expect(query.get('scopeRepo')).toBe('org/project'); expect(JSON.parse(query.get('states')!)).toEqual([]); return Response.json(page());
  });
  expect(await createHostSuggestedContactAdminService(f.lifetime.signal, f.options).list({ version: 1, scope: 'global', limit: 10, cursor: null })).toEqual({ status: 'unavailable', reason: 'service-unavailable' });
  const result = await f.service.list(input); expect(result).toMatchObject({ status: 'available', value: { items: [{ blocksPublication: true, answerability: { available: false } }] } });
});
it('rejects scope broadening, foreign configured repositories and foreign response rows', async () => {
  const f = setup();
  expect(await f.service.list({ ...input, repo: null })).toEqual({ status: 'unavailable', reason: 'forbidden' }); expect(f.fetcher).not.toHaveBeenCalled();
  f.fetcher.mockResolvedValueOnce(Response.json({ repos: ['org/other'] }));
  expect(await f.service.list(input)).toEqual({ status: 'unavailable', reason: 'forbidden' });
  f.fetcher.mockImplementation(async url => url === '/api/context' ? context() : Response.json({ ...page(), items: [{ ...item, repo: 'org/foreign' }] }));
  expect(await f.service.list(input)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
});
it('fences a stale epoch even when a caller fails to abort its old scope signal', async () => {
  const f = setup(); let resolve!: (response: Response) => void;
  f.fetcher.mockImplementation(async url => url === '/api/context' ? context() : new Promise(yes => { resolve = yes; }));
  const pending = f.service.list(input); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); f.change(); resolve(Response.json(page())); await cancelled;
});
it('cancels stalled bodies on caller abort and bounds chunked response bytes', async () => {
  const f = setup(); const cancel = vi.fn(); const abort = new AbortController();
  f.fetcher.mockImplementation(async url => url === '/api/context' ? context() : new Response(new ReadableStream({ cancel })));
  const pending = f.service.list(input, abort.signal); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); abort.abort(); await cancelled; expect(cancel).toHaveBeenCalled();
  f.fetcher.mockImplementation(async url => url === '/api/context' ? context() : new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); } })));
  expect(await f.service.list(input)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
});
it('preserves cursor failure and missing question results without inventing empty lists', async () => {
  const f = setup(); f.fetcher.mockImplementation(async url => url === '/api/context' ? context() : Response.json({ reason: 'cursor-invalid' }, { status: 409 }));
  expect(await f.service.list({ ...input, cursor: 'expired' })).toEqual({ status: 'unavailable', reason: 'cursor-invalid' });
  f.fetcher.mockImplementation(async url => url === '/api/context' ? context() : Response.json({ reason: 'not-found' }, { status: 404 }));
  expect(await f.service.load({ version: 1, repo: input.repo!, runId: 'run', questionId: 'question' })).toEqual({ status: 'unavailable', reason: 'not-found' });
});
