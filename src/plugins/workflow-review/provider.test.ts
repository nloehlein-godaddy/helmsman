import { describe, expect, it } from 'vitest';
import type { WorkflowPromptInputV1 } from '../workflow';
import { reviewWorkflowProvider } from './provider';
import { renderReviewPrompt } from './prompt';

const headSha = 'b'.repeat(40);

function input(reviewDelegation: WorkflowPromptInputV1['runtime']['reviewDelegation']): WorkflowPromptInputV1 {
  return {
    version: 1,
    runtime: { providerId: 'helmsman.agent-codex/codex', model: null, effort: null, reviewDelegation },
    byline: 'Reviewed by Helmsman',
    clarificationInstructions: 'Use the clarification protocol.',
    task: {
      ticketId: 'TEST-1', title: 'Review task', repo: 'org/repo', jiraBaseUrl: 'https://jira.example.com', review: true,
      prNumber: 42, prBranch: 'feature/test', prHeadSha: headSha,
      reviewOutputPaths: { markdown: '/tmp/review.md', comments: '/tmp/comments.json' },
    },
    stage: null,
  };
}

describe('review workflow', () => {
  it('declares a direct review-only provider without execution access', () => {
    expect(reviewWorkflowProvider().metadata).toEqual({ version: 1, label: 'Pull request review', modes: ['review'], execution: 'direct', requiredSkills: [], maxRounds: 1, stageTimeoutMinutes: 45 });
  });

  it.each([
    ['review-agent-skill', '$review-agent'],
    ['native-subagents', 'runtime’s sub-agent tools'],
    ['none', 'no review delegation support'],
  ] as const)('renders pinned read-only output rules for %s delegation', (mode, expected) => {
    const value = renderReviewPrompt(input(mode));
    expect(value).toContain(headSha);
    expect(value).toContain('/tmp/review.md');
    expect(value).toContain('/tmp/comments.json');
    expect(value).toContain(expected);
    expect(value).toContain('Do not submit a GitHub approval');
    expect(value).toContain('modify code, commit, push, open a pull request, merge, or approve');
  });
});
