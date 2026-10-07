// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { handleSourceAdminApi } from './source-admin-routes';
import type { SourceAdminServerService } from './source-admin-service';
import { JiraSourceAccessError } from './task-source-jira-connection';

function fixture(error: Error) {
  const validateReplacement = vi.fn().mockRejectedValue(error);
  const service = { validateReplacement } as unknown as SourceAdminServerService;
  return handleSourceAdminApi({ method: 'POST', path: '/api/source-admin/validate', query: new URLSearchParams(),
    caller: 'helmsman.source-settings/panel', body: {}, service });
}
it.each([401, 403] as const)('returns sanitized actionable evidence for Jira HTTP %s', async status => {
  const error = new JiraSourceAccessError(status);
  expect(await fixture(error)).toEqual({ status: 502, json: { error: error.message,
    diagnostic: status === 401 ? 'jira-credentials-rejected' : 'jira-access-denied' } });
});
it('keeps unclassified provider failures private', async () => {
  expect(await fixture(new Error('private upstream diagnostic'))).toEqual({ status: 503, json: { error: 'Source administration unavailable' } });
});
