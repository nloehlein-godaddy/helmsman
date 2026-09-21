import { parsePullRequestInspectDetailV1 } from '../../src/plugins/pull-request-inspect';
import { parsePullRequestReadItemV1, parsePullRequestReadPageV1 } from '../../src/plugins/pull-request-read';
import type { PullRequestProviderContextV1, PullRequestProviderV1 } from '../../src/plugins/pull-request-provider';
import type { TriggerReviewDetailInputV1 } from '../../src/plugins/trigger';
import { parseTaskRepo } from '../../src/plugins/tasks';
import type { ArtifactBinding, ProviderBinding } from './execution-store';
import { persistenceHash } from './persistence';

export interface TriggerPullRequestReadCapture {
  binding: ProviderBinding;
  artifacts: readonly ArtifactBinding[];
  revision: string;
  repos?: readonly string[];
  settings?: Readonly<Record<string, import('../../src/plugins/backend').PluginJson>>;
  provider: PullRequestProviderV1;
  context: PullRequestProviderContextV1;
  assertCurrent(): void;
}
export interface TriggerCommunicationReadCapture {
  sourceKey: string;
  revision: string;
  bindings: readonly ProviderBinding[];
  artifacts: readonly ArtifactBinding[];
  channelId: string;
  channelName: string;
  assertCurrent(): void;
  messages(input: { since: string | null }): Promise<{ messages: readonly { channelId: string; ts: string; permalink: string; author: string; prUrls: readonly string[] }[]; complete: boolean }>;
}

export function captureTriggerReviewSource(options: {
  role: 'slack-review' | 'github-review';
  signal: AbortSignal;
  repos(): readonly string[];
  pullRequest: TriggerPullRequestReadCapture;
  communication?: TriggerCommunicationReadCapture;
}) {
  const { pullRequest, communication, signal } = options;
  if ((options.role === 'slack-review') !== Boolean(communication)) throw new Error('Trigger source does not match its role');
  const scope = () => [...new Set(options.repos().map(parseTaskRepo))].sort();
  const repos = scope(); const scopeHash = persistenceHash(repos);
  const source = Object.freeze({ sourceKey: communication?.sourceKey ?? 'github-review-requests',
    revision: persistenceHash({ pullRequest: pullRequest.revision, communication: communication?.revision ?? null, repos }),
    bindings: Object.freeze([pullRequest.binding, ...(communication?.bindings ?? [])]) });
  const artifacts = new Map<string, ArtifactBinding>();
  for (const artifact of [...pullRequest.artifacts, ...(communication?.artifacts ?? [])]) {
    const previous = artifacts.get(artifact.pluginId);
    if (previous && persistenceHash(previous) !== persistenceHash(artifact)) throw new Error('Conflicting trigger source artifacts');
    artifacts.set(artifact.pluginId, artifact);
  }
  function assertCurrent(): void {
    signal.throwIfAborted(); pullRequest.assertCurrent(); communication?.assertCurrent();
    if (scopeHash !== persistenceHash(scope())) throw new Error('Trigger source scope changed');
  }
  async function detail(input: TriggerReviewDetailInputV1) {
    assertCurrent(); const repo = parseTaskRepo(input.repo);
    if (!repos.includes(repo)) return null;
    if (!Number.isSafeInteger(input.number) || input.number < 1) throw new Error('Invalid trigger pull request number');
    const query = { version: 1 as const, repo, number: input.number };
    const result = await pullRequest.provider.detail(query, pullRequest.context);
    assertCurrent();
    const value = parsePullRequestInspectDetailV1(result, query);
    return Object.freeze({ repo: value.target.repo, number: value.target.number, headSha: value.target.headSha,
      title: value.title, url: value.url, status: value.status, draft: value.draft });
  }
  const common = { source, artifacts: Object.freeze([...artifacts.values()]), assertCurrent, detail };
  assertCurrent();
  if (communication) return Object.freeze({ ...common, kind: 'communication' as const, channelName: communication.channelName,
    channelId: communication.channelId,
    async messages(input: { since: string | null }) {
      assertCurrent(); const result = await communication.messages(input); assertCurrent();
      if (!result || !Array.isArray(result.messages) || typeof result.complete !== 'boolean') throw new Error('Invalid trigger communication source');
      const items = result.messages.filter(message => message?.channelId === communication.channelId);
      return { items, complete: result.complete };
    } });
  return Object.freeze({ ...common, kind: 'pull-request' as const,
    async requested() {
      assertCurrent(); const query = { version: 1 as const, repo: null, kind: 'review-requested' as const, limit: 100 };
      const result = await pullRequest.provider.list({ query, repos }, pullRequest.context); assertCurrent();
      if (!result || !Array.isArray(result.items) || result.items.length > 300) throw new Error('Invalid requested review source');
      const items = result.items.map(parsePullRequestReadItemV1).filter(item => repos.includes(item.repo));
      const truncated = result.truncated || items.length > query.limit;
      const page = parsePullRequestReadPageV1({ version: 1, repo: null, kind: query.kind, items: items.slice(0, query.limit),
        quality: result.quality === 'complete' && truncated ? 'partial' : result.quality, truncated, browseUrl: result.browseUrl }, query, repos);
      return { items: page.items.map(item => ({ repo: item.repo, number: item.number })), quality: page.quality, truncated: page.truncated };
    } });
}
