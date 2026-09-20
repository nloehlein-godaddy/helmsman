import { parseTaskRepo, parseWorkRefV1, TaskSourceValidationError, type TaskSnapshotV1 } from '../../src/plugins/tasks';
import type { PluginJson } from '../../src/plugins/backend';
import { PersistenceConflictError, PersistenceValidationError } from './persistence';
import type { ApiResult } from './router';
import type { TaskSourceService } from './task-source-service';
import type { LaunchIntent } from './retry';
import { pluginJson } from './plugins/data';
import type { TaskSourceSchedule } from './task-source-schedule';

function object(input: unknown): Record<string, unknown> {
  try { input = pluginJson(input, { maxBytes: 256 * 1024, maxNodes: 16_384 }); } catch { throw new PersistenceValidationError('Request body must be plain JSON'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PersistenceValidationError('Request body must be an object');
  return input as Record<string, unknown>;
}
function revision(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) throw new PersistenceValidationError('Source instance revision is required');
  return input;
}
function text(input: unknown, label: string, limit: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > limit) throw new PersistenceValidationError(`${label} is required`);
  return input;
}

export async function handleTaskSourceApi(input: { method: string; path: string; query: URLSearchParams; body: unknown;
  service?: TaskSourceService; schedule?: TaskSourceSchedule; launch(body: LaunchIntent): string; signal?: AbortSignal }): Promise<ApiResult | null> {
  if (input.path !== '/api/task-sources' && !input.path.startsWith('/api/task-sources/')) return null;
  if (!input.service) return { status: 503, json: { error: 'Task sources are unavailable.' } };
  const service = input.service;
  const signal = input.signal ?? AbortSignal.timeout(30_000);
  try {
    signal.throwIfAborted();
    if (input.path === '/api/task-sources' && input.method === 'GET') return { status: 200, json: { instances: service.instances(input.query.get('repo')) } };
    if (input.path === '/api/task-sources') return { status: 405, json: { error: 'Task source method is unavailable.' } };
    if (input.path === '/api/task-sources/adoption' || input.path === '/api/task-sources/refresh') {
      if (input.method !== 'GET') return { status: 405, json: { error: 'Task source method is unavailable.' } };
      return { status: 200, json: (input.path.endsWith('/refresh') ? service.refresh : service.adoption).candidates(text(input.query.get('sourceId'), 'Source ID', 160)) };
    }
    if (/^\/api\/task-sources\/(adoption|refresh)\/(validate|commit)$/.test(input.path)) {
      const replacement = input.path.includes('/refresh/') ? service.refresh : service.adoption;
      if (input.method !== 'POST') return { status: 405, json: { error: 'Task source method is unavailable.' } };
      const body = object(input.body);
      if (input.path.endsWith('/commit')) {
        if (Object.keys(body).some(key => key !== 'validationId')) throw new PersistenceValidationError('Unsupported source adoption commit field');
        return { status: 200, json: replacement.commit(text(body.validationId, 'Validation ID', 160)) };
      }
      if (Object.keys(body).some(key => !['sourceId', 'sourceRevision', 'providerId', 'artifactHash', 'repo', 'actor', 'reason'].includes(key))) throw new PersistenceValidationError('Unsupported source adoption validation field');
      return { status: 200, json: await replacement.validate({ sourceId: text(body.sourceId, 'Source ID', 160), sourceRevision: revision(body.sourceRevision), providerId: text(body.providerId, 'Provider ID', 240), artifactHash: text(body.artifactHash, 'Artifact hash', 64), repo: parseTaskRepo(body.repo), actor: text(body.actor, 'Actor', 240), reason: text(body.reason, 'Reason', 2048) }, signal) };
    }
    if (input.path === '/api/task-sources/schedule') {
      if (!input.schedule) return { status: 503, json: { error: 'Source scheduling is unavailable.' } };
      const repo = parseTaskRepo(input.query.get('repo'));
      if (input.method === 'GET') return { status: 200, json: input.schedule.selections(repo) };
      if (input.method === 'POST') {
        const body = object(input.body);
        if (!Array.isArray(body.instanceIds) || !body.instanceIds.every(value => typeof value === 'string')
          || typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new PersistenceValidationError('Invalid source schedule');
        return { status: 200, json: input.schedule.select(repo, body.instanceIds, body.revision) };
      }
      return { status: 405, json: { error: 'Task source method is unavailable.' } };
    }
    const match = /^\/api\/task-sources\/([a-z\d-]{1,160})\/(tasks|lookup|commands|launch|enablement|configuration)$/i.exec(input.path);
    if (!match) return { status: 404, json: { error: 'Task source route not found.' } };
    const instanceId = match[1]!;
    if (input.method === 'GET' && (match[2] === 'tasks' || match[2] === 'lookup')) {
      const scope = { instanceId, instanceRevision: revision(Number(input.query.get('revision'))), repo: parseTaskRepo(input.query.get('repo')) };
      if (match[2] === 'lookup') return { status: 200, json: { ref: await service.lookup({ ...scope, displayKey: text(input.query.get('key'), 'Task key', 512) }, signal) } };
      const sourceId = input.query.get('sourceId');
      const externalId = input.query.get('externalId');
      if (sourceId !== null || externalId !== null) {
        const task = await service.load({ ...scope, ref: parseWorkRefV1({ sourceId, externalId }) }, signal);
        return task ? { status: 200, json: { task } } : { status: 404, json: { error: 'Task not found.' } };
      }
      return { status: 200, json: await service.list({ ...scope, state: input.query.get('state') as TaskSnapshotV1['state'] | null,
        cursor: input.query.get('cursor'), limit: Number(input.query.get('limit') ?? '50') }, signal) };
    }
    if (input.method === 'POST') {
      const body = object(input.body);
      const instanceRevision = revision(body.instanceRevision);
      if (match[2] === 'enablement') {
        if (typeof body.desiredEnabled !== 'boolean') throw new PersistenceValidationError('Source enablement must be boolean');
        const instance = service.configure({ instanceId, instanceRevision, desiredEnabled: body.desiredEnabled });
        return { status: 200, json: { instance: { id: instance.id, revision: instance.revision, desiredEnabled: instance.desiredEnabled } } };
      }
      if (match[2] === 'configuration') {
        const instance = service.configure({ ...body, instanceId, instanceRevision } as Parameters<TaskSourceService['configure']>[0]);
        return { status: 200, json: { instance: { id: instance.id, revision: instance.revision, desiredEnabled: instance.desiredEnabled } } };
      }
      const repo = parseTaskRepo(body.repo);
      if (match[2] === 'commands') return { status: 200, json: { record: await service.command({ instanceId, instanceRevision, repo,
        commandId: text(body.commandId, 'Command ID', 100), requestId: text(body.requestId, 'Request ID', 240), input: body.input as PluginJson }, signal) } };
      if (match[2] === 'launch') {
        const ref = parseWorkRefV1(body.ref);
        service.assertLaunch({ instanceId, instanceRevision, repo, ref });
        signal.throwIfAborted();
        return { status: 202, json: { runId: input.launch({ repo, mode: 'source', workRef: ref, sourceInstanceId: instanceId, sourceInstanceRevision: instanceRevision,
          ...(typeof body.model === 'string' ? { model: body.model } : {}), ...(typeof body.effort === 'string' ? { effort: body.effort } : {}) }) } };
      }
    }
    return { status: 405, json: { error: 'Task source method is unavailable.' } };
  } catch (error) {
    if (error instanceof TaskSourceValidationError || error instanceof PersistenceValidationError) return { status: 400, json: { error: error.message } };
    if (error instanceof PersistenceConflictError) return { status: 409, json: { error: error.message } };
    return { status: 503, json: { error: 'Task source request failed. Check source availability and recovery diagnostics.' } };
  }
}
