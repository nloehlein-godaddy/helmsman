import type { CommunicationReviewTriggerProviderV1, TriggerReviewTargetV1 } from '@helmsman/plugin-sdk';

export interface SlackReviewTriggerSettings {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly overlapSeconds: number;
  readonly repoFilter: readonly string[];
}

function githubRepo(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[a-z\d_.-]+$/i.test(value)) return null;
  return value.toLowerCase();
}

export function parseRepoFilterJson(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length > 100) throw new TypeError('Invalid Slack review repository filter');
  const repos = parsed.map(githubRepo);
  if (repos.some(repo => repo === null) || new Set(repos).size !== repos.length) throw new TypeError('Invalid Slack review repository filter');
  return repos as string[];
}

export function parsePullRequestUrl(value: unknown): { repo: string; number: number } | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return null;
  const match = /^\/([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(url.pathname);
  if (!match) return null;
  const number = Number(match[3]);
  const repo = githubRepo(`${match[1]}/${match[2]}`);
  return repo && Number.isSafeInteger(number) ? { repo, number } : null;
}

function seconds(value: string | null): number | null {
  if (value === null || !/^\d{10,}\.\d{1,6}$/.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function activeTarget(target: TriggerReviewTargetV1 | null, repo: string, number: number): target is TriggerReviewTargetV1 {
  return target !== null && target.repo.toLowerCase() === repo && target.number === number && target.status === 'open' && !target.draft;
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Trigger scan aborted');
}

export function slackReviewTriggerProvider(settings: SlackReviewTriggerSettings): CommunicationReviewTriggerProviderV1 {
  const filter = new Set(settings.repoFilter.map(repo => repo.toLowerCase()));
  return {
    metadata: { version: 1, label: 'Slack review discovery', kind: 'review-watch', intervalMs: settings.intervalMs, source: 'communication' },
    async scan(input, context) {
      if (!settings.enabled) return { proposals: [], nextCursor: input.cursor, complete: false };
      abort(context.signal);
      const activated = Date.parse(input.activatedAt) / 1000;
      const cursor = seconds(input.cursor) ?? activated;
      const since = Math.max(activated, cursor - settings.overlapSeconds).toFixed(6);
      const batch = await context.messages({ since });
      abort(context.signal);
      let complete = batch.complete;
      let nextCursor = Math.max(cursor, activated);
      const proposals = [];
      const seen = new Set<string>();
      const details = new Map<string, TriggerReviewTargetV1 | null>();
      messages: for (const message of batch.items) {
        abort(context.signal);
        const messageTime = seconds(message?.ts);
        if (messageTime === null || messageTime < activated) continue;
        nextCursor = Math.max(nextCursor, messageTime);
        for (const value of message.prUrls ?? []) {
          const parsed = parsePullRequestUrl(value);
          if (!parsed || filter.size > 0 && !filter.has(parsed.repo)) continue;
          const detailKey = `${parsed.repo}#${parsed.number}`;
          let target = details.get(detailKey);
          if (target === undefined && !details.has(detailKey)) {
            if (details.size >= 100) { complete = false; break messages; }
            target = await context.detail(parsed);
            abort(context.signal);
            details.set(detailKey, target);
          }
          if (target === null || target === undefined) { complete = false; continue; }
          if (!activeTarget(target, parsed.repo, parsed.number)) continue;
          const key = `${message.eventId}\u0000${target.targetId}`;
          if (seen.has(key)) continue;
          if (proposals.length >= 100) { complete = false; break messages; }
          seen.add(key);
          proposals.push({
            eventId: message.eventId,
            targetId: target.targetId,
            workflowRef: input.defaultWorkflowRef,
            sourceUrl: message.permalink,
            author: message.author,
            channelName: message.channelId,
          });
        }
      }
      return { proposals, nextCursor: complete ? nextCursor.toFixed(6) : input.cursor, complete };
    },
  };
}
