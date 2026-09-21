import type { PluginJson } from "./backend.js";
export declare const NATIVE_TERMINAL_LIMITS_V1: Readonly<Record<'reference' | 'session' | 'tabs' | 'text' | 'screen' | 'lines' | 'browserJson' | 'script' | 'selector', number>>;
export interface NativeTerminalMetadataV1 {
    readonly version: 1;
    readonly label: string;
    readonly browser: boolean;
}
export interface NativeTerminalSurfaceV1 {
    readonly windowRef: string;
    readonly workspaceRef: string;
    readonly workspaceTitle: string;
    readonly surfaceRef: string;
    readonly surfaceTitle: string;
    readonly type: string;
    readonly cwd: string | null;
    readonly selected: boolean;
}
export interface NativeTerminalTabsV1 {
    readonly connected: boolean;
    readonly tabs: readonly NativeTerminalSurfaceV1[];
}
export type NativeTerminalControlResultV1 = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly error: string;
};
export type NativeTerminalScreenResultV1 = {
    readonly ok: true;
    readonly text: string;
} | {
    readonly ok: false;
    readonly error: string;
};
export interface NativeTerminalBrowserV1 {
    tree(signal?: AbortSignal): Promise<unknown>;
    focus(input: {
        readonly surface: string;
    }, signal?: AbortSignal): Promise<void>;
    evaluate(input: {
        readonly surface: string;
        readonly script: string;
    }, signal?: AbortSignal): Promise<unknown>;
    click(input: {
        readonly surface: string;
        readonly selector: string;
    }, signal?: AbortSignal): Promise<void>;
    fill(input: {
        readonly surface: string;
        readonly selector: string;
        readonly value: string;
    }, signal?: AbortSignal): Promise<void>;
    wait(input: {
        readonly surface: string;
        readonly selector: string;
        readonly timeoutMs: number;
    }, signal?: AbortSignal): Promise<void>;
}
export interface NativeTerminalProviderV1 {
    readonly metadata: NativeTerminalMetadataV1;
    sessionIdentity(): string;
    listTabs(signal?: AbortSignal): Promise<NativeTerminalTabsV1>;
    readScreen(surfaceRef: string, lines: number, signal?: AbortSignal): Promise<NativeTerminalScreenResultV1>;
    send(surfaceRef: string, text: string, enter: boolean, signal?: AbortSignal): Promise<NativeTerminalControlResultV1>;
    sendKey(surfaceRef: string, key: string, signal?: AbortSignal): Promise<NativeTerminalControlResultV1>;
    readonly browser?: NativeTerminalBrowserV1;
}
export interface NativeTerminalDeclarationV1 {
    readonly access: readonly [
        'native-session'
    ];
}
export interface NativeTerminalBackendContextV1 {
    readonly pluginId: string;
    readonly signal: AbortSignal;
    readonly settings: Readonly<Record<string, PluginJson>>;
    registerNativeTerminal(localId: string, provider: NativeTerminalProviderV1): void;
    onDispose(cleanup: () => void | Promise<void>): void;
}
export interface NativeTerminalBackendModuleV1 {
    activate(context: NativeTerminalBackendContextV1): void | Promise<void>;
}
export declare function parseNativeTerminalMetadataV1(input: unknown): NativeTerminalMetadataV1;
export declare function parseNativeTerminalReferenceV1(value: unknown): string;
export declare function parseNativeTerminalSessionV1(value: unknown): string;
export declare function parseNativeTerminalTextV1(value: unknown): string;
export declare function parseNativeTerminalKeyV1(value: unknown): string;
export declare function parseNativeTerminalLinesV1(value: unknown): number;
export declare function parseNativeTerminalSurfaceV1(input: unknown): NativeTerminalSurfaceV1;
export declare function parseNativeTerminalTabsV1(input: unknown): NativeTerminalTabsV1;
export declare function parseNativeTerminalControlResultV1(input: unknown): NativeTerminalControlResultV1;
export declare function parseNativeTerminalScreenResultV1(input: unknown): NativeTerminalScreenResultV1;
export declare function parseNativeTerminalBrowserValueV1(input: unknown): PluginJson;
export declare function parseNativeTerminalBrowserTreeV1(input: unknown): PluginJson;
export declare function parseNativeTerminalBrowserFocusV1(input: unknown): {
    readonly surface: string;
};
export declare function parseNativeTerminalBrowserEvaluateV1(input: unknown): {
    readonly surface: string;
    readonly script: string;
};
export declare function parseNativeTerminalBrowserClickV1(input: unknown): {
    readonly surface: string;
    readonly selector: string;
};
export declare function parseNativeTerminalBrowserFillV1(input: unknown): {
    readonly surface: string;
    readonly selector: string;
    readonly value: string;
};
export declare function parseNativeTerminalBrowserWaitV1(input: unknown): {
    readonly surface: string;
    readonly selector: string;
    readonly timeoutMs: number;
};
