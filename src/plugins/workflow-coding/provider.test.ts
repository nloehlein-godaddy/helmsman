import { describe, expect, it } from 'vitest';
import type { WorkflowPromptInputV1, WorkflowReviewReportV1, WorkflowStepInputV1 } from '../workflow';
import { codingNext, codingWorkflowProvider, branchWorkflowProvider } from './provider';
import { renderBranchPrompt, renderCodingPrompt } from './prompt';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const writerId = 'helmsman.agent-codex/codex';
const alternateId = 'helmsman.agent-claude/claude-code';
const approved: WorkflowReviewReportV1 = { baseSha, headSha, verdict: 'APPROVE', summary: 'Complete.', findings: [] };
const changes: WorkflowReviewReportV1 = { baseSha, headSha, verdict: 'REQUEST_CHANGES', summary: 'Defect.', findings: [{ title: 'Broken path', body: 'Fails for valid input.' }] };
const comment: WorkflowReviewReportV1 = { baseSha, headSha, verdict: 'COMMENT', summary: 'Review unavailable.', findings: [] };

function step(changes: Partial<WorkflowStepInputV1> = {}): WorkflowStepInputV1 {
  return {
    version: 1,
    writerId,
    reviewerIds: [writerId, alternateId],
    round: 0,
    maxRounds: 3,
    implemented: false,
    revision: { baseSha, headSha: baseSha, branch: 'agent/test' },
    reviews: [],
    ...changes,
  };
}

function prompt(stage: WorkflowPromptInputV1['stage']): WorkflowPromptInputV1 {
  return {
    version: 1,
    runtime: { providerId: writerId, model: null, effort: null, reviewDelegation: 'native-subagents' },
    byline: 'Authored by Helmsman',
    clarificationInstructions: 'Use the clarification protocol.',
    task: { ticketId: 'TEST-1', title: 'Implement task', repo: 'org/repo', jiraBaseUrl: 'https://jira.example.com', skillsPath: '/tmp/skills' },
    stage,
  };
}

describe('coding workflow policy', () => {
  it('requires implementation, every selected reviewer, remediation, fresh reviews, then publication', () => {
    expect(codingNext(step())).toEqual({ kind: 'author', stage: 'implement' });
    const implemented = step({ implemented: true, round: 1, revision: { baseSha, headSha, branch: 'agent/test' } });
    expect(codingNext(implemented)).toEqual({ kind: 'review', reviewerId: writerId });
    expect(codingNext(step({ ...implemented, reviews: [{ reviewer: writerId, report: changes }] }))).toEqual({ kind: 'review', reviewerId: alternateId });
    expect(codingNext(step({ ...implemented, reviews: [{ reviewer: writerId, report: changes }, { reviewer: alternateId, report: approved }] }))).toEqual({ kind: 'author', stage: 'fix' });
    const repaired = step({ ...implemented, round: 2, reviews: [{ reviewer: writerId, report: approved }, { reviewer: alternateId, report: approved }] });
    expect(codingNext(repaired)).toEqual({ kind: 'publish' });
  });

  it('publishes completed approvals with non-blocking summary notes without a fix round', () => {
    const report = { ...approved, summary: 'Non-blocking: a rare low-impact case can be handled in a follow-up.' };
    expect(codingNext(step({ implemented: true, round: 1, revision: { baseSha, headSha, branch: 'agent/test' },
      reviews: [{ reviewer: writerId, report }, { reviewer: alternateId, report }] }))).toEqual({ kind: 'publish' });
  });

  it('stops on incomplete review and unresolved final-round findings', () => {
    const implemented = { implemented: true, round: 3, revision: { baseSha, headSha, branch: 'agent/test' } } as const;
    expect(codingNext(step({ ...implemented, reviews: [{ reviewer: writerId, report: comment }] }))).toMatchObject({ kind: 'stop', reason: expect.stringContaining('Review unavailable') });
    expect(codingNext(step({ ...implemented, reviews: [{ reviewer: writerId, report: changes }, { reviewer: alternateId, report: approved }] }))).toEqual({ kind: 'stop', reason: 'Unresolved material findings after 3 review rounds' });
  });

  it('declares retained staged and direct metadata', () => {
    expect(codingWorkflowProvider({ maxRounds: 4, stageTimeoutMinutes: 60 }).metadata).toEqual({ version: 1, label: 'Coding', modes: ['coding'], execution: 'staged', requiredSkills: [], maxRounds: 4, stageTimeoutMinutes: 60 });
    expect(branchWorkflowProvider({ stageTimeoutMinutes: 30 }).metadata).toEqual({ version: 1, label: 'Branch update', modes: ['branch'], execution: 'direct', requiredSkills: [], maxRounds: 1, stageTimeoutMinutes: 30 });
  });
});

