import { afterEach, expect, it, vi } from 'vitest';
import { PrCompatibilitySession, bindPrCompatibilitySession, findPrCompatibilitySession, prTarget } from './pr-compatibility-session';
import { renderPrPanel } from './render';
import type { PrStatusView } from './data/pr';

const status: PrStatusView = { repo: 'org/a', number: 1, headSha: 'head', state: 'open', draft: false, merged: false, headRefName: 'topic', reviewDecision: '', comments: 0, checks: { passed: 0, failed: 0, pending: 0 }, url: 'https://github.com/org/a/pull/1' };
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
it('shares reads across surfaces and cancels only when the last interested surface hides', async () => {
  const pending = deferred<Response>(); const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((_url, init) => { signals.push(init.signal); return pending.promise; }));
  const session = new PrCompatibilitySession(); const legacy = {}; const registered = {};
  session.setActive(legacy, true); session.setActive(registered, true);
  const first = session.readStatus(legacy, status); const second = session.readStatus(registered, status);
  expect(fetch).toHaveBeenCalledTimes(1);
  session.setActive(registered, false); expect(signals[0]?.aborted).toBe(false);
  pending.resolve(json(status)); expect(await first).toEqual(status); expect(await second).toEqual(status);
  const late = deferred<Response>(); vi.mocked(fetch).mockImplementationOnce(() => late.promise);
  const read = session.readStatus(legacy, status, true); session.setActive(legacy, false);
  late.resolve(json({ ...status, title: 'stale' })); await read; expect(session.status(status)?.title).toBeUndefined();
});
it('retains the newest shared draft, tuning and focus without overwriting from unchanged siblings', () => {
  const session = new PrCompatibilitySession(); const root = document.createElement('div'); document.body.append(root);
  root.innerHTML = renderPrPanel(status, true) + renderPrPanel(status, true); session.restore(root);
  const fields = root.querySelectorAll<HTMLTextAreaElement>('.pr-review-body'); fields[0]!.value = 'new draft'; fields[0]!.focus(); fields[0]!.setSelectionRange(2, 5);
  const focus = session.capture(root); root.innerHTML = renderPrPanel(status, true) + renderPrPanel(status, true); session.restore(root, focus);
  expect([...root.querySelectorAll<HTMLTextAreaElement>('.pr-review-body')].map(item => item.value)).toEqual(['new draft', 'new draft']);
  expect(document.activeElement).toBe(root.querySelector('.pr-review-body')); expect((document.activeElement as HTMLTextAreaElement).selectionStart).toBe(2);
});
it('keeps uncertain review identity across private surfaces and preserves the host binding', async () => {
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { writes.push(JSON.parse(String(init.body))); return json({ error: 'lost response' }, 503); }));
  const session = new PrCompatibilitySession(); const root = document.createElement('div'); document.body.append(root);
  const unbind = bindPrCompatibilitySession(root, session); root.innerHTML = renderPrPanel(status, true); session.restore(root);
  const control = root.querySelector<HTMLTextAreaElement>('.pr-review-body')!; control.value = 'same review'; session.capture(root);
  const first = {}; const second = {}; session.setActive(first, true); session.setActive(second, true);
  await session.review(first, prTarget(control)!, 'COMMENT'); session.setActive(first, false);
  const child = document.createElement('div'); root.append(child); child.innerHTML = renderPrPanel(status, true); session.restore(child);
  expect(findPrCompatibilitySession(child)).toBe(session);
  await session.review(second, prTarget(child.querySelector('textarea')!)!, 'COMMENT');
  expect(writes[0]?.requestId).toBe(writes[1]?.requestId); expect(writes[1]?.body).toBe('same review');
  unbind(); expect(findPrCompatibilitySession(child)).toBeNull();
});

it('drops an obsolete queued refresh when a successful review replaces its pending read', async () => {
  const pending = deferred<Response>(); let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') return json({ ok: true });
    return ++reads === 1 ? pending.promise : json({ ...status, viewerReview: 'APPROVED' });
  }));
  const session = new PrCompatibilitySession(); const owner = {}; session.setActive(owner, true);
  const first = session.readStatus(owner, status); const queued = session.readStatus(owner, status, true);
  const root = document.createElement('div'); root.innerHTML = renderPrPanel(status, true); document.body.append(root);
  await session.review(owner, prTarget(root.querySelector('.pr-approve')!)!, 'APPROVE');
  pending.resolve(json(status)); await first; await queued;
  expect(reads).toBe(2); expect(session.status(status)?.viewerReview).toBe('APPROVED');
});
