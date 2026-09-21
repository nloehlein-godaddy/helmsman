import { describe, expect, it } from 'vitest';
import { parseRunInspectExportMetadataV1, parseRunInspectHistoryPageV1, parseRunInspectLogPageV1, parseRunInspectLogQueryV1,
  parseRunInspectResolvedV1, RunInspectValidationError } from './run-inspect';

const target = { repo: 'owner/project', runId: 'run-1', expectedAttempt: 1 }; const observedAt = '2026-09-20T12:00:00Z';
const query = { version: 1 as const, target, direction: 'backward' as const, cursor: null, limit: 2 };
const page = { version: 1, target, provenance: 'run-wide', observedAt, workerStatus: 'running', events: [{ sequence: 1, at: observedAt, kind: 'log', text: '<script>literal</script>', truncated: false }],
  throughSequence: 1, hasEarlier: false, hasLater: false, nextCursor: null, followCursor: 'follow' };
describe('run inspection public contracts', () => {
  it('returns immutable run-wide events and rejects unknown attempts and directions', () => {
    const parsed = parseRunInspectLogPageV1(page, query); expect(Object.isFrozen(parsed.events[0])).toBe(true); expect(parsed.events[0]?.text).toBe('<script>literal</script>');
    expect(() => parseRunInspectLogQueryV1({ ...query, target: { ...target, expectedAttempt: 0 } })).toThrow();
    expect(() => parseRunInspectLogQueryV1({ ...query, direction: 'forward' })).toThrow(); expect(() => parseRunInspectLogQueryV1({ ...query, limit: 51 })).toThrow();
  });
  it.each([
    { target: { ...target, repo: 'other/project' } }, { target: { ...target, expectedAttempt: 2 } }, { provenance: 'attempt' }, { throughSequence: 0 },
    { hasEarlier: true }, { followCursor: null }, { events: [{ ...page.events[0], truncated: null }] }, { events: [{ ...page.events[0], text: 'x'.repeat(4001) }] },
    { events: [page.events[0], page.events[0]] }, { events: Array(1) },
  ])('rejects false identity, bounds, continuation or malformed event data %j', change => {
    expect(() => parseRunInspectLogPageV1({ ...page, ...change }, query)).toThrow(RunInspectValidationError);
  });
  it('never evaluates accessors in external DTOs', () => {
    const unsafe = { ...page }; Object.defineProperty(unsafe, 'events', { get() { throw new Error('Accessor executed'); } });
    expect(() => parseRunInspectLogPageV1(unsafe, query)).toThrow(RunInspectValidationError);
  });
  it('accepts unknown totals only with truthful coverage and quality', () => {
    const query = { version: 1 as const, repo: target.repo, kind: 'all' as const, limit: 2, cursor: null };
    const history = { version: 1, repo: target.repo, items: [], nextCursor: null, total: null, totalQuality: 'unknown', coverage: 'insertion-bounded-current-state', observedAt };
    expect(parseRunInspectHistoryPageV1(history, query, [target.repo]).total).toBeNull();
    expect(() => parseRunInspectHistoryPageV1({ ...history, totalQuality: 'exact' }, query, [target.repo])).toThrow();
    expect(() => parseRunInspectHistoryPageV1({ ...history, coverage: 'immutable-snapshot' }, query, [target.repo])).toThrow();
  });
  it('checks resolved scope and safe export filenames without disclosing foreign metadata', () => {
    expect(() => parseRunInspectResolvedV1({ version: 1, target, observedAt }, { version: 1, runId: target.runId }, ['other/repo'])).toThrow();
    const value = { version: 1, target, observedAt, provenance: 'run-wide', throughSequence: 0, filename: 'helmsman-run-1.log', contentType: 'text/plain; charset=utf-8' };
    expect(parseRunInspectExportMetadataV1(value, { version: 1, target }).filename).toBe(value.filename);
    expect(() => parseRunInspectExportMetadataV1({ ...value, filename: '../../unsafe' }, { version: 1, target })).toThrow();
  });
});
