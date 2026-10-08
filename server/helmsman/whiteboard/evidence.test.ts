import { expect, it } from 'vitest';
import { boundWhiteboardDiff } from './evidence';
import type { PullRequestInspectDiffV1 } from '../../../src/plugins/pull-request-inspect';
import { validateWhiteboardSources } from './generator';
import type { WhiteboardEvidence } from './service';
it('bounds previews fairly and adjusts source ranges to retained lines', () => {
  const patch = '@@ -1,1000 +1,1000 @@\n' + Array.from({ length: 1000 }, () => ' ' + 'x'.repeat(100)).join('\n');
  const diff: PullRequestInspectDiffV1 = { version: 1, target: { repo: 'owner/repo', number: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }, observedAt: new Date().toISOString(), coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false,
    files: Array.from({ length: 20 }, (_, index) => ({ filename: `file${index}.ts`, previousFilename: null, status: 'modified', additions: 0, deletions: 0, patchStatus: 'preview', patch })) };
  const result = boundWhiteboardDiff(diff);
  expect(result.quality).toBe('partial');
  expect(result.files.every(file => file.patch?.startsWith('@@ -1,14 +1,14 @@'))).toBe(true);
  expect(result.files.reduce((total, file) => total + Buffer.byteLength(file.patch ?? ''), 0)).toBeLessThanOrEqual(32_768);
});
it('caps UTF-8 previews despite oversized hunk context and forbids citations into omitted tails', () => {
  const patch = `@@ -10,100 +20,100 @@${'界'.repeat(5000)}\n${Array.from({ length: 100 }, () => ' ' + '界'.repeat(60)).join('\n')}`;
  const diff: PullRequestInspectDiffV1 = { version: 1, target: { repo: 'owner/repo', number: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }, observedAt: new Date().toISOString(), coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false,
    files: Array.from({ length: 20 }, (_, index) => ({ filename: `file${index}.ts`, previousFilename: null, status: 'modified', additions: 0, deletions: 0, patchStatus: 'preview', patch })) };
  const bounded = boundWhiteboardDiff(diff);
  expect(bounded.files.reduce((total, file) => total + Buffer.byteLength(file.patch ?? ''), 0)).toBeLessThanOrEqual(32_768);
  expect(bounded.files[0]?.patch?.split('\n')[0]).not.toContain('界');
  const match = bounded.files[0]?.patch?.match(/^@@ -10,(\d+) \+20,(\d+) @@/);
  expect(match).not.toBeNull(); const last = 20 + Number(match?.[2]) - 1;
  const evidence: WhiteboardEvidence = { version: 1, target: { kind: 'pull-request', ...diff.target }, title: 'Bounded preview', comparison: diff.target, diff: bounded, run: null };
  const document = { summary: 'Partial preview.', requirements: [], design: 'Observed change.', implementation: [`[file0.ts](review-source:head/file0.ts#L${last})`], diagram: { nodes: [{ id: 'file', label: 'file0.ts' }], edges: [] } };
  expect(() => validateWhiteboardSources(document, evidence)).not.toThrow();
  expect(() => validateWhiteboardSources({ ...document, implementation: [`[file0.ts](review-source:head/file0.ts#L${last + 1})`] }, evidence)).toThrow();
});
it('normalizes upstream truncated hunks even when their preview is below the byte quota', () => {
  const diff: PullRequestInspectDiffV1 = { version: 1, target: { repo: 'owner/repo', number: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }, observedAt: new Date().toISOString(), coverage: 'immutable-comparison-preview', quality: 'complete', truncated: false,
    files: [{ filename: 'parser.ts', previousFilename: null, status: 'modified', additions: 0, deletions: 0, patchStatus: 'truncated', patch: '@@ -1,1000 +1,1000 @@\n first\n second' }] };
  const bounded = boundWhiteboardDiff(diff);
  expect(bounded).toMatchObject({ truncated: true, quality: 'partial' });
  expect(bounded.files[0]?.patch).toBe('@@ -1,2 +1,2 @@\n first\n second');
  const evidence: WhiteboardEvidence = { version: 1, target: { kind: 'pull-request', ...diff.target }, title: 'Truncated preview', comparison: diff.target, diff: bounded, run: null };
  const document = { summary: 'Partial preview.', requirements: [], design: 'Observed change.', implementation: ['[parser.ts](review-source:head/parser.ts#L2)'], diagram: { nodes: [{ id: 'parser', label: 'parser.ts' }], edges: [] } };
  expect(() => validateWhiteboardSources(document, evidence)).not.toThrow();
  expect(() => validateWhiteboardSources({ ...document, implementation: ['[parser.ts](review-source:head/parser.ts#L900)'] }, evidence)).toThrow();
});
