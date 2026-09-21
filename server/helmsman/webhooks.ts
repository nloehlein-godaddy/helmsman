import type { WebhookTriggerProviderV1, WebhookTriggerResultV1 } from '../../src/plugins/trigger';
import type { ExecutionStore } from './execution-store';
import { persistenceHash } from './persistence';
import { parseTriggerProvenanceV1, triggerDependencyPins, type TriggerProvenanceV1 } from './trigger-provenance';
import { runWebhookTrigger, triggerSource, type SelectedTriggerCapture } from './trigger-runtime';
import type Database from 'better-sqlite3';
import { storeConnection } from './store-connection';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookLaunch { repo: string; workflowRef: string; runId: string; mode: 'freeform' | 'review'; title: string; task?: string; prNumber?: number; trigger?: TriggerProvenanceV1 }
export class WebhookError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function openWebhookIntake(path: string | Database.Database, deps: {
  secret(): string | undefined;
  captureTrigger: (signal: AbortSignal) => SelectedTriggerCapture<WebhookTriggerProviderV1> | null;
  credentialHandle?: () => string | null;
  assertWorkflow?: (input: WebhookLaunch) => void;
  verifyLaunch?: (input: WebhookLaunch, trigger: TriggerProvenanceV1) => void | Promise<void>;
  retainPins?: ExecutionStore['retainPins'];
  releaseTriggerPins?: ExecutionStore['releaseTriggerPins'];
  allowedRepos(): string[];
  canStart(repo: string): boolean;
  getRun(id: string): { status: string } | null;
  isRunActive(id: string): boolean;
  launch(input: WebhookLaunch): string;
  now?: () => number;
}) {
  const connection = storeConnection(path);
  const { sql } = connection;
  connection.migrate({ owner: 'compat.webhooks', ddl: `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    delivery TEXT PRIMARY KEY, digest TEXT NOT NULL, runId TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL, state TEXT NOT NULL, claimedAt INTEGER, error TEXT, triggerJson TEXT
  )`, optionalLegacyColumns: { webhook_deliveries: ['triggerJson'] }, upgrade(database) {
    const columns = database.prepare('PRAGMA table_info(webhook_deliveries)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'triggerJson')) database.exec('ALTER TABLE webhook_deliveries ADD COLUMN triggerJson TEXT');
  } });

  const now = deps.now ?? Date.now;
  let polling: Promise<void> | null = null;
  function release(delivery: string): void {
    try { deps.releaseTriggerPins?.({ store: 'webhook', rowId: delivery }); } catch {}
  }
  function assertEnabled(): SelectedTriggerCapture<WebhookTriggerProviderV1> {
    try {
      const capture = deps.captureTrigger(AbortSignal.timeout(30_000));
      if (!capture || capture.record.settings.enabled === false) throw new Error('disabled');
      capture.assertCurrent(); return capture;
    } catch { throw new WebhookError('Selected webhook trigger is unavailable', 503); }
  }
  function proposal(input: WebhookLaunch): WebhookTriggerResultV1 {
    return { workflowRef: input.workflowRef, intent: input.mode === 'review'
      ? { mode: 'review', repo: input.repo, title: input.title, prNumber: input.prNumber! }
      : { mode: 'freeform', repo: input.repo, title: input.title, task: input.task! } };
  }
  async function scan(): Promise<void> {
    const retained = sql.prepare('SELECT delivery FROM webhook_deliveries WHERE triggerJson IS NOT NULL').all() as Array<{ delivery: string }>;
    for (const row of retained) release(row.delivery);
    const pending = sql.prepare("SELECT * FROM webhook_deliveries WHERE state IN ('pending','dispatching') ORDER BY rowid LIMIT 100").all() as Array<{ delivery: string; payload: string; runId: string; claimedAt: number | null; state: string; triggerJson: string | null }>;
    for (const item of pending) {
      if (deps.getRun(item.runId)) {
        sql.prepare("UPDATE webhook_deliveries SET state = 'launched' WHERE delivery = ?").run(item.delivery); release(item.delivery); continue;
      }
      if (deps.isRunActive(item.runId) || item.state === 'dispatching' && now() - (item.claimedAt ?? 0) < 60000) continue;
      try {
        const input = JSON.parse(item.payload) as WebhookLaunch;
        if (!input || input.runId !== item.runId || !['review', 'freeform'].includes(input.mode)) throw new Error('Stored webhook launch is invalid');
        const trigger = item.triggerJson ? parseTriggerProvenanceV1(JSON.parse(item.triggerJson)) : null;
        const capture = assertEnabled();
        if (trigger) {
          if (persistenceHash(proposal(input)) !== trigger.proposalHash) throw new Error('Stored webhook proposal changed');
          if (!deps.verifyLaunch) throw new Error('Webhook dispatch verification is unavailable');
          await deps.verifyLaunch(input, trigger);
          capture?.assertCurrent();
        }
        if (!deps.allowedRepos().some(repo => repo.toLowerCase() === input.repo.toLowerCase())) {
          sql.prepare("UPDATE webhook_deliveries SET state = 'rejected', error = 'Galleon no longer configured' WHERE delivery = ?").run(item.delivery); release(item.delivery); continue;
        }
        if (!deps.canStart(input.repo)) continue;
        capture?.assertCurrent();
        const claimed = sql.prepare("UPDATE webhook_deliveries SET state = 'dispatching', claimedAt = ? WHERE delivery = ? AND (state = 'pending' OR (state = 'dispatching' AND claimedAt <= ?))").run(now(), item.delivery, now() - 60000);
        if (!claimed.changes) continue;
        if (deps.launch({ ...input, ...(trigger ? { trigger } : {}) }) !== item.runId) throw new Error('Webhook launcher returned a different run ID');
        if (deps.getRun(item.runId)) { sql.prepare("UPDATE webhook_deliveries SET state = 'launched', error = NULL WHERE delivery = ?").run(item.delivery); release(item.delivery); }
      } catch (error) {
        sql.prepare('UPDATE webhook_deliveries SET error = ? WHERE delivery = ?').run(String(error).slice(0, 2000), item.delivery);
      }
    }
  }
  function receiveTriggered(raw: Buffer, headers: { signature?: string; delivery?: string; event?: string; values?: Readonly<Record<string, string>> }) {
    const capture = assertEnabled(); const ingress = capture.provider.metadata.ingress;
    const secret = deps.secret(); const credentialHandle = deps.credentialHandle?.() ?? 'github-webhook';
    if (!secret || !credentialHandle) throw new WebhookError('Webhook intake is disabled', 503);
    if (raw.length > 1_000_000) throw new WebhookError('Webhook payload too large', 413);
    const signature = headers.values ? headers.values[ingress.signatureHeader] : headers.signature;
    const delivery = headers.values ? headers.values[ingress.deliveryHeader] : headers.delivery;
    const event = headers.values ? headers.values[ingress.eventHeader] : headers.event;
    const digestSignature = signature?.startsWith(ingress.signaturePrefix) ? signature.slice(ingress.signaturePrefix.length) : '';
    if (!/^[a-f\d]{64}$/i.test(digestSignature) || !timingSafeEqual(createHmac('sha256', secret).update(raw).digest(), Buffer.from(digestSignature, 'hex'))) throw new WebhookError('Invalid webhook signature', 401);
    if (!delivery || !/^[a-z\d_-]{1,128}$/i.test(delivery)) throw new WebhookError('Invalid delivery ID');
    const digest = createHash('sha256').update(raw).digest('hex');
    const prior = sql.prepare('SELECT digest,runId,state FROM webhook_deliveries WHERE delivery=?').get(delivery) as { digest: string; runId: string; state: string } | undefined;
    if (prior) {
      if (prior.digest !== digest) throw new WebhookError('Delivery ID reused for a different payload', 409);
      return { runId: prior.state === 'ignored' ? null : prior.runId, duplicate: true, ignored: prior.state === 'ignored' };
    }
    if (!event || event.length > 128 || /[\x00-\x1f\x7f]/.test(event)) throw new WebhookError('Invalid webhook event');
    let body: unknown;
    try { body = JSON.parse(raw.toString('utf8')); } catch { throw new WebhookError('Invalid webhook JSON'); }
    const decision = runWebhookTrigger({ capture, source: triggerSource(capture.instanceId, persistenceHash({ instanceId: capture.instanceId, credentialHandle })),
      request: { version: 1, deliveryId: delivery, event, body: body as import('../../src/plugins/backend').PluginJson }, capturedAt: new Date(now()).toISOString() });
    const runId = `wh-${createHash('sha256').update(delivery).digest('hex')}`;
    const input: WebhookLaunch | null = decision.result ? { ...decision.result.intent, workflowRef: decision.result.workflowRef, runId } : null;
    if (input) {
      if (!deps.allowedRepos().some(repo => repo.toLowerCase() === input.repo.toLowerCase())) throw new WebhookError('Galleon is not configured', 422);
      deps.assertWorkflow?.(input);
    }
    if (!deps.retainPins) throw new Error('Webhook trigger pin retention is unavailable');
    sql.transaction(() => {
      capture.assertCurrent();
      if (deps.secret() !== secret || (deps.credentialHandle?.() ?? 'github-webhook') !== credentialHandle) throw new WebhookError('Webhook credential changed', 409);
      if (input) deps.assertWorkflow?.(input);
      sql.prepare('INSERT INTO webhook_deliveries (delivery,digest,runId,payload,state,triggerJson) VALUES (?,?,?,?,?,?)')
        .run(delivery, digest, runId, JSON.stringify(input), input ? 'pending' : 'ignored', JSON.stringify(decision.trigger));
      deps.retainPins!(triggerDependencyPins(decision.trigger, 'webhook', delivery));
    }).immediate();
    if (!input) release(delivery);
    return { runId: input ? runId : null, duplicate: false, ignored: input === null };
  }
  return {
    receive: receiveTriggered,
    poll(): Promise<void> { polling ??= scan().finally(() => { polling = null; }); return polling; },
    status() { return sql.prepare('SELECT delivery, runId, state, error FROM webhook_deliveries ORDER BY rowid DESC LIMIT 100').all(); },
    close() { connection.close(); },
  };
}
