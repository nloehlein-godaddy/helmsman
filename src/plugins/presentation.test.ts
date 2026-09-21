import { describe, expect, it, vi } from 'vitest';
import { parsePresentationLocatorV1, samePresentationLocatorV1, scopedPresentationLocatorV1 } from './presentation';

describe('public presentation identities', () => {
  it('validates and freezes canonical identities without private fields', () => {
    const source = { version: 1, kind: 'run', repo: 'Org/Repo', runId: 'run-1', private: '/secret' };
    const value = parsePresentationLocatorV1(source);
    expect(value).toEqual({ version: 1, kind: 'run', repo: 'Org/Repo', runId: 'run-1' });
    source.runId = 'changed'; expect(value).toHaveProperty('runId', 'run-1'); expect(Object.isFrozen(value)).toBe(true);
    expect(parsePresentationLocatorV1({ version: 1, kind: 'pull-request', repo: 'org/repo', number: 2 })).toHaveProperty('number', 2);
    expect(parsePresentationLocatorV1({ version: 1, kind: 'legacy-run', runId: 'run-1' })).toEqual({ version: 1, kind: 'legacy-run', runId: 'run-1' });
  });
  it('rejects malformed and accessor-backed locators without invoking accessors', () => {
    const getter = vi.fn(() => 'run');
    for (const value of [undefined, [], 1, { version: 2 }, { version: 1, kind: 'run', runId: '../run', repo: 'org/repo' },
      { version: 1, kind: 'pull-request', repo: 'org/repo', number: 0 }, { version: 1, kind: 'run', repo: 'org/repo', runId: 'x'.repeat(129) },
      Object.defineProperty({ version: 1 }, 'kind', { get: getter })]) expect(() => parsePresentationLocatorV1(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('keeps canonical selections within concrete scope while allowing All and scoped legacy resolution', () => {
    const run = { version: 1, kind: 'run', repo: 'org/a', runId: 'run-1' };
    expect(scopedPresentationLocatorV1(run, 'org/a')).toEqual(run);
    expect(scopedPresentationLocatorV1(run, null)).toEqual(run);
    expect(() => scopedPresentationLocatorV1(run, 'org/b')).toThrow('outside');
    expect(scopedPresentationLocatorV1(null, 'org/b')).toBeNull();
    expect(scopedPresentationLocatorV1({ version: 1, kind: 'legacy-run', runId: 'run-1' }, 'org/b')).toHaveProperty('kind', 'legacy-run');
  });
  it('compares locator values rather than field ordering or object identity', () => {
    const a = parsePresentationLocatorV1({ version: 1, kind: 'run', repo: 'org/a', runId: 'run-1' });
    const b = parsePresentationLocatorV1({ runId: 'run-1', repo: 'org/a', kind: 'run', version: 1 });
    expect(samePresentationLocatorV1(a, b)).toBe(true);
    expect(samePresentationLocatorV1(undefined, null)).toBe(true);
    expect(samePresentationLocatorV1(a, { version: 1, kind: 'legacy-run', runId: 'run-1' })).toBe(false);
  });
});
