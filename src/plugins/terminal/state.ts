import type { TerminalControlInputV1, TerminalControlReceiptV1, TerminalTargetV1 } from '@helmsman/plugin-sdk';

export interface DraftState { version: 1; selected: string | null; drafts: Record<string, string>; collapsed: { tabs: boolean; screen: boolean }; }
export const emptyState = (): DraftState => ({ version: 1, selected: null, drafts: {}, collapsed: { tabs: false, screen: false } });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validSurface(value: unknown): value is string { return typeof value === 'string' && (/^surface:[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.slice(8))) || /^\d+$/.test(value) && Number.isSafeInteger(Number(value))); }
export function validTarget(value: unknown): value is TerminalTargetV1 { return object(value) && validSurface(value.surfaceRef) && typeof value.revision === 'string' && value.revision.length > 0 && value.revision.length <= 256 && (value.repo === null || typeof value.repo === 'string' && /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(value.repo)); }
export const sameTarget = (a: TerminalTargetV1 | null | undefined, b: TerminalTargetV1 | null | undefined) => !!a && !!b && a.repo === b.repo && a.surfaceRef === b.surfaceRef && a.revision === b.revision;
export const surfaceKey = (target: Pick<TerminalTargetV1, 'repo' | 'surfaceRef'>) => JSON.stringify([target.repo, target.surfaceRef]);
export function validInput(value: unknown): value is TerminalControlInputV1 {
  if (!object(value) || value.version !== 1 || !validTarget(value.target) || !object(value.operation)) return false;
  const op = value.operation;
  return op.kind === 'text' ? typeof op.text === 'string' && typeof op.enter === 'boolean' : op.kind === 'key' ? typeof op.key === 'string' : op.kind === 'action' ? typeof op.action === 'string' : op.kind === 'image' && typeof op.mimeType === 'string' && typeof op.dataBase64 === 'string';
}
export function validReceipt(value: unknown): value is TerminalControlReceiptV1 { return object(value) && value.version === 1 && typeof value.requestId === 'string' && value.requestId.length > 0 && validInput(value.input) && ['succeeded','rejected','pending','recovery-required'].includes(String(value.status)) && (value.reason === null || typeof value.reason === 'string'); }
export function parseDraft(value: unknown): DraftState {
  if (!object(value) || value.version !== 1 || Object.keys(value).some(key => !['version','selected','drafts','collapsed'].includes(key)) || value.selected !== null && !validSurface(value.selected) || !object(value.drafts) || Object.keys(value.drafts).length > 100 || Object.values(value.drafts).some(text => typeof text !== 'string' || text.length > 64_000) || !object(value.collapsed) || Object.keys(value.collapsed).some(key => !['tabs','screen'].includes(key)) || typeof value.collapsed.tabs !== 'boolean' || typeof value.collapsed.screen !== 'boolean') throw new Error('Saved terminal state uses an unsupported format. Its original data is kept.');
  return value as unknown as DraftState;
}
export class TerminalStorage {
  private readonly prefix: string;
  constructor(contributionId: string | undefined, instanceId: string) {
    if (!contributionId || !/^[a-z\d][a-z\d._-]*\/[a-z\d][a-z\d._-]*$/i.test(contributionId) || !instanceId) throw new Error('Terminal storage requires its mounted contribution and instance identity.');
    this.prefix = `helmsman.terminal.v1:${contributionId}:${encodeURIComponent(instanceId)}:`;
  }
  readDraft(): DraftState { const value = this.read('draft'); return value === null ? emptyState() : parseDraft(value); }
  private read(key: string): unknown { const raw = localStorage.getItem(this.prefix + key); if (raw === null) return null; if (raw.length > 3 * 1024 * 1024) throw new Error('Saved terminal evidence exceeds its supported limit. Its original data is kept.'); return JSON.parse(raw); }
  saveDraft(value: DraftState) { this.save('draft', value); }
  private save(key: string, value: unknown) { const raw = JSON.stringify(value); if (raw.length > 3 * 1024 * 1024) throw new Error('Terminal evidence is too large to save.'); localStorage.setItem(this.prefix + key, raw); }
  results(): TerminalControlReceiptV1[] {
    const rows: TerminalControlReceiptV1[] = [];
    for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (key?.startsWith(this.prefix + 'inspected:')) { const inspected = this.read(key.slice(this.prefix.length)); if (!object(inspected) || inspected.version !== 1 || Object.keys(inspected).some(field => !['version','receipt'].includes(field)) || !validReceipt(inspected.receipt) || inspected.receipt.status !== 'recovery-required') throw new Error('Saved terminal inspection evidence uses an unsupported format. Its original data is kept.'); continue; } if (!key?.startsWith(this.prefix + 'result:')) continue; const value = this.read(key.slice(this.prefix.length)); if (!validReceipt(value) || !['succeeded','rejected','recovery-required'].includes(value.status)) throw new Error('Saved terminal results use an unsupported format. Their original data is kept.'); rows.push(value); }
    return rows;
  }
  result(value: TerminalControlReceiptV1) { const key = `result:${value.requestId}:${value.status}`; const previous = this.read(key); if (previous !== null && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('Terminal receipt changed. Original evidence is kept.'); this.save(key, value); }
  inspected(value: TerminalControlReceiptV1) { const key = `inspected:${value.requestId}`; const evidence = { version: 1, receipt: value }; const previous = this.read(key); if (previous !== null && JSON.stringify(previous) !== JSON.stringify(evidence)) throw new Error('Terminal inspection evidence changed. Original data is kept.'); this.save(key, evidence); }
}
export const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
