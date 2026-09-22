const UNAVAILABLE = 'Firefox background automation disconnected. Check Firefox and restart the local bridge if needed.';

export interface FirefoxBidiClient {
  readonly closed: boolean;
  request(method: string, params: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>;
  close(): void;
}

function failure(value = UNAVAILABLE): Error { return new Error(value); }

export function connectFirefoxBidi(url: string, signal?: AbortSignal): Promise<FirefoxBidiClient> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try { socket = new WebSocket(url); } catch { reject(failure()); return; }
    let closed = false;
    let nextId = 0;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void }>();
    const fail = (error = failure()): void => {
      if (closed) return;
      closed = true;
      clearTimeout(openTimer);
      signal?.removeEventListener('abort', abort);
      reject(error);
      for (const request of pending.values()) {
        clearTimeout(request.timer); if (request.abort) request.signal?.removeEventListener('abort', request.abort); request.reject(error);
      }
      pending.clear();
      try { socket.close(); } catch {}
    };
    const abort = () => fail(signal?.reason instanceof Error ? signal.reason : failure('Firefox background automation aborted.'));
    const openTimer = setTimeout(() => fail(), 15_000);
    socket.addEventListener('error', () => fail());
    socket.addEventListener('close', () => fail());
    socket.addEventListener('message', event => {
      let message: Record<string, unknown>;
      try {
        if (typeof event.data !== 'string' || event.data.length > 4 * 1024 * 1024) throw new Error();
        const value: unknown = JSON.parse(event.data);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        message = value as Record<string, unknown>;
      } catch { fail(); return; }
      if (message.type === 'event') return;
      if (!Number.isSafeInteger(message.id)) { fail(); return; }
      const request = pending.get(message.id as number);
      if (!request) return;
      pending.delete(message.id as number);
      clearTimeout(request.timer); if (request.abort) request.signal?.removeEventListener('abort', request.abort);
      if (message.type !== 'success' || !Object.hasOwn(message, 'result')) { const error = failure(); request.reject(error); fail(error); return; }
      request.resolve(message.result);
    });
    socket.addEventListener('open', () => {
      if (closed) return;
      clearTimeout(openTimer);
      signal?.removeEventListener('abort', abort);
      resolve({
        get closed() { return closed; },
        close() { fail(); },
        request(method, params, timeoutMs = 15_000, requestSignal) {
          if (closed) return Promise.reject(failure());
          return new Promise((requestResolve, requestReject) => {
            requestSignal?.throwIfAborted();
            const id = ++nextId;
            const timer = setTimeout(() => fail(failure('Firefox background automation timed out.')), timeoutMs);
            const abortRequest = () => { clearTimeout(timer); pending.delete(id); requestSignal?.removeEventListener('abort', abortRequest); requestReject(requestSignal?.reason instanceof Error ? requestSignal.reason : failure('Firefox background automation aborted.')); };
            pending.set(id, { resolve: requestResolve, reject: requestReject, timer, signal: requestSignal, abort: abortRequest });
            requestSignal?.addEventListener('abort', abortRequest, { once: true });
            try { socket.send(JSON.stringify({ id, method, params })); } catch { fail(); }
          });
        },
      });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
