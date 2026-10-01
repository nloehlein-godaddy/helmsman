import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createRunInstructionJournal } from './run-instruction-journal';
import { createHostRunInstructionService } from './run-instruction-service';
import type { RunInstructionCommandV1, RunInstructionInputV1, RunInstructionReceiptV1 } from './run-instructions';

const caller = 'example.viewer/panel';
const input: RunInstructionInputV1 = { version: 1, repo: 'org/repo', runId: 'run', expectedAttempt: 1,
  expectedChannelId: '00000000-0000-4000-8000-000000000001', targetId: '00000000-0000-4000-8000-000000000002', text: 'Preserve the API 😀' };
function receipt(command: RunInstructionCommandV1, status: RunInstructionReceiptV1['status']): RunInstructionReceiptV1 {
  const { requestId, ...input } = command; return { version: 1, requestId, input, status, message: null };
}
it('recovers the same command after reload and response loss without inventing a new delivery identity', async () => {
  const indexedDB = new IDBFactory(); const journal = createRunInstructionJournal(caller, { indexedDB });
  const signal = new AbortController().signal; const scope = () => ({ repo: input.repo, epoch: 1, active: true, signal });
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Lost response'));
  const service = createHostRunInstructionService(signal, { caller, scope, journal, fetch: fetcher });
  expect((await service.submit(input)).status).toBe('unavailable');
  const command = (await journal.pending())[0]!.command;
  const restored = createRunInstructionJournal(caller, { indexedDB });
  expect(await restored.reserve(input)).toEqual(command);
  await expect(restored.reserve({ ...input, text: 'Changed instruction' })).rejects.toThrow('original command');
  fetcher.mockImplementation(async (_url, init) => { expect(JSON.parse(String(init?.body)).command).toEqual(command); return Response.json(receipt(command, 'unknown')); });
  expect((await service.retry({ repo: input.repo, requestId: command.requestId })).status).toBe('available');
  await expect(service.acknowledge({ repo: input.repo, requestId: command.requestId })).rejects.toThrow('terminal');
  fetcher.mockResolvedValue(Response.json(receipt(command, 'delivered')));
  await service.receipt({ repo: input.repo, requestId: command.requestId });
  await service.acknowledge({ repo: input.repo, requestId: command.requestId }); expect(await journal.pending()).toEqual([]);
});
it('rejects a rebound receipt and hides saved instructions when the panel scope changes', async () => {
  const journal = createRunInstructionJournal(caller, { indexedDB: new IDBFactory() });
  const command = await journal.reserve(input); const signal = new AbortController().signal;
  let repo = input.repo; const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(receipt({ ...command, targetId: crypto.randomUUID() }, 'delivered')));
  const service = createHostRunInstructionService(signal, { caller, journal, fetch: fetcher, scope: () => ({ repo, epoch: 1, active: true, signal }) });
  expect(await service.receipt({ repo, requestId: command.requestId })).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  expect((await journal.pending())[0]?.receipt).toBeNull();
  repo = 'org/other'; expect(await service.pending()).toEqual([]);
  expect(await service.submit(input)).toEqual({ status: 'unavailable', reason: 'forbidden' });
});
