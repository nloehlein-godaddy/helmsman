import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryRun } from './agents';
import { setPirateMode } from '../logic/terminology';

afterEach(() => {
  vi.unstubAllGlobals();
  setPirateMode(true);
  localStorage.clear();
});

describe('client error terminology', () => {
  it.each([true, false])('uses the selected mode for generated errors: pirate=%s', async enabled => {
    setPirateMode(enabled);
    const request = vi.fn().mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', request);
    await expect(retryRun('bad/id')).rejects.toThrow(enabled ? 'Invalid voyage ID.' : 'Invalid run ID.');
    expect(request).not.toHaveBeenCalled();
    await expect(retryRun('run-1')).rejects.toThrow(enabled
      ? 'The server did not return a new voyage ID. Check recent voyages before retrying.'
      : 'The server did not return a new run ID. Check recent runs before retrying.');

  });

  it('preserves server error content', async () => {
    setPirateMode(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Custom voyage failure from tool' }), { status: 409 })));
    await expect(retryRun('run-1')).rejects.toThrow('Custom voyage failure from tool');
  });
});
