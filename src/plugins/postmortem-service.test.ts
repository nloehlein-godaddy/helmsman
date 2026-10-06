import { describe, expect, it, vi } from 'vitest';
import { parsePostmortemEventV1, parsePostmortemSnapshotV1, type PostmortemEventV1 } from './postmortem';
import { createHostPostmortemService } from './postmortem-service';

const SID = '00000000-0000-4000-8000-000000000001';
const session = { id: SID, runId: 'run-1', provider: 'codex', model: null, effort: 'high', status: 'ready', error: null, turns: 1, costUsd: 0.1, providerSessionId: 't', createdAt: 'a', updatedAt: 'b' };
const snapshot = { session, activity: null, messages: [{ id: 1, sessionId: SID, clientId: null, role: 'agent', kind: 'text', text: 'Exec kill', ts: 't' }],
  patches: [{ file: '1-target.patch', path: '/p/1-target.patch', number: 1, repo: 'target', baseSha: 'abc1234', summary: 's', valid: true, reason: null, applyCommand: "git -C '/r' apply '/p'" }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function setup(fetch: typeof globalThis.fetch, repo: string | null = 'org/app') {
  const lifetime = new AbortController(); const activity = new AbortController();
  return createHostPostmortemService(lifetime.signal, { caller: 'helmsman.run-viewer/panel', fetch, scope: () => ({ repo, epoch: 1, active: true, signal: activity.signal }) });
}

describe('host post-mortem service', () => {
  it('parses snapshots defensively', () => {
    expect(parsePostmortemSnapshotV1(snapshot)).toMatchObject({ session: { id: SID, status: 'ready' }, messages: [{ text: 'Exec kill' }], patches: [{ valid: true }] });
    for (const bad of [null, [], { ...snapshot, session: { ...session, status: 'weird' } }, { ...snapshot, messages: [{ id: 'x' }] }]) expect(() => parsePostmortemSnapshotV1(bad)).toThrow(TypeError);
    expect(parsePostmortemEventV1({ type: 'nope' })).toBeNull();
    expect(parsePostmortemEventV1({ type: 'status', session, activity: 'resuming' })).toMatchObject({ type: 'status', activity: 'resuming' });
  });

  it('starts with the contribution header and maps errors to codes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(snapshot));
    const service = setup(fetch);
    expect(await service.start({ repo: 'org/app', runId: 'run-1', effort: 'high' })).toMatchObject({ status: 'available', value: { session: { id: SID } } });
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe('/api/runs/run-1/postmortem');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ effort: 'high', repo: 'org/app', scopeRepo: 'org/app' }), headers: expect.objectContaining({ 'X-Helmsman-Contribution': 'helmsman.run-viewer/panel' }) });
    fetch.mockResolvedValueOnce(json({ error: 'Post-mortem sandbox requires macOS' }, 412));
    expect(await service.send({ repo: 'org/app', sessionId: SID, clientId: SID, text: 'Why?' })).toEqual({ status: 'unavailable', code: 412, message: 'Post-mortem sandbox requires macOS' });
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/postmortem/${SID}/messages`);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ clientId: SID, text: 'Why?', repo: 'org/app', scopeRepo: 'org/app' }));
    fetch.mockRejectedValueOnce(new Error('offline'));
    expect(await service.stop({ repo: 'org/app', sessionId: SID })).toMatchObject({ status: 'unavailable', code: 0 });
    expect(fetch.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ repo: 'org/app', scopeRepo: 'org/app' }));
    fetch.mockResolvedValueOnce(json({ nonsense: true }));
    expect(await service.read({ repo: 'org/app', sessionId: SID })).toMatchObject({ status: 'unavailable', message: 'Invalid post-mortem response.' });
    expect(fetch.mock.calls[3]?.[0]).toBe(`/api/postmortem/${SID}?repo=org%2Fapp&scopeRepo=org%2Fapp`);
  });

  it('refuses runs outside the galleon scope without a request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await setup(fetch).start({ repo: 'org/other', runId: 'run-1' })).toMatchObject({ status: 'unavailable', code: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('streams SSE frames across chunk boundaries and skips malformed frames', async () => {
    const frames = [`data: ${JSON.stringify({ type: 'snapshot', snapshot })}\n\ndata: {bad}\n\nda`, `ta: ${JSON.stringify({ type: 'patches', patches: [] })}\n\n`];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } }));
    const events: PostmortemEventV1[] = [];
    await setup(fetch).watch({ repo: 'org/app', sessionId: SID }, event => events.push(event), new AbortController().signal);
    expect(events.map(event => event.type)).toEqual(['snapshot', 'patches']);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/postmortem/${SID}/events?repo=org%2Fapp&scopeRepo=org%2Fapp`);
  });

  it('sends a null scope and omits the scope query outside a galleon', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(snapshot));
    const service = setup(fetch, null);
    await service.stop({ repo: 'org/app', sessionId: SID });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ repo: 'org/app', scopeRepo: null }));
    await service.read({ repo: 'org/app', sessionId: SID });
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/postmortem/${SID}?repo=org%2Fapp`);
  });
});
