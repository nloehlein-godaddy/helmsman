// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createCommunicationCommandJournal } from '../../src/plugins/communication-command-journal';
import { createHostCommunicationCommandService } from '../../src/plugins/communication-command-service';
import { handleCommunicationCommandApi } from './communication-command-routes';
import type { CommunicationCommandInputV1, CommunicationCommandV1, CommunicationDestinationV1 } from '../../src/plugins/communication-command';
import { openExecutionStore, type ProviderBinding } from './execution-store';
import { openOperationStore, type DurableOperation, type OperationResult } from './operations';
import { openPersistence, type Persistence } from './persistence';
import { createCommunicationCommandService, type CommunicationCommandServerOptions } from './communication-command-service';

const databases: Persistence[] = [];
afterEach(() => databases.splice(0).forEach(database => database.close()));

const caller = 'example.communication/panel';
const otherCaller = 'example.other/panel';
const destination: CommunicationDestinationV1 = { providerId: 'helmsman.slack/review', artifactHash: 'a'.repeat(64), workspace: 'T123', channel: 'C123', mention: '@reviewers', connectionId: 'connection-1' };
const command: CommunicationCommandV1 = { version: 1, requestId: '12345678-1234-4123-8123-123456789abc', repo: 'org/repo', number: 12, expectedDestination: destination };
const artifact = { pluginId: 'helmsman.slack', artifactHash: destination.artifactHash, packageVersion: '1.0.0', requires: [] };
const binding: ProviderBinding = { role: 'effect', capability: 'helmsman/communication', contractVersion: 1, contributionId: destination.providerId,
  pluginId: artifact.pluginId, artifactHash: artifact.artifactHash, connectionId: destination.connectionId, credentialHandle: 'credential-a' };

function fixture() {
  const persistence = openPersistence(':memory:'); databases.push(persistence);
  const executions = openExecutionStore(persistence);
  const operations = openOperationStore(persistence, executions);
  let preparedDestination = destination;
  let preparedBinding = binding;
  const invoke = vi.fn(async (operation: DurableOperation): Promise<OperationResult> => {
    const target = operation.target as unknown as { destination: CommunicationDestinationV1 };
    return { status: 'acknowledged', receipt: {
      workspace: target.destination.workspace, channel: target.destination.channel, mention: target.destination.mention, connectionId: target.destination.connectionId,
      permalink: 'https://example.slack.com/archives/C123/p1710000000000000',
    } };
  });
  const prepareReviewRequest = vi.fn(async (input: CommunicationCommandInputV1) => ({ binding: preparedBinding, artifacts: [artifact],
    target: { repo: input.repo, number: input.number, destination: preparedDestination } }));
  const options: CommunicationCommandServerOptions = { persistence, operations, repos: () => ['org/repo', 'other/repo'],
    authorize: value => { if (value !== caller && value !== otherCaller) throw new Error('forbidden'); }, assertAdmission: () => {}, prepareReviewRequest,
    resolve: operation => ({ kind: operation.kind, binding: operation.binding, delivery: 'reconcile', invoke,
      reconcile: async current => ({ status: 'acknowledged', receipt: current.receipt }) }) };
  return { persistence, operations, invoke, prepareReviewRequest, options, service: createCommunicationCommandService(options),
    changeSettings(nextDestination: CommunicationDestinationV1, nextBinding: ProviderBinding) { preparedDestination = nextDestination; preparedBinding = nextBinding; } };
}

