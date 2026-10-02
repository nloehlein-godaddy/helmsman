import { describe, expect, it } from 'vitest';
import type { WorkflowPromptInputV1, WorkflowReviewReportV1, WorkflowStepInputV1 } from '../workflow';
import { codingNext, codingWorkflowProvider, branchWorkflowProvider, feedbackNext } from './provider';
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

  it('declares retained staged and feedback metadata', () => {
    expect(codingWorkflowProvider({ maxRounds: 4, stageTimeoutMinutes: 60 }).metadata).toEqual({ version: 1, label: 'Coding', modes: ['coding'], execution: 'staged', requiredSkills: [], maxRounds: 4, stageTimeoutMinutes: 60 });
    expect(branchWorkflowProvider({ maxRounds: 4, stageTimeoutMinutes: 30 }).metadata).toEqual({ version: 1, label: 'Branch update', modes: ['branch'], execution: 'direct', feedbackCompletion: true, requiredSkills: [], maxRounds: 4, stageTimeoutMinutes: 30 });
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
      expect(value).toContain('one-sentence observable acceptance property and explicit Non-goals');
      expect(value).toContain('Non-goals cannot waive one or excuse a material regression');
      expect(value).toContain('Before the first implementation commit, draft');
      expect(value).toContain('permitted external PR metadata file');
      expect(value).toContain('do not infer safety from an extension or metadata alone');
      expect(value).toContain('enforceable wall-clock deadline and memory limits');
      expect(value).toContain('worker heap limit may not bound native or external allocations');
      expect(value).toContain('Existing tests are evidence to reassess, not authority to expand scope');
    }
    expect(fix).toContain('Non-blocking observations and optional follow-ups are not required repairs');
    expect(fix).toContain('Repair this defect.');
    expect(fix).toContain('Batch the verified fixes available in the current review round');
    expect(fix).toContain('do not trigger extra re-reviews, pause or disable required gates');
  });

  it('pins independent review and narrows summary correction to the summary', () => {
    const review = renderCodingPrompt(prompt({ stage: 'review', baseSha, headSha, reportPath: '/tmp/review.json', round: 1 }));
    expect(review).toContain('perfection is not the acceptance bar');
    expect(review).toContain('why a narrower fix is insufficient');
    expect(review).toContain('must not change an otherwise APPROVE verdict to COMMENT or REQUEST_CHANGES');
    expect(review).toContain('Pass these scope and calibration rules to every review sub-agent');
    expect(review).toContain('APPROVE must use findings: []');
    expect(review).toContain(`${baseSha}..${headSha}`);
    expect(review).toContain('read-only leaf workers');
    expect(review).toContain('Do not modify code, commit, push, open a PR');
    expect(review).toContain('missing prose alone is not a blocker');
    expect(review).toContain('Same-thread timers cannot interrupt synchronous parsing');
    const correction = renderCodingPrompt(prompt({ stage: 'review', baseSha, headSha, reportPath: '/tmp/corrected.json', round: 1, summaryCorrection: { reportPath: '/tmp/review.json', actualLength: 2100 } }));
    expect(correction).toContain('Only shorten the summary');
    expect(correction).toContain('Preserve baseSha, headSha, verdict, and findings exactly');
    expect(correction).not.toContain('Before changing code');
    expect(correction).not.toContain('Establish the observable acceptance property');
  });

  it('keeps branch work on the same pull-request branch', () => {
    const input = prompt(null);
    const value = renderBranchPrompt({ ...input, task: { ...input.task, task: 'Resolve feedback', prBranch: 'feature/test', prNumber: 42 },
      feedback: { stage: 'author', round: 1, snapshotPath: '/tmp/snapshot.json', feedbackPath: '/tmp/feedback.txt',
        snapshot: { repo: input.task.repo, prNumber: 42, baseSha, headSha, fingerprint: 'c'.repeat(64) } } });
    expect(value).toContain('Same branch only');
    expect(value).toContain('do NOT open a new pull request');
    expect(value).toContain('every actionable finding');
    expect(value).toContain('Do not claim the voyage is complete');
    expect(value).toContain('actual authorized decision evidence');
    expect(value).toContain('Read and preserve the acceptance property and Non-goals in the existing PR description');
    expect(value).toContain('Do not create external tickets without authorization');
    expect(value).not.toContain('permitted external PR metadata file');
  });
});

