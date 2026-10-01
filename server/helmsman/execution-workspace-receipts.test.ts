// @vitest-environment node
import { expect, it } from 'vitest';
import { openExecutionWorkspaceReceipts } from './execution-workspace-receipts';
import { openExecutionStore } from './execution-store';
import { openPersistence } from './persistence';
it('retains exact allocation identity across attempts and rejects silently replacing a run workspace', () => {
  const persistence = openPersistence(':memory:');
  try {
    const executions = openExecutionStore(persistence, Date.now, { preferSchema: 2 });
    executions.reserveAdmission({ runId: 'one', repo: 'org/repo', maxConcurrency: 1, evidence: {} });
    const receipts = openExecutionWorkspaceReceipts(persistence);
    const identity = { version: 1, workspace: { path: '/tmp/repo/.worktrees/one', device: '1', inode: '2', birthtime: '3' }, administration: { path: '/tmp/repo/.git/worktrees/one', device: '1', inode: '4', birthtime: '5' }, commonDirectory: '/tmp/repo/.git' };
    receipts.record('one', identity.workspace.path, identity); receipts.record('one', identity.workspace.path, identity);
    expect(receipts.get('one', identity.workspace.path)).toEqual(identity);
    expect(() => receipts.record('one', identity.workspace.path, { ...identity, workspace: { ...identity.workspace, inode: '6' } })).toThrow('identity changed');
    persistence.sql.prepare("UPDATE execution_workspace_receipts SET json='{}'").run();
    expect(() => receipts.get('one', identity.workspace.path)).toThrow('integrity');
  } finally { persistence.close(); }
});
