import { describe, expect, it, vi } from 'vitest';
import { parseWorkflowFeedbackStageV1, parseWorkflowPromptInputV1, parseWorkflowMetadataV1, type WorkflowPromptInputV1 } from './workflow';
import { boundedWorkflowProvider } from '../../server/helmsman/workflow-providers';
import { branchWorkflowProvider } from './workflow-coding/provider';

const provider = branchWorkflowProvider({ maxRounds: 3, stageTimeoutMinutes: 45 });
const feedback = { stage: 'audit' as const, round: 1, snapshotPath: '/tmp/snapshot.json', reportPath: '/tmp/report.json',
  snapshot: { repo: 'o/r', prNumber: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), fingerprint: 'c'.repeat(64) } };
const prompt: WorkflowPromptInputV1 = { version: 1, runtime: { providerId: 'example.agent/agent', model: null, effort: null, reviewDelegation: 'none' },
  byline: '_Helmsman_', clarificationInstructions: '', task: { ticketId: 'feedback', title: 'Feedback', repo: 'o/r', jiraBaseUrl: '', prBranch: 'feature', prNumber: 1 },
  stage: null, feedback };
const step = { version: 1 as const, repairAttempts: 0, decisionRounds: 0, evidenceChanged: false, outcomes: ['completed' as const] };

describe('feedback workflow contract', () => {
  it('allows feedback only for branch execution and preserves retained direct branch metadata', () => {
    expect(parseWorkflowMetadataV1(provider.metadata)).toMatchObject({ execution: 'direct', feedbackCompletion: true });
    const legacy = { ...provider.metadata, maxRounds: 1 }; delete legacy.feedbackCompletion;
    expect(parseWorkflowMetadataV1(legacy).feedbackCompletion).toBeUndefined();
    for (const modes of [['coding'], ['review'], ['branch', 'review']]) expect(() => parseWorkflowMetadataV1({ ...provider.metadata, modes })).toThrow();
    for (const feedbackCompletion of [false, null, 'true', undefined]) expect(() => parseWorkflowMetadataV1({ ...provider.metadata, feedbackCompletion })).toThrow();
    expect(() => parseWorkflowMetadataV1({ ...provider.metadata, modes: ['coding'], execution: 'staged' })).toThrow();
    expect(() => boundedWorkflowProvider({ ...provider, nextFeedback: undefined })).toThrow('feedback workflow policy');
  });

  it('validates current PR identity and immutable input/output paths before rendering', () => {
    expect(parseWorkflowPromptInputV1(prompt).feedback).toEqual(feedback);
    const renderPrompt = vi.fn(provider.renderPrompt);
    const bounded = boundedWorkflowProvider({ ...provider, renderPrompt });
    for (const input of [
      { ...prompt, task: { ...prompt.task, repo: 'other/repo' } },
      { ...prompt, task: { ...prompt.task, prNumber: 2 } },
      { ...prompt, task: { ...prompt.task, prBranch: undefined } },
      { ...prompt, stage: { stage: 'implement', baseSha: feedback.snapshot.baseSha, reportPath: '/tmp/other' } },
      { ...prompt, feedback: { ...feedback, reportPath: feedback.snapshotPath } },
      { ...prompt, feedback: { ...feedback, decisions: { path: feedback.reportPath, fingerprint: 'd'.repeat(64) } } },
      { ...prompt, feedback: { ...feedback, snapshot: { ...feedback.snapshot, fingerprint: 'invalid' } } },
    ]) expect(() => bounded.renderPrompt(input as never)).toThrow();
    expect(renderPrompt).not.toHaveBeenCalled();
  });

  it.each([
    null, { ...feedback, reportPath: '/tmp/../report' }, { ...feedback, round: 0 }, { ...feedback, round: 11 },
    { ...feedback, stage: 'author' }, { ...feedback, feedbackPath: '/tmp/feedback' }, { ...feedback, reportPath: undefined },
    { ...feedback, decisions: { path: '/tmp/answers', fingerprint: 'invalid' } },
  ])('rejects malformed stage evidence: %j', input => {
    expect(() => parseWorkflowFeedbackStageV1(input)).toThrow();
  });

  it('bounds and freezes policy input and validates returned actions', () => {
    const nextFeedback = vi.fn((input: typeof step) => {
      expect(Object.isFrozen(input)).toBe(true); expect(Object.isFrozen(input.outcomes)).toBe(true);
      return { kind: 'complete' as const };
    });
    const bounded = boundedWorkflowProvider({ ...provider, nextFeedback });
    expect(bounded.nextFeedback?.(step)).toEqual({ kind: 'complete' });
    nextFeedback.mockClear();
    for (const input of [null, { ...step, outcomes: [] }, { ...step, outcomes: Array(9).fill('completed') },
      { ...step, outcomes: ['approved'] }, { ...step, repairAttempts: -1 }, { ...step, decisionRounds: 6 },
      { ...step, evidenceChanged: 1 }, { ...step, credentials: 'secret' }]) expect(() => bounded.nextFeedback?.(input as never)).toThrow();
    expect(nextFeedback).not.toHaveBeenCalled();
    for (const action of [null, { kind: 'publish' }, { kind: 'complete', force: true }, { kind: 'stop', reason: '' }]) {
      expect(() => boundedWorkflowProvider({ ...provider, nextFeedback: () => action as never }).nextFeedback?.(step)).toThrow();
    }
  });

  it('fences feedback policies after cancellation', () => {
    const abort = new AbortController(); const nextFeedback = vi.fn(() => { abort.abort(); return { kind: 'complete' as const }; });
    const bounded = boundedWorkflowProvider({ ...provider, nextFeedback }, abort.signal);
    expect(() => bounded.nextFeedback?.(step)).toThrow();
    expect(() => bounded.nextFeedback?.(step)).toThrow();
    expect(nextFeedback).toHaveBeenCalledOnce();
  });
});
