import { describe, expect, it, vi } from 'vitest';
import { parsePublicationRequest, publishApprovedRevision, validatePublicationConnection } from './publication-client';

const connection = { url: 'http://127.0.0.1:8790/publication/v1', token: 'a'.repeat(64) };
const request = parsePublicationRequest({ version: 1, kind: 'pre-pr', approved: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), branch: 'agent/run', baseBranch: 'main', round: 1, reviewers: ['codex'], metadata: { stage: 'implement', round: 0 } } });
describe('coordinator publication client', () => {
  it('accepts only the authenticated loopback core endpoint', () => {
    expect(validatePublicationConnection(connection)).toEqual(connection);
    for (const url of ['https://example.com/publication/v1', 'http://127.0.0.1/publication/v1?target=remote', 'http://user:pass@127.0.0.1/publication/v1', 'http://127.0.0.1/git/push']) {
      expect(() => validatePublicationConnection({ ...connection, url })).toThrow();
    }
    expect(() => validatePublicationConnection({ ...connection, token: 'short' })).toThrow();
  });
  it('sends only approved evidence and rejects incomplete receipts without following redirects', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, prNumber: 12 })));
    expect(await publishApprovedRevision(connection, request, AbortSignal.timeout(1000), fetcher)).toBe(12);
    expect(fetcher).toHaveBeenCalledWith(connection.url, expect.objectContaining({ redirect: 'error', method: 'POST', body: JSON.stringify(request), headers: expect.objectContaining({ Authorization: `Bearer ${connection.token}` }) }));
    for (const value of [{ ok: true }, { ok: true, prNumber: -1 }, { ok: false, prNumber: 12 }, null]) {
      await expect(publishApprovedRevision(connection, request, AbortSignal.timeout(1000), async () => new Response(JSON.stringify(value)))).rejects.toThrow('reconciled');
    }
  });
});

it('accepts only retained reviewer identities and bounded immutable continuation stages', () => {
  const stage = 'review-resume-12345678-1234-4123-8123-123456789abc';
  expect(parsePublicationRequest({ ...request, approved: { ...request.approved, reviewStages: { codex: stage } } }).approved.reviewStages).toEqual({ codex: stage });
  for (const reviewStages of [null, [], { other: stage }, { codex: '../review' }, { codex: 'review' }, { codex: 1 }]) {
    expect(() => parsePublicationRequest({ ...request, approved: { ...request.approved, reviewStages } })).toThrow('Invalid approved');
  }
});
