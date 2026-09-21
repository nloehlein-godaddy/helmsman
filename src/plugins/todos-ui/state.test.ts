import { describe, expect, it } from 'vitest';
import type { SourceCommandInputV1, SourceCommandPendingV1, TaskReadSelectionV1 } from '@helmsman/plugin-sdk';
import { consumeResult, emptyState, followHeader, readState, sameSubmission, saveValue, values, type Draft } from './state';

const selection: TaskReadSelectionV1 = { version: 1, sourceId: '11111111-1111-4111-8111-111111111111', instanceId: 'local', instanceRevision: 2, repo: 'owner/project' };
const fields = { title: 'Draft', repo: selection.repo, description: 'Details', acceptanceCriteria: '', priority: 'P2' as const, state: 'todo' as const };
const create: SourceCommandInputV1 = { version: 1, selection, sourceRevision: 3, editor: { id: 'helmsman/local-task-editor', version: 1 }, action: 'create', commandId: 'create', target: null, destinationRepo: selection.repo, input: fields };
const draft = (): Draft => ({ key: 'draft-one', selection, sourceRevision: 3, target: null, destinationPolicy: 'inherit', values: { ...fields }, baseline: { ...fields, title: '' }, submitted: null });
const receipt = (input: SourceCommandInputV1 = create): SourceCommandPendingV1 => {
  const command = { ...input, requestId: '22222222-2222-4222-8222-222222222222' }; const { input: _input, ...identity } = command;
  return { command, receipt: { ...identity, status: 'succeeded', message: null, result: { kind: 'changed', ref: { sourceId: selection.sourceId, externalId: 'TODO-1' }, repo: selection.repo, revision: 'record-2' } } };
};
describe('Todo draft state', () => {
  it('round-trips maximum Unicode fields without truncation and keeps unknown versions opaque', () => {
    const current = draft(); current.values.description = '界'.repeat(20_000); current.values.acceptanceCriteria = '界'.repeat(20_000); current.baseline = { ...current.values };
    const state = { ...emptyState(), activeDraftKey: current.key, drafts: [current] };
    expect(readState(saveValue(state))).toEqual(state);
    expect(readState({ version: 9, value: state })).toBeNull();
    expect(readState({ version: 1, value: { ...state, drafts: [current, current] } })).toBeNull();
  });
  it('rejects invalid fields and mismatched source identities without losing valid empty titles', () => {
    expect(values({ ...fields, title: '' })?.title).toBe('');
    expect(values({ ...fields, description: 'x'.repeat(20_001) })).toBeNull();
    expect(values({ ...fields, repo: '../project' })).toBeNull();
    const current = { ...draft(), target: { ref: { sourceId: '33333333-3333-4333-8333-333333333333', externalId: 'TODO-1' }, revision: '1' }, destinationPolicy: 'fixed' as const };
    expect(readState({ version: 1, value: { ...emptyState(), drafts: [current] } })).toBeNull();
  });
  it('follows the header only for unspecified new drafts on the exact source revision', () => {
    const current = draft(); const next = { ...selection, repo: 'owner/other' };
    expect(followHeader(current, next, 4)).toMatchObject({ selection: next, values: { ...fields, repo: next.repo } });
    for (const pinned of [{ ...current, destinationPolicy: 'fixed' as const }, { ...current, submitted: create }, { ...current, target: { ref: { sourceId: selection.sourceId, externalId: 'TODO-1' }, revision: 'r1' } }]) expect(followHeader(pinned, next, 4)).toBe(pinned);
    expect(followHeader(current, { ...next, instanceRevision: 3 }, 4)).toBe(current);
  });
  it('consumes a create exactly once and preserves text typed after submission', () => {
    const entry = receipt(); const current = { ...draft(), submitted: create, values: { ...fields, description: 'Typed after sending' } };
    const state = { ...emptyState(), activeDraftKey: current.key, drafts: [current] };
    const consumed = consumeResult(state, entry);
    expect(consumed.drafts[0]).toMatchObject({ target: { revision: 'record-2' }, submitted: null, values: { description: 'Typed after sending' }, baseline: fields, destinationPolicy: 'fixed' });
    expect(consumeResult(consumed, entry)).toBe(consumed);
    expect(readState(saveValue(consumed))).toEqual(consumed);
  });
  it('compares submission identity independently of JSON property ordering', () => {
    const entry = receipt();
    expect(sameSubmission({ ...create, input: { state: 'todo', priority: 'P2', acceptanceCriteria: '', description: 'Details', repo: selection.repo, title: 'Draft' } }, entry)).toBe(true);
    expect(sameSubmission({ ...create, sourceRevision: 4 }, entry)).toBe(false);
  });
  it('preserves rejection drafts and refuses to consume unknown or uncertain requests', () => {
    const entry = receipt();
    expect(() => consumeResult(emptyState(), entry)).toThrow(/original draft/);
    const state = { ...emptyState(), drafts: [{ ...draft(), submitted: create }] };
    expect(consumeResult(state, { ...entry, receipt: { ...entry.receipt!, status: 'pending', result: null } })).toBe(state);
    const rejected = consumeResult(state, { ...entry, receipt: { ...entry.receipt!, status: 'rejected', result: null } });
    expect(rejected.drafts[0]?.values).toEqual(fields); expect(rejected.drafts[0]?.submitted).toBeNull();
  });
});
