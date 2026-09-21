export async function awaitSourceResult<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? new DOMException('Source request aborted', 'AbortError'));
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([pending, cancelled]); } finally { signal.removeEventListener('abort', cancel); }
}
