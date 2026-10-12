export type VpnState = 'connected' | 'disconnected' | 'unknown';
export interface VpnStatusSnapshot {
  version: 1;
  state: VpnState;
  client: VpnState;
  network: 'reachable' | 'unreachable' | 'not-configured';
  checkedAt: string;
}
export type VpnNavigationStatus = VpnStatusSnapshot | { state: 'checking' | 'unknown' };
export const VPN_CHECK_INTERVAL_MS = 60_000;

export function parseVpnStatus(input: unknown): VpnStatusSnapshot | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const states = ['connected', 'disconnected', 'unknown'];
  if (Object.keys(value).length !== 5 || value.version !== 1
    || typeof value.state !== 'string' || !states.includes(value.state)
    || typeof value.client !== 'string' || !states.includes(value.client)
    || typeof value.network !== 'string' || !['reachable', 'unreachable', 'not-configured'].includes(value.network)
    || typeof value.checkedAt !== 'string' || value.checkedAt.length > 40 || !Number.isFinite(Date.parse(value.checkedAt))) return null;
  return value as unknown as VpnStatusSnapshot;
}

export function createVpnStatusController(onChange: (status: VpnNavigationStatus) => void, options: {
  fetcher?: typeof fetch; now?: () => number;
} = {}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let pending: Promise<void> | null = null;
  let checkedAt = -Infinity;
  let disposed = false;
  let controller: AbortController | null = null;
  return {
    refresh(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (pending) return pending;
      if (now() - checkedAt < VPN_CHECK_INTERVAL_MS) return Promise.resolve();
      checkedAt = now();
      controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
      onChange({ state: 'checking' });
      pending = (async () => {
        let value: VpnStatusSnapshot | null = null;
        try {
          const response = await fetcher('/api/vpn-status', { signal, credentials: 'same-origin' });
          if (response.ok) value = parseVpnStatus(await response.json());
        } catch {}
        if (disposed) return;
        onChange(value ?? { state: 'unknown' });
      })().finally(() => { pending = null; controller = null; });
      return pending;
    },
    nextCheckInMs(): number { return Math.max(1, VPN_CHECK_INTERVAL_MS - (now() - checkedAt)); },
    dispose(): void { disposed = true; controller?.abort(); },
  };
}
