import type { WorkRefV1 } from '../../src/plugins/tasks';
import { randomUUID } from 'node:crypto';
import type { SourceAdminRuntimeV1 } from '../../src/plugins/source-admin';
import { parseTaskRepo } from '../../src/plugins/tasks';
import { PersistenceConflictError } from './persistence';

export interface BacklogItem {
  schedulingDecision?: string;
  ticketId: string;
  title: string;
  todoId?: string;
  mode?: 'todo' | 'source';
  workRef?: WorkRefV1;
  sourceInstanceId?: string;
  sourceInstanceRevision?: number;
}

export interface SchedulerDeps {
  canStart: (repo: string) => boolean;
  fetchTopBacklog: (repo: string) => Promise<BacklogItem | null>;
  launch: (body: BacklogItem & { repo: string }) => void;
  onLog?: (msg: string) => void;
}

export class AutoClaimScheduler {
  private readonly deps: SchedulerDeps;
  private readonly enabledRepoSet: Set<string> = new Set();
  private readonly runtimeEpoch = randomUUID();
  private readonly runtimeRevisions = new Map<string, number>();

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  setEnabled(repo: string, enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new TypeError('Invalid automatic start state');
    this.runtimeRevisions.set(repo, (this.runtimeRevisions.get(repo) ?? 0) + 1);
    if (enabled) {
      this.enabledRepoSet.add(repo);
    } else {
      this.enabledRepoSet.delete(repo);
    }
  }

  runtime(repo: string): SourceAdminRuntimeV1 {
    parseTaskRepo(repo);
    return Object.freeze({ repo, epoch: this.runtimeEpoch, revision: this.runtimeRevisions.get(repo) ?? 0, enabled: this.isEnabled(repo) });
  }

  compareAndSetEnabled(input: { repo: string; epoch: string; expectedRevision: number; enabled: boolean }): SourceAdminRuntimeV1 {
    const current = this.runtime(input.repo);
    if (input.epoch !== current.epoch || input.expectedRevision !== current.revision) throw new PersistenceConflictError('Automatic start process or revision changed');
    this.setEnabled(input.repo, input.enabled);
    return this.runtime(input.repo);
  }

  isEnabled(repo: string): boolean {
    return this.enabledRepoSet.has(repo);
  }

  enabledRepos(): string[] {
    return Array.from(this.enabledRepoSet);
  }

  async tick(): Promise<void> {
    const reposSnapshot: string[] = Array.from(this.enabledRepoSet);

    for (const repo of reposSnapshot) {
      try {
        if (!this.deps.canStart(repo)) {
          continue;
        }

        const revision = this.runtimeRevisions.get(repo);
        const ticket: BacklogItem | null = await this.deps.fetchTopBacklog(repo);
        if (ticket === null) {
          continue;
        }

        if (!this.enabledRepoSet.has(repo) || this.runtimeRevisions.get(repo) !== revision || !this.deps.canStart(repo)) {
          continue;
        }

        this.deps.launch({
          ...ticket,
          repo,
        });
      } catch (err: unknown) {
        const message: string = err instanceof Error ? err.message : String(err);
        this.deps.onLog?.(`Error processing galleon ${repo}: ${message}`);
      }
    }
  }
}
