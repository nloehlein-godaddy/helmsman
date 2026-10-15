import { beforeEach, expect, it } from 'vitest';
import { PrStorage } from './storage';

beforeEach(() => localStorage.clear());
const storage = () => new PrStorage('core/pull-requests');
const input = { repo: 'org/project', launch: { prNumber: 42 } };

it('shows the rejection explanation from previously saved run receipts', () => {
  localStorage.setItem('helmsman.pull-request.v1:core/pull-requests:result:run:legacy', JSON.stringify({ version: 1, value: {
    input, receipt: { status: 'rejected', runId: 'original-run', message: 'Branch ownership is retained by failed run old-run. Reconcile its ownership before retrying.' },
  } }));
  expect(storage().results(input.repo, 42)).toEqual(['Saved run result: rejected · original-run — Branch ownership is retained by failed run old-run. Reconcile its ownership before retrying.']);
});

it('keeps legacy saved labels when explanations are absent', () => {
  const saved = storage();
  saved.result('run', input.repo, 'run', { input, receipt: { status: 'accepted', runId: 'run-id' } });
  saved.result('review', input.repo, 'review', { input: { repo: input.repo, number: 42 }, status: 'succeeded', result: { actor: 'reviewer' } });
  expect(saved.results(input.repo, 42)).toEqual(['Saved run result: accepted · run-id', 'Saved review result: succeeded by reviewer']);
});

it('shows review failure reasons as literal text', () => {
  const saved = storage();
  saved.result('review', input.repo, 'review', { input: { repo: input.repo, number: 42 }, status: 'rejected', reason: ' Head changed: <b>refresh</b> & try again. ' });
  expect(saved.results(input.repo, 42)).toEqual(['Saved review result: rejected — Head changed: <b>refresh</b> & try again.']);
});

it('ignores invalid and empty explanations while bounding retained output', () => {
  const saved = storage();
  saved.result('run', input.repo, 'invalid', { input, receipt: { status: 'rejected', message: { text: 'unsafe' } } });
  saved.result('run', input.repo, 'blank', { input, receipt: { status: 'rejected', message: '   ' } });
  saved.result('run', input.repo, 'long', { input, receipt: { status: 'rejected', message: 'x'.repeat(3000) } });
  expect(saved.results(input.repo, 42)).toEqual(['Saved run result: rejected', 'Saved run result: rejected', `Saved run result: rejected — ${'x'.repeat(2048)}`]);
});

it('keeps saved explanations scoped to their contribution, galleon, and pull request', () => {
  const saved = storage();
  saved.result('run', input.repo, 'matching', { input, receipt: { status: 'rejected', message: 'Matching request' } });
  saved.result('run', input.repo, 'other-pr', { input: { ...input, launch: { prNumber: 43 } }, receipt: { status: 'rejected', message: 'Other pull request' } });
  saved.result('run', 'org/other', 'other-repo', { input: { ...input, repo: 'org/other' }, receipt: { status: 'rejected', message: 'Other galleon' } });
  new PrStorage('other/pull-requests').result('run', input.repo, 'other-plugin', { input, receipt: { status: 'rejected', message: 'Other contribution' } });
  expect(saved.results(input.repo, 42)).toEqual(['Saved run result: rejected — Matching request']);
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
