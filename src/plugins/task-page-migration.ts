import type { CompositionLayoutV1 } from './composition';
import { parseTriageFilters } from '../logic/triageFilters';
import { DEFAULT_TRIAGE_PAGE_SIZE, TRIAGE_PAGE_SIZES } from '../logic/triagePagination';

const keys = ['helmsman.triageFilters', 'helmsman.triagePageSize', 'helmsman.collapsed'] as const;
const groups = { 'triage:backlog': 'unassigned-backlog', 'triage:todo': 'unassigned-todo', 'triage:mine': 'mine-open' } as const;
const contributionId = 'helmsman.triage/panel';

function json(raw: string | null): unknown {
  try { return raw === null ? null : JSON.parse(raw); } catch { return null; }
}

export function initializeTaskPageLayout(initial: CompositionLayoutV1, storage: Pick<Storage, 'getItem'> = globalThis.localStorage) {
  if (initial.compositionId !== 'helmsman/triage-page') throw new Error('Unsupported task-page migration.');
  const raw = Object.fromEntries(keys.map(key => [key, storage.getItem(key)])) as Record<typeof keys[number], string | null>;
  if (Object.values(raw).some(value => value !== null && typeof value !== 'string')
    || new TextEncoder().encode(JSON.stringify(raw)).byteLength > 4 * 1024 * 1024 - 1024) throw new Error('Legacy task preferences exceed the migration limit.');
  const filters = parseTriageFilters(json(raw['helmsman.triageFilters']));
  const collapsed = json(raw['helmsman.collapsed']);
  const legacyCollapsedGroups = Object.entries(groups).filter(([key]) => Array.isArray(collapsed) && collapsed.includes(key)).map(([, group]) => group);
  const pageSize = TRIAGE_PAGE_SIZES.find(size => String(size) === raw['helmsman.triagePageSize']) ?? DEFAULT_TRIAGE_PAGE_SIZE;
  return {
    layout: { ...initial, instances: initial.instances.map(instance => instance.contributionId !== contributionId || Object.hasOwn(instance.state, contributionId) ? instance : {
      ...instance, state: { ...instance.state, [contributionId]: { version: 1, value: {
        source: null, priorities: filters.priorities.map(priority => Number(priority.slice(1))), days: filters.days,
        pageSize, collapsed: [], legacyCollapsedGroups, expanded: [],
      } } },
    }) },
    archive: { version: 1, raw },
  };
}
