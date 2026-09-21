import type { ClarificationCommandReceiptV1 } from '@helmsman/plugin-sdk';
import type { SuggestedContactAdminReceiptV1 } from '@helmsman/plugin-sdk';
import { clarificationObject, clarificationFields, clarificationBoolean, clarificationId, clarificationUuid, invalidClarification, parseRepo, contributionIdentity } from './validation.js';

export interface ClarificationContactDraft { name: string; address: string; enabled: boolean; }
export interface ClarificationDraftState {
  version: 1; answers: Record<string, string>; contact: ClarificationContactDraft;
  results: { requestId: string; repo: string | null; message: string }[];
}
export interface ClarificationDraftStore {
  read(): ClarificationDraftState;
  answer(key: string, text: string): void;
  contact(draft: ClarificationContactDraft): void;
  accept(receipt: ClarificationCommandReceiptV1 | SuggestedContactAdminReceiptV1, message: string): void;
  removeAnswer(key: string, expected: string | undefined): void;
  removeContact(expected: ClarificationContactDraft): void;
  removeResult(requestId: string): void;
}
export function clarificationDraftKey(item: { repo: string; runId: string; id: string }): string { return JSON.stringify([item.repo, item.runId, item.id]); }
export function emptyClarificationDrafts(): ClarificationDraftState { return { version: 1, answers: {}, contact: { name: '', address: '', enabled: true }, results: [] }; }
function text(value: unknown, maximum: number): string { if (typeof value !== 'string' || value.length > maximum) invalidClarification(); return value; }
function answerIdentity(key: string): string {
  const identity: unknown = JSON.parse(key);
  if (!Array.isArray(identity) || identity.length !== 3 || JSON.stringify([parseRepo(identity[0]), clarificationId(identity[1]), clarificationId(identity[2])]) !== key) invalidClarification(); return key;
}
function contact(value: unknown): ClarificationContactDraft {
  const c = clarificationObject(value); clarificationFields(c, ['name', 'address', 'enabled']);
  return { name: text(c.name, 160), address: text(c.address, 320), enabled: clarificationBoolean(c.enabled) };
}
export function createClarificationDraftStore(contributionId: string, storage?: Storage): ClarificationDraftStore {
  const identity = contributionIdentity(contributionId);
  const prefix = identity === 'helmsman.compat-clarifications/page' ? 'helmsman.compat-clarifications.drafts.v2:' : `helmsman.clarification-recovery.drafts.v2:${identity}:`;
  const store = () => storage ?? localStorage;
  function keys(): string[] {
    const source = store(); const keys: string[] = [];
    for (let index = 0; index < source.length; index++) { const key = source.key(index); if (key?.startsWith(prefix)) keys.push(key); }
    if (keys.length > 1024) throw new Error('Too many saved clarification drafts and results'); return keys.sort();
  }
  function read(): ClarificationDraftState {
    const state = emptyClarificationDrafts(); let bytes = 0;
    for (const key of keys()) {
      const raw = store().getItem(key); if (raw === null) continue; bytes += new TextEncoder().encode(raw).byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error('Saved clarification state exceeds its bound');
      const value: unknown = JSON.parse(raw); const suffix = key.slice(prefix.length);
      if (suffix.startsWith('answer:')) state.answers[answerIdentity(suffix.slice(7))] = text(value, 4000);
      else if (suffix === 'contact') state.contact = contact(value);
      else if (suffix.startsWith('result:')) {
        const r = clarificationObject(value); clarificationFields(r, ['requestId', 'repo', 'message']);
        const requestId = clarificationUuid(r.requestId); if (requestId !== suffix.slice(7)) invalidClarification();
        state.results.push({ requestId, repo: r.repo === null ? null : parseRepo(r.repo), message: text(r.message, 512) });
      } else invalidClarification();
    }
    return state;
  }
  function write(key: string, value: unknown): void {
    const source = store(); const existing = source.getItem(key); const retained = keys(); const encoded = JSON.stringify(value);
    if (existing === null && retained.length >= 1024) throw new Error('Saved clarification state is full');
    let bytes = new TextEncoder().encode(encoded).byteLength;
    for (const retainedKey of retained) if (retainedKey !== key) { bytes += new TextEncoder().encode(source.getItem(retainedKey) ?? '').byteLength; if (bytes > 8 * 1024 * 1024) throw new Error('Saved clarification state exceeds its bound'); }
    source.setItem(key, encoded);
  }
  return {
    read,
    answer(identity, value) { write(`${prefix}answer:${answerIdentity(identity)}`, text(value, 4000)); },
    contact(value) { write(`${prefix}contact`, contact(value)); },
    removeAnswer(identity, expected) {
      const source = store(); const key = `${prefix}answer:${answerIdentity(identity)}`;
      if (source.getItem(key) !== (expected === undefined ? null : JSON.stringify(text(expected, 4000)))) throw new Error('Saved draft changed; refresh before discarding it');
      source.removeItem(key);
    },
    removeContact(expected) {
      const source = store(); const key = `${prefix}contact`; const raw = source.getItem(key);
      const current = raw === null ? emptyClarificationDrafts().contact : contact(JSON.parse(raw));
      if (JSON.stringify(current) !== JSON.stringify(contact(expected))) throw new Error('Saved draft changed; refresh before discarding it');
      source.removeItem(key);
    },
    removeResult(requestId) { store().removeItem(`${prefix}result:${clarificationUuid(requestId)}`); },
    accept(receipt, message) {
      const result = { requestId: clarificationUuid(receipt.requestId), repo: 'repo' in receipt.input ? parseRepo(receipt.input.repo) : null, message: text(message, 512) };
      const key = `${prefix}result:${result.requestId}`; const previous = store().getItem(key);
      if (previous !== null && previous !== JSON.stringify(result)) throw new Error('Saved clarification result changed');
      write(key, result);
    },
  };
}