describe('coding workflow prompts', () => {
  it('keeps implementation and remediation committed but unpublished', () => {
    const implement = renderCodingPrompt(prompt({ stage: 'implement', baseSha, reportPath: '/tmp/pr.json', round: 0 }));
    const fix = renderCodingPrompt(prompt({ stage: 'fix', baseSha, headSha, reportPath: '/tmp/pr.json', round: 1, feedback: 'Repair this defect.' }));
    for (const value of [implement, fix]) {
      expect(value).toContain('commit');
      expect(value).toContain('NEVER push, open a PR');
      expect(value).toContain('/tmp/pr.json');
    }
    expect(fix).toContain('Non-blocking observations and optional follow-ups are not required repairs');
    expect(fix).toContain('Repair this defect.');
  });

  it('pins independent review and narrows summary correction to the summary', () => {
    const review = renderCodingPrompt(prompt({ stage: 'review', baseSha, headSha, reportPath: '/tmp/review.json', round: 1 }));
    expect(review).toContain('The goal is not perfection');
    expect(review).toContain('why a narrower fix is insufficient');
    expect(review).toContain('Non-blocking observations alone must not cause REQUEST_CHANGES or COMMENT');
    expect(review).toContain('Pass these scope and non-blocking rules to every review sub-agent');
    expect(review).toContain('APPROVE must use findings: []');
    expect(review).toContain(`${baseSha}..${headSha}`);
    expect(review).toContain('read-only leaf workers');
    expect(review).toContain('Do not modify code, commit, push, open a PR');
    const correction = renderCodingPrompt(prompt({ stage: 'review', baseSha, headSha, reportPath: '/tmp/corrected.json', round: 1, summaryCorrection: { reportPath: '/tmp/review.json', actualLength: 2100 } }));
    expect(correction).toContain('Only shorten the summary');
    expect(correction).toContain('Preserve baseSha, headSha, verdict, and findings exactly');
  });

  it('keeps branch work on the same pull-request branch', () => {
    const input = prompt(null);
    const value = renderBranchPrompt({ ...input, task: { ...input.task, task: 'Resolve feedback', prBranch: 'feature/test', prNumber: 42 } });
    expect(value).toContain('Same branch only');
    expect(value).toContain('do NOT open a new pull request');
  });
});

it('renders an interrupted review with bounded verification permissions and unchanged prior evidence', () => {
  const incompleteReview = { reportPath: '/tmp/original.json', summary: 'Dependencies unavailable' };
  const rendered = renderCodingPrompt(prompt({ stage: 'review', baseSha, headSha, reportPath: '/tmp/resumed.json', round: 1, incompleteReview }));
  expect(rendered).toContain('explicit continuation of a COMMENT review');
  expect(rendered).toContain(JSON.stringify(incompleteReview.reportPath));
  expect(rendered).toContain('use the pinned lockfile');
  expect(rendered).toContain('git-ignored dependency/build/cache files');
  expect(rendered).toContain('retain COMMENT');
  expect(rendered).not.toContain('This is the only file you may write.');
});


it.each(['implement', 'fix'] as const)('keeps %s review within Helmsman without external AI requests', stage => {
  const rendered = renderCodingPrompt(prompt({ stage, baseSha, reportPath: '/tmp/metadata.json' }));
  expect(rendered).toContain('Helmsman owns the independent review stages');
  expect(rendered).toContain('Do not request GitHub Copilot or other external AI reviewers');
});
