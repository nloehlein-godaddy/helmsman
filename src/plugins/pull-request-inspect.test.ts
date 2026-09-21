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
