import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PrStorage, type SavedPrResult } from './storage';

beforeEach(() => { localStorage.clear(); vi.spyOn(Date, 'now').mockReturnValue(1000); });
afterEach(() => vi.restoreAllMocks());
const storage = () => new PrStorage('core/pull-requests');
const input = { repo: 'org/project', launch: { prNumber: 42 } };
const result = (fields: Partial<SavedPrResult> = {}): SavedPrResult => ({ id: expect.any(String), kind: 'run', status: 'rejected', runId: null, actor: null, message: null, savedAt: 1000, action: null, mode: null, event: null, ...fields });

it('shows the rejection explanation from previously saved run receipts', () => {
  localStorage.setItem('helmsman.pull-request.v1:core/pull-requests:result:run:legacy', JSON.stringify({ version: 1, value: {
    input, receipt: { status: 'rejected', runId: 'original-run', message: 'Branch ownership is retained by failed run old-run. Reconcile its ownership before retrying.' },
  } }));
  expect(storage().results(input.repo, 42)).toEqual([result({ runId: 'original-run', savedAt: null, message: 'Branch ownership is retained by failed run old-run. Reconcile its ownership before retrying.' })]);
});

it('returns run admissions and review publication results independently', () => {
  const saved = storage();
  saved.result('run', input.repo, 'run', { input, receipt: { status: 'accepted', runId: 'run-id' } });
  saved.result('review', input.repo, 'review', { input: { repo: input.repo, number: 42 }, status: 'succeeded', result: { actor: 'reviewer' } });
  expect(saved.results(input.repo, 42)).toEqual([result({ status: 'accepted', runId: 'run-id' }), result({ kind: 'review', status: 'succeeded', actor: 'reviewer' })]);
});

it('shows review failure reasons as literal text', () => {
  const saved = storage();
  saved.result('review', input.repo, 'review', { input: { repo: input.repo, number: 42 }, status: 'rejected', reason: ' Head changed: <b>refresh</b> & try again. ' });
  expect(saved.results(input.repo, 42)).toEqual([result({ kind: 'review', message: 'Head changed: <b>refresh</b> & try again.' })]);
});

it('ignores invalid and empty explanations while bounding retained output', () => {
  const saved = storage();
  saved.result('run', input.repo, 'invalid', { input, receipt: { status: 'rejected', message: { text: 'unsafe' } } });
  saved.result('run', input.repo, 'blank', { input, receipt: { status: 'rejected', message: '   ' } });
  saved.result('run', input.repo, 'long', { input, receipt: { status: 'rejected', message: 'x'.repeat(3000) } });
  expect(saved.results(input.repo, 42)).toEqual([result(), result(), result({ message: 'x'.repeat(2048) })]);
});

it('keeps saved explanations scoped to their contribution, galleon, and pull request', () => {
  const saved = storage();
  saved.result('run', input.repo, 'matching', { input, receipt: { status: 'rejected', message: 'Matching request' } });
  saved.result('run', input.repo, 'other-pr', { input: { ...input, launch: { prNumber: 43 } }, receipt: { status: 'rejected', message: 'Other pull request' } });
  saved.result('run', 'org/other', 'other-repo', { input: { ...input, repo: 'org/other' }, receipt: { status: 'rejected', message: 'Other galleon' } });
  new PrStorage('other/pull-requests').result('run', input.repo, 'other-plugin', { input, receipt: { status: 'rejected', message: 'Other contribution' } });
  expect(saved.results(input.repo, 42)).toEqual([result({ message: 'Matching request' })]);
});

it('loads old drafts and retains independent review guidance', () => {
  const saved = storage();
  localStorage.setItem('helmsman.pull-request.v1:core/pull-requests:draft:["org/project",42]', JSON.stringify({ version: 1, draft: { body: 'review', feedback: 'branch changes', model: '', effort: '' } }));
  expect(saved.draft(input.repo, 42).guidance).toBe('');
  saved.edit(input.repo, 42, 'guidance', '  Focus on retries\nKeep literal text.  ');
  expect(storage().draft(input.repo, 42)).toMatchObject({ guidance: '  Focus on retries\nKeep literal text.  ', feedback: 'branch changes' });
});

it('finds the latest accepted review settings for only the same head and preserves receipt idempotency', () => {
  const saved = storage(); const headSha = 'a'.repeat(40);
  const launch = { repo: input.repo, action: 'launch', launch: { mode: 'review', prNumber: 42, headSha, model: 'sonnet', effort: 'high' } };
  const first = { input: launch, receipt: { status: 'accepted' } };
  saved.result('run', input.repo, 'first', first);
  saved.result('run', input.repo, 'second', { input: { ...launch, launch: { ...launch.launch, model: 'opus' } }, receipt: { status: 'accepted' } });
  saved.result('run', input.repo, 'rejected', { input: { ...launch, launch: { ...launch.launch, model: 'fable' } }, receipt: { status: 'rejected' } });
  saved.result('run', input.repo, 'other-head', { input: { ...launch, launch: { ...launch.launch, headSha: 'b'.repeat(40) } }, receipt: { status: 'accepted' } });
  saved.result('run', input.repo, 'first', first);
  expect(saved.reviewSettings(input.repo, 42, headSha)).toEqual({ model: 'opus', effort: 'high' });
  expect(saved.reviewSettings(input.repo, 43, headSha)).toBeNull();
  expect(saved.reviewSettings('org/other', 42, headSha)).toBeNull();
});

