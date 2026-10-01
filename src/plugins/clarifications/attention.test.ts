import { expect, it, vi } from 'vitest';
import { createHostPageServices } from '../host-services';
import { attention } from './attention';
import type { ClarificationReadItemV1, ClarificationReadServiceV1, PluginPageAttentionContext } from '../sdk';

function fixture() {
  const now = new Date().toISOString();
  const question: ClarificationReadItemV1 = { version: 1, id: 'question', repo: 'org/a', runId: 'run', revision: 1, prompt: 'Choose an option?', required: true,
    owner: 'local', contactId: null, state: 'pending', answer: null, createdAt: now, timeoutAt: null, answeredAt: null,
    provenance: { kind: 'legacy-unproven', attempt: null, channelId: null }, currentAttempt: null, blocksPublication: true, answerability: { available: false, reason: 'provenance-unknown' } };
  const controller = new AbortController();
  const list = vi.fn<ClarificationReadServiceV1['list']>(async query => ({ status: 'available', value: { version: 1, repo: query.repo, items: [question], observedAt: now, nextCursor: null, total: null } }));
  const context: PluginPageAttentionContext = { contributionId: 'example.questions/page', repo: 'org/a', signal: controller.signal, services: { ...createHostPageServices(controller.signal), clarifications: { version: 1, list, load: vi.fn() } } };
  return { question, list, context, controller, now };
}
it('uses the public pending query and stable identities across revisions, with bounded pagination', async () => {
  const f = fixture(); f.list.mockImplementation(async query => ({ status: 'available', value: { version: 1, repo: query.repo,
    items: [{ ...f.question, id: query.cursor ?? 'first', revision: query.cursor ? 99 : 1 }], observedAt: f.now, nextCursor: query.cursor ? null : 'next', total: 2 } }));
  expect(await attention(f.context)).toEqual({ version: 1, keys: ['["org/a","run","first"]', '["org/a","run","next"]'] });
  expect(f.list).toHaveBeenCalledWith({ version: 1, repo: 'org/a', runId: null, states: ['pending'], limit: 100, cursor: null }, f.controller.signal);
  expect(f.list).toHaveBeenCalledTimes(2);
});
it('excludes expired pending rows and rejects cross-scope, answered or malformed observations', async () => {
  const f = fixture(); const response = (item: ClarificationReadItemV1) => ({ status: 'available' as const, value: { version: 1 as const, repo: 'org/a', items: [item], observedAt: f.now, nextCursor: null, total: 1 } });
  f.list.mockResolvedValue(response({ ...f.question, timeoutAt: '2000-01-01T00:00:00Z' })); expect(await attention(f.context)).toEqual({ version: 1, keys: [] });
  f.list.mockResolvedValue(response({ ...f.question, state: 'answered', answer: 'Yes' })); expect(await attention(f.context)).toBeNull();
  f.list.mockResolvedValue(response({ ...f.question, repo: 'org/b' })); expect(await attention(f.context)).toBeNull();
  f.list.mockResolvedValue({ status: 'unavailable', reason: 'forbidden' }); expect(await attention(f.context)).toBeNull();
});
it('stops on abort and refuses a repeated pagination cursor', async () => {
  const f = fixture(); f.list.mockResolvedValue({ status: 'available', value: { version: 1, repo: 'org/a', items: [f.question], observedAt: f.now, nextCursor: 'repeat', total: null } });
  expect(await attention(f.context)).toBeNull(); expect(f.list).toHaveBeenCalledTimes(2);
  f.controller.abort(); await expect(attention(f.context)).rejects.toThrow();
});
