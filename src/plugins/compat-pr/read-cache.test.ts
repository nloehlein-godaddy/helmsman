import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestReadPageV1, RunReadSummaryV1 } from '@helmsman/plugin-sdk';
import { listSnapshots, runSnapshots } from './read-cache';

const repo = 'org/project';
function listPage(title = 'A pull request', count = 1): PullRequestReadPageV1 {
  return { version: 1, repo, kind: 'review-requested', quality: 'complete', truncated: false, browseUrl: null,
    items: Array.from({ length: count }, (_, index) => ({ repo, number: index + 1, title, url: null, status: 'open', createdAt: '2026-10-16T00:00:00Z', mergedAt: null, draft: false, ticketId: null, reviewDecision: null, comments: 0, reviews: null })) };
}
function runPage(title = 'A run', count = 1): { items: RunReadSummaryV1[]; more: boolean } {
  return { items: Array.from({ length: count }, (_, index) => ({ version: 1, id: `run-${index}`, repo, displayKey: `PR #${index + 1}`, title, status: 'succeeded', attempt: 1, startedAt: '2026-10-16T00:00:00Z', endedAt: '2026-10-16T00:01:00Z', prNumber: index + 1, costUsd: null, review: null, sourceSettlement: null })), more: false };
}
const caches = [
  { name: 'PR lists', set: (key: string, title = 'Snapshot', count = 1) => listSnapshots.set(key, listPage(title, count)), get: (key: string) => listSnapshots.get(key), bytes: (title: string, count: number) => new TextEncoder().encode(JSON.stringify(listPage(title, count))).byteLength, delete: (key: string) => listSnapshots.delete(key), clear: () => listSnapshots.clear() },
  { name: 'run lists', set: (key: string, title = 'Snapshot', count = 1) => runSnapshots.set(key, runPage(title, count)), get: (key: string) => runSnapshots.get(key), bytes: (title: string, count: number) => new TextEncoder().encode(JSON.stringify(runPage(title, count))).byteLength, delete: (key: string) => runSnapshots.delete(key), clear: () => runSnapshots.clear() },
];

beforeEach(() => { listSnapshots.clear(); runSnapshots.clear(); vi.spyOn(Date, 'now').mockReturnValue(1000); });
afterEach(() => { listSnapshots.clear(); runSnapshots.clear(); vi.restoreAllMocks(); });

describe.each(caches)('$name snapshot retention', cache => {
  it('expires at sixty seconds and restarts expiry when replaced', () => {
    cache.set('scope');
    vi.mocked(Date.now).mockReturnValue(60_999);
    expect(cache.get('scope')).not.toBeNull();
    cache.set('replacement');
    vi.mocked(Date.now).mockReturnValue(61_000);
    expect(cache.get('scope')).toBeNull();
    expect(cache.get('replacement')).not.toBeNull();
    cache.set('replacement', 'Updated');
    vi.mocked(Date.now).mockReturnValue(121_000);
    expect(cache.get('replacement')).toBeNull();
  });

  it('evicts the oldest entry when a thirty-third scope is retained', () => {
    for (let index = 0; index < 33; index++) cache.set(`scope-${index}`);
    expect(cache.get('scope-0')).toBeNull();
    for (let index = 1; index < 33; index++) expect(cache.get(`scope-${index}`)).not.toBeNull();
  });

  it('bounds total UTF-8 storage to four MiB before the entry-count limit', () => {
    const title = 'é'.repeat(2000); const rows = 100;
    const capacity = Math.floor(4 * 1024 * 1024 / cache.bytes(title, rows));
    expect(capacity).toBeLessThan(32);
    for (let index = 0; index <= capacity; index++) cache.set(`scope-${index}`, title, rows);
    expect(cache.get('scope-0')).toBeNull();
    for (let index = 1; index <= capacity; index++) expect(cache.get(`scope-${index}`)).not.toBeNull();
  });

  it('releases byte accounting after replacement, deletion, and clearing', () => {
    const title = 'é'.repeat(2000); const rows = 100;
    const capacity = Math.floor(4 * 1024 * 1024 / cache.bytes(title, rows));
    cache.set('replaced', title, rows);
    cache.set('replaced', 'Small');
    cache.set('deleted', title, rows);
    cache.delete('deleted');
    cache.delete('deleted');
    for (let index = 0; index < capacity; index++) cache.set(`scope-${index}`, title, rows);
    expect(cache.get('replaced')).not.toBeNull();
    for (let index = 0; index < capacity; index++) expect(cache.get(`scope-${index}`)).not.toBeNull();
    cache.clear();
    for (let index = 0; index < capacity; index++) cache.set(`new-${index}`, title, rows);
    for (let index = 0; index < capacity; index++) expect(cache.get(`new-${index}`)).not.toBeNull();
  });

  it('rejects a single oversized snapshot while preserving other retained scopes', () => {
    cache.set('small');
    cache.set('oversized', 'x'.repeat(4 * 1024 * 1024));
    expect(cache.get('oversized')).toBeNull();
    expect(cache.get('small')).not.toBeNull();
  });
});

it('isolates retained data from mutation of input and returned snapshots', () => {
  const input = runPage();
  runSnapshots.set('scope', input);
  const original = input.items[0];
  if (!original) throw new Error('Expected input run');
  (original as { title?: string }).title = 'Changed input';
  input.items.push({ ...original, id: 'extra' });
  const first = runSnapshots.get('scope');
  expect(first?.items).toHaveLength(1);
  expect(first?.items[0]?.title).toBe('A run');
  if (!first) throw new Error('Expected retained snapshot');
  (first.items[0] as { title?: string }).title = 'Changed read';
  expect(runSnapshots.get('scope')?.items[0]?.title).toBe('A run');
});

it('keeps identical scope keys independent between PR and run snapshots', () => {
  listSnapshots.set('scope', listPage()); runSnapshots.set('scope', runPage());
  listSnapshots.clear();
  expect(runSnapshots.get('scope')).toEqual(runPage());
  listSnapshots.set('scope', listPage()); runSnapshots.delete('scope');
  expect(listSnapshots.get('scope')).toEqual(listPage());
});