it('prefills new and legacy empty update feedback while preserving edited or explicitly cleared feedback', () => {
  const saved = storage();
  const feedback = 'update the pr using the provided comment feedback.';
  expect(saved.draft(input.repo, 42).feedback).toBe(feedback);
  localStorage.setItem('helmsman.pull-request.v1:core/pull-requests:draft:["org/project",42]', JSON.stringify({ version: 1, draft: { body: 'Existing review', feedback: '', guidance: 'Focus', model: 'sonnet', effort: 'high' } }));
  expect(saved.draft(input.repo, 42)).toMatchObject({ feedback, body: 'Existing review', guidance: 'Focus', model: 'sonnet' });
  saved.edit(input.repo, 42, 'feedback', 'Custom instructions');
  expect(storage().draft(input.repo, 42).feedback).toBe('Custom instructions');
  saved.edit(input.repo, 42, 'feedback', '');
  saved.edit(input.repo, 42, 'model', 'opus');
  expect(storage().draft(input.repo, 42).feedback).toBe('');
});


it('includes request intent without confusing admission with execution or recommendation', () => {
  const saved = storage();
  saved.result('run', input.repo, 'run', { input: { ...input, action: 'launch', launch: { ...input.launch, mode: 'rerun' } }, receipt: { status: 'accepted', runId: 'run-id' } });
  saved.result('review', input.repo, 'review', { input: { repo: input.repo, number: 42, event: 'REQUEST_CHANGES' }, status: 'succeeded', result: { actor: 'reviewer' } });
  expect(saved.results(input.repo, 42)).toEqual([
    result({ status: 'accepted', runId: 'run-id', action: 'launch', mode: 'rerun' }),
    result({ kind: 'review', status: 'succeeded', actor: 'reviewer', event: 'REQUEST_CHANGES' }),
  ]);
});

it('sorts all matching records newest first before keeping the latest fifty', () => {
  const saved = storage();
  for (let index = 0; index < 60; index++) {
    vi.mocked(Date.now).mockReturnValue(index + 1);
    saved.result('run', input.repo, String(index), { input, receipt: { status: 'accepted', runId: `run-${index}` } });
  }
  const results = saved.results(input.repo, 42);
  expect(results).toHaveLength(50);
  expect(results[0]).toEqual(result({ status: 'accepted', runId: 'run-59', savedAt: 60 }));
  expect(results.at(-1)).toEqual(result({ status: 'accepted', runId: 'run-10', savedAt: 11 }));
});

it('skips individually malformed entries and keeps valid legacy records without timestamps', () => {
  const prefix = 'helmsman.pull-request.v1:core/pull-requests:result:run:';
  for (const [key, value] of Object.entries({ broken: '{', null: 'null', array: '[]', future: JSON.stringify({ version: 2, value: { input } }) })) localStorage.setItem(`${prefix}${key}`, value);
  localStorage.setItem(`${prefix}legacy`, JSON.stringify({ version: 1, savedAt: 'yesterday', value: { input, receipt: { status: {}, runId: 123, message: [] } } }));
  const saved = storage();
  saved.result('run', input.repo, 'valid', { input, receipt: { status: 'accepted', runId: 'run-id' } });
  expect(saved.results(input.repo, 42)).toEqual([
    result({ status: 'accepted', runId: 'run-id' }),
    result({ status: 'unknown', savedAt: null }),
  ]);
});


it('uses the immutable storage key as identity when newer results reorder history', () => {
  const saved = storage();
  const first = { input, receipt: { status: 'accepted', runId: 'run-id' } };
  saved.result('run', input.repo, 'first', first);
  const original = saved.results(input.repo, 42)[0];
  expect(original?.id).toBe('helmsman.pull-request.v1:core/pull-requests:result:run:["org/project","first"]');
  vi.mocked(Date.now).mockReturnValue(2000);
  saved.result('run', input.repo, 'newer', { input, receipt: { status: 'rejected' } });
  expect(saved.results(input.repo, 42)[1]).toEqual(original);
  expect(saved.results(input.repo, 42)[0]?.id).not.toBe(original?.id);
  saved.result('run', input.repo, 'first', first);
  expect(saved.results(input.repo, 42)[1]).toEqual(original);
});
