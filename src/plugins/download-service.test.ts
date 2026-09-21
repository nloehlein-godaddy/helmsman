import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostDownloadService } from './download-service';
import { createHostRunInspectService } from './run-inspect-service';
import type { DownloadRequestV1 } from './download';

const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const lifetime = new AbortController(); const activity = new AbortController();
  const saved: Uint8Array[] = []; const abort = vi.fn(); const close = vi.fn();
  const write = vi.fn((value: Uint8Array) => { saved.push(value); });
  const writable = new WritableStream<Uint8Array>({ write, abort, close });
  const createWritable = vi.fn(async () => writable);
  const picker = vi.fn(async () => ({ createWritable })); vi.stubGlobal('showSaveFilePicker', picker);
  const cancel = vi.fn();
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('Unicode 😀\n')); controller.close(); }, cancel });
  const open = vi.fn(async () => source);
  const input: DownloadRequestV1 = { filename: 'run-test.log', contentType: 'text/plain; charset=utf-8', open };
  const service = createHostDownloadService(lifetime.signal, () => ({ epoch: 0, repo: 'org/a', active: !activity.signal.aborted, signal: activity.signal }));
  return { service, lifetime, activity, saved, write, abort, close, createWritable, picker, open, input, cancel };
}

function workerFixture(throwChunks = false) {
  const f = fixture(); vi.stubGlobal('showSaveFilePicker', undefined);
  class Port {
    peer: Port | null = null; onmessage: ((event: { data: Record<string, unknown> }) => void) | null = null;
    postMessage(value: Record<string, unknown>) { if (throwChunks && value.type === 'chunk') throw new DOMException('Transfer failed', 'DataCloneError'); this.peer?.onmessage?.({ data: value }); }
    start() {} close() {}
  }
  class Channel { port1 = new Port(); port2 = new Port(); constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; } }
  vi.stubGlobal('MessageChannel', Channel); let workerPort: Port | null = null;
  vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(async () => ({ active: { state: 'activated', postMessage(_request: unknown, ports: Port[]) {
    workerPort = ports[0] ?? null; workerPort?.postMessage({ type: 'ready' });
  } } })) } });
  return { ...f, send(value: Record<string, unknown>) { workerPort?.postMessage(value); } };
}

