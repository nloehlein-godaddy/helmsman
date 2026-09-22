export function createPluginCleanup(options: { timeoutMs: number; onError?(late: boolean): void }) {
  const pending: Array<() => void | Promise<void>> = [];
  let disposal: Promise<void> | undefined;
  let draining = false;
  let completed = false;
  function drain(late: boolean): Promise<void> {
    draining = true;
    return Promise.resolve().then(async () => {
      const deadline = performance.now() + options.timeoutMs * Math.max(1, pending.length);
      try {
        while (pending.length) {
          const remaining = deadline - performance.now();
          if (remaining <= 0) { options.onError?.(late); pending.length = 0; break; }
          const cleanup = pending.pop();
          if (!cleanup) continue;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([Promise.resolve().then(cleanup), new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Plugin cleanup timed out')), Math.min(options.timeoutMs, remaining));
            })]);
          } catch { options.onError?.(late); }
          finally { clearTimeout(timer); }
        }
      } finally { draining = false; completed = true; }
    });
  }
  return {
    register(cleanup: () => void | Promise<void>): void {
      if (typeof cleanup !== 'function') throw new TypeError('Plugin cleanup must be a function');
      pending.push(cleanup);
      if (completed && !draining) void drain(true);
    },
    dispose(): Promise<void> { return disposal ??= drain(false); },
  };
}
