import type { PanelOpaqueStateV1, RunInspectLogEventV1, RunInspectLogPageV1, RunInspectTargetV1, RunReadSummaryV1, RunCommandReceiptV1 } from '@helmsman/plugin-sdk';

export interface SavedTab { repo: string; runId: string; scrollTop: number; follow: boolean; }
export interface SavedViewer { tabs: SavedTab[]; activeKey: string | null; results: RunCommandReceiptV1[]; }
export interface RunTab extends SavedTab {
  target: RunInspectTargetV1 | null; summary: RunReadSummaryV1 | null; events: RunInspectLogEventV1[];
  olderCursor: string | null; followCursor: string | null; hasEarlier: boolean; hasLater: boolean;
  olderTrimmed: boolean; newerTrimmed: boolean; loaded: boolean; error: string; observedAt: string | null;
}
export const tabKey = (tab: { repo: string; runId: string }) => JSON.stringify([tab.repo, tab.runId]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const repo = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && /^[a-z\d-]+\/[a-z\d_.-]+$/i.test(value) && !['.', '..'].includes(value.split('/')[1]!);
const runId = (value: unknown): value is string => typeof value === 'string' && /^[a-z\d_-]{1,128}$/i.test(value);
export function emptyState(): SavedViewer { return { tabs: [], activeKey: null, results: [] }; }
export function readState(input: PanelOpaqueStateV1 | null): SavedViewer | null {
  if (input === null) return emptyState();
  const value = input.value;
  if (input.version !== 1 || !record(value) || !Array.isArray(value.tabs) || value.tabs.length > 12 || !Array.isArray(value.results) || value.results.length > 16
    || value.activeKey !== null && typeof value.activeKey !== 'string') return null;
  const tabs: SavedTab[] = [];
  for (const item of value.tabs) {
    if (!record(item) || !repo(item.repo) || !runId(item.runId) || typeof item.follow !== 'boolean' || typeof item.scrollTop !== 'number' || !Number.isFinite(item.scrollTop) || item.scrollTop < 0) return null;
    const tab = { repo: item.repo, runId: item.runId, follow: item.follow, scrollTop: item.scrollTop };
    if (tabs.some(existing => tabKey(existing) === tabKey(tab))) return null; tabs.push(tab);
  }
  if (value.activeKey !== null && !tabs.some(tab => tabKey(tab) === value.activeKey)) return null;
  const results: RunCommandReceiptV1[] = [];
  for (const item of value.results) {
    if (!record(item) || item.version !== 1 || !repo(item.repo) || typeof item.requestId !== 'string' || !/^[a-f\d-]{36}$/i.test(item.requestId)
      || !['stop', 'retry'].includes(String(item.action)) || !['accepted', 'rejected'].includes(String(item.status))
      || item.runId !== null && !runId(item.runId) || item.attempt !== null && (typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) || item.attempt < 1)
      || item.message !== null && (typeof item.message !== 'string' || item.message.length > 2048)) return null;
    results.push(item as unknown as RunCommandReceiptV1);
  }
  return { tabs, activeKey: value.activeKey as string | null, results };
}
export function newTab(tab: SavedTab): RunTab {
  return { ...tab, target: null, summary: null, events: [], olderCursor: null, followCursor: null, hasEarlier: false, hasLater: false,
    olderTrimmed: false, newerTrimmed: false, loaded: false, error: '', observedAt: null };
}
export function saveState(tabs: readonly RunTab[], activeKey: string | null, results: readonly RunCommandReceiptV1[]): PanelOpaqueStateV1 {
  return { version: 1, value: { tabs: tabs.map(tab => ({ repo: tab.repo, runId: tab.runId, scrollTop: tab.scrollTop, follow: tab.follow })), activeKey,
    results: results.map(receipt => ({ ...receipt, ...(receipt.resolution ? { resolution: { ...receipt.resolution } } : {}) })) } };
}
export function mergeLog(tab: RunTab, page: RunInspectLogPageV1, direction: 'initial' | 'older' | 'follow'): void {
  const events = new Map<number, RunInspectLogEventV1>();
  for (const event of direction === 'initial' ? [] : tab.events) events.set(event.sequence, event);
  for (const event of page.events) events.set(event.sequence, event);
  const ordered = [...events.values()].sort((a, b) => a.sequence - b.sequence);
  if (direction === 'older') {
    tab.events = ordered.slice(0, 300); tab.newerTrimmed ||= ordered.length > 300;
    tab.olderCursor = page.nextCursor; tab.hasEarlier = page.hasEarlier;
  } else {
    tab.events = ordered.slice(-300); tab.olderTrimmed ||= ordered.length > 300;
    if (direction === 'initial') {
      tab.olderCursor = page.nextCursor; tab.hasEarlier = page.hasEarlier; tab.followCursor = page.followCursor;
      tab.olderTrimmed = false; tab.newerTrimmed = false;
    } else tab.followCursor = page.nextCursor;
    tab.hasLater = page.hasLater;
  }
  tab.observedAt = page.observedAt; tab.loaded = true;
}
