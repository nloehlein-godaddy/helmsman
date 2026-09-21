import { describe, expect, it } from 'vitest';
import { emptyDraft, launchInput, readState, saveValue } from './state';

const repo = 'owner/project';
describe('New Run draft contract', () => {
  it('round trips independent galleon drafts without changing their inputs', () => {
    const value = { selectedRepo: repo, drafts: [{ repo, draft: { ...emptyDraft(), task: 'Implement\nwith tests' } },
      { repo: 'owner/other', draft: { ...emptyDraft(), mode: 'review' as const, prNumber: '24' } }] };
    expect(readState(saveValue(value))).toEqual(value);
  });
  it('keeps unknown and malformed saved versions unavailable instead of dropping them', () => {
    expect(readState({ version: 2, value: { newer: true } })).toBeNull();
    expect(readState({ version: 1, value: { selectedRepo: null, drafts: [{ repo, draft: null }] } })).toBeNull();
    expect(readState({ version: 1, value: { selectedRepo: '../repo', drafts: [] } })).toBeNull();
  });
  it('enforces the aggregate state byte limit without truncating draft text', () => {
    const draft = { ...emptyDraft(), task: '界'.repeat(6000) }; const value = { selectedRepo: repo, drafts: [{ repo, draft }] };
    expect(() => saveValue(value)).toThrow('16 KiB'); expect(draft.task).toHaveLength(6000);
  });
  it.each(['0', '-1', '1.2', '01', '1x', '9007199254740992'])('rejects invalid PR number %s', prNumber => {
    expect(() => launchInput(repo, { ...emptyDraft(), mode: 'review', prNumber })).toThrow('positive PR');
  });
  it('requires canonical source identity instead of interpreting display keys', () => {
    expect(() => launchInput(repo, { ...emptyDraft(), mode: 'source' })).toThrow('source and a task');
    expect(() => launchInput(repo, { ...emptyDraft(), mode: 'source', source: { version: 1, sourceId: 'source', instanceId: 'one', instanceRevision: 1, repo }, ref: { sourceId: 'other', externalId: 'ISSUE-1' } })).toThrow();
  });
  it('validates task and tuning while preserving explicit instructions', () => {
    expect(() => launchInput(repo, emptyDraft())).toThrow('instructions');
    expect(() => launchInput(repo, { ...emptyDraft(), task: 'Do it', model: '--command' })).toThrow('model');
    expect(() => launchInput(repo, { ...emptyDraft(), task: 'Do it', effort: 'invented' })).toThrow('model');
    expect(launchInput(repo, { ...emptyDraft(), task: 'Do it', model: 'gpt-6-astra', effort: 'high' })).toMatchObject({ repo, launch: { task: 'Do it', model: 'gpt-6-astra', effort: 'high' } });
  });
});
