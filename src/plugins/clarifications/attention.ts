import type { PluginPageAttentionContext, PluginPageAttentionV1 } from '@helmsman/plugin-sdk';

export async function attention(context: PluginPageAttentionContext): Promise<PluginPageAttentionV1 | null> {
  const service = context.services.clarifications;
  if (service?.version !== 1) return null;
  const keys = new Set<string>(); const cursors = new Set<string>(); let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    context.signal.throwIfAborted();
    const result = await service.list({ version: 1, repo: context.repo, runId: null, states: ['pending'], limit: 100, cursor }, context.signal);
    context.signal.throwIfAborted();
    if (result?.status !== 'available' || result.value?.version !== 1 || result.value.repo !== context.repo || !Array.isArray(result.value.items)
      || result.value.items.length > 100 || result.value.items.some(item => !item || item.state !== 'pending' || item.answer !== null
        || typeof item.id !== 'string' || typeof item.runId !== 'string' || typeof item.repo !== 'string'
        || context.repo !== null && item.repo !== context.repo)) return null;
    for (const item of result.value.items) {
      if (item.timeoutAt !== null && (!Number.isFinite(Date.parse(item.timeoutAt)) || Date.parse(item.timeoutAt) <= Date.now())) continue;
      keys.add(JSON.stringify([item.repo, item.runId, item.id]));
    }
    cursor = result.value.nextCursor;
    if (cursor === null) break;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) return null;
    cursors.add(cursor);
  }
  return { version: 1, keys: [...keys] };
}