beforeEach(() => { vi.stubGlobal('isSecureContext', true); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded browser downloads', () => {
  it('opens the picker synchronously and defers the stream until a destination exists', async () => {
    const f = fixture(); const choice = deferred<Awaited<ReturnType<typeof f.picker>>>(); f.picker.mockReturnValue(choice.promise);
    const result = f.service.save(f.input); expect(f.picker).toHaveBeenCalledOnce(); expect(f.open).not.toHaveBeenCalled();
    choice.resolve({ createWritable: f.createWritable }); expect(await result).toEqual({ status: 'saved', bytesWritten: 13 });
    expect(new TextDecoder().decode(f.saved[0])).toBe('Unicode 😀\n'); expect(f.close).toHaveBeenCalledOnce();
  });
  it('waits for the destination write before pulling another source chunk', async () => {
    const f = fixture(); const writing = deferred<void>(); let reads = 0;
    const write = vi.fn(async () => { await writing.promise; });
    f.createWritable.mockResolvedValue(new WritableStream<Uint8Array>({ write }));
    f.open.mockResolvedValue(new ReadableStream<Uint8Array>({ pull(controller) { reads++; if (reads < 3) controller.enqueue(new Uint8Array([reads])); else controller.close(); } }, { highWaterMark: 0 }));
    const result = f.service.save(f.input); await vi.waitFor(() => expect(write).toHaveBeenCalledOnce()); expect(reads).toBe(1);
    writing.resolve(); expect(await result).toEqual({ status: 'saved', bytesWritten: 2 }); expect(reads).toBe(3);
  });
  it('cancels source and writable destination on a scope change', async () => {
    const f = fixture(); const sourceCancel = vi.fn(); f.open.mockResolvedValue(new ReadableStream<Uint8Array>({ cancel: sourceCancel }));
    const result = f.service.save(f.input); await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce()); f.activity.abort();
    expect(await result).toEqual({ status: 'cancelled-stream', bytesWritten: 0 }); expect(sourceCancel).toHaveBeenCalledOnce(); expect(f.abort).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
  });
  it('never opens a source after lifetime cancellation while the native picker remains open', async () => {
    const f = fixture(); const choice = deferred<Awaited<ReturnType<typeof f.picker>>>(); f.picker.mockReturnValue(choice.promise);
    const result = f.service.save(f.input); f.lifetime.abort(); expect(await result).toEqual({ status: 'cancelled-stream', bytesWritten: 0 });
    choice.resolve({ createWritable: f.createWritable }); await Promise.resolve(); expect(f.open).not.toHaveBeenCalled(); expect(f.createWritable).not.toHaveBeenCalled();
  });
  it('cancels a late source that ignored its aborted signal', async () => {
    const f = fixture(); const opening = deferred<ReadableStream<Uint8Array>>(); f.open.mockReturnValue(opening.promise);
    const result = f.service.save(f.input); await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce()); f.lifetime.abort();
    expect((await result).status).toBe('cancelled-stream'); const cancel = vi.fn(); opening.resolve(new ReadableStream<Uint8Array>({ cancel }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
  it('reports picker cancellation without reading or falling back to another destination', async () => {
    const f = fixture(); f.picker.mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    expect(await f.service.save(f.input)).toEqual({ status: 'cancelled-stream', bytesWritten: 0 }); expect(f.open).not.toHaveBeenCalled();
  });
  it('aborts the destination on malformed oversized source chunks', async () => {
    const f = fixture(); const cancel = vi.fn(); f.open.mockResolvedValue(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel }));
    expect(await f.service.save(f.input)).toEqual({ status: 'failed', reason: 'source-failed', bytesWritten: 0 });
    expect(f.write).not.toHaveBeenCalled(); expect(f.abort).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels the producer when a destination write fails', async () => {
    const f = fixture(); const cancel = vi.fn(); f.open.mockResolvedValue(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel }));
    f.write.mockImplementation(() => { throw new Error('No space'); });
    expect(await f.service.save(f.input)).toEqual({ status: 'failed', reason: 'sink-failed', bytesWritten: 0 }); expect(cancel).toHaveBeenCalledOnce();
  });
  it('splits one coalesced network chunk into bounded writes before reading more source bytes', async () => {
    const f = fixture(); const firstWrite = deferred<void>(); let reads = 0; const bytes = new Uint8Array(256 * 1024 + 13); bytes.fill(42);
    f.open.mockResolvedValue(new ReadableStream<Uint8Array>({ pull(controller) { reads++; if (reads === 1) controller.enqueue(bytes); else controller.close(); } }, { highWaterMark: 0 }));
    f.createWritable.mockResolvedValue(new WritableStream<Uint8Array>({ async write(value) { f.saved.push(value); if (f.saved.length === 1) await firstWrite.promise; } }));
    const result = f.service.save(f.input); await vi.waitFor(() => expect(f.saved).toHaveLength(1)); expect(reads).toBe(1); firstWrite.resolve();
    expect(await result).toEqual({ status: 'saved', bytesWritten: bytes.length }); expect(f.saved.map(value => value.byteLength)).toEqual([65536, 65536, 65536, 65536, 13]);
    expect(f.saved.every(value => value.every(byte => byte === 42))).toBe(true); expect(reads).toBe(2);
  });
  it('saves a real inspection export adapter stream with a long canonical run ID and coalesced HTTP bytes', async () => {
    const f = fixture(); const target = { repo: 'org/a', runId: 'r'.repeat(128), expectedAttempt: 1 };
    const metadata = { version: 1, target, observedAt: '2026-09-20T12:00:00Z', provenance: 'run-wide', throughSequence: 1, filename: `helmsman-${target.runId}.log`, contentType: 'text/plain; charset=utf-8' };
    const bytes = new Uint8Array(256 * 1024 + 7); bytes.fill(73);
    const inspect = createHostRunInspectService(f.lifetime.signal, { scope: () => ({ epoch: 0, repo: target.repo, active: true, signal: f.activity.signal }),
      fetch: vi.fn(async input => String(input) === '/api/context' ? Response.json({ repos: [target.repo] }) : new Response(bytes, { headers: { 'Content-Type': metadata.contentType, 'X-Helmsman-Run-Inspect': encodeURIComponent(JSON.stringify(metadata)) } })) });
    const result = await f.service.save({ ...f.input, filename: metadata.filename, open: async signal => {
      const exported = await inspect.exportLog({ version: 1, target }, signal); if (exported.status !== 'available') throw new Error('Export unavailable'); return exported.value.stream;
    } });
    expect(result).toEqual({ status: 'saved', bytesWritten: bytes.length }); expect(f.saved.every(value => value.byteLength <= 65536)).toBe(true);
    const actual = new Uint8Array(bytes.length); let offset = 0; for (const value of f.saved) { actual.set(value, offset); offset += value.length; } expect(actual).toEqual(bytes);
  });
  it('keeps a live worker transport open while browser backpressure pauses demand beyond the transport timeout', async () => {
    vi.useFakeTimers(); const f = fixture(); vi.stubGlobal('showSaveFilePicker', undefined);
    class Port {
      peer: Port | null = null; onmessage: ((event: { data: { type: string } }) => void) | null = null;
      postMessage(value: { type: string }) { this.peer?.onmessage?.({ data: value }); }
      start() {} close() {}
    }
    class Channel { port1 = new Port(); port2 = new Port(); constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; } }
    vi.stubGlobal('MessageChannel', Channel); let heartbeats = 0;
    vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(async () => ({ active: { state: 'activated', postMessage(_request: unknown, ports: Port[]) {
      const port = ports[0]; if (!port) return; port.onmessage = event => { if (event.data.type === 'heartbeat') { heartbeats++; port.postMessage({ type: 'heartbeat' }); } }; port.postMessage({ type: 'ready' });
    } } })) } });
    let finished = false; const result = f.service.save(f.input).then(value => { finished = true; return value; });
    await vi.advanceTimersByTimeAsync(61000); expect(heartbeats).toBeGreaterThan(15); expect(finished).toBe(false); expect(f.open).not.toHaveBeenCalled();
    f.activity.abort(); expect(await result).toEqual({ status: 'cancelled-stream', bytesWritten: 0 }); expect(document.querySelector('iframe')).toBeNull();
  });
  it('rejects worker completion before the producer reaches EOF', async () => {
    const f = workerFixture(); const result = f.service.save(f.input);
    await vi.waitFor(() => expect(document.querySelector('iframe')).not.toBeNull()); f.send({ type: 'complete', sequence: 0 });
    expect(await result).toEqual({ status: 'failed', reason: 'transport-failed', bytesWritten: 0 }); expect(f.open).not.toHaveBeenCalled();
  });
  it('does not count bytes when transferring a chunk to the worker throws', async () => {
    const f = workerFixture(true); const result = f.service.save(f.input);
    await vi.waitFor(() => expect(document.querySelector('iframe')).not.toBeNull()); f.send({ type: 'pull', sequence: 1 });
    expect(await result).toMatchObject({ status: 'failed', bytesWritten: 0 }); expect(f.open).toHaveBeenCalledOnce(); expect(document.querySelector('iframe')).toBeNull();
  });
  it('aborts pending source preparation on worker transport failure and cancels a late source', async () => {
    const f = workerFixture(); const pending = deferred<ReadableStream<Uint8Array>>(); f.open.mockReturnValue(pending.promise);
    const result = f.service.save(f.input); await vi.waitFor(() => expect(document.querySelector('iframe')).not.toBeNull()); f.send({ type: 'pull', sequence: 1 });
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce()); const signal = (f.open.mock.calls[0] as unknown as [AbortSignal])[0];
    f.send({ type: 'error' }); expect(await result).toEqual({ status: 'failed', reason: 'transport-failed', bytesWritten: 0 }); expect(signal.aborted).toBe(true);
    const cancel = vi.fn(); pending.resolve(new ReadableStream<Uint8Array>({ cancel })); await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
  it('rejects filenames, inactive scope and insecure environments before a picker or source is touched', async () => {
    const f = fixture();
    for (const filename of ['../private.log', 'bad\r\nname', 'trailing.', 'trailing ', '']) expect(await f.service.save({ ...f.input, filename })).toMatchObject({ status: 'failed', reason: 'invalid-input' });
    vi.stubGlobal('isSecureContext', false); expect(await f.service.save(f.input)).toEqual({ status: 'unavailable', reason: 'unsupported' });
    f.activity.abort(); expect(await f.service.save(f.input)).toEqual({ status: 'unavailable', reason: 'inactive' }); expect(f.picker).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
});
