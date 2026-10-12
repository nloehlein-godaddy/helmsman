import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import { clarificationAbortable } from '../../src/plugins/clarification-transport';
import type { VpnState, VpnStatusSnapshot } from '../../src/data/vpn-status';
import type { ApiResult } from './router';

const exec = promisify(execFile);
export type { VpnState, VpnStatusSnapshot } from '../../src/data/vpn-status';

export function createGlobalProtectCheck(options: {
  platform?: string;
  read?: (key: 'tunnel-status' | 'tunnel-ip', signal: AbortSignal) => Promise<string>;
  interfaces?: typeof networkInterfaces;
} = {}) {
  const read = options.read ?? (async (key, signal) => (await exec('/usr/libexec/PlistBuddy',
    ['-c', `Print :"Palo Alto Networks":GlobalProtect:DEM:${key}`, '/Library/Preferences/com.paloaltonetworks.GlobalProtect.settings.plist'],
    { encoding: 'utf8', timeout: 1500, maxBuffer: 4096, signal })).stdout.trim());
  return async (signal: AbortSignal): Promise<VpnState> => {
    if ((options.platform ?? process.platform) !== 'darwin') return 'unknown';
    try {
      const status = (await read('tunnel-status', signal)).trim().toLowerCase();
      if (status !== 'connected' && status !== 'disconnected') return 'unknown';
      let addresses = '';
      try { addresses = await read('tunnel-ip', signal); }
      catch { if (status !== 'disconnected' || signal.aborted) return 'unknown'; }
      const assigned = addresses.split(',').map(value => value.trim().replace(/^ipv[46]=/, '')).filter(value => isIP(value) !== 0);
      const active = Object.entries((options.interfaces ?? networkInterfaces)()).some(([name, values]) =>
        /^utun\d+$/.test(name) && (values ?? []).some(value => assigned.includes(value.address)));
      if (signal.aborted) return 'unknown';
      return status === 'connected' ? active ? 'connected' : 'unknown' : active ? 'unknown' : 'disconnected';
    } catch { return 'unknown'; }
  };
}

export function createVpnStatusService(options: {
  client(signal: AbortSignal): Promise<VpnState>;
  checkUrl?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}) {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid VPN timeout');
  let endpoint: URL | null = null;
  if (options.checkUrl?.trim()) {
    try {
      const parsed = new URL(options.checkUrl.trim());
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) endpoint = parsed;
    } catch {}
  }
  let cached: { at: number; snapshot: VpnStatusSnapshot } | null = null;
  let pending: Promise<VpnStatusSnapshot> | null = null;
  return {
    async snapshot(): Promise<VpnStatusSnapshot> {
      if (cached && now() - cached.at < 60_000) return cached.snapshot;
      if (pending) return pending;
      const startedAt = now();
      pending = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const clientCheck = async (): Promise<VpnState> => {
          try { return await clarificationAbortable(Promise.resolve().then(() => options.client(controller.signal)), controller.signal); }
          catch { return 'unknown'; }
        };
        const networkCheck = async (): Promise<VpnStatusSnapshot['network']> => {
          if (!endpoint) return 'not-configured';
          try {
            const response = await clarificationAbortable(Promise.resolve().then(() => (options.fetcher ?? fetch)(endpoint,
              { method: 'HEAD', credentials: 'omit', redirect: 'error', signal: controller.signal })), controller.signal);
            void response.body?.cancel().catch(() => {});
            return response.status > 0 && response.status < 600 ? 'reachable' : 'unreachable';
          } catch { return 'unreachable'; }
        };
        try {
          const [client, network] = await Promise.all([clientCheck(), networkCheck()]);
          const state = client === 'connected' && network !== 'unreachable' ? 'connected'
            : client === 'disconnected' && network !== 'reachable' ? 'disconnected' : 'unknown';
          const snapshot: VpnStatusSnapshot = { version: 1, state, client, network, checkedAt: new Date(now()).toISOString() };
          cached = { at: startedAt, snapshot };
          return snapshot;
        } finally { clearTimeout(timer); }
      })().finally(() => { pending = null; });
      return pending;
    },
  };
}
export type VpnStatusService = ReturnType<typeof createVpnStatusService>;

export async function handleVpnStatusApi(input: { method: string; path: string; query: URLSearchParams; service?: VpnStatusService }): Promise<ApiResult | null> {
  if (input.path !== '/api/vpn-status') return null;
  if (input.method !== 'GET') return { status: 405, json: { error: 'Method unavailable' } };
  if ([...input.query.keys()].length) return { status: 400, json: { error: 'VPN status is global' } };
  if (!input.service) return { status: 503, json: { error: 'Status unavailable' } };
  try { return { status: 200, json: await input.service.snapshot() }; }
  catch { return { status: 503, json: { error: 'Status unavailable' } }; }
}
