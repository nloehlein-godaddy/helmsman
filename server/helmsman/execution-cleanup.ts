import type { ExecutionStore } from './execution-store';
import { openExecutionOwnership } from './execution-ownership';
import { PersistenceConflictError, type Persistence } from './persistence';

export function createExecutionCleanup(options: {
  persistence: Persistence; executions: ExecutionStore;
  withMaintenance<T>(repoDirectory: string, operation: () => Promise<T>): Promise<T>;
  verifyAbsent(repoDirectory: string, workspace: string): Promise<void>;
}) {
  const ownership = openExecutionOwnership(options.persistence);
  return {
    async remove(input: { runId: string; repoDirectory: string; commonDirectory: string; workspace: string; remove: () => Promise<void> }): Promise<void> {
      const owner = ownership.get(input.runId);
      if (!owner || owner.state === 'released') throw new PersistenceConflictError('Cleanup has no retained execution owner');
      const footprint = owner.footprint;
      if (footprint.checkout && (footprint.checkout.path !== input.repoDirectory || footprint.checkout.commonDirectory !== input.commonDirectory)
        || footprint.completeness === 'verified' && !footprint.resources.some(resource => resource.kind === 'workspace' && resource.identity === input.workspace)) {
        throw new PersistenceConflictError('Cleanup workspace differs from retained ownership');
      }
      const eligible = () => options.executions.cleanupEligibility(input.runId).allowed;
      const token = ownership.beginCleanup(input.runId, eligible);
      await options.withMaintenance(input.repoDirectory, async () => {
        const current = ownership.get(input.runId);
        if (current?.cleanupToken !== token || !eligible()) throw new PersistenceConflictError('Cleanup owner changed before filesystem mutation');
        for (const other of ownership.held()) {
          if (other.footprint.runId !== input.runId && other.footprint.resources.some(resource => resource.kind === 'workspace' && resource.identity === input.workspace)) {
            throw new PersistenceConflictError('Another execution retains this workspace');
          }
        }
        await input.remove();
        await options.verifyAbsent(input.repoDirectory, input.workspace);
        ownership.completeCleanup(input.runId, token, eligible);
      });
    },
  };
}
