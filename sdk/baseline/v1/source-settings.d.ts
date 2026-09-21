import type { PluginJson, PluginSetting } from "./backend.js";
export type SourceSettingSchemaV1 = PluginSetting | {
    readonly type: 'string-list';
    readonly default: readonly string[];
    readonly maxItems: number;
    readonly maxLength: number;
} | {
    readonly type: 'string-map';
    readonly default: Readonly<Record<string, string>>;
    readonly maxItems: number;
    readonly maxLength: number;
};
export interface SourceSettingFieldV1 {
    readonly label: string;
    readonly schema: SourceSettingSchemaV1;
}
export type SourceSettingFieldsV1 = Readonly<Record<string, SourceSettingFieldV1>>;
export declare function validateSourceSettingV1(schema: SourceSettingSchemaV1, input: unknown): PluginJson;
export declare function parseSourceSettingFieldsV1(input: unknown): SourceSettingFieldsV1;
