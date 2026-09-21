import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createTerminalCommandJournal } from './terminal-command-journal';
import { createHostTerminalService } from './terminal-service';
import { parseTerminalControlInputV1, TERMINAL_LIMITS, type TerminalControlCommandV1, type TerminalControlInputV1, type TerminalControlReceiptV1 } from './terminal';

const caller = 'example.terminal/panel';
const input: TerminalControlInputV1 = { version: 1, target: { repo: 'org/a', surfaceRef: 'surface:1', revision: 'a'.repeat(64) }, operation: { kind: 'text', text: 'hello', enter: true } };
function receipt(command: TerminalControlCommandV1, status: TerminalControlReceiptV1['status'] = 'succeeded'): TerminalControlReceiptV1 {
  const { requestId, ...input } = command;
  return { version: 1, requestId, input, status, reason: status === 'recovery-required' ? 'Inspect terminal before acknowledging' : null };
}
function setup() {
  const indexedDB = new IDBFactory(); const journal = createTerminalCommandJournal(caller, { indexedDB });
  const scope: {repo:string|null;epoch:number;active:boolean;signal:AbortSignal} = { repo: 'org/a', epoch: 1, active: true, signal: new AbortController().signal };
  const fetcher = vi.fn<typeof fetch>();
  const options = { caller, scope: () => scope, journal, fetch: fetcher };
  const service = createHostTerminalService(new AbortController().signal, options);
  return { indexedDB, journal, scope, fetcher, options, service };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it('retains original input across response loss/reload and never replays an absent receipt', async () => {
  const f = setup(); let command!: TerminalControlCommandV1;
  f.fetcher.mockImplementationOnce(async (_url, init) => { command = JSON.parse(String(init?.body)).command; expect((await f.journal.pending())[0]?.command).toEqual(command); throw new Error('response lost'); });
  expect(await f.service.control(input)).toEqual({ status: 'unavailable', reason: 'connection-failed' });
  const reloaded = createHostTerminalService(new AbortController().signal, { ...f.options, journal: createTerminalCommandJournal(caller, { indexedDB: f.indexedDB }) });
  f.fetcher.mockImplementationOnce(async (url, init) => { expect(String(url)).toContain('/api/terminal/receipts/'); expect(init?.method).toBe('GET'); return Response.json(null); });
  expect(await reloaded.control(input)).toMatchObject({ status: 'unavailable', reason: 'conflict' });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  await expect(reloaded.acknowledge({ requestId: command.requestId, repo: 'org/a' })).rejects.toThrow();
  expect((await reloaded.pending())[0]?.command).toEqual(command);
});

it('records unknown receipts before explicit acknowledgment and rejects altered receipts', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  f.fetcher.mockResolvedValueOnce(Response.json({ ...receipt(command), input: { ...input, target: { ...input.target, revision: 'b'.repeat(64) } } }));
  expect(await f.service.receipt({ requestId: command.requestId, repo: 'org/a' })).toMatchObject({ status: 'unavailable' });
  expect((await f.service.pending())[0]?.receipt).toBeNull();
  f.fetcher.mockResolvedValueOnce(Response.json(receipt(command, 'recovery-required')));
  expect(await f.service.receipt({ requestId: command.requestId, repo: 'org/a' })).toMatchObject({ status: 'available', value: { status: 'recovery-required' } });
  expect((await f.service.pending())[0]?.receipt?.status).toBe('recovery-required');
  await f.service.acknowledge({ requestId: command.requestId, repo: 'org/a' }); expect(await f.service.pending()).toEqual([]);
});

it('prevents foreign/null repo controls and keeps nullable receipt lookup explicit', async () => {
  const f = setup(); const unattached = { ...input, target: { ...input.target, repo: null } };
  expect(await f.service.control(unattached)).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
  expect(await f.service.list({ version: 1, repo: null })).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
  expect(f.fetcher).not.toHaveBeenCalled();
  f.scope.repo = null; f.scope.epoch++; const command = await f.journal.reserve(unattached);
  f.fetcher.mockImplementationOnce(async url => { expect(new URL(String(url), 'http://test').searchParams.has('repo')).toBe(false); return Response.json(receipt(command)); });
  expect(await f.service.receipt({ repo: null, requestId: command.requestId })).toMatchObject({ status: 'available' });
});

it('cancels delayed controls after scope change without reserving or sending queued work', async () => {
  const f = setup(); const gate = deferred<Response>(); const started = deferred<void>();
  f.fetcher.mockImplementationOnce(() => { started.resolve(); return gate.promise; });
  const first = f.service.control(input); await started.promise;
  const second = f.service.control({ ...input, target: { ...input.target, surfaceRef: 'surface:2' } });
  const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  f.scope.repo = 'org/b'; f.scope.epoch++; gate.resolve(Response.json({}));
  await Promise.all([firstRejected, secondRejected]);
  expect(f.fetcher).toHaveBeenCalledTimes(1); expect(await f.journal.pending()).toHaveLength(1);
});

