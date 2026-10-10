import type { ClarificationReadResultV1 } from './clarification-read';

export interface TerminalTargetV1 {
  readonly repo: string | null;
  readonly surfaceRef: string;
  readonly revision: string;
}

export interface TerminalTabV1 {
  readonly target: TerminalTargetV1;
  readonly title: string;
  readonly workspaceTitle: string;
  readonly type: string;
  readonly selected: boolean;
  readonly lastPrompt?: string | null;
  readonly actions: readonly { readonly id: string; readonly label: string }[];
}

export interface TerminalSnapshotV1 {
  readonly version: 1;
  readonly repo: string | null;
  readonly connected: boolean;
  readonly quality: 'complete' | 'partial';
  readonly tabs: readonly TerminalTabV1[];
  readonly observedAt: string;
}

export interface TerminalScreenV1 {
  readonly version: 1;
  readonly target: TerminalTargetV1;
  readonly text: string;
  readonly truncated: boolean;
  readonly observedAt: string;
}

export type TerminalControlOperationV1 =
  | { readonly kind: 'text'; readonly text: string; readonly enter: boolean }
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'action'; readonly action: string }
  | { readonly kind: 'image'; readonly mimeType: string; readonly dataBase64: string };

export interface TerminalControlInputV1 {
  readonly version: 1;
  readonly target: TerminalTargetV1;
  readonly operation: TerminalControlOperationV1;
}

export interface TerminalControlCommandV1 extends TerminalControlInputV1 {
  readonly requestId: string;
}

export interface TerminalControlReceiptV1 {
  readonly version: 1;
  readonly requestId: string;
  readonly input: TerminalControlInputV1;
  readonly status: 'succeeded' | 'rejected' | 'pending' | 'recovery-required';
  readonly reason: string | null;
}

export interface TerminalReceiptQueryV1 {
  readonly repo: string | null;
  readonly requestId: string;
}

export interface TerminalPendingV1 {
  readonly command: TerminalControlCommandV1;
  readonly receipt: TerminalControlReceiptV1 | null;
}

