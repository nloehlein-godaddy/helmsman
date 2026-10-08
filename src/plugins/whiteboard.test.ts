import { describe, expect, it } from 'vitest';
import { parseWhiteboardSnapshotV1, parseWhiteboardTargetV1 } from './whiteboard';
const target = { kind: 'pull-request', repo: 'owner/repo', number: 42, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
describe('Whiteboard public contract', () => {
  it('rejects mutable comparisons and browser-supplied paths', () => {
    expect(() => parseWhiteboardTargetV1({ ...target, headSha: 'main' })).toThrow();
    expect(() => parseWhiteboardTargetV1({ ...target, repositoryPath: '/private' })).toThrow();
    expect(() => parseWhiteboardTargetV1({ kind: 'run', repo: 'owner/repo', runId: '../run', expectedAttempt: 1 })).toThrow();
  });
  it('requires retained pins and a session for a ready board', () => {
    expect(() => parseWhiteboardSnapshotV1({ version: 1, target, status: 'ready', sessionId: null, baseSha: null, headSha: null, message: null })).toThrow();
  });
});
