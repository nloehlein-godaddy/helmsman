import { invalidSourceContract, sourceFields, sourceObject, sourceText } from './source-contract-validation';

export interface TaskEditorContractV1 { readonly id: string; readonly version: 1; }
export type TaskEditActionV1 = 'create' | 'update' | 'delete';
export interface TaskEditorDeclarationV1 extends TaskEditorContractV1 {
  readonly commands: Readonly<Record<TaskEditActionV1, string | null>>;
}
export function parseTaskEditorContractV1(input: unknown): TaskEditorContractV1 {
  const value = sourceObject(input); sourceFields(value, ['id', 'version']);
  const id = sourceText(value.id, 240); if (!/^[a-z\d][a-z\d._-]*\/[a-z\d][a-z\d._-]*$/i.test(id) || value.version !== 1) invalidSourceContract();
  return Object.freeze({ id, version: 1 });
}
export function parseTaskEditorDeclarationV1(input: unknown): TaskEditorDeclarationV1 {
  const value = sourceObject(input); sourceFields(value, ['id', 'version', 'commands']);
  const commands = sourceObject(value.commands); sourceFields(commands, ['create', 'update', 'delete']);
  const command = (action: TaskEditActionV1) => commands[action] === null ? null : sourceText(commands[action], 100);
  return Object.freeze({ ...parseTaskEditorContractV1({ id: value.id, version: value.version }), commands: Object.freeze({ create: command('create'), update: command('update'), delete: command('delete') }) });
}
