import { describe, expect, it, vi } from 'vitest';
import { parsePullRequestInspectDetailQueryV1, parsePullRequestInspectDetailV1, parsePullRequestInspectDiffQueryV1, parsePullRequestInspectDiffV1, PULL_REQUEST_INSPECT_LIMITS } from './pull-request-inspect';
import { inspectDetail as detail, inspectDiff as diff, inspectQuery as query, inspectTarget as target } from './pull-request-inspect.test-fixture';

describe('public PR inspection validation', () => {
  it('projects only public immutable fields and separates preview text from file enumeration', () => {
    const result = parsePullRequestInspectDetailV1({ ...detail, token: 'private', path: '/private' }, query);
    expect(result).toEqual(detail); expect(Object.isFrozen(result.target)).toBe(true);
    expect(parsePullRequestInspectDiffV1(diff, { version: 1, target })).toMatchObject({ quality: 'complete', files: [{ patchStatus: 'preview' }] });
  });
  it.each([null, {}, { ...query, repo: null }, { ...query, number: 0 }, { ...query, number: 1.1 }])('rejects malformed canonical query %j', value => {
    expect(() => parsePullRequestInspectDetailQueryV1(value)).toThrow();
  });
  it('rejects invalid target hashes and cross-target detail or diff responses', () => {
    expect(() => parsePullRequestInspectDiffQueryV1({ version: 1, target: { ...target, headSha: 'main' } })).toThrow();
    expect(() => parsePullRequestInspectDetailV1({ ...detail, target: { ...target, repo: 'other/project' } }, query)).toThrow();
    expect(() => parsePullRequestInspectDiffV1({ ...diff, target: { ...target, baseSha: 'c'.repeat(40) } }, { version: 1, target })).toThrow();
  });
  it('never accepts partial counts as exact zeros, or unsafe URLs', () => {
    expect(() => parsePullRequestInspectDetailV1({ ...detail, checks: { ...detail.checks, quality: 'partial' } }, query)).toThrow();
    expect(() => parsePullRequestInspectDetailV1({ ...detail, reviews: { ...detail.reviews, quality: 'unavailable' } }, query)).toThrow();
    expect(() => parsePullRequestInspectDetailV1({ ...detail, url: 'https://token@github.com/org/project' }, query)).toThrow();
    expect(() => parsePullRequestInspectDetailV1({ ...detail, url: 'javascript:alert(1)' }, query)).toThrow();
  });
  it('rejects contradictory completeness, duplicate files, missing patches and oversized patch payloads', () => {
    for (const value of [{ ...diff, truncated: true }, { ...diff, files: [diff.files[0], diff.files[0]] },
      { ...diff, files: [{ ...diff.files[0], patch: null }] }, { ...diff, files: [{ ...diff.files[0], patch: 'x'.repeat(PULL_REQUEST_INSPECT_LIMITS.patch + 1) }] }]) {
      expect(() => parsePullRequestInspectDiffV1(value, { version: 1, target })).toThrow();
    }
  });
  it('bounds total UTF byte output and rejects accessors without executing them', () => {
    const getter = vi.fn(); const value = { ...detail }; Object.defineProperty(value, 'title', { get: getter });
    expect(() => parsePullRequestInspectDetailV1(value, query)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const files = Array.from({ length: 9 }, (_, index) => ({ ...diff.files[0], filename: String(index), patch: 'x'.repeat(PULL_REQUEST_INSPECT_LIMITS.patch) }));
    expect(() => parsePullRequestInspectDiffV1({ ...diff, files }, { version: 1, target })).toThrow();
    const byteHeavy = Array.from({ length: 100 }, (_, index) => ({ ...diff.files[0], filename: String(index).padStart(1024, '\u0800'), previousFilename: '\u0800'.repeat(1024),
      patch: index < 8 ? '\u0001'.repeat(PULL_REQUEST_INSPECT_LIMITS.patch) : '', patchStatus: 'preview' }));
    expect(() => parsePullRequestInspectDiffV1({ ...diff, files: byteHeavy }, { version: 1, target })).toThrow();
  });
});

const emptyEvidence = () => ({ comments: { quality: 'complete' as const, truncated: false, items: [] }, changesRequested: { quality: 'complete' as const, truncated: false, items: [] },
  approved: { quality: 'complete' as const, truncated: false, items: [] }, requested: { quality: 'complete' as const, truncated: false, items: [] },
  checksPassed: { quality: 'complete' as const, truncated: false, items: [] }, checksFailed: { quality: 'complete' as const, truncated: false, items: [] }, checksPending: { quality: 'complete' as const, truncated: false, items: [] } });
const discussion = { id: 'comment:1', author: 'author', body: '<img src=x onerror=alert(1)>\nUser content', bodyTruncated: false, url: 'https://github.com/org/project/pull/42#issuecomment-1', createdAt: '2026-09-21T10:00:00Z' };
it('accepts optional independently qualified evidence and retains plain user content while projecting private fields away', () => {
  const evidence = { ...emptyEvidence(), comments: { quality: 'partial', truncated: true, items: [{ ...discussion, privateToken: 'hidden' }] },
    approved: { quality: 'complete', truncated: false, items: [{ id: 'user:alice', label: 'alice', url: null }] },
    requested: { quality: 'unavailable', truncated: false, items: [] } };
  const parsed = parsePullRequestInspectDetailV1({ ...detail, evidence }, query);
  expect(parsed.comments).toBe(detail.comments); expect(parsed.checks).toEqual(detail.checks);
  expect(parsed.evidence?.comments).toEqual({ quality: 'partial', truncated: true, items: [discussion] });
  expect(Object.isFrozen(parsed.evidence?.comments.items)).toBe(true);
  expect(parsePullRequestInspectDetailV1(detail, query)).not.toHaveProperty('evidence');
});
it('rejects malformed, contradictory, duplicate and oversized independently scoped evidence', () => {
  for (const comments of [null, { quality: 'complete', truncated: true, items: [] }, { quality: 'unavailable', truncated: false, items: [discussion] },
    { quality: 'complete', truncated: false, items: [discussion, discussion] }, { quality: 'complete', truncated: false, items: Array.from({ length: 101 }, (_, index) => ({ ...discussion, id: String(index) })) },
    { quality: 'partial', truncated: false, items: [{ ...discussion, body: 'é'.repeat(2049) }] },
    { quality: 'partial', truncated: false, items: [{ ...discussion, url: 'https://secret@github.com/a' }] },
    { quality: 'partial', truncated: false, items: [{ ...discussion, url: 'javascript:alert(1)' }] },
    { quality: 'partial', truncated: false, items: [{ ...discussion, createdAt: 'today' }] },
    { quality: 'partial', truncated: false, items: [{ ...discussion, bodyTruncated: undefined }] }]) {
    expect(() => parsePullRequestInspectDetailV1({ ...detail, evidence: { ...emptyEvidence(), comments } }, query)).toThrow();
  }
  const getter = vi.fn(() => 'body'); const comment = { ...discussion }; Object.defineProperty(comment, 'body', { get: getter });
  expect(() => parsePullRequestInspectDetailV1({ ...detail, evidence: { ...emptyEvidence(), comments: { quality: 'complete', truncated: false, items: [comment] } } }, query)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const items = Array.from({ length: 100 }, (_, index) => ({ ...discussion, id: String(index), body: '\n'.repeat(4096) }));
  expect(() => parsePullRequestInspectDetailV1({ ...detail, evidence: { ...emptyEvidence(), comments: { quality: 'complete', truncated: false, items }, changesRequested: { quality: 'complete', truncated: false, items } } }, query)).toThrow();
});
