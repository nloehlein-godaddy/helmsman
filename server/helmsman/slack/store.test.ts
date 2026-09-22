import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openPersistence } from '../persistence';
import type { AutomaticReviewPolicy } from '../automatic-review-ownership';
import { openSlackStore, type SlackNotification } from './store';

const now = '2026-09-22T00:00:00Z';
const notification: SlackNotification = { id: 'review', repo: 'org/repo', prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42',
  sourceUrl: 'https://example.slack.com/message', author: 'sender', channelName: 'reviews', status: 'queued', runId: 'run-1',
  createdAt: now, updatedAt: now, readAt: null, error: null,
  proposal: { eventId: 'event', targetId: 'target', repo: 'org/repo', number: 42, headSha: 'a'.repeat(40), title: 'Title',
    url: 'https://github.com/org/repo/pull/42', status: 'open', draft: false, workflowRef: 'review@1',
    sourceUrl: 'https://example.slack.com/message', author: 'sender', channelName: 'reviews' } };
const policy: AutomaticReviewPolicy = { version: 1, kind: 'authenticated-pr-owner', decision: 'own', actorLogin: 'author', authorLogin: 'author',
  headSha: 'a'.repeat(40), providerBindingHash: 'c'.repeat(64), sourceRevision: 'source-1', observedAt: now, reason: 'Own PR' };

describe('durable automatic review decisions', () => {
  it('adds evidence storage to an existing version-one Slack database without changing its schema checksum or queue identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'helmsman-review-policy-'));
    const path = join(directory, 'state.db');
    try {
      const persistence = openPersistence(path);
      const initial = openSlackStore(persistence.sql); initial.insertNotification('slack', notification);
      const baseline = persistence.sql.prepare("SELECT checksum FROM migration_ledger WHERE owner='compat.slack'").get();
      persistence.sql.exec('DROP TABLE slack_review_policies');
      persistence.sql.prepare("DELETE FROM migration_ledger WHERE owner='core.slack-review-policy'").run();
      persistence.close();
      const reopened = openPersistence(path); const store = openSlackStore(reopened.sql);
      try {
        expect(reopened.sql.prepare("SELECT checksum FROM migration_ledger WHERE owner='compat.slack'").get()).toEqual(baseline);
        expect(store.getNotification('review')).toMatchObject({ id: 'review', runId: 'run-1', status: 'queued', policy: null });
        expect(store.claimDispatch('review', 'claimed', now)).toBe(true);
        expect(store.transitionDispatch({ notification, token: 'claimed', status: 'blocked', now, policy, assertCurrent() {} })).toBe(true);
        expect(store.getNotification('review')).toMatchObject({ status: 'blocked', policy });
      } finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('requires the original queued row and dispatch owner before changing a decision or releasing pins', () => {
    const store = openSlackStore(':memory:');
    try {
      store.insertNotification('slack', notification); store.claimDispatch('review', 'claimed', now);
      const releasePins = vi.fn();
      const transition = (token: string) => store.transitionDispatch({ notification, token, status: 'blocked', now, policy, assertCurrent() {}, releasePins });
      expect(transition('stale')).toBe(false);
      store.setNotificationRunId('review', 'replacement'); expect(transition('claimed')).toBe(false);
      store.setNotificationRunId('review', 'run-1'); store.updateNotification('review', 'launched', now);
      expect(transition('claimed')).toBe(false); expect(releasePins).not.toHaveBeenCalled();
      expect(store.getNotification('review')).toMatchObject({ status: 'launched', policy: null });
    } finally { store.close(); }
  });

  it('rolls back status and policy when the final authority fence or atomic pin release fails', () => {
    const store = openSlackStore(':memory:');
    try {
      store.insertNotification('slack', notification); store.claimDispatch('review', 'claimed', now);
      for (const stage of ['authority', 'pins']) {
        expect(() => store.transitionDispatch({ notification, token: 'claimed', status: 'blocked', now, policy,
          assertCurrent() { if (stage === 'authority') throw new Error('authority changed'); },
          releasePins() { if (stage === 'pins') throw new Error('pins retained'); } })).toThrow();
        expect(store.getNotification('review')).toMatchObject({ status: 'queued', policy: null });
      }
    } finally { store.close(); }
  });
});
