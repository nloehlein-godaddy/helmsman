import type { PullRequestReviewTriggerProviderV1 } from '@helmsman/plugin-sdk';

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Trigger scan aborted');
}

export function githubReviewTriggerProvider(settings: { readonly enabled: boolean; readonly intervalMs: number }): PullRequestReviewTriggerProviderV1 {
  return {
    metadata: { version: 1, label: 'GitHub requested reviews', kind: 'review-watch', intervalMs: settings.intervalMs, source: 'pull-request' },
    async scan(input, context) {
      if (!settings.enabled) return { proposals: [], nextCursor: null, complete: false };
      abort(context.signal);
      const requested = await context.requested();
      abort(context.signal);
      let complete = requested.quality === 'complete' && !requested.truncated;
      const proposals = [];
      for (const item of requested.items) {
        abort(context.signal);
        const target = await context.detail(item);
        abort(context.signal);
        if (target === null) { complete = false; continue; }
        if (target.repo.toLowerCase() !== item.repo.toLowerCase() || target.number !== item.number || target.status !== 'open' || target.draft) continue;
        proposals.push({
          eventId: null,
          targetId: target.targetId,
          workflowRef: input.defaultWorkflowRef,
          sourceUrl: target.url,
          author: 'GitHub',
          channelName: 'GitHub requested reviews',
        });
      }
      return { proposals, nextCursor: null, complete };
    },
  };
}