it('does not dispatch a queued caller-cancelled control', async () => {
  const f = setup(); const gate = deferred<Response>(); const started = deferred<void>(); let command!: TerminalControlCommandV1;
  f.fetcher.mockImplementationOnce((_url, init) => { command = JSON.parse(String(init?.body)).command; started.resolve(); return gate.promise; });
  const first = f.service.control(input); await started.promise;
  const controller = new AbortController(); const second = f.service.control({ ...input, target: { ...input.target, surfaceRef: 'surface:2' } }, controller.signal);
  const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); gate.resolve(Response.json(receipt(command)));
  await first; await rejected; expect(f.fetcher).toHaveBeenCalledTimes(1);
});

it('journals preserve original targets and disallow acknowledging pending evidence', async () => {
  const f = setup(); const command = await f.journal.reserve(input);
  await expect(f.journal.reserve({ ...input, target: { ...input.target, revision: 'b'.repeat(64) } })).rejects.toThrow('original command');
  await f.journal.record(receipt(command, 'pending'));
  await expect(f.journal.acknowledge({ repo: 'org/a', requestId: command.requestId })).rejects.toThrow('terminal receipts');
  expect(await f.journal.retained({ repo: null, requestId: command.requestId })).toBeNull();
});

it('bounds malformed keys/text/images while preserving supported keyboard tokens', () => {
  for (const key of ['up', 'ctrl+c', 'Enter', 'C-c']) expect(parseTerminalControlInputV1({ ...input, operation: { kind: 'key', key } }).operation).toEqual({ kind: 'key', key });
  for (const operation of [{ kind: 'key', key: '--surface' }, { kind: 'text', text: 'x'.repeat(TERMINAL_LIMITS.text + 1), enter: false }, { kind: 'image', mimeType: 'text/html', dataBase64: 'AAAA' }, { kind: 'image', mimeType: 'image/png', dataBase64: 'a===' }])
    expect(() => parseTerminalControlInputV1({ ...input, operation })).toThrow();
});

it('explicit inspection uses only the original journal command, records its fence, and permits acknowledgment after inspection', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const query = { repo: 'org/a', requestId: command.requestId };
  f.fetcher.mockResolvedValueOnce(Response.json(null));
  expect(await f.service.receipt(query)).toMatchObject({ status: 'available', value: null });
  await expect(f.service.acknowledge(query)).rejects.toThrow();
  f.fetcher.mockImplementationOnce(async (url, init) => {
    expect(url).toBe('/api/terminal/inspect'); expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ command, scopeRepo: 'org/a' });
    return Response.json(receipt(command, 'recovery-required'));
  });
  expect(await f.service.inspect(query)).toMatchObject({ status: 'available', value: { input, status: 'recovery-required' } });
  expect((await f.journal.pending())[0]?.receipt?.status).toBe('recovery-required');
  await f.service.acknowledge(query); expect(await f.journal.pending()).toEqual([]);
  expect(await f.service.inspect(query)).toMatchObject({ status: 'unavailable', reason: 'not-found' });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});

it('inspection keeps active sends pending and preserves original input after inspection response loss', async () => {
  const f = setup(); const command = await f.journal.reserve(input); const query = { repo: 'org/a', requestId: command.requestId };
  f.fetcher.mockResolvedValueOnce(Response.json(receipt(command, 'pending')));
  expect(await f.service.inspect(query)).toMatchObject({ status: 'available', value: { status: 'pending' } });
  await expect(f.service.acknowledge(query)).rejects.toThrow();
  f.fetcher.mockRejectedValueOnce(new Error('inspection response lost'));
  expect(await f.service.inspect(query)).toMatchObject({ status: 'unavailable', reason: 'connection-failed' });
  const reloaded = createHostTerminalService(new AbortController().signal, { ...f.options, journal: createTerminalCommandJournal(caller, { indexedDB: f.indexedDB }) });
  f.fetcher.mockImplementationOnce(async (url, init) => { expect(String(url)).toContain('/api/terminal/receipts/'); expect(init?.method).toBe('GET'); return Response.json(receipt(command, 'recovery-required')); });
  expect(await reloaded.receipt(query)).toMatchObject({ status: 'available', value: { status: 'recovery-required' } });
  expect((await reloaded.pending())[0]?.command).toEqual(command);
});
