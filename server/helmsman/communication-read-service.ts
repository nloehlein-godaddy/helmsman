import type { CommunicationDestinationV1 } from '../../src/plugins/communication-provider';
import { parseCommunicationNotificationsV1, parseCommunicationSettingsValuesV1, type CommunicationNotificationsV1,
  type CommunicationSettingsSnapshotV1, type CommunicationSettingsValuesV1 } from '../../src/plugins/communication';
import type { SlackState } from '../../src/data/slack';
import { parseTaskRepo } from '../../src/plugins/tasks';
import { clarificationScope, ClarificationServiceError } from './clarification-service-common';
import { persistenceHash, type Persistence } from './persistence';

export interface CommunicationReadServerOptions {
  readonly persistence: Persistence;
  repos(): readonly string[];
  authorize(caller: string): void;
  snapshot(): SlackState;
  markRead(id: string, now: string): boolean;
  values(): CommunicationSettingsValuesV1;
  destination(): CommunicationDestinationV1 | null;
  write(values: CommunicationSettingsValuesV1): void;
  now?(): string;
}

export function createCommunicationReadService(options: CommunicationReadServerOptions) {
  function scope(caller: string, scopeRepo: string | null, repo: string | null): readonly string[] {
    options.authorize(caller);
    return clarificationScope(options.repos(), scopeRepo, repo);
  }
  function settings(): CommunicationSettingsSnapshotV1 {
    const values = parseCommunicationSettingsValuesV1(options.values());
    const destination = options.destination();
    return Object.freeze({ version: 1, revision: persistenceHash({ values, destination }), values, destination });
  }
  return Object.freeze({
    notifications(caller: string, input: { version: 1; repo: string | null; limit: number }, scopeRepo: string | null): CommunicationNotificationsV1 {
      if (input?.version !== 1 || !Number.isSafeInteger(input?.limit) || input.limit < 1 || input.limit > 256)
        throw new ClarificationServiceError(400, 'invalid-response');
      const allowed = scope(caller, scopeRepo, input.repo === null ? null : parseTaskRepo(input.repo));
      const snapshot = options.snapshot();
      const notifications = snapshot.notifications.filter(item => item && allowed.some(repo => repo.toLowerCase() === item.repo?.toLowerCase()));
      const selected = notifications.slice(0, input.limit);
      return parseCommunicationNotificationsV1({ version: 1, quality: selected.length < notifications.length ? 'partial' : 'complete',
        health: snapshot.health, githubHealth: snapshot.githubHealth ?? null,
        unread: notifications.filter(item => item.readAt === null).length, notifications: selected });
    },
    markRead(caller: string, input: { repo: string; id: string }, scopeRepo: string | null) {
      const repo = parseTaskRepo(input?.repo); scope(caller, scopeRepo, repo);
      if (typeof input?.id !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(input.id)) throw new ClarificationServiceError(400, 'invalid-response');
      const notification = options.snapshot().notifications.find(item => item.id === input.id && item.repo.toLowerCase() === repo.toLowerCase());
      if (!notification) throw new ClarificationServiceError(404, 'not-found');
      const readAt = notification.readAt ?? (options.now?.() ?? new Date().toISOString());
      if (!notification.readAt && !options.markRead(input.id, readAt)) throw new ClarificationServiceError(404, 'not-found');
      return Object.freeze({ version: 1 as const, id: input.id, readAt });
    },
    settings(caller: string, scopeRepo: string | null): CommunicationSettingsSnapshotV1 {
      scope(caller, scopeRepo, null); return settings();
    },
    saveSettings(caller: string, input: { expectedRevision: string; values: CommunicationSettingsValuesV1 }, scopeRepo: string | null): CommunicationSettingsSnapshotV1 {
      scope(caller, scopeRepo, null);
      const values = parseCommunicationSettingsValuesV1(input?.values);
      if (typeof input?.expectedRevision !== 'string' || !/^[a-f\d]{64}$/.test(input.expectedRevision)) throw new ClarificationServiceError(400, 'invalid-response');
      return options.persistence.transaction(() => {
        if (settings().revision !== input.expectedRevision) throw new ClarificationServiceError(409, 'conflict');
        options.write(values);
        return settings();
      });
    },
  });
}

export type CommunicationReadServerService = ReturnType<typeof createCommunicationReadService>;
