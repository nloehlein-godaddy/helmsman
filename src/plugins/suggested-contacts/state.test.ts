import { expect, it } from 'vitest';
import { empty, readState } from './state';
const result = { requestId: '00000000-0000-4000-8000-000000000001', id: 'contact', kind: 'create', status: 'succeeded', name: 'Owner', address: 'Slack handle', enabled: true, revision: 1, reason: null };
it('preserves global drafts and terminal summaries with arbitrary addresses and disabled contacts', () => {
  const value = { create: { name: 'Owner', address: 'Slack handle', enabled: false }, edits: [{ id: 'legacy', expectedRevision: 2, name: 'Owner', address: 'room', enabled: false }], results: [result] };
  expect(readState({ version: 1, value })).toEqual(value);
});
it('preserves unsupported and rejects malformed contact draft/result state without coercion', () => {
  for (const value of [{ ...empty(), create: { name: 'Owner', address: 'room', enabled: 1 } }, { ...empty(), results: [{ ...result, status: ['succeeded'] }] }, { ...empty(), results: [{ ...result, kind: ['create'] }] }, { ...empty(), results: [{ ...result, revision: null }] }, { ...empty(), edits: [{ id: 'legacy', expectedRevision: 0, name: 'Owner', address: 'room', enabled: false }] }]) expect(readState({ version: 1, value })).toBeNull();
  expect(readState({ version: 2, value: empty() })).toBeNull(); expect(readState(null)).toEqual(empty());
});