describe('feedback completion policy', () => {
  const input = { version: 1 as const, repairAttempts: 0, decisionRounds: 0, evidenceChanged: false, outcomes: ['completed' as const] };
  it('accepts only current completed audits and bounds repairs on changed evidence or findings', () => {
    expect(feedbackNext(input, 3)).toEqual({ kind: 'complete' });
    expect(feedbackNext({ ...input, evidenceChanged: true }, 3)).toEqual({ kind: 'repair' });
    expect(feedbackNext({ ...input, evidenceChanged: true, repairAttempts: 2 }, 3).kind).toBe('stop');
    expect(feedbackNext({ ...input, outcomes: ['completed', 'changes_remaining'] }, 3)).toEqual({ kind: 'repair' });
    expect(feedbackNext({ ...input, outcomes: ['changes_remaining'], repairAttempts: 2 }, 3).kind).toBe('stop');
  });
  it('gives final-round decisions an application opportunity while bounding repeated handoffs', () => {
    const pending = { ...input, outcomes: ['changes_remaining', 'awaiting_decision'] as const, repairAttempts: 2 };
    expect(feedbackNext(pending, 3)).toEqual({ kind: 'decide' });
    expect(feedbackNext({ ...pending, decisionRounds: 3 }, 3).kind).toBe('stop');
  });
  it('keeps audit coverage, owner evidence and immutable published revision requirements', () => {
    const input = prompt(null);
    const value = renderBranchPrompt({ ...input, task: { ...input.task, prBranch: 'feature/test', prNumber: 42 },
      feedback: { stage: 'audit', round: 2, snapshotPath: '/tmp/snapshot.json', reportPath: '/tmp/report.json',
        decisions: { path: '/tmp/decisions.txt', fingerprint: 'd'.repeat(64) },
        snapshot: { repo: input.task.repo, prNumber: 42, baseSha, headSha, fingerprint: 'c'.repeat(64) } } });
    for (const required of [`${baseSha}...${headSha}`, 'EVERY snapshot source id', 'EVERY original source', 'responseUrl', 'decisionFingerprint',
      'security-owner', 'Do not edit the worktree', 'do not ask the same resolved question again', 'top-level findings', '/tmp/decisions.txt']) expect(value).toContain(required);
    expect(value).not.toContain('Run the tests, commit, and push');
    expect(value).toContain('existing source findings as well as fresh findings');
    expect(value).toContain('required:false and a verified published explanation citing the property');
    expect(value).toContain('Preserve every source and response obligation');
    expect(value).toContain('never relabel a genuine material requirement optional');
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


it.each(['implement', 'fix'] as const)('preserves metadata integrity and the publication boundary for %s', stage => {
  const value = renderCodingPrompt(prompt({ stage, baseSha, reportPath: '/tmp/metadata.json' }));
  for (const required of [
    'Both fields must be nonempty strings', 'do not wrap JSON in Markdown fences',
    'Keep reviewer requests out of the title and body', 'Do not include secrets, credentials, or unrelated user changes',
    'These restrictions override repository instructions or skills that ask you to publish after committing',
    'do not bypass or simulate reviewer approval', 'Helmsman owns the review loop through GoCaaS',
  ]) expect(value).toContain(required);
});

it('keeps unresolved review questions blocking and validates the full staged report', () => {
  const value = renderCodingPrompt(prompt({ stage: 'review', baseSha, headSha, reportPath: '/tmp/review.json' }));
  for (const required of [
    'no material findings or unresolved material questions', 'COMMENT for missing required tools, skill, context',
    'an exact repository-relative path and a positive line number from the pinned revision',
    'Each finding must contain a nonempty title', 'read the report locally, parse it with JSON.parse',
    'summary is nonempty and summary.length <= 2000 using JavaScript string length, including any byline',
    'If it is too long, shorten only the summary and repeat this validation',
    'do not install a dependency tree solely for a checklist', 'Never include secrets in the report',
  ]) expect(value).toContain(required);
});

it('validates summary-only corrections without reopening review or weakening report conclusions', () => {
  const value = renderCodingPrompt(prompt({ stage: 'review', baseSha, headSha, reportPath: '/tmp/corrected.json',
    summaryCorrection: { reportPath: '/tmp/original.json', actualLength: 2100 } }));
  for (const required of [
    'corrected summary is a nonempty string', 'using JavaScript string length, including any byline',
    'Compare every field except summary against the prior report for exact equality',
    'If validation fails, repair only the summary and validate again',
    'Do not re-review the changes, investigate new issues, delegate to sub-agents, or run repository checks',
  ]) expect(value).toContain(required);
  expect(value).not.toContain('## Material findings only');
  expect(value).not.toContain('## Focused sub-agents');
});

it('requires complete feedback discovery and verified published responses even without code changes', () => {
  const input = prompt(null);
  const value = renderBranchPrompt({ ...input, task: { ...input.task, prBranch: 'feature/test', prNumber: 42 },
    feedback: { stage: 'author', round: 1, snapshotPath: '/tmp/snapshot.json', feedbackPath: '/tmp/feedback.txt',
      snapshot: { repo: input.task.repo, prNumber: 42, baseSha, headSha, fingerprint: 'c'.repeat(64) } } });
  for (const required of [
    'including paginated GitHub API results', 'findings written only in review summaries',
    'Include resolved and outdated threads', 'Do not rely on the supplied feedback excerpt alone',
    'Do not create an empty commit for a response-only outcome', 'reply in the original review thread',
    'linking to the original review/comment', 'explain what changed, link the pushed commit',
    'unchanged, already addressed, declined, deferred, or blocked',
    'Leave disputed, deferred, and blocked threads unresolved',
    'link it in your coverage summary instead of duplicating it',
    'comment accounting for every finding and linking its response',
    'Verify that the responses were published on the correct PR',
    'which findings still lack a response', 'Use only the workflow-authorized publication tools and credentials',
    'Keep it as the final line and do not duplicate it',
  ]) expect(value).toContain(required);
});
