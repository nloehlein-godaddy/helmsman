import { describe, expect, it } from 'vitest';
import { retainedRunTitle } from './run-title';

describe('retained run titles', () => {
  it('reads only valid text from retained task objects', () => {
    expect(retainedRunTitle(JSON.stringify({ title: '  Fix login failure  ', secret: 'private' }))).toBe('Fix login failure');
    for (const value of [null, undefined, '', '{broken', 'null', '[]', '42', '{"title":42}', '{"title":" "}', JSON.stringify({ title: 'line\nfeed' })]) {
      expect(retainedRunTitle(value)).toBeNull();
    }
  });
  it('bounds titles without splitting a supplementary Unicode character', () => {
    expect(retainedRunTitle(JSON.stringify({ title: 'x'.repeat(511) + '🛟' }))).toBe('x'.repeat(511));
    expect(retainedRunTitle(JSON.stringify({ title: 'x'.repeat(513) }))).toHaveLength(512);
  });
});
