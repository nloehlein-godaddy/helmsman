import { initializeNotificationHistory, type NotificationIdentity } from '../notification-history';
import type Database from 'better-sqlite3';
import { storeConnection } from '../store-connection';
import type { ArtifactPin } from '../execution-store';
import { parseAutomaticReviewPolicy, type AutomaticReviewPolicy } from '../automatic-review-ownership';
import { immediateTransaction, persistenceHash, stableJson } from '../persistence';

export interface ReviewNotificationProposal {
  eventId: string | null;
  targetId: string;
  repo: string;
  number: number;
  headSha: string;
  title: string;
  url: string;
  status: 'open' | 'closed' | 'merged';
  draft: boolean;
  workflowRef: string;
  sourceUrl: string;
  author: string;
  channelName: string;
}

export interface SlackNotification {
  sourceKey?: string;
  id: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  sourceUrl: string;
  author: string;
  channelName: string;
  status: 'queued' | 'launched' | 'failed' | 'blocked';
  runId: string | null;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  error: string | null;
  trigger?: unknown | null;
  proposal?: ReviewNotificationProposal | null;
  policy?: AutomaticReviewPolicy | null;
}

export interface SlackHealth {
  enabled: boolean;
  status: 'disabled' | 'healthy' | 'scanning' | 'partial' | 'unavailable';
  channelName: string;
  intervalMs: number;
  lastSuccessAt: string | null;
  error: string | null;
}

export interface SlackSourceState {
  key: string;
  activatedAt: string;
  cursor: string | null;
  health: SlackHealth;
}

export interface SlackStore {
  ensureSource(key: string, activatedAt: string, health: SlackHealth): SlackSourceState;
  saveSource(state: SlackSourceState): void;
  insertNotification(sourceKey: string, notification: SlackNotification): boolean;
  commitTriggerScan(input: {
    sourceKey: string;
    expected: { activatedAt: string; cursor: string | null };
    state: SlackSourceState;
    notifications: ReadonlyArray<{ notification: SlackNotification; proposal: ReviewNotificationProposal; trigger: unknown; pins: readonly ArtifactPin[] }>;
    assertCurrent(): void;
    retainPins(pins: readonly ArtifactPin[]): void;
  }): number;
  queuedNotifications(sourceKey: string): SlackNotification[];
  launchedNotifications(sourceKey: string): SlackNotification[];
  notificationsByStatus(status: 'queued' | 'launched'): SlackNotification[];
  updateNotification(id: string, status: SlackNotification['status'], now: string, error?: string | null): void;
  setNotificationRunId(id: string, runId: string): void;
  getNotification(id: string): SlackNotification | null;
  listNotifications(limit?: number): SlackNotification[];
  notificationIdentities(): Iterable<NotificationIdentity>;
  markRead(id: string, now: string): boolean;
  claimDispatch(id: string, token: string, now: string): boolean;
  dispatchClaims(sourceKey: string): Array<{ notificationId: string; token: string; claimedAt: string }>;
  ownsDispatch(id: string, token: string): boolean;
  releaseDispatch(id: string, token: string): boolean;
  transitionDispatch(input: {
    notification: SlackNotification; token: string; status: SlackNotification['status']; now: string;
    error?: string | null; policy?: AutomaticReviewPolicy; assertCurrent(): void; releasePins?(): void;
  }): boolean;
  close(): void;
}

const NOTIFICATION_COLUMNS = 'id, repo, prNumber, prUrl, sourceUrl, author, channelName, status, runId, createdAt, updatedAt, readAt, error, proposalJson, triggerJson';
const NOTIFICATION_SELECT_COLUMNS = `sourceKey, ${NOTIFICATION_COLUMNS}`;

