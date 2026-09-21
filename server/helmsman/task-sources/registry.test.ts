import { describe, expect, it } from 'vitest';
import { createTaskSourceRegistry, selectTaskSourceInstance } from './registry';
import { binding, fixture, provider } from './fixtures.test-support';
const declaration = { identityFormats: ['helmsman.local-task/v1'], effectIds: [], commandIds: [], access: ['local-records' as const] };
describe('task source registry', () => {
  it('retains validated source settings metadata through staging and publication', () => {
    const fields = { project: { label: 'Project', schema: { type: 'string' as const, default: '', maxLength: 128 } } };
    const registry = createTaskSourceRegistry({ eligible: () => true });
    const staged = registry.stage(binding, { ...declaration, settingsFields: fields }, provider);
    fields.project.label = 'Mutated'; registry.publish([staged]);
    expect(registry.list()[0]?.declaration.settingsFields?.project?.label).toBe('Project');
    expect(Object.isFrozen(staged.declaration.settingsFields?.project?.schema)).toBe(true);
  });
  it('publishes atomically and resolves disabled instances only for retained obligations', () => {
    const { persistence, instance } = fixture(); try {
      const registry = createTaskSourceRegistry({ eligible: () => true }); const staged = registry.stage(binding, declaration, provider);
      expect(() => registry.publish([staged, staged])).toThrow(); expect(registry.list()).toHaveLength(0);
      registry.publish([staged]); expect(registry.resolve(instance, 'admission').provider).toBe(provider);
      expect(() => registry.resolve({ ...instance, desiredEnabled: false }, 'admission')).toThrow(/disabled/);
      expect(registry.resolve({ ...instance, desiredEnabled: false }, 'obligation').provider).toBe(provider);
      expect(() => registry.resolve({ ...instance, binding: { ...binding, artifactHash: 'b'.repeat(64) } }, 'obligation')).toThrow(/unavailable/);
    } finally { persistence.close(); }
  });
  it('never falls back after an invalid explicit choice or guesses ambiguous discovery', () => {
    const { persistence, instance } = fixture(); try {
      const registry = createTaskSourceRegistry({ eligible: () => true }); registry.publish([registry.stage(binding, declaration, provider)]);
      expect(() => selectTaskSourceInstance({ registry, instances: [instance], repo: 'owner/project', selections: ['missing', instance.id] })).toThrow(/Explicit/);
      expect(() => selectTaskSourceInstance({ registry, instances: [instance, { ...instance, id: 'another' }], repo: 'owner/project' })).toThrow(/ambiguous/);
      expect(selectTaskSourceInstance({ registry, instances: [instance], repo: 'owner/project' }).id).toBe(instance.id);
    } finally { persistence.close(); }
  });
});
