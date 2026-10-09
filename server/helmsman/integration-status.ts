import { clarificationAbortable } from '../../src/plugins/clarification-transport';
import { parseTaskRepo } from '../../src/plugins/tasks';
import type { IntegrationState, IntegrationStatusSnapshot } from '../../src/data/integration-status';
import { createPullRequestProviderHttp } from './pull-request-provider-http';
import type { ApiResult } from './router';

class IntegrationStatusScopeError extends Error {}

export function createGithubConnectionCheck(options: { token(): string | null; fetcher?: typeof fetch }) {
  return async (repo: string | null, signal: AbortSignal): Promise<IntegrationState> => {
    const token = options.token();
    if (!token) return 'not-configured';
    const connection = { id: 'github-status', credentialHandle: 'github-primary', origin: 'https://api.github.com', subject: 'integration-status' };
    const http = createPullRequestProviderHttp({ connection, signal, mutation: false, fetcher: options.fetcher, timeoutMs: 7000, maxResponseBytes: 128 * 1024,
      authorize(request) {
        if (options.token() !== token || request.method !== 'GET' || !['/user', ...(repo ? [`/repos/${repo}/pulls`] : [])].includes(request.path)) throw new Error('Integration selection changed');
      },
      resolve: async () => ({ ...connection, headers: { Authorization: `Bearer ${token}` } }),
    });
    const identity = await http.request({ method: 'GET', path: '/user', query: {}, body: null });
    const body = identity.body as { login?: unknown } | null;
    if (identity.status !== 200 || typeof body?.login !== 'string' || !body.login.trim()) return 'unavailable';
    if (repo !== null) {
      const access = await http.request({ method: 'GET', path: `/repos/${repo}/pulls`, query: { per_page: '1', state: 'open' }, body: null });
      if (access.status !== 200 || !Array.isArray(access.body)) return 'unavailable';
    }
    return 'available';
  };
}

export function createIntegrationStatusService(options: {
  repos(): readonly string[]; revision(repo: string | null): string;
  jira(repo: string | null, signal: AbortSignal): Promise<IntegrationState>;
  github(repo: string | null, signal: AbortSignal): Promise<IntegrationState>;
  now?: () => number; timeoutMs?: number;
}) {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 7000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 7000) throw new RangeError('Invalid integration timeout');
  const cached = new Map<string, { snapshot: IntegrationStatusSnapshot; at: number }>();
  const pending = new Map<string, Promise<IntegrationStatusSnapshot>>();
  return {
    async snapshot(repo: string | null): Promise<IntegrationStatusSnapshot> {
      if (repo !== null) {
        try { parseTaskRepo(repo); } catch { throw new IntegrationStatusScopeError(); }
        if (!options.repos().includes(repo)) throw new IntegrationStatusScopeError();
      }
      const revision = options.revision(repo);
      const key = JSON.stringify([repo, revision]);
      const existing = cached.get(key);
      if (existing && now() - existing.at < 30_000) return existing.snapshot;
      const running = pending.get(key);
      if (running) return running;
      const promise = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const check = async (fn: typeof options.jira): Promise<IntegrationState> => {
          try { return await clarificationAbortable(Promise.resolve().then(() => fn(repo, controller.signal)), controller.signal); }
          catch { return 'unavailable'; }
        };
        try {
          const [jira, github] = await Promise.all([check(options.jira), check(options.github)]);
          const current = options.revision(repo) === revision && (repo === null || options.repos().includes(repo));
          const snapshot: IntegrationStatusSnapshot = { version: 1, repo, jira: current ? jira : 'unknown', github: current ? github : 'unknown', checkedAt: new Date(now()).toISOString() };
          if (current) {
            if (cached.size >= 100) cached.delete(cached.keys().next().value!);
            cached.set(key, { snapshot, at: now() });
          }
          return snapshot;
        } finally { clearTimeout(timer); }
      })().finally(() => pending.delete(key));
      pending.set(key, promise);
      return promise;
    },
  };
}
export type IntegrationStatusService = ReturnType<typeof createIntegrationStatusService>;

export async function handleIntegrationStatusApi(input: { method: string; path: string; query: URLSearchParams; service?: IntegrationStatusService }): Promise<ApiResult | null> {
  if (input.path !== '/api/integration-status') return null;
  if (input.method !== 'GET') return { status: 405, json: { error: 'Method unavailable' } };
  if ([...input.query.keys()].some(key => key !== 'repo') || input.query.getAll('repo').length > 1) return { status: 400, json: { error: 'Invalid scope' } };
  if (!input.service) return { status: 503, json: { error: 'Status unavailable' } };
  try { return { status: 200, json: await input.service.snapshot(input.query.get('repo')) }; }
  catch (error) { return error instanceof IntegrationStatusScopeError ? { status: 400, json: { error: 'Invalid scope' } } : { status: 503, json: { error: 'Status unavailable' } }; }
}
