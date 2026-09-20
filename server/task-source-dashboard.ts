import type { Ticket } from '../src/types';
import type { TaskSourceService } from './helmsman/task-source-service';

export async function sourceDashboard(service: TaskSourceService, selectedRepo: string | null, signal: AbortSignal) {
  const instances = service.instances(selectedRepo);
  const repos = [...new Set(instances.flatMap(instance => instance.allowedRepos))].sort();
  const queue: Ticket[] = [];
  const underway: Ticket[] = [];
  const degraded: string[] = [];
  const seen = new Set<string>();
  for (const instance of instances.filter(instance => instance.available)) {
    for (const repo of selectedRepo ? [selectedRepo] : instance.allowedRepos) {
      try {
        let cursor: string | null = null;
        const visited = new Set<string>();
        do {
          const page = await service.list({ instanceId: instance.id, instanceRevision: instance.revision, repo, state: null, cursor, limit: 100 }, signal);
          for (const task of page.items) {
            const key = JSON.stringify([task.ref.sourceId, task.ref.externalId]);
            if (seen.has(key)) continue;
            seen.add(key);
            const ticket: Ticket = { id: task.displayKey, title: task.title, repo: task.repo,
              priority: `P${Math.min(4, Math.max(0, Math.round(task.priority ?? 3)))}` as Ticket['priority'],
              status: task.state === 'ready' ? 'backlog' : task.state === 'in_progress' ? 'in-progress' : task.state === 'review' ? 'in-review' : 'done',
              source: { instanceId: instance.id, instanceRevision: instance.revision, ref: task.ref, url: task.url } };
            if (task.state === 'ready' && task.requirements.description.trim()) queue.push(ticket);
            if (task.state === 'in_progress' || task.state === 'review') underway.push(ticket);
          }
          cursor = page.nextCursor;
          if (cursor !== null) {
            if (visited.has(cursor) || visited.size >= 100) throw new Error('Source discovery exceeded its page limit');
            visited.add(cursor);
          }
        } while (cursor !== null);
      } catch { degraded.push(`task-source:${instance.id}`); }
    }
  }
  return { queue, underway, repos, degraded: [...new Set(degraded)] };
}
