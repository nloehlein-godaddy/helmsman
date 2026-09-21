import type { WorkflowPromptInputV1 } from '@helmsman/plugin-sdk';

function delegation(input: WorkflowPromptInputV1): string[] {
  if (input.runtime.reviewDelegation === 'review-agent-skill') return [
    '- Every review sub-agent must explicitly use $review-agent. Read its installed SKILL.md, include `Use $review-agent` in each delegated task, and keep reviewers as read-only leaf workers.',
    '- If $review-agent or sub-agent tools are unavailable, report that limitation and use COMMENT rather than claiming the required review completed.',
  ];
  if (input.runtime.reviewDelegation === 'none') return [
    '- This provider declares no review delegation support. Disclose that limitation and use COMMENT. Do not claim independent review completed.',
  ];
  return [
    '- Use this runtime’s sub-agent tools. Review sub-agents are read-only leaf workers: they do not delegate further, edit files, or publish. If delegation is unavailable, use COMMENT.',
  ];
}

export function renderReviewPrompt(input: WorkflowPromptInputV1): string {
  if (input.stage) throw new Error('Direct review workflow does not accept a guarded stage');
  if (!input.task.review || !input.task.prNumber || !input.task.prHeadSha && !input.task.prBranch) throw new Error('Review workflow requires a pinned pull request');
  const markdown = input.task.reviewOutputPaths?.markdown ?? '.agent-review.md';
  const comments = input.task.reviewOutputPaths?.comments ?? '.agent-review-comments.json';
  return [
    `# Code-review PR #${input.task.prNumber} (${input.task.prBranch ? `branch ${input.task.prBranch}` : `revision ${input.task.prHeadSha}`})`,
    'Working dir = the repo checkout. Fully unattended: do not pause for confirmation; use the clarification protocol when a required human decision blocks safe progress.',
    input.clarificationInstructions,
    ...(input.task.skillsPath ? [`- Use only the pinned skills under ${JSON.stringify(`${input.task.skillsPath}/skills`)}. Do not use or install global skill copies.`] : []),
    '',
    '## Review scope',
    `- End every review summary, inline comment, and reply with this exact standalone byline, outside code or suggestion fences: ${JSON.stringify(input.byline)}. This does not grant permission to publish.`,
    ...(input.task.prHeadSha ? [`- Review the pinned revision ${input.task.prHeadSha}. Do not check out or switch to another revision.`] : []),
    '- Read the PR description and linked acceptance criteria. Review the complete diff and trace changed callers or external effects only as needed to establish a concrete defect. Do not expand into a general repository audit.',
    `- Read existing PR comments and inline threads once with the GitHub CLI/API. Share that context with sub-agents. Do not re-post existing findings or recap resolved, waived, or deferred issues.`,
    '',
    '## Adversarial review',
    '- Act as an independent adversarial reviewer, including when another Helmsman agent authored the PR. Treat explanations, tests, and claimed success as hypotheses to verify. Try to falsify core claims using realistic supported inputs and explicit acceptance criteria.',
    '- Challenge failure paths, state transitions, boundaries, concurrency, and external effects. Seek counterevidence before reporting. Adversarial review has no finding quota; APPROVE is correct when the change withstands scrutiny.',
    '',
    '## Material findings only',
    '- REQUEST_CHANGES requires an evidenced material problem introduced or newly exposed by this PR: an obvious logic flaw, consequential integration defect, or missed explicit acceptance criterion. Establish trigger, changed path, expected versus actual behavior, and consequence.',
    '- Omit style preferences, speculative hardening, unsupported hypothetical inputs, refactor wishes, minor visual polish, and standalone missing tests/docs/logs/types. Test gaps matter only when they expose a demonstrated defect or miss an explicit material requirement.',
    '- Repository instructions and skills inform verification; their hygiene checklists do not make every improvement a blocker.',
    '',
    '## Focused sub-agents',
    '- Act as review lead. Delegate bounded applicable areas: logic/state/structure; acceptance criteria and relevant tests; changed UX/accessibility; external API, persistence, flags, and side effects. Give each the pinned revision, shared PR context, and materiality rules. Skip unaffected areas.',
    ...delegation(input),
    '- Run independent scopes concurrently within available slots without duplicate searches. Use low effort by default and higher effort only when scope warrants it. No recursive fan-out.',
    '- Reconcile results yourself: reject unsupported or low-impact candidates, verify material claims, deduplicate by root cause and existing discussion, and decide the verdict. Never request changes solely because tests could not run.',
    '',
    '## Required output',
    `- Write a concise GitHub-flavored Markdown summary to ${JSON.stringify(markdown)}. Start with exactly \`Verdict: APPROVE — short reason\`, \`Verdict: REQUEST_CHANGES — short reason\`, or \`Verdict: COMMENT — short reason\`.`,
    '- Choose APPROVE when the complete review has no remaining material issues. Choose REQUEST_CHANGES only for a verified material issue. Choose COMMENT for a material unresolved question or incomplete required review.',
    `- Write inline findings to ${JSON.stringify(comments)} as a JSON array, or [] when none. Each item has path, line, side, and body; optional ranges use start_line and start_side. Verify every anchor against the reviewed revision.`,
    '- Prefer one concise inline comment per root cause with trigger, failure, consequence, and a reliable fix. Use suggestion fences only for exact applicable replacements.',
    '- Helmsman publishes the recommendation as a COMMENT review. Do not submit a GitHub approval, request-changes review, or comment yourself.',
    '',
    '## Do NOT',
    '- modify code, commit, push, open a pull request, merge, or approve. Produce only the two review output files.',
  ].join('\n');
}
