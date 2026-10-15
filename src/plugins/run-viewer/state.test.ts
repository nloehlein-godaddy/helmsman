import { describe, expect, it } from 'vitest';
import type { RunInspectLogPageV1 } from '@helmsman/plugin-sdk';
import { mergeLog, newTab, readState, saveState, tabKey } from './state';

const target = { repo: 'org/a', runId: 'run-1', expectedAttempt: 1 };
const events = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => ({ sequence: from + index, at: '2026-09-20T00:00:00Z', kind: 'log', text: `event ${from + index}`, truncated: false }));
const page = (from: number, to: number, nextCursor: string | null, followCursor: string | null = null): RunInspectLogPageV1 => ({ version: 1, target, provenance: 'run-wide', observedAt: '2026-09-20T00:00:00Z', workerStatus: 'running', events: events(from, to), throughSequence: to, hasEarlier: nextCursor !== null, hasLater: false, nextCursor, followCursor });

describe('authored viewer bounded state', () => {
  it('keeps older pagination independent from the live follow cursor', () => {
    const tab = newTab({ repo: target.repo, runId: target.runId, follow: true, scrollTop: 0 });
    mergeLog(tab, page(51, 100, 'older-51', 'follow-100'), 'initial');
    mergeLog(tab, page(1, 50, null), 'older');
    expect(tab.followCursor).toBe('follow-100'); expect(tab.events.map(event => event.sequence)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    mergeLog(tab, page(101, 150, 'follow-150'), 'follow');
    expect(tab.olderCursor).toBeNull(); expect(tab.followCursor).toBe('follow-150');
  });
  it('bounds each live window at 300 events and marks released earlier data', () => {
    const tab = newTab({ repo: target.repo, runId: target.runId, follow: true, scrollTop: 0 });
    mergeLog(tab, page(1, 50, null, '50'), 'initial');
    for (let from = 51; from <= 401; from += 50) mergeLog(tab, page(from, from + 49, String(from + 49)), 'follow');
    expect(tab.events).toHaveLength(300); expect(tab.events[0]?.sequence).toBe(151); expect(tab.events.at(-1)?.sequence).toBe(450); expect(tab.olderTrimmed).toBe(true);
  });
  it('retains earlier browsing at a bounded size without replacing the follow cursor', () => {
    const tab = newTab({ repo: target.repo, runId: target.runId, follow: false, scrollTop: 44 });
    mergeLog(tab, page(401, 450, '400', '450'), 'initial');
    for (let from = 351; from >= 1; from -= 50) mergeLog(tab, page(from, from + 49, from > 1 ? String(from - 1) : null), 'older');
    expect(tab.events).toHaveLength(300); expect(tab.events[0]?.sequence).toBe(1); expect(tab.events.at(-1)?.sequence).toBe(300); expect(tab.newerTrimmed).toBe(true); expect(tab.followCursor).toBe('450');
  });
  it('persists tabs and scroll independently of logs, private paths or cursors', () => {
    const tab = newTab({ repo: target.repo, runId: target.runId, follow: false, scrollTop: 44 }); mergeLog(tab, page(1, 50, null, 'private-cursor'), 'initial');
    const value = saveState([tab], tabKey(tab), []);
    expect(readState(value)).toEqual({ tabs: [{ repo: 'org/a', runId: 'run-1', follow: false, scrollTop: 44 }], activeKey: tabKey(tab), results: [], logHeight: 420 });
    expect(JSON.stringify(value)).not.toContain('private-cursor'); expect(JSON.stringify(value)).not.toContain('event 1');
  });
  it('restores legacy heights and bounds persisted size preferences', () => {
    const legacy = { version: 1, value: { tabs: [], activeKey: null, results: [] } };
    expect(readState(legacy)?.logHeight).toBe(420);
    expect(readState(saveState([], null, [], 680))?.logHeight).toBe(680);
    for (const [height, expected] of [[0, 180], [1500, 1200], [NaN, 420], [Infinity, 420], [400.7, 401]]) {
      expect(readState(saveState([], null, [], height))?.logHeight).toBe(expected);
    }
  });
  it('preserves unknown or malformed saved state instead of overwriting it', () => {
    expect(readState({ version: 2, value: {} })).toBeNull();
    expect(readState({ version: 1, value: { tabs: [null], activeKey: null, results: [] } })).toBeNull();
    expect(readState({ version: 1, value: { tabs: [], activeKey: 'missing', results: [] } })).toBeNull();
  });
  it('round-trips the full public repository contract and rejects invalid owners', () => {
    const tab = newTab({ repo: `owner/${'r'.repeat(506)}`, runId: 'one', follow: true, scrollTop: 0 });
    expect(readState(saveState([tab], tabKey(tab), []))?.tabs[0]?.repo).toBe(tab.repo);
    const invalid = newTab({ ...tab, repo: 'owner.name/repository' });
    expect(readState(saveState([invalid], tabKey(invalid), []))).toBeNull();
  });
});
