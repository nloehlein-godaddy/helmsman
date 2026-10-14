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
