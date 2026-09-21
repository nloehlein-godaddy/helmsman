import type { DownloadRequestV1, DownloadResultV1, DownloadServiceV1 } from './download';
import type { PanelActivityV1 } from './composition';

interface FileHandle { createWritable(): Promise<WritableStream<Uint8Array>>; }
type SavePicker = (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileHandle>;
const chunkLimit = 64 * 1024;
const sourceChunkLimit = 2 * 1024 * 1024;
const workerPath = '/plugin-download/worker.js';
const workerScope = '/plugin-download/';

function valid(input: DownloadRequestV1): boolean {
  return !!input && typeof input.filename === 'string' && /^[a-z\d][a-z\d_. -]{0,199}$/i.test(input.filename)
    && !input.filename.endsWith('.') && !input.filename.endsWith(' ') && input.contentType === 'text/plain; charset=utf-8' && typeof input.open === 'function';
}

function abortError(): DOMException { return new DOMException('Download cancelled.', 'AbortError'); }
function aborted(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }
function boundedChunk(value: unknown, maximum = chunkLimit): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]' && value.byteLength > 0 && value.byteLength <= maximum;
}

function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(abortError()); signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

type SourceReader = Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel'>;
async function openReader(input: DownloadRequestV1, signal: AbortSignal): Promise<SourceReader> {
  const source = Promise.resolve().then(() => input.open(signal));
  void source.then(stream => { if (signal.aborted && typeof stream?.cancel === 'function') void stream.cancel().catch(() => {}); }, () => {});
  const stream = await untilAbort(source, signal);
  if (!stream || typeof stream.getReader !== 'function') throw new TypeError('Invalid download stream.');
  const reader = stream.getReader(); let buffer: Uint8Array | null = null; let offset = 0;
  return {
    async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      if (!buffer) {
        const part = await untilAbort(reader.read(), signal);
        if (part.done) return part;
        if (!boundedChunk(part.value, sourceChunkLimit)) { void reader.cancel().catch(() => {}); throw new TypeError('Download source chunks must contain 1–2097152 bytes.'); }
        buffer = part.value; offset = 0;
      }
      const value = buffer.subarray(offset, offset + chunkLimit); offset += value.byteLength;
      if (offset === buffer.byteLength) buffer = null;
      return { done: false, value };
    },
    cancel(reason?: unknown) { buffer = null; return reader.cancel(reason); },
  };
}

async function pickerDownload(input: DownloadRequestV1, destination: Promise<FileHandle>, signal: AbortSignal): Promise<DownloadResultV1> {
  let reader: SourceReader | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let bytesWritten = 0;
  let stage: 'source-failed' | 'sink-failed' = 'sink-failed';
  const cancel = () => { void reader?.cancel().catch(() => {}); void writer?.abort().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const handle = await untilAbort(destination, signal);
    const opening = handle.createWritable();
    void opening.then(stream => { if (signal.aborted) void stream.abort().catch(() => {}); }, () => {});
    const writable = await untilAbort(opening, signal); writer = writable.getWriter();
    stage = 'source-failed'; reader = await openReader(input, signal);
    while (!signal.aborted) {
      stage = 'source-failed'; const value = await untilAbort(reader.read(), signal);
      if (value.done) { stage = 'sink-failed'; await untilAbort(writer.close(), signal); return { status: 'saved', bytesWritten }; }
      if (!boundedChunk(value.value)) throw new TypeError('Download chunks must contain 1–65536 bytes.');
      stage = 'sink-failed'; await untilAbort(writer.write(value.value), signal); bytesWritten += value.value.byteLength;
    }
    throw abortError();
  } catch (error) {
    cancel();
    return signal.aborted || aborted(error) ? { status: 'cancelled-stream', bytesWritten } : { status: 'failed', reason: stage, bytesWritten };
  } finally { signal.removeEventListener('abort', cancel); }
}

async function activeWorker(signal: AbortSignal): Promise<ServiceWorker> {
  const registration = await untilAbort(navigator.serviceWorker.register(workerPath, { scope: workerScope, updateViaCache: 'none' }), signal);
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) throw new Error('Download worker is unavailable.');
  if (worker.state === 'activated') return worker;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); worker.removeEventListener('statechange', changed); signal.removeEventListener('abort', cancel); error ? reject(error) : resolve(); };
    const changed = () => { if (worker.state === 'activated') finish(); else if (worker.state === 'redundant') finish(new Error('Download worker could not activate.')); };
    const cancel = () => finish(abortError()); const timer = setTimeout(() => finish(new Error('Download worker activation timed out.')), 10000);
    worker.addEventListener('statechange', changed); signal.addEventListener('abort', cancel, { once: true }); changed(); if (signal.aborted) cancel();
  });
  return worker;
}

