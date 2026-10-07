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
    ['native-subagents', "runtime's sub-agent tools"],
    ['none', 'no review delegation support'],
  ] as const)('renders pinned read-only output rules for %s delegation', (mode, expected) => {
    const value = renderReviewPrompt(input(mode));
    expect(value).toContain('perfection is not the acceptance bar');
    expect(value).toContain('why a narrower fix is insufficient');
    expect(value).toContain('must not change an otherwise APPROVE verdict to COMMENT or REQUEST_CHANGES');
    expect(value).toContain('Pass these scope and calibration rules to every review sub-agent');
    expect(value).toContain('Put only blocking material defects in inline findings');
    expect(value).toContain('observable acceptance property and Non-goals');
    expect(value).toContain('missing prose alone is not a blocker');
    expect(value).toContain('Existing regression tests do not establish that their invariant is required');
    expect(value).toContain('input-pattern counters alone do not establish safety');
    expect(value).toContain('do not lower the required review or acceptance bar to end the loop');
    expect(value).toContain(headSha);
    expect(value).toContain('/tmp/review.md');
    expect(value).toContain('/tmp/comments.json');
    expect(value).toContain(expected);
    expect(value).toContain('do not submit a GitHub approval');
    expect(value).toContain('modify code, commit, push, open a pull request, merge, or approve');
  });
});


it.each(['review-agent-skill', 'native-subagents'] as const)('preserves the complete evidence and publication contract for %s reviews', mode => {
  const value = renderReviewPrompt(input(mode));
  for (const required of [
    'Read existing PR comments, submitted reviews, and inline threads once',
    'Cite the actual requirement for acceptance-criteria claims',
    'If criteria are inaccessible, say so briefly; do not invent them',
    'A source trace can be sufficient proof; do not demand a reproduction',
    'Each sub-agent returns concise evidence-backed candidates or No findings; it does not set the final verdict',
    'do not clone unrelated repos merely to satisfy a review checklist',
    'reference its original thread once in the summary without reposting the finding',
    'at most two short validation/limitation bullets',
    'Output files must be written; stdout is not used as the review',
    'Keep the reason to 120 characters or fewer on that same line',
    'positive file line number, not diff position',
    'RIGHT for new/context lines or LEFT for deleted lines',
    'both ends must be on the same side and in the same diff hunk',
    'Do not invent missing APIs or offer speculative fixes',
    'Keep it as the final line and do not duplicate it',
    'outside any code or suggestion fence',
  ]) expect(value).toContain(required);
  expect(value).not.toContain('## Respond to every finding on GitHub');
});
