import type { PluginJson } from './backend';
import { sourceFields, sourceJson, sourceObject, sourceText } from './source-contract-validation';

export const NATIVE_TERMINAL_LIMITS_V1: Readonly<Record<'reference' | 'session' | 'tabs' | 'text' | 'screen' | 'lines' | 'browserJson' | 'script' | 'selector', number>> = Object.freeze({ reference: 256, session: 4096, tabs: 4096, text: 128 * 1024, screen: 1024 * 1024, lines: 10_000, browserJson: 4 * 1024 * 1024, script: 1024 * 1024, selector: 8192 });
export interface NativeTerminalMetadataV1 { readonly version: 1; readonly label: string; readonly browser: boolean; }
export interface NativeTerminalSurfaceV1 {
  readonly windowRef: string; readonly workspaceRef: string; readonly workspaceTitle: string;
  readonly surfaceRef: string; readonly surfaceTitle: string; readonly type: string; readonly cwd: string | null; readonly selected: boolean;
  readonly lastPrompt?: string | null;
}
export interface NativeTerminalTabsV1 { readonly connected: boolean; readonly tabs: readonly NativeTerminalSurfaceV1[]; }
export type NativeTerminalControlResultV1 = { readonly ok: true } | { readonly ok: false; readonly error: string };
export type NativeTerminalScreenResultV1 = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };
export interface NativeTerminalBrowserV1 {
  tree(signal?: AbortSignal): Promise<unknown>;
  focus(input: { readonly surface: string }, signal?: AbortSignal): Promise<void>;
  evaluate(input: { readonly surface: string; readonly script: string }, signal?: AbortSignal): Promise<unknown>;
  click(input: { readonly surface: string; readonly selector: string }, signal?: AbortSignal): Promise<void>;
  fill(input: { readonly surface: string; readonly selector: string; readonly value: string }, signal?: AbortSignal): Promise<void>;
  wait(input: { readonly surface: string; readonly selector: string; readonly timeoutMs: number }, signal?: AbortSignal): Promise<void>;
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
export interface NativeTerminalDeclarationV1 { readonly access: readonly ['native-session']; }
export interface NativeTerminalBackendContextV1 {
  readonly pluginId: string; readonly signal: AbortSignal; readonly settings: Readonly<Record<string, PluginJson>>;
  registerNativeTerminal(localId: string, provider: NativeTerminalProviderV1): void;
  onDispose(cleanup: () => void | Promise<void>): void;
}
export interface NativeTerminalBackendModuleV1 { activate(context: NativeTerminalBackendContextV1): void | Promise<void>; }

function invalid(): never { throw new TypeError('Invalid native terminal contract'); }
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || new TextEncoder().encode(value).byteLength > maximum || value.includes('\0') || !empty && !value.trim()) invalid(); return value;
}
export function parseNativeTerminalMetadataV1(input: unknown): NativeTerminalMetadataV1 {
  const value = sourceObject(input); sourceFields(value, ['version', 'label', 'browser']);
  if (value.version !== 1 || typeof value.browser !== 'boolean') invalid();
  return Object.freeze({ version: 1, label: sourceText(value.label, 128), browser: value.browser });
}
export function parseNativeTerminalReferenceV1(value: unknown): string { return sourceText(value, NATIVE_TERMINAL_LIMITS_V1.reference); }
export function parseNativeTerminalSessionV1(value: unknown): string { return sourceText(value, NATIVE_TERMINAL_LIMITS_V1.session); }
export function parseNativeTerminalTextV1(value: unknown): string { return text(value, NATIVE_TERMINAL_LIMITS_V1.text, true); }
export function parseNativeTerminalKeyV1(value: unknown): string { return sourceText(value, 128); }
export function parseNativeTerminalLinesV1(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > NATIVE_TERMINAL_LIMITS_V1.lines) invalid(); return value;
}
export function parseNativeTerminalSurfaceV1(input: unknown): NativeTerminalSurfaceV1 {
  const value = sourceObject(input); sourceFields(value, ['windowRef', 'workspaceRef', 'workspaceTitle', 'surfaceRef', 'surfaceTitle', 'type', 'cwd', 'selected'], ['lastPrompt']);
  if (typeof value.selected !== 'boolean') invalid();
  return Object.freeze({ windowRef: parseNativeTerminalReferenceV1(value.windowRef), workspaceRef: parseNativeTerminalReferenceV1(value.workspaceRef),
    workspaceTitle: text(value.workspaceTitle, 4096, true), surfaceRef: parseNativeTerminalReferenceV1(value.surfaceRef), surfaceTitle: text(value.surfaceTitle, 4096, true),
    type: sourceText(value.type, 128), cwd: value.cwd === null ? null : text(value.cwd, 4096), selected: value.selected,
    ...(value.lastPrompt === undefined ? {} : { lastPrompt: value.lastPrompt === null ? null : text(value.lastPrompt, 4096, true) }) });
}
export function parseNativeTerminalTabsV1(input: unknown): NativeTerminalTabsV1 {
  const value = sourceObject(sourceJson(input, 4 * 1024 * 1024)); sourceFields(value, ['connected', 'tabs']);
  if (typeof value.connected !== 'boolean' || !Array.isArray(value.tabs) || value.tabs.length > NATIVE_TERMINAL_LIMITS_V1.tabs || !value.connected && value.tabs.length) invalid();
  const tabs = value.tabs.map(parseNativeTerminalSurfaceV1);
  if (new Set(tabs.map(item => item.surfaceRef)).size !== tabs.length) invalid();
  return Object.freeze({ connected: value.connected, tabs: Object.freeze(tabs) });
}
export function parseNativeTerminalControlResultV1(input: unknown): NativeTerminalControlResultV1 {
  const value = sourceObject(input); sourceFields(value, value.ok === true ? ['ok'] : ['ok', 'error']);
  if (value.ok === true) return Object.freeze({ ok: true });
  if (value.ok !== false) invalid(); return Object.freeze({ ok: false, error: text(value.error, 4096) });
}
export function parseNativeTerminalScreenResultV1(input: unknown): NativeTerminalScreenResultV1 {
  const value = sourceObject(input); sourceFields(value, value.ok === true ? ['ok', 'text'] : ['ok', 'error']);
  if (value.ok === true) return Object.freeze({ ok: true, text: text(value.text, NATIVE_TERMINAL_LIMITS_V1.screen, true) });
  if (value.ok !== false) invalid(); return Object.freeze({ ok: false, error: text(value.error, 4096) });
}
export function parseNativeTerminalBrowserValueV1(input: unknown): PluginJson { return sourceJson(input, NATIVE_TERMINAL_LIMITS_V1.browserJson); }
export function parseNativeTerminalBrowserTreeV1(input: unknown): PluginJson {
  const value = parseNativeTerminalBrowserValueV1(input); sourceObject(value); return value;
}
export function parseNativeTerminalBrowserFocusV1(input: unknown): { readonly surface: string } {
  const value = sourceObject(input); sourceFields(value, ['surface']); return Object.freeze({ surface: parseNativeTerminalReferenceV1(value.surface) });
}
export function parseNativeTerminalBrowserEvaluateV1(input: unknown): { readonly surface: string; readonly script: string } {
  const value = sourceObject(input); sourceFields(value, ['surface', 'script']);
  return Object.freeze({ surface: parseNativeTerminalReferenceV1(value.surface), script: text(value.script, NATIVE_TERMINAL_LIMITS_V1.script) });
}
export function parseNativeTerminalBrowserClickV1(input: unknown): { readonly surface: string; readonly selector: string } {
  const value = sourceObject(input); sourceFields(value, ['surface', 'selector']);
  return Object.freeze({ surface: parseNativeTerminalReferenceV1(value.surface), selector: text(value.selector, NATIVE_TERMINAL_LIMITS_V1.selector) });
}
export function parseNativeTerminalBrowserFillV1(input: unknown): { readonly surface: string; readonly selector: string; readonly value: string } {
  const value = sourceObject(input); sourceFields(value, ['surface', 'selector', 'value']);
  return Object.freeze({ surface: parseNativeTerminalReferenceV1(value.surface), selector: text(value.selector, NATIVE_TERMINAL_LIMITS_V1.selector), value: parseNativeTerminalTextV1(value.value) });
}
export function parseNativeTerminalBrowserWaitV1(input: unknown): { readonly surface: string; readonly selector: string; readonly timeoutMs: number } {
  const value = sourceObject(input); sourceFields(value, ['surface', 'selector', 'timeoutMs']);
  if (typeof value.timeoutMs !== 'number' || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 15_000) invalid();
  return Object.freeze({ surface: parseNativeTerminalReferenceV1(value.surface), selector: text(value.selector, NATIVE_TERMINAL_LIMITS_V1.selector), timeoutMs: value.timeoutMs });
}