async function workerDownload(input: DownloadRequestV1, signal: AbortSignal): Promise<DownloadResultV1> {
  let reader: SourceReader | null = null;
  let port: MessagePort | null = null;
  let frame: HTMLIFrameElement | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let bytesWritten = 0; let settled = false; let pulling = false; let sequence = 0; let eofSequence: number | null = null; let opened = false;
  let complete: (result: DownloadResultV1) => void = () => {};
  const result = new Promise<DownloadResultV1>(resolve => { complete = resolve; });
  const finish = (value: DownloadResultV1) => {
    if (settled) return; settled = true;
    if (heartbeat !== null) clearInterval(heartbeat); if (timeout !== null) clearTimeout(timeout);
    if (value.status !== 'delivered-to-browser') { port?.postMessage({ type: 'abort' }); void reader?.cancel().catch(() => {}); }
    port?.close(); frame?.remove(); signal.removeEventListener('abort', cancel); complete(value);
  };
  const fail = (reason: 'source-failed' | 'transport-failed') => finish({ status: 'failed', reason, bytesWritten });
  const cancel = () => finish({ status: 'cancelled-stream', bytesWritten });
  const renew = () => { if (timeout !== null) clearTimeout(timeout); timeout = setTimeout(() => fail('transport-failed'), 20000); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const worker = await activeWorker(signal); if (signal.aborted || settled) { cancel(); return result; }
    const channel = new MessageChannel(); port = channel.port1;
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
    port.onmessageerror = () => fail('transport-failed');
    port.onmessage = event => {
      const message = event.data; if (settled || !message || typeof message !== 'object') return;
      renew();
      if (message.type === 'ready' && !opened) {
        opened = true;
        heartbeat = setInterval(() => port?.postMessage({ type: 'heartbeat' }), 3000);
        frame = document.createElement('iframe'); frame.hidden = true; frame.setAttribute('aria-hidden', 'true');
        frame.src = `${workerScope}file/${token}`; document.body.append(frame); return;
      }
      if (message.type === 'cancelled') { cancel(); return; }
      if (message.type === 'error') { fail('transport-failed'); return; }
      if (message.type === 'heartbeat' && opened) return;
      if (message.type === 'complete' && opened && eofSequence !== null && message.sequence === eofSequence && !pulling) { finish({ status: 'delivered-to-browser', bytesWritten }); return; }
      if (message.type !== 'pull' || !opened || pulling || message.sequence !== sequence + 1) { fail('transport-failed'); return; }
      pulling = true; sequence = message.sequence;
      void (async () => {
        try {
          reader ??= await openReader(input, signal);
          if (settled || signal.aborted) { void reader.cancel().catch(() => {}); return; }
          const value = await untilAbort(reader.read(), signal);
          if (settled || signal.aborted) return;
          if (value.done) { pulling = false; eofSequence = sequence; port?.postMessage({ type: 'done', sequence }); return; }
          if (!boundedChunk(value.value)) throw new TypeError('Download chunks must contain 1–65536 bytes.');
          const chunk = new Uint8Array(value.value); const chunkBytes = chunk.byteLength; pulling = false;
          port?.postMessage({ type: 'chunk', sequence, chunk: chunk.buffer }, [chunk.buffer]);
          bytesWritten += chunkBytes;
        } catch { if (!settled) signal.aborted ? cancel() : fail('source-failed'); }
      })();
    };
    port.start(); renew();
    worker.postMessage({ version: 1, type: 'register', token, filename: input.filename, contentType: input.contentType }, [channel.port2]);
  } catch { signal.aborted ? cancel() : fail('transport-failed'); }
  return result;
}

export function createHostDownloadService(lifetime: AbortSignal, scope: () => PanelActivityV1): DownloadServiceV1 {
  return Object.freeze({ version: 1, save(input: DownloadRequestV1, signal?: AbortSignal): Promise<DownloadResultV1> {
    if (!valid(input)) return Promise.resolve({ status: 'failed', reason: 'invalid-input', bytesWritten: 0 });
    const activity = scope();
    if (lifetime.aborted || !activity?.active || activity.signal.aborted || signal?.aborted) return Promise.resolve({ status: 'unavailable', reason: 'inactive' });
    if (!globalThis.isSecureContext) return Promise.resolve({ status: 'unavailable', reason: 'unsupported' });
    const controller = new AbortController(); const signals = [lifetime, activity.signal, ...(signal ? [signal] : [])];
    const abort = () => controller.abort(); for (const source of signals) source.addEventListener('abort', abort, { once: true });
    const picker = (globalThis as typeof globalThis & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    let operation: Promise<DownloadResultV1>;
    try {
      if (typeof picker === 'function') operation = pickerDownload(input, picker({ suggestedName: input.filename, types: [{ description: 'Text log', accept: { 'text/plain': ['.txt', '.log'] } }] }), controller.signal);
      else if (navigator.serviceWorker && typeof MessageChannel === 'function') operation = workerDownload(input, controller.signal);
      else operation = Promise.resolve({ status: 'unavailable', reason: 'unsupported' });
    } catch (error) { operation = Promise.resolve(aborted(error) ? { status: 'cancelled-stream', bytesWritten: 0 } : { status: 'failed', reason: 'sink-failed', bytesWritten: 0 }); }
    return operation.then(result => {
      if (result.status !== 'saved' && result.status !== 'delivered-to-browser') controller.abort();
      return result;
    }).finally(() => { for (const source of signals) source.removeEventListener('abort', abort); });
  } });
}
