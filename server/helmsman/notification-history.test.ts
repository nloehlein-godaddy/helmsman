// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openPersistence } from './persistence';
import { openDb, type RunRow } from './db';
import { openSlackStore, type SlackNotification } from './slack/store';
import { openVoyageNotifications } from './voyage-notifications';
import { openNotificationHistory } from './notification-history';
import { createCommunicationReadService } from './communication-read-service';
import { handleCommunicationApi } from './communication-routes';

const now = '2026-09-20T12:00:00Z';
const health = { enabled: false, status: 'disabled' as const, channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: null };
const caller = 'example.ui/notifications';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()));
function fixture(path = ':memory:') {
  const persistence = openPersistence(path); cleanup.push(() => persistence.close());
  const db = openDb(persistence.sql); const reviews = openSlackStore(persistence.sql); const voyages = openVoyageNotifications(persistence.sql);
  const history = openNotificationHistory(persistence.sql, function* () { yield* reviews.notificationIdentities(); yield* voyages.notificationIdentities(); });
  const snapshot = (repo: string | null = null) => ({ health, notifications: [...reviews.listNotifications(100, repo).map(({ sourceKey: _sourceKey, proposal: _proposal, trigger: _trigger, policy: _policy, ...notification }) => notification), ...voyages.listNotifications(100, repo)] });
  const service = createCommunicationReadService({ persistence, repos: () => ['org/a', 'org/b'], authorize: id => { if (id !== caller) throw new Error('forbidden'); },
    notificationHistory: history, snapshot, markRead: (id, when) => reviews.markRead(id, when), values: () => ({ enabled: false, watchEnabled: false, clientId: '', channelId: '', channelName: '', browserSurface: '', reviewChannel: '', reviewMention: '' }), destination: () => null, write() {} });
  const read = (repo: string | null = null) => service.notifications(caller, { version: 1, repo, limit: 256 }, repo);
  const clear = (repo: string | null, clearToken: string, scopeRepo = repo) => service.clearNotifications(caller, { version: 1, repo, clearToken }, scopeRepo);
  return { persistence, db, reviews, voyages, history, service, read, clear };
}
const review = (id: string, repo = 'org/a'): SlackNotification => ({ id, repo, prNumber: 42, prUrl: `https://github.com/${repo}/pull/42`, sourceUrl: 'https://team.slack.com/archives/C001/p1234', author: 'Writer', channelName: 'reviews', status: 'queued', runId: null, createdAt: now, updatedAt: now, readAt: null, error: null });
const run = (id: string, repo = 'org/a'): RunRow => ({ id, repo, ticketId: 'TASK-1', adapter: 'codex', status: 'succeeded', attempt: 1, prNumber: null, startedAt: now, endedAt: now, costUsd: null, worktreePath: null });

it('clears complete scoped history beyond display bounds without changing queues, deduplication, reads or runs', () => {
  const f = fixture();
  for (let index = 0; index < 140; index++) { f.reviews.insertNotification('source', review(`review-${index}`)); f.db.insertRun(run(`run-${index}`)); }
  f.reviews.insertNotification('source', review('other', 'org/b')); f.db.insertRun(run('other-run', 'org/b'));
  f.reviews.markRead('review-0', now); f.reviews.claimDispatch('review-0', 'claim', now);
  const beforeReview = f.reviews.getNotification('review-0'); const beforeRun = f.db.getRun('run-0');
  const snapshot = f.read(); expect(snapshot.notifications.length).toBeLessThan(282);
  expect(f.clear('org/a', snapshot.clearToken!).cleared).toBe(280);
  expect(f.read('org/a')).toMatchObject({ notifications: [], unread: 0 });
  expect(f.read('org/b').notifications).toHaveLength(2);
  expect(f.reviews.getNotification('review-0')).toEqual(beforeReview); expect(f.db.getRun('run-0')).toEqual(beforeRun);
  expect(f.reviews.queuedNotifications('source')).toHaveLength(141); expect(f.reviews.ownsDispatch('review-0', 'claim')).toBe(true);
  expect(f.reviews.insertNotification('source', review('review-0'))).toBe(false);
  f.reviews.updateNotification('review-0', 'launched', now);
  expect(f.read('org/a').notifications).toEqual([]);
});

it('retains backdated arrivals and later run attempts through retries, polls and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'notification-history-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.db'); const first = fixture(path);
  first.reviews.insertNotification('source', review('old')); first.db.insertRun(run('finished'));
  const token = first.read().clearToken!;
  expect(first.read().clearToken).toBe(token);
  expect(first.persistence.sql.prepare("SELECT seq FROM sqlite_sequence WHERE name='notification_history'").get()).toEqual({ seq: 2 });
  first.reviews.insertNotification('source', { ...review('new'), createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' });
  first.persistence.sql.prepare('UPDATE runs SET attempt=2 WHERE id=?').run('finished');
  first.read(); expect(first.clear(null, token).cleared).toBe(2);
  expect(first.read().notifications.map(item => item.id)).toContain('new'); expect(first.read().notifications).toHaveLength(2);
  first.persistence.close(); const reopened = fixture(path);
  expect(reopened.clear(null, token).cleared).toBe(0); expect(reopened.read().notifications).toHaveLength(2);
  expect(reopened.clear(null, reopened.read().clearToken!).cleared).toBe(2); expect(reopened.read().unread).toBe(0);
});

it('enforces HTTP scope and token validation, and limits All to configured galleons', () => {
  const f = fixture(); for (const repo of ['org/a', 'org/b', 'other/private']) f.reviews.insertNotification('source', review(repo.replace('/', '-'), repo));
  const clearToken = f.read().clearToken!;
  const request = (body: unknown, contribution: string | undefined = caller) => handleCommunicationApi({ method: 'POST', path: '/api/communication/notifications/clear', query: new URLSearchParams(), body, caller: contribution, service: f.service });
  expect(request({ version: 1, repo: 'org/b', scopeRepo: 'org/a', clearToken })?.status).toBe(404);
  expect(request({ version: 1, repo: null, scopeRepo: null, clearToken: '999:invalid' })?.status).toBe(400);
  expect(request({ version: 1, repo: null, scopeRepo: null, clearToken, unwanted: true })?.status).toBe(400);
  expect(handleCommunicationApi({ method: 'POST', path: '/api/communication/notifications/clear', query: new URLSearchParams(), body: {}, service: f.service })?.status).toBe(403);
  expect(f.read().notifications).toHaveLength(2);
  expect(request({ version: 1, repo: null, scopeRepo: null, clearToken })?.json).toMatchObject({ version: 1, cleared: 2, repo: null, clearToken });
  expect(f.reviews.listNotifications().map(item => item.repo)).toEqual(['other/private']);
});

it('applies galleon scope before history limits so busy neighbors cannot hide clearable entries', () => {
  const f = fixture();
  f.reviews.insertNotification('source', review('older-own')); f.db.insertRun(run('older-own-run'));
  for (let index = 0; index < 120; index++) {
    f.reviews.insertNotification('source', { ...review(`newer-${index}`, 'org/b'), updatedAt: '2026-09-21T12:00:00Z' });
    f.db.insertRun({ ...run(`newer-run-${index}`, 'org/b'), endedAt: '2026-09-21T12:00:00Z' });
  }
  const snapshot = f.read('org/a'); expect(snapshot.notifications).toHaveLength(2); expect(snapshot.unread).toBe(2);
  expect(f.clear('org/a', snapshot.clearToken!).cleared).toBe(2); expect(f.read('org/a').notifications).toHaveLength(0);
  expect(f.read('org/b').notifications).toHaveLength(200);
});