describe('durable public communication commands', () => {
  it('never returns a receipt for changed input submitted concurrently under the same caller and request ID', async () => {
    const f = fixture();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    f.prepareReviewRequest.mockImplementation(async input => { await waiting; return { binding, artifacts: [artifact], target: { repo: input.repo, number: input.number, destination: input.expectedDestination } }; });
    const changed = { ...command, number: command.number + 1 };
    const first = f.service.submit(caller, command, null);
    const second = f.service.submit(caller, changed, null);
    await vi.waitFor(() => expect(f.prepareReviewRequest).toHaveBeenCalledTimes(2));
    release();
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.flatMap((result, index) => result.status === 'fulfilled' ? [{ receipt: result.value, submitted: [command, changed][index]! }] : []);
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.receipt.input).toEqual(expect.objectContaining({ number: fulfilled[0]?.submitted.number, expectedDestination: fulfilled[0]?.submitted.expectedDestination }));
    expect(fulfilled[0]?.receipt.result).toEqual(expect.objectContaining({ number: fulfilled[0]?.submitted.number, destination: fulfilled[0]?.submitted.expectedDestination }));
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(f.operations.list()).toHaveLength(1);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it('requires explicit retry after a proven pre-send failure, including after service restart', async () => {
    const f = fixture();
    f.invoke.mockResolvedValueOnce({ status: 'definitely-not-applied', retryable: true, reason: 'Clear the existing draft', evidence: {} });
    expect((await f.service.submit(caller, command, null)).status).toBe('recovery-required');
    const restarted = createCommunicationCommandService(f.options);
    await restarted.drainPending();
    await restarted.submit(caller, command, null);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    await expect(restarted.retry(caller, { ...command, number: command.number + 1 }, null)).rejects.toThrow('content changed');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const result = await restarted.retry(caller, command, null);
    expect(result).toMatchObject({ status: 'succeeded', requestId: command.requestId });
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.operations.list()).toHaveLength(1);
  });

  it('requires explicit retry after reconciliation proves no delivery', async () => {
    const f = fixture();
    f.invoke.mockRejectedValueOnce(new Error('Response lost'));
    const service = createCommunicationCommandService({ ...f.options, resolve: operation => ({ kind: operation.kind, binding: operation.binding, delivery: 'reconcile', invoke: f.invoke,
      reconcile: async () => ({ status: 'definitely-not-applied', retryable: true, reason: 'Exact external evidence proves no delivery', evidence: {} }) }) });
    expect((await service.submit(caller, command, null)).status).toBe('recovery-required');
    await service.drainPending(); await service.drainPending();
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect((await service.retry(caller, command, null)).status).toBe('succeeded');
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });

  it('routes browser exact retry through server reopening without allocating another command', async () => {
    const f = fixture();
    f.invoke.mockResolvedValueOnce({ status: 'definitely-not-applied', retryable: true, reason: 'Existing draft', evidence: {} });
    const journal = createCommunicationCommandJournal(caller, { indexedDB: new IDBFactory() });
    const scope = { repo: command.repo, epoch: 1, active: true, signal: new AbortController().signal };
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      const response = await handleCommunicationCommandApi({ method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams,
        body: init?.body ? JSON.parse(String(init.body)) : undefined, caller, service: f.service });
      return Response.json(response?.json ?? null, { status: response?.status ?? 404 });
    };
    const browser = createHostCommunicationCommandService(new AbortController().signal, { caller, journal, scope: () => scope, fetch: fetcher });
    const { requestId: _id, ...input } = command;
    expect(await browser.submit(input)).toMatchObject({ status: 'available', value: { status: 'recovery-required' } });
    const original = (await journal.pending())[0]!.command;
    await f.service.drainPending(); expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(await browser.retry({ repo: original.repo, requestId: original.requestId })).toMatchObject({ status: 'available', value: { status: 'succeeded', requestId: original.requestId } });
    expect(f.invoke).toHaveBeenCalledTimes(2); expect(f.operations.list()).toHaveLength(1);
  });

  it('retains the original destination and provider after settings change', async () => {
    const f = fixture();
    f.invoke.mockRejectedValueOnce(new Error('Response lost'));
    const first = await f.service.submit(caller, command, null);
    expect(first.status).toBe('recovery-required');
    const replacementDestination = { ...destination, channel: 'C999', artifactHash: 'b'.repeat(64), connectionId: 'connection-2' };
    const replacementBinding = { ...binding, artifactHash: replacementDestination.artifactHash, connectionId: replacementDestination.connectionId };
    f.changeSettings(replacementDestination, replacementBinding);
    const retried = await f.service.retry(caller, command, null);
    expect(retried).toMatchObject({ status: 'recovery-required', input: { expectedDestination: destination } });
    expect(f.operations.list()[0]).toMatchObject({ binding, target: { repo: command.repo, number: command.number, destination },
      payload: { caller, requestId: command.requestId, command, manual: true, expectedDestination: destination } });
    expect(f.prepareReviewRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects forbidden callers and galleon scopes before mutation', async () => {
    const f = fixture();
    await expect(f.service.submit('invalid', command, null)).rejects.toThrow('forbidden');
    await expect(f.service.submit(caller, command, 'other/repo')).rejects.toThrow('not-found');
    expect(f.operations.list()).toEqual([]);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('enforces cooldown across callers even when they reuse the same UUID', async () => {
    const f = fixture();
    expect((await f.service.submit(caller, command, null)).status).toBe('succeeded');
    await expect(f.service.submit(otherCaller, command, null)).rejects.toThrow('just attempted');
    expect(f.operations.list()).toHaveLength(1);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
});

it('checks captured PR source freshness at the final durable communication admission', async () => {
  const f = fixture();
  const service = createCommunicationCommandService({ ...f.options, async prepareReviewRequest(input) {
    const prepared = await f.prepareReviewRequest(input);
    return { ...prepared, assertCurrent() { throw new Error('Captured PR source changed'); } };
  } });
  await expect(service.submit(caller, command, null)).rejects.toThrow('Captured PR source changed');
  expect(f.operations.list()).toHaveLength(0); expect(f.invoke).not.toHaveBeenCalled();
});
