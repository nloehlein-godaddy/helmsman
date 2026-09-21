import { describe, expect, it, vi } from 'vitest';
import type { PullRequestReviewTriggerContextV1, ReviewTriggerInputV1, TriggerReviewTargetV1 } from '../trigger';
import { githubReviewTriggerProvider } from './provider';

const input: ReviewTriggerInputV1 = { version: 1, activatedAt: '2026-09-21T00:00:00Z', cursor: null, defaultWorkflowRef: 'review@1' };
function target(repo: string, number: number, changes: Partial<TriggerReviewTargetV1> = {}): TriggerReviewTargetV1 {
  return { targetId: `${repo}#${number}@head`, repo, number, headSha: 'a'.repeat(40), title: 'Review me', url: `https://github.com/${repo}/pull/${number}`, status: 'open', draft: false, ...changes };
}

describe('GitHub requested-review trigger', () => {
  it('proposes only open non-draft observed details and preserves partial quality', async () => {
    const requested = vi.fn(async () => ({ items: [{ repo: 'org/open', number: 1 }, { repo: 'org/draft', number: 2 }, { repo: 'org/missing', number: 3 }], quality: 'partial' as const, truncated: false }));
    const detail = vi.fn(async ({ repo, number }: { repo: string; number: number }) => repo === 'org/missing' ? null : target(repo, number, { draft: repo === 'org/draft' }));
    const context: PullRequestReviewTriggerContextV1 = { source: 'pull-request', signal: new AbortController().signal, requested, detail };
    const provider = githubReviewTriggerProvider({ enabled: true, intervalMs: 300_000 });
    await expect(provider.scan(input, context)).resolves.toEqual({
      proposals: [{ eventId: null, targetId: 'org/open#1@head', workflowRef: 'review@1', sourceUrl: 'https://github.com/org/open/pull/1', author: 'GitHub', channelName: 'GitHub requested reviews' }],
      nextCursor: null,
      complete: false,
    });
    expect(detail).toHaveBeenCalledTimes(3);
  });

  it('does not read or claim completeness while disabled', async () => {
    const requested = vi.fn();
    const context = { source: 'pull-request' as const, signal: new AbortController().signal, requested, detail: vi.fn() };
    await expect(githubReviewTriggerProvider({ enabled: false, intervalMs: 300_000 }).scan(input, context)).resolves.toEqual({ proposals: [], nextCursor: null, complete: false });
    expect(requested).not.toHaveBeenCalled();
  });
});
