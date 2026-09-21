import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const module = relative => import(pathToFileURL(join(input.app, relative)).href);
const { loadPluginSnapshot } = await module('server/helmsman/plugins/store.js');
const { activateBackendPlugins } = await module('server/helmsman/plugins/backend.js');
const { resolveTriggerSelection, assertTriggerSelectionCurrent } = await module('server/helmsman/trigger-selection.js');
const { openPersistence } = await module('server/helmsman/persistence.js');
const { openExecutionStore } = await module('server/helmsman/execution-store.js');
const { openAdmissionStore } = await module('server/helmsman/admission-store.js');
const { openWebhookIntake } = await module('server/helmsman/webhooks.js');

const snapshot = await loadPluginSnapshot(input.pluginsRoot);
const runtime = await activateBackendPlugins({ root: input.pluginsRoot, snapshot, usage: { async query() { throw new Error('Unexpected usage access'); } } });
const persistence = openPersistence(input.database);
const executions = openExecutionStore(persistence);
const admissions = openAdmissionStore(persistence, executions);
function capture() {
  try {
    const selection = resolveTriggerSelection({ root: input.pluginsRoot, registry: runtime.triggers, kind: 'github-webhook' });
    if (!selection.record || selection.record.settings.enabled === false) return null;
    const registration = runtime.triggers.resolve(selection.record.binding);
    const artifact = [...snapshot.artifacts.values()].find(value => value.package.manifest.id === selection.record.binding.pluginId);
    if (!artifact) throw new Error('Selected trigger artifact is unavailable');
    return { instanceId: 'github-webhook', selectionRevision: selection.revision, record: selection.record, provider: registration.provider,
      artifacts: [{ pluginId: artifact.package.manifest.id, artifactHash: artifact.hash, packageVersion: artifact.package.manifest.version, requires: [] }],
      assertCurrent() { assertTriggerSelectionCurrent({ root: input.pluginsRoot, registry: runtime.triggers }, selection); } };
  } catch { return null; }
}
const intake = openWebhookIntake(persistence.sql, {
  secret: () => input.secret,
  credentialHandle: () => 'queue-credential',
  captureTrigger: capture,
  assertWorkflow() {},
  async verifyLaunch() {},
  retainPins: executions.retainPins,
  releaseTriggerPins: executions.releaseTriggerPins,
  allowedRepos: () => ['org/a'],
  canStart: () => input.action === 'poll',
  getRun(id) { const admission = admissions.get(id); return admission ? { status: admission.state === 'failed' ? 'failed' : 'running' } : null; },
  isRunActive: () => false,
  launch(value) {
    admissions.admit({ runId: value.runId, repo: value.repo, request: { trigger: value.trigger }, settings: {}, artifacts: value.trigger?.artifacts ?? [] }, 2);
    writeFileSync(input.launchOutput, JSON.stringify(value));
    return value.runId;
  },
});
try {
  if (input.action === 'enqueue') {
    const raw = Buffer.from(JSON.stringify(input.body));
    const signature = createHmac('sha256', input.secret).update(raw).digest('hex');
    intake.receive(raw, { values: { 'x-hub-signature-256': `sha256=${signature}`, 'x-github-delivery': 'queued-delivery', 'x-github-event': 'issues' } });
  }
  await intake.poll();
  const status = intake.status();
  const row = status.find(value => value.delivery === 'queued-delivery');
  console.log(JSON.stringify({ row, admission: row?.runId ? admissions.get(row.runId) : null }));
} finally {
  intake.close();
  await runtime.dispose();
  persistence.close();
}
