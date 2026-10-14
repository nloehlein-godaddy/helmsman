import { beforeEach, expect, it } from 'vitest';
import { AGENT_PROMPT_LIMITS_V1 } from '@helmsman/plugin-sdk';
import { DraftStorage, maximumTextLength, validSnapshot, validText } from './state';
const storage = () => new DraftStorage('helmsman.agent-prompts/panel', 'editor');
const role = { id: 'coding.implement', label: 'Implementation', description: 'Build', providerLabel: 'Coding workflow', defaultText: 'Built-in', text: 'Built-in', overridden: false };
beforeEach(() => localStorage.clear());
it('keeps the standalone editor limit aligned with the public service contract', () => {
  expect(maximumTextLength).toBe(AGENT_PROMPT_LIMITS_V1.textBytes);
});
it('retains per-role empty drafts and their original revision', () => {
  const saved = { version: 1 as const, selectedRole: role.id, drafts: { [role.id]: { revision: 'a'.repeat(64), text: '' }, 'coding.fix': { revision: 'b'.repeat(64), text: null } } };
  storage().save(saved); expect(storage().read()).toEqual(saved); expect(validText('')).toBe(false);
});
it('validates UTF8 byte limits and control characters while allowing multiline instructions', () => {
  expect(validText('Review\n\t carefully')).toBe(true); expect(validText('é'.repeat(2049))).toBe(false); expect(validText('work\u0001')).toBe(false); expect(validText('   ')).toBe(false);
});
it('rejects mismatched defaults, duplicate roles, and malformed snapshots', () => {
  expect(validSnapshot({ version: 1, revision: 'a'.repeat(64), roles: [role] })).toBe(true);
  expect(validSnapshot({ version: 1, revision: 'a'.repeat(64), roles: [role, role] })).toBe(false);
  expect(validSnapshot({ version: 1, revision: 'a'.repeat(64), roles: [{ ...role, text: 'different' }] })).toBe(false);
  expect(validSnapshot(null)).toBe(false);
});
it('does not overwrite unsupported saved drafts', () => {
  const key = 'helmsman.agent-prompts.v1:helmsman.agent-prompts/panel:editor:draft';
  localStorage.setItem(key, '{"version":2,"future":true}'); expect(() => storage().read()).toThrow('unsupported format'); expect(localStorage.getItem(key)).toBe('{"version":2,"future":true}');
});
