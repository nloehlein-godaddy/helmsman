export interface ApiCachePolicy { readonly ttlMs: number; readonly staleMs: number; }
const policy = (seconds: number, stale = 60): ApiCachePolicy => ({ ttlMs: seconds * 1000, staleMs: stale * 1000 });
export function apiCachePolicy(url: URL): ApiCachePolicy | null {
  const path = url.pathname;
  if (path === '/api/pull-request-read') return policy(30);
  if (path === '/api/run-read') return policy(5);
  if (/^\/api\/task-sources\/[^/]+\/tasks$/.test(path)
    && [...url.searchParams.keys()].every(key => ['repo', 'revision', 'limit', 'state', 'cursor'].includes(key))) return policy(15);
  if (/^\/api\/task-views-read\/[^/]+\/(triage|bugs)$/.test(path)) return policy(15);
  if (/^\/api\/activity-read\/[^/]+$/.test(path)) return policy(10);
  if (['/api/campaign-service/list', '/api/clarification-read'].includes(path)) return policy(15);
  if (['/api/usage/v1', '/api/reports/outcomes/v1', '/api/pricing/v1'].includes(path)) return policy(60, 120);
  return null;
}
