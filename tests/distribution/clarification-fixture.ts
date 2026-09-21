import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { fixture } from './isolated-fixture';

export async function seedClarificationProof(host: Awaited<ReturnType<typeof fixture>>): Promise<{ channelId: string }> {
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(host.app, `server/helmsman/${name}.js`)).href);
  return JSON.parse(await host.script('seed-clarification-proof.mjs', `
      import { openPersistence, persistedJson } from ${moduleUrl('persistence')};
      import { openDb } from ${moduleUrl('db')};
      import { openExecutionStore } from ${moduleUrl('execution-store')};
      import { openClarificationStore } from ${moduleUrl('clarifications')};
      import { createClarificationChannel } from ${moduleUrl('clarification-protocol-store')};
      const persistence = openPersistence(process.env.HELMSMAN_DB); const db = openDb(persistence.sql);
      try {
        const executions = openExecutionStore(persistence); const store = openClarificationStore(persistence.sql, { getRun: db.getRun });
        const channel = createClarificationChannel(process.env.RUNS_DIR, { runId: 'run-proof', attempt: 1 });
        const task = { ticketId: 'proof', title: 'Proof', repo: 'org/a', task: 'Isolated proof', jiraBaseUrl: '', clarification: channel };
        db.insertRun({ id: 'run-proof', repo: 'org/a', ticketId: 'proof', adapter: 'test', status: 'running', attempt: 1, prNumber: null,
          startedAt: new Date().toISOString(), endedAt: null, costUsd: null, worktreePath: null, taskJson: JSON.stringify(task) });
        const artifact = { pluginId: 'example.runtime', artifactHash: 'a'.repeat(64), packageVersion: '1', requires: [] };
        const attempt = executions.prepare({ snapshot: { version: 1, runId: 'run-proof', attempt: 1, repo: 'org/a', task: persistedJson(task), logicalWork: { source: 'test', instance: 'test', taskId: 'proof' },
          workflowSnapshotId: null, artifacts: [artifact], settings: {}, schemas: [], provenance: { kind: 'admission', evidence: null },
          bindings: [{ role: 'host', capability: 'host', contractVersion: 1, contributionId: 'detached', pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, connectionId: null, credentialHandle: null }] },
          launchId: 'proof-launch', maxConcurrency: 10, paths: { worktree: null, log: process.env.RUNS_DIR + '/proof.log', exit: process.env.RUNS_DIR + '/proof.exit', spec: process.env.RUNS_DIR + '/proof.spec' } });
        store.protocol.bind(executions.snapshot(attempt.snapshotId));
        store.ingestQuestion('run-proof', { kind: 'question', id: 'question-proof', required: true, prompt: 'Approve the voyage?' }, channel);
        store.ingestQuestion('run-proof', { kind: 'question', id: 'legacy-proof', required: true, prompt: 'Unknown original question' });
        console.log(JSON.stringify({ channelId: channel.channelId }));
      } finally { persistence.close(); }
    `));
}