export interface TerminalServiceV1 {
  readonly version: 1;
  list(input: { readonly version: 1; readonly repo: string | null }, signal?: AbortSignal): Promise<ClarificationReadResultV1<TerminalSnapshotV1>>;
  screen(input: { readonly target: TerminalTargetV1; readonly lines: number }, signal?: AbortSignal): Promise<ClarificationReadResultV1<TerminalScreenV1>>;
  control(input: TerminalControlInputV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<TerminalControlReceiptV1>>;
  receipt(input: TerminalReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<TerminalControlReceiptV1 | null>>;
  inspect(input: TerminalReceiptQueryV1, signal?: AbortSignal): Promise<ClarificationReadResultV1<TerminalControlReceiptV1>>;
  pending(signal?: AbortSignal): Promise<readonly TerminalPendingV1[]>;
  acknowledge(input: TerminalReceiptQueryV1, signal?: AbortSignal): Promise<void>;
}

import { clarificationArray, clarificationBoolean, clarificationFields, clarificationInteger, clarificationJson, clarificationObject, clarificationTime, clarificationUuid, clarificationVersion, invalidClarification } from './clarification-validation';
import { sourceText } from './source-contract-validation';
import { parseTaskRepo } from './tasks';

export const TERMINAL_LIMITS: Readonly<{ tabs: number; text: number; screen: number; lines: number; imageBase64: number; responseBytes: number }> = Object.freeze({
  tabs: 512, text: 64 * 1024, screen: 512 * 1024, lines: 2000, imageBase64: 2 * 1024 * 1024, responseBytes: 3 * 1024 * 1024,
});
export function parseTerminalRepo(value: unknown): string | null { return value === null ? null : parseTaskRepo(value); }
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) invalidClarification();
  return value;
}
export function parseTerminalTargetV1(input: unknown): TerminalTargetV1 {
  const value = clarificationObject(input); clarificationFields(value, ['repo', 'surfaceRef', 'revision']);
  const surfaceRef = sourceText(value.surfaceRef, 256); const revision = sourceText(value.revision, 64);
  if (!/^[a-f\d]{64}$/.test(revision)) invalidClarification();
  return Object.freeze({ repo: parseTerminalRepo(value.repo), surfaceRef, revision });
}
export function parseTerminalControlInputV1(input: unknown): TerminalControlInputV1 {
  const value = clarificationVersion(clarificationJson(input, TERMINAL_LIMITS.responseBytes));
  clarificationFields(value, ['version', 'target', 'operation']);
  const op = clarificationObject(value.operation); let operation: TerminalControlOperationV1;
  switch (op.kind) {
    case 'text':
      clarificationFields(op, ['kind', 'text', 'enter']);
      operation = { kind: 'text', text: text(op.text, TERMINAL_LIMITS.text), enter: clarificationBoolean(op.enter) };
      if (!operation.text.length && !operation.enter) invalidClarification();
      break;
    case 'key': {
      clarificationFields(op, ['kind', 'key']); const key = sourceText(op.key, 32);
      if (!/^(?:Enter|Escape|Tab|Backspace|Delete|Up|Down|Left|Right|Home|End|PageUp|PageDown|C-[a-z]|ctrl\+[a-z]|S-Tab|F(?:[1-9]|1[0-2]))$/i.test(key)) invalidClarification();
      operation = { kind: 'key', key }; break;
    }
    case 'action':
      clarificationFields(op, ['kind', 'action']); operation = { kind: 'action', action: sourceText(op.action, 64) }; break;
    case 'image': {
      clarificationFields(op, ['kind', 'mimeType', 'dataBase64']);
      const mimeType = sourceText(op.mimeType, 32); const dataBase64 = sourceText(op.dataBase64, TERMINAL_LIMITS.imageBase64);
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType) || dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) invalidClarification();
      operation = { kind: 'image', mimeType, dataBase64 }; break;
    }
    default: return invalidClarification();
  }
  return Object.freeze({ version: 1, target: parseTerminalTargetV1(value.target), operation: Object.freeze(operation) });
}
export function parseTerminalControlCommandV1(input: unknown): TerminalControlCommandV1 {
  const { requestId, ...value } = clarificationObject(input);
  return Object.freeze({ ...parseTerminalControlInputV1(value), requestId: clarificationUuid(requestId) });
}
export function parseTerminalReceiptQueryV1(input: unknown): TerminalReceiptQueryV1 {
  const value = clarificationObject(input); clarificationFields(value, ['repo', 'requestId']);
  return Object.freeze({ repo: parseTerminalRepo(value.repo), requestId: clarificationUuid(value.requestId) });
}
export function parseTerminalControlReceiptV1(input: unknown, expected?: TerminalControlCommandV1 | TerminalReceiptQueryV1): TerminalControlReceiptV1 {
  const value = clarificationVersion(clarificationJson(input, TERMINAL_LIMITS.responseBytes));
  clarificationFields(value, ['version', 'requestId', 'input', 'status', 'reason']);
  const intent = parseTerminalControlInputV1(value.input); const requestId = clarificationUuid(value.requestId);
  if (expected && (expected.requestId !== requestId || ('target' in expected ? expected.target.repo : expected.repo) !== intent.target.repo)) invalidClarification();
  if (expected && 'target' in expected) {
    const { requestId: _id, ...original } = parseTerminalControlCommandV1(expected);
    if (JSON.stringify(original) !== JSON.stringify(intent)) invalidClarification();
  }
  if (!['succeeded', 'rejected', 'pending', 'recovery-required'].includes(String(value.status))) invalidClarification();
  const reason = value.reason === null ? null : sourceText(value.reason, 2000);
  if (value.status === 'succeeded' && reason !== null || ['rejected', 'recovery-required'].includes(String(value.status)) && reason === null) invalidClarification();
  return Object.freeze({ version: 1, requestId, input: intent, status: value.status as TerminalControlReceiptV1['status'], reason });
}
export function parseTerminalSnapshotV1(input: unknown): TerminalSnapshotV1 {
  const value = clarificationVersion(clarificationJson(input, TERMINAL_LIMITS.responseBytes));
  clarificationFields(value, ['version', 'repo', 'connected', 'quality', 'tabs', 'observedAt']);
  const repo = parseTerminalRepo(value.repo);
  if (value.quality !== 'complete' && value.quality !== 'partial') invalidClarification();
  const tabs = clarificationArray(value.tabs, item => {
    const tab = clarificationObject(item); clarificationFields(tab, ['target', 'title', 'workspaceTitle', 'type', 'selected', 'actions'], ['lastPrompt']);
    const target = parseTerminalTargetV1(tab.target); if (repo !== null && target.repo !== repo) invalidClarification();
    return Object.freeze({ target, title: text(tab.title, 1024), workspaceTitle: text(tab.workspaceTitle, 1024), type: sourceText(tab.type, 64), selected: clarificationBoolean(tab.selected),
      ...(tab.lastPrompt === undefined ? {} : { lastPrompt: tab.lastPrompt === null ? null : text(tab.lastPrompt, 1024) }),
      actions: clarificationArray(tab.actions, entry => { const action = clarificationObject(entry); clarificationFields(action, ['id', 'label']); return Object.freeze({ id: sourceText(action.id, 64), label: sourceText(action.label, 128) }); }, 32) });
  }, TERMINAL_LIMITS.tabs);
  if (new Set(tabs.map(tab => tab.target.surfaceRef)).size !== tabs.length || value.connected === false && tabs.length) invalidClarification();
  return Object.freeze({ version: 1, repo, connected: clarificationBoolean(value.connected), quality: value.quality, tabs, observedAt: clarificationTime(value.observedAt) });
}
export function parseTerminalScreenV1(input: unknown, target?: TerminalTargetV1): TerminalScreenV1 {
  const value = clarificationVersion(clarificationJson(input, TERMINAL_LIMITS.responseBytes)); clarificationFields(value, ['version', 'target', 'text', 'truncated', 'observedAt']);
  const actual = parseTerminalTargetV1(value.target);
  if (target && JSON.stringify(actual) !== JSON.stringify(parseTerminalTargetV1(target))) invalidClarification();
  return Object.freeze({ version: 1, target: actual, text: text(value.text, TERMINAL_LIMITS.screen), truncated: clarificationBoolean(value.truncated), observedAt: clarificationTime(value.observedAt) });
}
export function parseTerminalLines(value: unknown): number { return clarificationInteger(value, TERMINAL_LIMITS.lines); }
