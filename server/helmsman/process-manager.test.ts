import { describe, expect, it, vi } from 'vitest';
import { ProcessManager } from './process-manager';

describe('ProcessManager', () => {
  it('rejects a second run for the same repo (single-flight)', () => {
    const pm = new ProcessManager(4);
    expect(pm.canStart('o/r').ok).toBe(true);
    pm.add('r1', 'o/r', () => undefined);
    const res = pm.canStart('o/r');
    expect(res.ok).toBe(false);
  });

  it('rejects beyond max concurrency', () => {
    const pm = new ProcessManager(1);
    pm.add('r1', 'o/a', () => undefined);
    expect(pm.canStart('o/b').ok).toBe(false);
  });

  it('treats repository names as case-insensitive while preserving checkout casing', () => {
    const pm = new ProcessManager(4);
    pm.add('r1', 'Org/MyRepo', () => undefined);
    expect(pm.canStart('org/myrepo')).toMatchObject({ ok: false });
    expect(pm.canStart('ORG/MYREPO')).toMatchObject({ ok: false });
    expect(pm.canStart('org/another-repo')).toMatchObject({ ok: true });
    expect(pm.activeRepos()).toEqual(['Org/MyRepo']);
    pm.remove('r1');
    expect(pm.canStart('org/myrepo')).toMatchObject({ ok: true });
  });

  it('frees the slot on remove', () => {
    const pm = new ProcessManager(1);
    pm.add('r1', 'o/a', () => undefined);
    pm.remove('r1');
    expect(pm.canStart('o/b').ok).toBe(true);
  });

  it('stop invokes the run stopper and returns true', () => {
    const pm = new ProcessManager(4);
    const stop = vi.fn();
    pm.add('r1', 'o/a', stop);
    expect(pm.stop('r1')).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(pm.stop('missing')).toBe(false);
  });

  it('hasRun reflects whether a run id is tracked', () => {
    const pm = new ProcessManager(4);
    pm.add('r1', 'o/r', () => undefined);
    expect(pm.hasRun('r1')).toBe(true);
    expect(pm.hasRun('nope')).toBe(false);
    pm.remove('r1');
    expect(pm.hasRun('r1')).toBe(false);
  });

  it('restores unresolved durable ownership without falsely claiming an attached process', () => {
    let reservations = [{ runId: 'r1', repo: 'Org/A', reason: 'unresolved' }];
    const pm = new ProcessManager(2, { reservations: () => reservations });
    expect(pm.hasRun('r1')).toBe(true);
    expect(pm.hasAttached('r1')).toBe(false);
    expect(pm.stop('r1')).toBe(false);
    expect(pm.canStart('org/a')).toMatchObject({ ok: false });
    pm.add('r1', 'Org/A', () => {});
    expect(pm.count()).toBe(1);
    pm.remove('r1');
    expect(pm.count()).toBe(1);
    expect(pm.activeRepos()).toEqual(['Org/A']);
    reservations = [];
    expect(pm.canStart('org/a')).toEqual({ ok: true });
  });

  it('counts durable blocked attempts against global concurrency', () => {
    const pm = new ProcessManager(1, { reservations: () => [{ runId: 'blocked', repo: 'org/a' }] });
    expect(pm.canStart('org/b')).toEqual({ ok: false, reason: 'max concurrency reached' });
  });
});

it('applies current galleon opt-in independently of global limits and keeps lowered occupancy intact', () => {
  let maximum = 2;
  const pm = new ProcessManager(3, undefined, () => maximum);
  pm.add('one', 'org/repo', () => {}); expect(pm.canStart('org/repo').ok).toBe(true);
  pm.add('two', 'org/repo', () => {}); expect(pm.canStart('org/repo').ok).toBe(false);
  maximum = 1; expect(pm.count()).toBe(2); expect(pm.canStart('org/other').ok).toBe(true);
  pm.add('three', 'org/other', () => {}); expect(pm.canStart('org/new').ok).toBe(false);
});
