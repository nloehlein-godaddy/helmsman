import { describe, expect, it, vi } from 'vitest';
import type { ReviewTriggerInputV1, TriggerMessageV1, TriggerReviewTargetV1 } from '../trigger';
import { parsePullRequestUrl, parseRepoFilterJson, slackReviewTriggerProvider } from './provider';

const input: ReviewTriggerInputV1 = { version: 1, activatedAt: '2025-01-01T00:00:00Z', cursor: '1760000000.000000', defaultWorkflowRef: 'review@1' };
function target(repo: string, number: number, changes: Partial<TriggerReviewTargetV1> = {}): TriggerReviewTargetV1 {
  return { targetId: `${repo}#${number}@head`, repo, number, headSha: 'a'.repeat(40), title: 'Review me', url: `https://github.com/${repo}/pull/${number}`, status: 'open', draft: false, ...changes };
}
function context(items: readonly TriggerMessageV1[]) {
  const messages = vi.fn(async () => ({ items, complete: true }));
  const detail = vi.fn(async ({ repo, number }: { repo: string; number: number }): Promise<TriggerReviewTargetV1 | null> => target(repo, number));
  return { value: { source: 'communication' as const, signal: new AbortController().signal, messages, detail }, messages, detail };
}

describe('Slack review trigger', () => {
  it('parses canonical GitHub pull request URLs only', () => {
    expect(parsePullRequestUrl('https://github.com/Org/Repo/pull/42')).toEqual({ repo: 'org/repo', number: 42 });
    for (const value of ['http://github.com/org/repo/pull/42', 'https://evil.test/org/repo/pull/42', 'https://github.com/org/repo/issues/42', 'https://github.com/org/repo/pull/42?x=1', null]) {
      expect(parsePullRequestUrl(value)).toBeNull();
    }
  });

  it('applies overlap, repository filtering, exact detail status, and message identity', async () => {
    const fixture = context([{
      eventId: 'event-1', channelId: 'C001', ts: '1760000010.000000', permalink: 'https://team.slack.com/archives/C001/p1', author: 'Ada',
      prUrls: ['https://github.com/org/allowed/pull/42', 'https://github.com/org/blocked/pull/7'],
    }]);
    const provider = slackReviewTriggerProvider({ enabled: true, intervalMs: 300_000, overlapSeconds: 300, repoFilter: ['org/allowed'] });
    await expect(provider.scan(input, fixture.value)).resolves.toEqual({
      proposals: [{ eventId: 'event-1', targetId: 'org/allowed#42@head', workflowRef: 'review@1', sourceUrl: 'https://team.slack.com/archives/C001/p1', author: 'Ada', channelName: 'C001' }],
      nextCursor: '1760000010.000000',
      complete: true,
    });
    expect(fixture.messages).toHaveBeenCalledWith({ since: '1759999700.000000' });
    expect(fixture.detail).toHaveBeenCalledExactlyOnceWith({ repo: 'org/allowed', number: 42 });
  });

  it('retains the cursor for incomplete detail and makes no reads when disabled', async () => {
    const fixture = context([{ eventId: 'event-1', channelId: 'C001', ts: '1760000010.000000', permalink: '', author: '', prUrls: ['https://github.com/org/repo/pull/42'] }]);
    fixture.detail.mockResolvedValue(null);
    const provider = slackReviewTriggerProvider({ enabled: true, intervalMs: 300_000, overlapSeconds: 300, repoFilter: [] });
    await expect(provider.scan(input, fixture.value)).resolves.toEqual({ proposals: [], nextCursor: input.cursor, complete: false });
    const disabled = slackReviewTriggerProvider({ enabled: false, intervalMs: 300_000, overlapSeconds: 300, repoFilter: [] });
    await expect(disabled.scan(input, fixture.value)).resolves.toEqual({ proposals: [], nextCursor: input.cursor, complete: false });
    expect(fixture.messages).toHaveBeenCalledTimes(1);
  });

  it('bounds distinct detail reads and proposals without advancing the cursor', async () => {
    const urls = Array.from({ length: 101 }, (_, index) => `https://github.com/org/repo/pull/${index + 1}`);
    const fixture = context([
      { eventId: 'event-1', channelId: 'C001', ts: '1760000010.000000', permalink: '', author: '', prUrls: urls.slice(0, 100) },
      { eventId: 'event-2', channelId: 'C001', ts: '1760000020.000000', permalink: '', author: '', prUrls: urls.slice(100) },
    ]);
    const provider = slackReviewTriggerProvider({ enabled: true, intervalMs: 300_000, overlapSeconds: 300, repoFilter: [] });
    const result = await provider.scan(input, fixture.value);
    expect(result).toMatchObject({ nextCursor: input.cursor, complete: false });
    expect(result.proposals).toHaveLength(100);
    expect(fixture.detail).toHaveBeenCalledTimes(100);
  });

  it('validates bounded unique repository filters', () => {
    expect(parseRepoFilterJson('["Org/Repo"]')).toEqual(['org/repo']);
    expect(() => parseRepoFilterJson('["org/repo","ORG/REPO"]')).toThrow('Invalid Slack review repository filter');
    expect(() => parseRepoFilterJson('{}')).toThrow('Invalid Slack review repository filter');
  });
});
