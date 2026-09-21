import { describe, expect, it, vi } from 'vitest';
import { handleRunCommandApi } from './run-command-routes';
import { RunCommandError, RunCommandRejection, type RunCommandServerService } from './run-command-coordinator';
import { PersistenceConflictError } from './persistence';
import type { RunCommandV1 } from '../../src/plugins/run-command';

const command: RunCommandV1 = { version: 1, requestId: '00000000-0000-4000-8000-000000000001', repo: 'owner/repo', action: 'stop', target: { runId: 'run', expectedAttempt: 1 } };
const receipt = { version: 1 as const, requestId: command.requestId, repo: command.repo, action: 'stop' as const, status: 'accepted' as const, runId: 'run', attempt: 1, message: null };
function setup() {
  const service: RunCommandServerService = { submit: vi.fn(async () => receipt), receipt: vi.fn(() => receipt) };
  const route = (options: { path?: string; method?: string; body?: unknown; caller?: string }) => handleRunCommandApi({ method: 'POST', path: '/api/run-commands',
    body: command, caller: 'example.running/panel', query: new URLSearchParams({ repo: command.repo }), service, ...options });
  return { service, route };
}
describe('fixed run command routes', () => {
  it('uses the host supplied caller separately from the strict authored envelope', async () => {
    const { service, route } = setup();
    expect(await route({})).toEqual({ status: 200, json: receipt });
    expect(service.submit).toHaveBeenCalledWith('example.running/panel', command);
    expect((await route({ body: { ...command, caller: 'forged' } }))?.status).toBe(400);
    expect((await route({ caller: undefined }))?.status).toBe(403);
  });
  it('provides exact scoped receipt reads including missing receipts', async () => {
    const { service, route } = setup();
    expect(await route({ path: `/api/run-commands/${command.requestId}`, method: 'GET' })).toEqual({ status: 200, json: receipt });
    expect(service.receipt).toHaveBeenCalledWith('example.running/panel', { repo: command.repo, requestId: command.requestId });
    vi.mocked(service.receipt).mockReturnValue(null);
    expect(await route({ path: `/api/run-commands/${command.requestId}`, method: 'GET' })).toEqual({ status: 200, json: null });
  });
  it('cannot dispatch arbitrary methods, paths or invalid identifiers', async () => {
    const { route } = setup();
    expect(await route({ path: '/api/elsewhere' })).toBeNull();
    expect((await route({ method: 'GET' }))?.status).toBe(405);
    expect((await route({ path: '/api/run-commands/a/b' }))?.status).toBe(404);
    expect((await route({ path: '/api/run-commands/bad', method: 'GET' }))?.status).toBe(400);
    expect((await route({ path: `/api/run-commands/${command.requestId}`, method: 'DELETE' }))?.status).toBe(405);
  });
  it('maps authorization, conflicts and unexpected failures without private details', async () => {
    const { service, route } = setup();
    vi.mocked(service.submit).mockRejectedValueOnce(new RunCommandError(403, 'Scope denied'));
    expect((await route({}))?.status).toBe(403);
    vi.mocked(service.submit).mockRejectedValueOnce(new RunCommandRejection('Contribution disabled'));
    expect(await route({})).toEqual({ status: 403, json: { error: 'Contribution disabled' } });
    vi.mocked(service.submit).mockRejectedValueOnce(new PersistenceConflictError('private hash'));
    expect(await route({})).toEqual({ status: 409, json: { error: 'Run command identity or ownership conflict' } });
    vi.mocked(service.submit).mockRejectedValueOnce(new Error('private config'));
    expect(await route({})).toEqual({ status: 503, json: { error: 'Run commands unavailable' } });
  });
});
