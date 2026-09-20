import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from './fixtures.test-support';
import type { Persistence } from '../persistence';
const opened: Persistence[] = [];
const setup = () => { const result = fixture(); opened.push(result.persistence); return result; };
afterEach(() => { for (const item of opened.splice(0)) item.close(); });
describe('task source persistence', () => {
  it('provisions stable identity and reuses verified authority across instances', () => {
    const { store, input, source, instance } = setup(); expect(store.provision(input).instance.id).toBe(instance.id);
    const second = store.provision({ ...input, provisioningKey: 'second' }); expect(second.source.id).toBe(source.id); expect(second.instance.id).not.toBe(instance.id);
    expect(() => store.provision({ ...input, binding: { ...input.binding, connectionId: 'changed' } })).toThrow(/identity changed/);
    const changed = store.configureInstance({ instanceId: instance.id, expectedRevision: 1, desiredEnabled: false }); expect(changed.revision).toBe(2);
    expect(() => store.configureInstance({ instanceId: instance.id, expectedRevision: 1, label: 'stale' })).toThrow(/revision/);
  });
  it('keeps unverified namespaces distinct and requires deliberate additional provisioning', () => {
    const { store, input } = setup(); const seeded = { ...input, provisioningKey: 'jira', storageLayout: 'remote' as const, identityEvidence: { ...input.identityEvidence, level: 'operator-seeded' as const, authority: null } };
    const first = store.provision(seeded); expect(store.provision(seeded).source.id).toBe(first.source.id);
    expect(() => store.provision({ ...seeded, provisioningKey: 'another' })).toThrow(/distinct-source/);
    expect(store.provision({ ...seeded, provisioningKey: 'another', distinctUnverifiedSource: true }).source.id).not.toBe(first.source.id);
  });
  it('deduplicates immutable WorkRef across instances and rolls reservations back atomically', () => {
    const { store, persistence, source, instance, input } = setup(); const ref = { sourceId: source.id, externalId: 'TODO-1' };
    const request = { ref, admissionId: 'admission-one', runId: 'run-one', instanceId: instance.id, expectedSourceRevision: source.revision, expectedInstanceRevision: instance.revision };
    expect(() => persistence.transaction(() => { store.reserveWork(request); throw new Error('rollback'); })).toThrow('rollback'); expect(store.activeClaim(ref)).toBeNull();
    const claim = store.reserveWork(request); expect(store.reserveWork(request).id).toBe(claim.id);
    const second = store.provision({ ...input, provisioningKey: 'second' });
    expect(() => store.reserveWork({ ...request, instanceId: second.instance.id, admissionId: 'other', runId: 'other' })).toThrow(/already reserved/);
    const settling = store.beginSettlement(claim.id, claim.revision); store.settleWork({ claimId: claim.id, expectedRevision: settling.revision, disposition: 'retained-for-operator', reason: 'uncertain', localRecordRevision: null, operations: [] });
    expect(store.activeClaim(ref)?.state).toBe('settling');
  });
  it('enforces immutable alias mapping and quarantines all instances and galleons', () => {
    const { store, source } = setup(); store.recordAlias({ sourceId: source.id, displayKey: 'ABC-1', externalId: '123', evidence: {} });
    expect(store.alias(source.id, 'ABC-1')).toBe('123'); expect(() => store.recordAlias({ sourceId: source.id, displayKey: 'ABC-1', externalId: '456', evidence: {} })).toThrow(/another immutable/);
    store.quarantine({ sourceId: source.id, externalId: null, displayKey: 'ABC-1', reason: 'old run', evidence: {} });
    expect(() => store.assertUnquarantined({ sourceId: source.id, externalId: '123' })).toThrow(/quarantined/);
  });
});
