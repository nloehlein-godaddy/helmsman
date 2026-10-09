const listeners = new Set<() => void>();

export function notifyIntegrationSettingsChanged(): void {
  for (const listener of listeners) {
    try { listener(); } catch {}
  }
}

export function onIntegrationSettingsChanged(listener: () => void, signal: AbortSignal): void {
  if (signal.aborted) return;
  listeners.add(listener);
  signal.addEventListener('abort', () => listeners.delete(listener), { once: true });
}