export function openSlackStore(path: string | Database.Database): SlackStore {
  const connection = storeConnection(path);
  const { sql } = connection;
  initializeNotificationHistory(sql);
  connection.migrate({ owner: 'compat.slack', ddl: `
    CREATE TABLE IF NOT EXISTS slack_sources (
      key TEXT PRIMARY KEY, activatedAt TEXT NOT NULL, cursor TEXT, health TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slack_notifications (
      id TEXT PRIMARY KEY, sourceKey TEXT NOT NULL, repo TEXT NOT NULL,
      prNumber INTEGER NOT NULL, prUrl TEXT NOT NULL, sourceUrl TEXT NOT NULL,
      author TEXT NOT NULL, channelName TEXT NOT NULL, status TEXT NOT NULL,
      runId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, readAt TEXT, error TEXT,
      proposalJson TEXT, triggerJson TEXT
    );
    CREATE INDEX IF NOT EXISTS slack_notifications_queue ON slack_notifications(sourceKey, status, createdAt);
    CREATE TABLE IF NOT EXISTS slack_dispatch_claims (
      notificationId TEXT PRIMARY KEY, token TEXT NOT NULL, claimedAt TEXT NOT NULL
    );
  `, optionalLegacyColumns: { slack_notifications: ['proposalJson', 'triggerJson'] }, upgrade(database) {
    const columns = new Set((database.pragma('table_info(slack_notifications)') as Array<{ name: string }>).map(column => column.name));
    if (!columns.has('proposalJson')) database.exec('ALTER TABLE slack_notifications ADD COLUMN proposalJson TEXT');
    if (!columns.has('triggerJson')) database.exec('ALTER TABLE slack_notifications ADD COLUMN triggerJson TEXT');
  } });

  const policyDdl = 'CREATE TABLE slack_review_policies (notificationId TEXT PRIMARY KEY, json TEXT NOT NULL)';
  connection.migrate({ owner: 'core.slack-review-policy', ddl: policyDdl });

  type NotificationRow = Omit<SlackNotification, 'proposal' | 'trigger' | 'policy'> & { sourceKey: string; proposalJson: string | null; triggerJson: string | null };
  const decode = (row: NotificationRow): SlackNotification => {
    try {
      const { proposalJson, triggerJson, ...notification } = row;
      const policy = sql.prepare('SELECT json FROM slack_review_policies WHERE notificationId=?').get(row.id) as { json: string } | undefined;
      return { ...notification, proposal: proposalJson ? JSON.parse(proposalJson) as ReviewNotificationProposal : null,
        trigger: triggerJson ? JSON.parse(triggerJson) as unknown : null, policy: policy ? parseAutomaticReviewPolicy(JSON.parse(policy.json)) : null };
    } catch { throw new Error('Stored review trigger is invalid'); }
  };
  const insert = (sourceKey: string, notification: SlackNotification, proposal: ReviewNotificationProposal | null, trigger: unknown | null): boolean => sql.prepare(`INSERT OR IGNORE INTO slack_notifications (sourceKey, ${NOTIFICATION_COLUMNS})
    VALUES (@sourceKey, @id, @repo, @prNumber, @prUrl, @sourceUrl, @author, @channelName, @status, @runId, @createdAt, @updatedAt, @readAt, @error, @proposalJson, @triggerJson)`)
    .run({ ...notification, sourceKey, proposalJson: proposal === null ? null : JSON.stringify(proposal), triggerJson: trigger === null ? null : JSON.stringify(trigger) }).changes > 0;

  return {
    ensureSource(key, activatedAt, health) {
      sql.prepare('INSERT OR IGNORE INTO slack_sources (key, activatedAt, cursor, health) VALUES (?, ?, NULL, ?)')
        .run(key, activatedAt, JSON.stringify(health));
      const row = sql.prepare('SELECT * FROM slack_sources WHERE key = ?').get(key) as Omit<SlackSourceState, 'health'> & { health: string };
      return { ...row, health: JSON.parse(row.health) as SlackHealth };
    },
    saveSource(state) {
      sql.prepare('UPDATE slack_sources SET cursor = ?, health = ? WHERE key = ?')
        .run(state.cursor, JSON.stringify(state.health), state.key);
    },
    insertNotification(sourceKey, notification) {
      return insert(sourceKey, notification, notification.proposal ?? null, notification.trigger ?? null);
    },
    commitTriggerScan: sql.transaction((input: {
      sourceKey: string; expected: { activatedAt: string; cursor: string | null }; state: SlackSourceState;
      notifications: ReadonlyArray<{ notification: SlackNotification; proposal: ReviewNotificationProposal; trigger: unknown; pins: readonly ArtifactPin[] }>;
      assertCurrent(): void; retainPins(pins: readonly ArtifactPin[]): void;
    }): number => {
      const current = sql.prepare('SELECT activatedAt,cursor FROM slack_sources WHERE key = ?').get(input.sourceKey) as { activatedAt: string; cursor: string | null } | undefined;
      if (!current || current.activatedAt !== input.expected.activatedAt || current.cursor !== input.expected.cursor || input.state.key !== input.sourceKey
        || input.state.activatedAt !== current.activatedAt || !Array.isArray(input.notifications)) throw new Error('Review source changed before trigger capture');
      input.assertCurrent();
      let inserted = 0;
      for (const item of input.notifications) {
        if (!item?.proposal || !item.trigger || !Array.isArray(item.pins)) throw new Error('Invalid review trigger capture');
        if (!insert(input.sourceKey, item.notification, item.proposal, item.trigger)) continue;
        input.retainPins(item.pins);
        inserted++;
      }
      sql.prepare('UPDATE slack_sources SET cursor = ?, health = ? WHERE key = ?').run(input.state.cursor, JSON.stringify(input.state.health), input.sourceKey);
      return inserted;
    }).immediate,
    queuedNotifications(sourceKey) {
      return (sql.prepare(`SELECT ${NOTIFICATION_SELECT_COLUMNS} FROM slack_notifications WHERE sourceKey = ? AND status = 'queued' ORDER BY createdAt, id`)
        .all(sourceKey) as NotificationRow[]).map(decode);
    },
    launchedNotifications(sourceKey) {
      return (sql.prepare(`SELECT ${NOTIFICATION_SELECT_COLUMNS} FROM slack_notifications WHERE sourceKey = ? AND status = 'launched'`)
        .all(sourceKey) as NotificationRow[]).map(decode);
    },
    notificationsByStatus(status) {
      return (sql.prepare(`SELECT ${NOTIFICATION_SELECT_COLUMNS} FROM slack_notifications WHERE status = ? ORDER BY createdAt, id`)
        .all(status) as NotificationRow[]).map(decode);
    },
    updateNotification(id, status, now, error = null) {
      sql.prepare('UPDATE slack_notifications SET status = ?, updatedAt = ?, readAt = NULL, error = ? WHERE id = ?')
        .run(status, now, error, id);
    },
    setNotificationRunId(id, runId) {
      sql.prepare('UPDATE slack_notifications SET runId = ? WHERE id = ?').run(runId, id);
    },
    getNotification(id) {
      const row = sql.prepare(`SELECT ${NOTIFICATION_SELECT_COLUMNS} FROM slack_notifications WHERE id = ?`).get(id) as NotificationRow | undefined;
      return row ? decode(row) : null;
    },
    *notificationIdentities() {
      for (const row of sql.prepare('SELECT id,repo FROM slack_notifications').iterate() as Iterable<{ id: string; repo: string }>)
        yield { kind: 'review' as const, id: row.id, repo: row.repo };
    },
    listNotifications(limit = 100) {
      const count = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 100;
      return (sql.prepare(`SELECT ${NOTIFICATION_SELECT_COLUMNS} FROM slack_notifications WHERE NOT EXISTS (SELECT 1 FROM notification_history history WHERE history.kind='review' AND history.id=slack_notifications.id AND history.dismissed=1) ORDER BY updatedAt DESC, id DESC LIMIT ?`)
        .all(count) as NotificationRow[]).map(decode);
    },
    markRead(id, now) {
      return sql.prepare('UPDATE slack_notifications SET readAt = COALESCE(readAt, ?) WHERE id = ?').run(now, id).changes > 0;
    },
    claimDispatch(id, token, now) {
      if (!id || !token || !Number.isFinite(Date.parse(now))) throw new Error('Invalid dispatch claim');
      return sql.prepare(`INSERT OR IGNORE INTO slack_dispatch_claims (notificationId, token, claimedAt)
        SELECT id, ?, ? FROM slack_notifications WHERE id = ? AND status = 'queued'`).run(token, now, id).changes > 0;
    },
    dispatchClaims(sourceKey) {
      return sql.prepare(`SELECT claim.notificationId, claim.token, claim.claimedAt FROM slack_dispatch_claims claim
        JOIN slack_notifications notification ON notification.id = claim.notificationId WHERE notification.sourceKey = ?`)
        .all(sourceKey) as Array<{ notificationId: string; token: string; claimedAt: string }>;
    },
    ownsDispatch(id, token) {
      return !!sql.prepare('SELECT 1 FROM slack_dispatch_claims WHERE notificationId = ? AND token = ?').get(id, token);
    },
    releaseDispatch(id, token) {
      return sql.prepare('DELETE FROM slack_dispatch_claims WHERE notificationId = ? AND token = ?').run(id, token).changes > 0;
    },
    transitionDispatch(input) {
      return immediateTransaction(sql, () => {
        const row = sql.prepare(`SELECT ${NOTIFICATION_SELECT_COLUMNS} FROM slack_notifications WHERE id=?`).get(input.notification.id) as NotificationRow | undefined;
        const identity = (notification: SlackNotification) => persistenceHash({ runId: notification.runId, repo: notification.repo,
          prNumber: notification.prNumber, proposal: notification.proposal ?? null, trigger: notification.trigger ?? null });
        if (!row || row.status !== 'queued' || identity(decode(row)) !== identity(input.notification)
          || !sql.prepare('SELECT 1 FROM slack_dispatch_claims WHERE notificationId=? AND token=?').get(row.id, input.token)) return false;
        input.assertCurrent();
        if (input.policy) {
          const policy = parseAutomaticReviewPolicy(input.policy);
          if (policy.headSha !== input.notification.proposal?.headSha) throw new Error('Review policy belongs to a different PR head');
          sql.prepare('INSERT INTO slack_review_policies VALUES (?,?) ON CONFLICT(notificationId) DO UPDATE SET json=excluded.json').run(row.id, stableJson(policy));
        }
        sql.prepare('UPDATE slack_notifications SET status=?,updatedAt=?,readAt=NULL,error=? WHERE id=?')
          .run(input.status, input.now, input.error ?? null, row.id);
        input.releasePins?.();
        return true;
      });
    },
    close() { connection.close(); },
  };
}
