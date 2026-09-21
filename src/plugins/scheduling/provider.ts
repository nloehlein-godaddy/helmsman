import type {
  SchedulingCandidateV1,
  SchedulingInputV1,
  SchedulingProviderV1,
  SchedulingSourceV1,
} from '@helmsman/plugin-sdk';

const pageLimit = 100;
const pageBound = 100;

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function source(value: unknown): value is SchedulingSourceV1 {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SchedulingSourceV1>;
  return text(item.instanceId, 160) && text(item.sourceId, 160) && text(item.label, 256);
}

function candidate(value: unknown, expectedSourceId: string): value is SchedulingCandidateV1 {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SchedulingCandidateV1>;
  const ref = item.ref;
  if (!ref || typeof ref !== 'object') return false;
  const workRef = ref as { sourceId?: unknown; externalId?: unknown };
  return text(item.candidateId, 128) && text(item.revision, 256) && text(item.displayKey, 512)
    && text(item.title, 4096) && (item.priority === null || typeof item.priority === 'number' && Number.isFinite(item.priority))
    && workRef.sourceId === expectedSourceId && text(workRef.externalId, 512);
}

function orderedSources(input: SchedulingInputV1): readonly SchedulingSourceV1[] {
  if (!Array.isArray(input?.sources)) return [];
  const sources = input.sources.filter(source);
  if (new Set(sources.map(item => item.instanceId)).size !== sources.length) return [];
  const sorted = [...sources].sort((first, second) => first.instanceId.localeCompare(second.instanceId));
  if (!sorted.length) return [];
  const offset = input.lastInstanceId === null ? 0 : Math.max(0, sorted.findIndex(item => item.instanceId === input.lastInstanceId) + 1) % sorted.length;
  return [...sorted.slice(offset), ...sorted.slice(0, offset)];
}

export const roundRobinSchedulingProvider: SchedulingProviderV1 = {
  intervalMs: 60000,
  async select(input, context) {
    if (!input || !context || typeof context.list !== 'function' || typeof input.repo !== 'string') return null;
    const sources = orderedSources(input);
    for (const source of sources) {
      context.signal.throwIfAborted();
      let cursor: string | null = null;
      const visited = new Set<string>();
      try {
        for (let pageNumber = 0; pageNumber < pageBound; pageNumber++) {
          context.signal.throwIfAborted();
          const page = await context.list({ instanceId: source.instanceId, cursor, limit: pageLimit });
          context.signal.throwIfAborted();
          if (!page || !Array.isArray(page.items) || page.items.length > pageLimit || (page.nextCursor !== null && !text(page.nextCursor, 128))) throw new Error('Malformed scheduling page');
          for (const item of page.items) if (candidate(item, source.sourceId)) return { candidateId: item.candidateId };
          if (page.nextCursor === null) break;
          if (visited.has(page.nextCursor) || visited.size >= pageBound) throw new Error('Scheduling pagination did not advance');
          visited.add(page.nextCursor);
          cursor = page.nextCursor;
        }
      } catch (error) {
        context.signal.throwIfAborted();
        continue;
      }
    }
    return null;
  },
};
