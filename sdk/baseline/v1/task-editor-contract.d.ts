export interface TaskEditorContractV1 {
    readonly id: string;
    readonly version: 1;
}
export type TaskEditActionV1 = 'create' | 'update' | 'delete';
export interface TaskEditorDeclarationV1 extends TaskEditorContractV1 {
    readonly commands: Readonly<Record<TaskEditActionV1, string | null>>;
}
export declare function parseTaskEditorContractV1(input: unknown): TaskEditorContractV1;
export declare function parseTaskEditorDeclarationV1(input: unknown): TaskEditorDeclarationV1;
