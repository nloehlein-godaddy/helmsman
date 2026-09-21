import type { PanelOpaqueStateV1, SuggestedContactAdminReceiptV1 } from '@helmsman/plugin-sdk';
import { bounded, fields, identifier, positive, record, text, uuid } from './saved-state.js';
export interface ContactDraft { name: string; address: string; enabled: boolean; }
export interface ContactEdit extends ContactDraft { id: string; expectedRevision: number; }
export interface ContactResult extends ContactDraft { requestId: string; id: string; kind: 'create' | 'update'; status: 'succeeded' | 'rejected'; revision: number | null; reason: string | null; }
export interface ContactState { create: ContactDraft; edits: ContactEdit[]; results: ContactResult[]; }
export const emptyDraft = (): ContactDraft => ({ name: '', address: '', enabled: true });
export const empty = (): ContactState => ({ create: emptyDraft(), edits: [], results: [] });
const draft = (v: unknown): v is Record<string, unknown> & ContactDraft => record(v) && text(v.name, 160) && text(v.address, 320) && typeof v.enabled === 'boolean';
export function readState(input: PanelOpaqueStateV1 | null): ContactState | null {
  if (input === null) return empty(); const value = input.value;
  if (input.version !== 1 || !bounded(input) || !record(value) || !fields(value, ['create', 'edits', 'results']) || !draft(value.create) || !fields(value.create, ['name', 'address', 'enabled'])
    || !Array.isArray(value.edits) || value.edits.length > 64 || !Array.isArray(value.results) || value.results.length > 32) return null;
  const edits: ContactEdit[] = []; const results: ContactResult[] = [];
  for (const edit of value.edits) {
    if (!draft(edit) || !fields(edit, ['id', 'expectedRevision', 'name', 'address', 'enabled']) || !identifier(edit.id) || !positive(edit.expectedRevision) || edits.some(item => item.id === edit.id)) return null;
    edits.push({ id: edit.id, expectedRevision: edit.expectedRevision, name: edit.name, address: edit.address, enabled: edit.enabled });
  }
  for (const result of value.results) {
    if (!draft(result) || !fields(result, ['requestId', 'id', 'kind', 'status', 'name', 'address', 'enabled', 'revision', 'reason']) || !uuid(result.requestId) || !identifier(result.id) || (result.kind !== 'create' && result.kind !== 'update')
      || (result.status !== 'succeeded' && result.status !== 'rejected') || result.revision !== null && !positive(result.revision) || result.reason !== null && !text(result.reason, 128)
      || result.status === 'succeeded' && (result.reason !== null || result.revision === null) || result.status === 'rejected' && (!result.reason || result.revision !== null) || results.some(item => item.requestId === result.requestId)) return null;
    results.push(result as unknown as ContactResult);
  }
  return { create: { name: value.create.name, address: value.create.address, enabled: value.create.enabled }, edits, results };
}
export const resultState = (receipt: SuggestedContactAdminReceiptV1): ContactResult => ({ requestId: receipt.requestId, id: receipt.input.id, kind: receipt.input.kind,
  name: receipt.input.name, address: receipt.input.address, enabled: receipt.input.enabled, status: receipt.status, revision: receipt.result?.revision ?? null, reason: receipt.reason });
