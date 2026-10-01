import { describe, expect, it } from 'vitest';
import { startupScope } from './startupScope';

describe('startup scope', () => {
  const resolve = (query: string, saved?: string | null) => startupScope(new URL(`https://helmsman.local/helm${query}`), ['org/a', 'org/b'], saved);
  it('requires a selection when missing, malformed, or no longer configured', () => {
    expect(resolve('')).toBeUndefined();
    expect(resolve('', 'invalid')).toBeUndefined();
    expect(resolve('', 'org/removed')).toBeUndefined();
    expect(resolve('?repo=invalid', 'org/a')).toBeUndefined();
  });
  it('restores a saved configured scope with its configured spelling', () => {
    expect(resolve('', 'ORG/A')).toBe('org/a');
  });
  it('honors explicit URL scope ahead of saved preferences', () => {
    expect(resolve('?repo=org/b', 'org/a')).toBe('org/b');
    expect(resolve('?repo=org/unavailable', 'org/a')).toBe('org/unavailable');
  });
  it('restores only an explicit All choice', () => {
    expect(resolve('', null)).toBeNull();
    expect(resolve('?repo=', 'org/a')).toBeNull();
  });
});
