import type { TaskSourceDeclaration } from './backend';
import { invalidSourceContract, sourceFields, sourceObject, sourceText } from './source-contract-validation';

export function parseTaskSourceRemoteActionsV1(input: unknown, declaration: Pick<TaskSourceDeclaration, 'effectIds' | 'access'>): NonNullable<TaskSourceDeclaration['remoteActions']> {
  if (!Array.isArray(input) || input.length > 1) invalidSourceContract();
  return Object.freeze(input.map(entry => {
    const value = sourceObject(entry);
    sourceFields(value, ['id', 'effectId']);
    const effectId = sourceText(value.effectId, 100);
    if (value.id !== 'assign-self' || !declaration.effectIds.includes(effectId) || !declaration.access.includes('connection-http')) invalidSourceContract();
    return Object.freeze({ id: 'assign-self' as const, effectId });
  }));
}
