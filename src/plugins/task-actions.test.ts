import { describe, expect, it } from 'vitest';
import { parseSourceRemoteActionCommandV1, parseSourceRemoteActionDiscoveryV1, parseSourceRemoteActionReceiptV1 } from './task-actions';
const selection = { version: 1, sourceId: '00000000-0000-4000-8000-000000000001', instanceId: '00000000-0000-4000-8000-000000000002', instanceRevision: 1, repo: 'owner/project' };
const command = { version: 1, action: 'assign-self', requestId: '00000000-0000-4000-8000-000000000003', selection, sourceRevision: 2,
  target: { ref: { sourceId: selection.sourceId, externalId: '42' }, repo: selection.repo, expectedRevision: 'revision' } };
describe('remote task action contract', () => {
  it('retains distinct source and instance revisions', () => expect(parseSourceRemoteActionCommandV1(command)).toEqual(command));
  it.each(['accountId', 'connectionId', 'credentialHandle', 'settings'])('rejects injected %s at every authority boundary', field => {
    for (const value of [{ ...command, [field]: 'injected' }, { ...command, selection: { ...selection, [field]: 'injected' } }, { ...command, target: { ...command.target, [field]: 'injected' } }]) expect(() => parseSourceRemoteActionCommandV1(value)).toThrow();
    expect(() => parseSourceRemoteActionDiscoveryV1({ version: 1, selection: { ...selection, [field]: 'injected' }, sourceRevision: 2, actions: ['assign-self'] })).toThrow();
  });
  it('requires receipts to preserve the exact retained command and result target', () => {
    const { requestId, ...input } = command;
    const receipt = { version: 1, requestId, input, status: 'succeeded', reason: null, result: { ref: command.target.ref, repo: selection.repo, revision: 'new', accountId: 'self' } };
    expect(parseSourceRemoteActionReceiptV1(receipt, parseSourceRemoteActionCommandV1(command)).status).toBe('succeeded');
    expect(() => parseSourceRemoteActionReceiptV1({ ...receipt, input: { ...input, sourceRevision: 3 } }, parseSourceRemoteActionCommandV1(command))).toThrow();
    expect(() => parseSourceRemoteActionReceiptV1({ ...receipt, result: { ...receipt.result, ref: { ...command.target.ref, externalId: '43' } } })).toThrow();
  });
});
