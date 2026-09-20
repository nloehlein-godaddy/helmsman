import { RecoveryActionError, type RecoveryService, validRecoveryRepo } from './recovery-service';

export async function handleRecoveryRequest(method: string, path: string, query: URLSearchParams, body: unknown, service: RecoveryService): Promise<{ status: number; json: unknown } | null> {
  if (path !== '/api/recovery' && path !== '/api/recovery/actions') return null;
  try {
    if (path === '/api/recovery' && method === 'GET') {
      const repo = query.get('repo');
      if (!validRecoveryRepo(repo)) return { status: 400, json: { error: 'Invalid galleon filter.' } };
      return { status: 200, json: service.snapshot(repo) };
    }
    if (path === '/api/recovery/actions' && method === 'POST') {
      await service.act(body);
      return { status: 200, json: { ok: true } };
    }
    return { status: 405, json: { error: 'Recovery method is unavailable.' } };
  } catch (error) {
    return error instanceof RecoveryActionError ? { status: error.status, json: { error: error.message } }
      : { status: 409, json: { error: 'Recovery action could not complete; retained state was preserved.' } };
  }
}
