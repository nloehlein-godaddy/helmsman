// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { handleRecoveryRequest } from './recovery-http';
import { RecoveryActionError, type RecoveryService } from './recovery-service';

function service() { return { snapshot: vi.fn(), act: vi.fn() } satisfies RecoveryService; }
it('handles exact endpoints and validates the selected galleon', async () => {
  const value = service(); value.snapshot.mockReturnValue({ version: 1 });
  expect(await handleRecoveryRequest('GET', '/api/other', new URLSearchParams(), null, value)).toBeNull();
  expect(await handleRecoveryRequest('GET', '/api/recovery', new URLSearchParams('repo=org/a'), null, value)).toEqual({ status: 200, json: { version: 1 } });
  expect(value.snapshot).toHaveBeenCalledExactlyOnceWith('org/a');
  expect(await handleRecoveryRequest('GET', '/api/recovery', new URLSearchParams('repo=bad'), null, value)).toMatchObject({ status: 400 });
  expect(await handleRecoveryRequest('DELETE', '/api/recovery', new URLSearchParams(), null, value)).toMatchObject({ status: 405 });
});
it('forwards actions and returns safe error responses without leaking internal details', async () => {
  const value = service(); const action = { action: 'retry-attachment', runId: 'voyage1' };
  expect(await handleRecoveryRequest('POST', '/api/recovery/actions', new URLSearchParams(), action, value)).toEqual({ status: 200, json: { ok: true } });
  expect(value.act).toHaveBeenCalledExactlyOnceWith(action);
  value.act.mockRejectedValueOnce(new RecoveryActionError(400, 'Invalid recovery target.'));
  expect(await handleRecoveryRequest('POST', '/api/recovery/actions', new URLSearchParams(), null, value)).toMatchObject({ status: 400 });
  value.act.mockRejectedValueOnce(new Error('private credential path'));
  const response = await handleRecoveryRequest('POST', '/api/recovery/actions', new URLSearchParams(), action, value);
  expect(response).toMatchObject({ status: 409 }); expect(JSON.stringify(response)).not.toContain('private');
});
