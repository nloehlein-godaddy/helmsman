import type { RunRow } from './db';
import type { openExecutionOwnership, ExecutionOwnership } from './execution-ownership';
import { proveLegacyTerminalProcessInactive } from './legacy-execution-process-proof';
import { withLegacyExecutionWorkspaceProof } from './legacy-execution-workspace-proof';
import { persistenceHash, type Persistence } from './persistence';

export async function reconcileLegacyExecution(options: {
  persistence: Persistence;
  ownership: ReturnType<typeof openExecutionOwnership>;
  owner: ExecutionOwnership;
  agentsRoot: string;
  isolatedRoot: string;
}): Promise<'skipped' | 'reconciled'> {
  const { persistence, ownership, owner } = options;
  const { runId, repo } = owner.footprint;
  if (owner.state !== 'held' || owner.footprint.checkout !== null || owner.footprint.completeness !== 'exclusive'
    || owner.footprint.resources.length !== 1 || owner.footprint.resources[0]?.kind !== 'galleon-exclusive') return 'skipped';
  const row = persistence.sql.prepare('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | undefined;
  if (!row || row.status === 'running'
    || !persistence.sql.prepare('SELECT 1 FROM legacy_execution_obligations WHERE runId=?').get(runId)) return 'skipped';
  const expectedRunHash = persistenceHash(row);
  const expectedFootprintHash = persistenceHash(owner.footprint);
  return withLegacyExecutionWorkspaceProof({ agentsRoot: options.agentsRoot, isolatedRoot: options.isolatedRoot,
    repo, runId, recordedWorkspacePath: row.worktreePath }, async proof => {
    if (proof.kind === 'blocked') throw new Error(proof.reason);
    const process = await proveLegacyTerminalProcessInactive(row);
    if (!process.inactive) throw new Error(process.reason);
    ownership.reconcileLegacyTerminal({ runId, expectedRunHash, expectedFootprintHash,
      checkout: proof.checkout, workspace: proof.workspace,
      ...(proof.kind === 'retained' ? { kind: 'registered', branchRef: proof.branchRef } as const
        : { kind: proof.kind, branchRef: null }) });
    return 'reconciled' as const;
  });
}
