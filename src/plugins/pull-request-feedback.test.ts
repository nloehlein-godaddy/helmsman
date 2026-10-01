// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { fingerprintPullRequestFeedbackSnapshotV1, parsePullRequestFeedbackSnapshotV1, PULL_REQUEST_FEEDBACK_LIMITS } from './pull-request-feedback';

const query = { version: 1 as const, repo: 'org/project', number: 42 };
const date = '2026-09-30T10:00:00Z';
const description = { id: 'description:42', kind: 'description', url: 'https://github.com/org/project/pull/42', body: '', updatedAt: date };
const comment = { id: 'comment:10', kind: 'comment', url: `${description.url}#issuecomment-10`, body: 'All findings\n\u0000stay unchanged.', updatedAt: date };
const snapshot = { version: 1, quality: 'complete', repo: query.repo, prNumber: query.number, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  headBranch: 'fix/feedback', baseBranch: 'main', state: 'OPEN', sources: [description, comment], fingerprint: '0'.repeat(64) };

describe('complete pull request feedback contract', () => {
  it('preserves full user bodies and produces deterministic canonical SHA256 evidence', async () => {
    const parsed = parsePullRequestFeedbackSnapshotV1(snapshot, query);
    expect(parsed.sources.map(source => source.id)).toEqual(['comment:10', 'description:42']);
    expect(parsed.sources[0]?.body).toBe(comment.body);
    const reordered = parsePullRequestFeedbackSnapshotV1({ ...snapshot, sources: [comment, description], fingerprint: 'f'.repeat(64) }, query);
    expect(await fingerprintPullRequestFeedbackSnapshotV1(parsed)).toBe(await fingerprintPullRequestFeedbackSnapshotV1(reordered));
    const { fingerprint: _fingerprint, ...content } = parsed;
    expect(await fingerprintPullRequestFeedbackSnapshotV1(parsed)).toBe(createHash('sha256').update(JSON.stringify(content)).digest('hex'));
    expect(Object.isFrozen(parsed.sources)).toBe(true);
  });

  it.each([{ body: 'Edited existing bot summary' }, { updatedAt: '2026-09-30T11:00:00Z' }, { url: `${description.url}#issuecomment-11` }])(
    'fingerprints changed source evidence %j', async patch => {
      const first = parsePullRequestFeedbackSnapshotV1(snapshot, query);
      const changed = parsePullRequestFeedbackSnapshotV1({ ...snapshot, sources: [description, { ...comment, ...patch }] }, query);
      expect(await fingerprintPullRequestFeedbackSnapshotV1(changed)).not.toBe(await fingerprintPullRequestFeedbackSnapshotV1(first));
    });

  it.each([null, [], { ...snapshot, quality: 'partial' }, { ...snapshot, truncated: true }, { ...snapshot, repo: 'other/project' },
    { ...snapshot, prNumber: 43 }, { ...snapshot, sources: [] }, { ...snapshot, sources: [comment] },
    { ...snapshot, sources: [description, comment, comment] }, { ...snapshot, sources: [null] },
    { ...snapshot, state: null }, { ...snapshot, headSha: 'bad' }, { ...snapshot, fingerprint: 'bad' }])('rejects incomplete or malformed evidence: %j', value => {
    expect(() => parsePullRequestFeedbackSnapshotV1(value, query)).toThrow();
  });

  it.each([{ body: null }, { updatedAt: 'yesterday' }, { id: 'comment:01' }, { id: 'comment:9007199254740992' },
    { url: 'http://github.com/org/project/pull/42' }, { url: 'https://secret@github.com/org/project/pull/42' },
    { replyTo: 'inline:12' }, { state: 'PENDING' }, { submittedAt: null }])('rejects malformed source fields %j', patch => {
    expect(() => parsePullRequestFeedbackSnapshotV1({ ...snapshot, sources: [description, { ...comment, ...patch }] }, query)).toThrow();
  });

  it('rejects sparse sources and accessor records before invoking getters', () => {
    expect(() => parsePullRequestFeedbackSnapshotV1({ ...snapshot, sources: new Array(1) }, query)).toThrow();
    const malicious = { ...snapshot, get fingerprint() { throw new Error('getter invoked'); } };
    expect(() => parsePullRequestFeedbackSnapshotV1(malicious, query)).toThrow('Invalid or incomplete');
  });

  it('retains pending review identity but rejects missing submission data and invalid reply references', () => {
    const review = { ...comment, id: 'review:20', kind: 'review', state: 'PENDING', submittedAt: null };
    expect(parsePullRequestFeedbackSnapshotV1({ ...snapshot, sources: [description, review] }, query).sources).toContainEqual(review);
    for (const patch of [{ state: 'APPROVED' }, { submittedAt: undefined }, { state: 'UNKNOWN' }]) {
      expect(() => parsePullRequestFeedbackSnapshotV1({ ...snapshot, sources: [description, { ...review, ...patch }] }, query)).toThrow();
    }
    expect(() => parsePullRequestFeedbackSnapshotV1({ ...snapshot, sources: [description,
      { ...comment, kind: 'inline', id: 'inline:10', replyTo: 'inline:10' }] }, query)).toThrow();
  });

  it('rejects oversize bodies rather than truncating them', () => {
    for (const body of ['x'.repeat(PULL_REQUEST_FEEDBACK_LIMITS.body + 1), '€'.repeat(Math.ceil(PULL_REQUEST_FEEDBACK_LIMITS.body / 2))]) {
      expect(() => parsePullRequestFeedbackSnapshotV1({ ...snapshot, sources: [description, { ...comment, body }] }, query)).toThrow();
    }
  });
});
