import { apiFetch } from './api-client';
export type IntegrationState = 'available' | 'unavailable' | 'not-configured' | 'unknown';
export interface IntegrationStatusSnapshot {
  version: 1;
  repo: string | null;
  jira: IntegrationState;
  github: IntegrationState;
  checkedAt: string;
}
export interface IntegrationNavigationStatus {
  repo: string | null;
  jira: IntegrationState | 'checking';
  github: IntegrationState | 'checking';
}

export function parseIntegrationStatus(input: unknown, repo: string | null): IntegrationStatusSnapshot | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const states = ['available', 'unavailable', 'not-configured', 'unknown'];
  if (Object.keys(value).length !== 5 || value.version !== 1 || value.repo !== repo
    || typeof value.jira !== 'string' || !states.includes(value.jira) || typeof value.github !== 'string' || !states.includes(value.github)
    || typeof value.checkedAt !== 'string' || value.checkedAt.length > 40 || !Number.isFinite(Date.parse(value.checkedAt))) return null;
  return value as unknown as IntegrationStatusSnapshot;
}

export function createIntegrationStatusController(onChange: (status: IntegrationNavigationStatus) => void, options: {
  fetcher?: typeof fetch; now?: () => number;
} = {}) {
  const fetcher = options.fetcher ?? apiFetch;
  const now = options.now ?? Date.now;
  let active: { repo: string | null; controller: AbortController; promise: Promise<void> } | null = null;
  let cached: { value: IntegrationStatusSnapshot; at: number } | null = null;
  let disposed = false;
  const isCurrent = (controller: AbortController): boolean => active?.controller === controller;
  return {
    refresh(repo: string | null, force = false): Promise<void> {
      if (disposed) return Promise.resolve();
      if (!force && active?.repo === repo) return active.promise;
      active?.controller.abort();
      active = null;
      if (!force && cached?.value.repo === repo && now() - cached.at < 30_000) {
        onChange(cached.value);
        return Promise.resolve();
      }
      const controller = new AbortController();
      onChange({ repo, jira: 'checking', github: 'checking' });
      const promise = (async () => {
        let value: IntegrationStatusSnapshot | null = null;
        try {
          const query = repo === null ? '' : `?repo=${encodeURIComponent(repo)}`;
          const response = await fetcher(`/api/integration-status${query}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), credentials: 'same-origin' });
          if (response.ok) value = parseIntegrationStatus(await response.json(), repo);
        } catch {}
        if (disposed || controller.signal.aborted || !isCurrent(controller)) return;
        if (value) cached = { value, at: now() };
        onChange(value ?? { repo, jira: 'unknown', github: 'unknown' });
      })().finally(() => { if (active?.controller === controller) active = null; });
      active = { repo, controller, promise };
      return promise;
    },
    dispose(): void { disposed = true; active?.controller.abort(); active = null; },
  };
}
