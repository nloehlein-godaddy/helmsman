import { randomUUID } from 'node:crypto';
import { clarificationAbortable } from '../../src/plugins/clarification-transport';
import { parseSchedulingChoiceV1, parseSchedulingDiscoveryInputV1, type SchedulingPageV1 } from '../../src/plugins/scheduling-provider';
import type { SourceInstanceV1, TaskSnapshotV1 } from '../../src/plugins/tasks';
import type { SchedulingProviderSelection } from './scheduling-providers';
import { parseTaskRepo } from '../../src/plugins/tasks';
import { migrateOwned, validateTableColumns } from './migrations';
import { persistedJson, persistenceHash, PersistenceConflictError, PersistenceValidationError, stableJson } from './persistence';
import type { TaskSourceStore } from './task-sources/store';
import type { TaskSourceService } from './task-source-service';
import type { BacklogItem } from './scheduler';

interface SourceSchedule { repo: string; instanceIds: readonly string[]; lastInstanceId: string | null; revision: number; cursorRevision: number; }
export function openTaskSourceSchedule(store: TaskSourceStore, service: TaskSourceService, onUnavailable: (instanceId: string) => void = () => {}, policy?: () => SchedulingProviderSelection) {
  const { sql } = store.persistence;
  const ddl = 'CREATE TABLE source_schedules (repo TEXT PRIMARY KEY,json TEXT NOT NULL)';
  migrateOwned(sql, { owner: 'core.source-schedules', version: 1, checksum: persistenceHash(ddl), tables: ['source_schedules'],
    validateLegacy: () => null, apply: database => database.exec(ddl), validateCurrent: database => validateTableColumns(database, 'source_schedules', ['repo', 'json']) });
  function selection(repo: string): SourceSchedule | null {
    parseTaskRepo(repo);
    const row = sql.prepare('SELECT json FROM source_schedules WHERE repo=?').get(repo) as { json: string } | undefined;
    if (!row) return null;
    const value = persistedJson(JSON.parse(row.json)) as unknown as SourceSchedule;
    if (!value || value.repo !== repo || !Array.isArray(value.instanceIds) || value.instanceIds.length > 32
      || value.instanceIds.some(id => typeof id !== 'string' || !id || id.length > 160) || new Set(value.instanceIds).size !== value.instanceIds.length
      || value.cursorRevision !== undefined && (!Number.isSafeInteger(value.cursorRevision) || value.cursorRevision < 0)
      || value.lastInstanceId !== null && !value.instanceIds.includes(value.lastInstanceId) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new PersistenceValidationError('Invalid task source scheduling selection');
    return { ...value, cursorRevision: value.cursorRevision ?? 0 };
  }
  const write = (value: SourceSchedule) => sql.prepare('INSERT INTO source_schedules VALUES (?,?) ON CONFLICT(repo) DO UPDATE SET json=excluded.json').run(value.repo, stableJson(value));
  type Candidate = { instance: SourceInstanceV1; task: Pick<TaskSnapshotV1, 'state' | 'repo' | 'ref' | 'revision' | 'displayKey' | 'title'> };
  const decisions = new Map<string, { expiresAt: number; ticket: BacklogItem; selected: SourceSchedule; policy: SchedulingProviderSelection; candidate: Candidate; signal: AbortSignal }>();
  function currentPolicy(expected: SchedulingProviderSelection): void {
    const current = policy?.();
    if (!current || current.revision !== expected.revision || current.registration !== expected.registration) throw new PersistenceConflictError('Scheduling provider selection changed during discovery');
  }
  function currentSelection(expected: SourceSchedule): void {
    const current = selection(expected.repo);
    if (current?.revision !== expected.revision || current.cursorRevision !== expected.cursorRevision) throw new PersistenceConflictError('Task source scheduling selection changed during discovery');
  }
  function eligible(candidate: Candidate, repo: string): void {
    service.assertScope(candidate.instance, repo, 'admission');
    if (candidate.task.state !== 'ready' || candidate.task.repo !== repo || store.activeClaim(candidate.task.ref)) throw new PersistenceConflictError('Scheduled task is no longer eligible');
    store.assertUnquarantined(candidate.task.ref, candidate.task.displayKey);
  }
  return {
    initialize(input: { repos: readonly string[]; defaultSourceId: string | null }) {
      store.persistence.transaction(() => {
        const source = input.defaultSourceId ? store.source(input.defaultSourceId) : null;
        const instance = source ? store.instance(source.currentInstanceId) : null;
        for (const repo of input.repos) if (!selection(repo)) write({ repo, instanceIds: instance?.allowedRepos.includes(repo) ? [instance.id] : [], lastInstanceId: null, revision: 1, cursorRevision: 0 });
      });
    },
    selections(repo: string) { return selection(repo) ?? { repo, instanceIds: [], lastInstanceId: null, revision: 0, cursorRevision: 0 }; },
    select(repo: string, instanceIds: readonly string[], expectedRevision: number) {
      return store.persistence.transaction(() => {
        const current = selection(repo);
        if ((current?.revision ?? 0) !== expectedRevision) throw new PersistenceConflictError('Task source schedule changed');
        if (!Array.isArray(instanceIds) || instanceIds.length > 32 || new Set(instanceIds).size !== instanceIds.length) throw new PersistenceValidationError('Select distinct task source instances');
        const sources = new Set<string>();
        for (const id of instanceIds) {
          const instance = typeof id === 'string' ? store.instance(id) : null;
          if (!instance || !instance.allowedRepos.includes(repo)) throw new PersistenceConflictError('Task source is outside this galleon');
          service.assertScope(instance, repo, 'admission');
          if (sources.has(instance.sourceId)) throw new PersistenceConflictError('Select one instance per logical source');
          sources.add(instance.sourceId);
        }
        const next = { repo, instanceIds: [...instanceIds].sort(), lastInstanceId: null, revision: expectedRevision + 1, cursorRevision: 0 };
        write(next); return next;
      });
    },
    assertAdmission(body: { repo: string; schedulingDecision?: string; ticketId?: string; title?: string; workRef?: BacklogItem['workRef']; sourceInstanceId?: string; sourceInstanceRevision?: number }) {
      if (body.schedulingDecision === undefined) return null;
      const decision = decisions.get(body.schedulingDecision);
      if (!decision || decision.expiresAt < Date.now()) throw new PersistenceConflictError('Scheduling decision expired or is unavailable');
      decision.signal.throwIfAborted(); currentPolicy(decision.policy); currentSelection(decision.selected);
      const ticket = decision.ticket;
      if (body.repo !== decision.selected.repo || body.ticketId !== ticket.ticketId || body.title !== ticket.title
        || body.sourceInstanceId !== ticket.sourceInstanceId || body.sourceInstanceRevision !== ticket.sourceInstanceRevision
        || persistenceHash(body.workRef ?? null) !== persistenceHash(ticket.workRef ?? null)) throw new PersistenceConflictError('Scheduling decision does not match admission');
      eligible(decision.candidate, body.repo);
      decisions.delete(body.schedulingDecision);
      return persistedJson({ version: 1, provider: decision.policy.registration.binding, settingsHash: decision.policy.registration.settingsHash, policyRevision: decision.policy.revision,
        sourceScheduleRevision: decision.selected.revision, sourceCursorRevision: decision.selected.cursorRevision,
        instanceId: decision.candidate.instance.id, instanceRevision: decision.candidate.instance.revision,
        ref: decision.candidate.task.ref, taskRevision: decision.candidate.task.revision });
    },
    async next(repo: string, callerSignal: AbortSignal): Promise<BacklogItem | null> {
      callerSignal.throwIfAborted();
      const selected = selection(repo);
      if (!selected?.instanceIds.length) return null;
      const chosenPolicy = policy?.();
      if (!chosenPolicy) throw new PersistenceConflictError('Scheduling provider is unavailable');
      const controller = new AbortController(); const signal = AbortSignal.any([callerSignal, controller.signal]);
      const timer = setTimeout(() => controller.abort(new Error('Scheduling decision timed out')), 30_000);
      const candidates = new Map<string, Candidate>(); const cursors = new Map<string, { instanceId: string; cursor: string }>();
      const consumed = new Set<string>(); const pageCounts = new Map<string, number>(); const visited = new Map<string, Set<string>>();
      const instances = new Map<string, SourceInstanceV1>();
      let violation: Error | undefined;
      function invalid(message: string): never { violation = new PersistenceConflictError(message); throw violation; }
      const check = () => { signal.throwIfAborted(); if (violation) throw violation; currentPolicy(chosenPolicy); currentSelection(selected); };
      for (const id of selected.instanceIds) {
        const instance = store.instance(id);
        if (!instance) continue;
        try { service.assertScope(instance, repo, 'admission'); instances.set(id, instance); } catch { continue; }
      }
      try {
        const list = async (value: unknown): Promise<SchedulingPageV1> => {
          check(); const input = parseSchedulingDiscoveryInputV1(value); const instance = instances.get(input.instanceId);
          if (!instance) invalid('Scheduling discovery source is outside the selected scope');
          const issued = input.cursor === null ? null : cursors.get(input.cursor);
          const key = input.cursor ?? `first:${instance.id}`;
          if (input.cursor !== null && (!issued || issued.instanceId !== instance.id) || consumed.has(key)) invalid('Scheduling discovery cursor is invalid or already consumed');
          if (consumed.size >= 512 || (pageCounts.get(instance.id) ?? 0) >= 100) invalid('Scheduling discovery page budget exceeded');
          consumed.add(key); pageCounts.set(instance.id, (pageCounts.get(instance.id) ?? 0) + 1);
          try {
            const page = await clarificationAbortable(service.list({ instanceId: instance.id, instanceRevision: instance.revision, repo, state: 'ready', cursor: issued?.cursor ?? null, limit: input.limit }, signal), signal);
            check(); service.assertScope(instance, repo, 'admission');
            const items = [];
            for (const task of page.items) {
              const candidate: Candidate = { instance, task: { state: task.state, repo: task.repo, ref: task.ref, revision: task.revision, displayKey: task.displayKey, title: task.title } };
              try { eligible(candidate, repo); } catch { continue; }
              if (candidates.size >= 10_000) invalid('Scheduling discovery candidate budget exceeded');
              const candidateId = randomUUID(); candidates.set(candidateId, candidate);
              items.push(Object.freeze({ candidateId, ref: task.ref, revision: task.revision, displayKey: task.displayKey, title: task.title, priority: task.priority }));
            }
            let nextCursor: string | null = null;
            if (page.nextCursor !== null) {
              const seen = visited.get(instance.id) ?? new Set<string>();
              if (seen.has(page.nextCursor)) throw new PersistenceConflictError('Task source pagination did not advance');
              seen.add(page.nextCursor); visited.set(instance.id, seen);
              nextCursor = randomUUID(); cursors.set(nextCursor, { instanceId: instance.id, cursor: page.nextCursor });
            }
            return Object.freeze({ items: Object.freeze(items), nextCursor });
          } catch {
            check(); onUnavailable(instance.id); return Object.freeze({ items: Object.freeze([]), nextCursor: null });
          }
        };
        const input = Object.freeze({ version: 1 as const, repo, sources: Object.freeze([...instances.values()].map(instance => Object.freeze({ instanceId: instance.id, sourceId: instance.sourceId, label: instance.label }))), lastInstanceId: selected.lastInstanceId });
        const result = await clarificationAbortable(Promise.resolve().then(() => { check(); return chosenPolicy.registration.provider.select(input, Object.freeze({ signal, list })); }), signal);
        check(); const choice = parseSchedulingChoiceV1(result);
        if (choice === null) return null;
        const candidate = candidates.get(choice.candidateId);
        if (!candidate) throw new PersistenceConflictError('Scheduling provider chose an undiscovered task');
        const next = { ...selected, lastInstanceId: candidate.instance.id, cursorRevision: selected.cursorRevision + 1 };
        store.persistence.transaction(() => { check(); eligible(candidate, repo); write(next); });
        const schedulingDecision = randomUUID();
        const ticket: BacklogItem = Object.freeze({ mode: 'source', ticketId: candidate.task.displayKey, title: candidate.task.title, workRef: candidate.task.ref,
          sourceInstanceId: candidate.instance.id, sourceInstanceRevision: candidate.instance.revision, schedulingDecision });
        for (const [id, decision] of decisions) if (decision.expiresAt < Date.now() || decision.selected.repo === repo) decisions.delete(id);
        if (decisions.size >= 1000) decisions.delete(decisions.keys().next().value!);
        decisions.set(schedulingDecision, { expiresAt: Date.now() + 30_000, ticket, selected: next, policy: chosenPolicy, candidate, signal: callerSignal });
        return ticket;
      } finally { clearTimeout(timer); controller.abort(); }
    },
  };
}
export type TaskSourceSchedule = ReturnType<typeof openTaskSourceSchedule>;
