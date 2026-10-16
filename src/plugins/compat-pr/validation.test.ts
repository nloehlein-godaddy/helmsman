import { expect, it, vi } from 'vitest';
import { inspectDetail, inspectQuery } from '../pull-request-inspect.test-fixture';
import { validDetail, validList } from './validation';

const evidence = () => Object.fromEntries(['comments', 'changesRequested', 'approved', 'requested', 'checksPassed', 'checksFailed', 'checksPending'].map(key => [key, { quality: 'complete', truncated: false, items: [] }]));
const comment = { id: 'comment:1', author: null, body: '<b>Raw text</b>', bodyTruncated: false, url: null, createdAt: null };
it('validates optional review-request author and personal review history without treating absent history as false', () => {
  const row = { repo: 'org/b', number: 42, title: 'Review current work', status: 'open', comments: 0 };
  const page = (fields: object) => ({ version: 1, repo: 'org/b', items: [{ ...row, ...fields }] });
  for (const fields of [{}, { authorLogin: null, viewerHasReviewed: null }, { authorLogin: 'writer', viewerHasReviewed: false }, { viewerHasReviewed: true }]) expect(validList(page(fields), 'org/b')).toBe(true);
  for (const fields of [{ authorLogin: {} }, { authorLogin: '' }, { authorLogin: 'a'.repeat(129) }, { viewerHasReviewed: 'false' }, { viewerHasReviewed: 0 }]) expect(validList(page(fields), 'org/b')).toBe(false);
});
it('accepts legacy detail and independently qualified bounded evidence at the authored panel boundary', () => {
  expect(validDetail(inspectDetail, inspectQuery)).toBe(true);
  expect(validDetail({ ...inspectDetail, evidence: { ...evidence(), comments: { quality: 'partial', truncated: true, items: [comment] } } }, inspectQuery)).toBe(true);
});
it('rejects malformed evidence before rendering without executing accessors', () => {
  for (const comments of [null, { quality: 'complete', truncated: false, items: {} }, { quality: 'complete', truncated: true, items: [] },
    { quality: 'unavailable', truncated: false, items: [comment] }, { quality: 'partial', truncated: false, items: [comment, comment] },
    { quality: 'partial', truncated: false, items: [{ ...comment, body: 'é'.repeat(2049) }] },
    { quality: 'partial', truncated: false, items: [{ ...comment, url: 'javascript:alert(1)' }] }]) expect(validDetail({ ...inspectDetail, evidence: { ...evidence(), comments } }, inspectQuery)).toBe(false);
  const getter = vi.fn(() => []); const list = { quality: 'complete', truncated: false }; Object.defineProperty(list, 'items', { get: getter });
  expect(validDetail({ ...inspectDetail, evidence: { ...evidence(), comments: list } }, inspectQuery)).toBe(false); expect(getter).not.toHaveBeenCalled();
  const items = Array.from({ length: 100 }, (_, index) => ({ ...comment, id: String(index), body: '\n'.repeat(4096) }));
  expect(validDetail({ ...inspectDetail, evidence: { ...evidence(), comments: { quality: 'partial', truncated: true, items } } }, inspectQuery)).toBe(false);
});
