import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const postRoot = fileURLToPath(new URL('../', import.meta.url));
const preRoot = resolve(process.argv[2] ?? resolve(postRoot, '../helmsman-pre-rewrite'));
const from = (root, path) => import(pathToFileURL(resolve(root, path)).href);
const [{ buildPrompt: pre }, { buildPrompt: legacy }, { buildFeedbackAuditPrompt: audit }, coding, review,
  { clarificationPrompt }, { agentAttribution, appendAgentByline }, { feedbackAuthorContext }] = await Promise.all([
  from(preRoot, 'server/helmsman/agents/prompt.ts'), from(postRoot, 'server/helmsman/agents/prompt.ts'),
  from(preRoot, 'server/helmsman/agents/feedback-audit-prompt.ts'), from(postRoot, 'src/plugins/workflow-coding/prompt.ts'),
  from(postRoot, 'src/plugins/workflow-review/prompt.ts'), from(postRoot, 'server/helmsman/agents/clarification-prompt.ts'),
  from(preRoot, 'server/helmsman/agent-attribution.ts'),
  from(preRoot, 'server/helmsman/agents/feedback-author-context.ts'),
]);
const base = { ticketId: 'TASK-1', title: 'Fix customer workflow', repo: 'example/project', jiraBaseUrl: 'https://jira.example.test',
  modelRouting: 'gocaas', skillsPath: '/pinned', jiraContext: 'Preserve the supported customer workflow.' };
const baseSha = 'a'.repeat(40); const headSha = 'b'.repeat(40);
let failures = 0; let checks = 0;
function check(name, expected, actual) {
  checks++;
  if (expected === actual) { console.log(`PASS ${name}`); return; }
  failures++;
  const before = expected.split('\n'); const after = actual.split('\n');
  const missing = before.filter(line => line && !after.includes(line));
  const added = after.filter(line => line && !before.includes(line));
  console.error(`FAIL ${name}\n${missing.map(line => `PRE: ${line}`).join('\n')}\n${added.map(line => `POST: ${line}`).join('\n')}`);
}
function input(task, runtime, feedback) {
  return { version: 1, runtime: { providerId: runtime === 'codex' ? 'helmsman.agent-codex/codex' : 'helmsman.agent-claude/claude-code',
    model: task.model, effort: task.effort, reviewDelegation: runtime === 'codex' ? 'review-agent-skill' : 'native-subagents' },
    byline: appendAgentByline('', agentAttribution(runtime, task, task.review || task.prePr?.stage === 'review' ? 'review agent' : 'PR author')),
    clarificationInstructions: clarificationPrompt(task), task, stage: task.prePr ?? null, ...(feedback ? { feedback } : {}) };
}
for (const runtime of ['codex', 'claude-code']) {
  const task = { ...base, model: runtime === 'codex' ? 'gpt-6-astra' : 'sonnet', effort: 'medium' };
  for (const [name, extra] of [
    ['implement', { stage: 'implement' }], ['fix', { stage: 'fix', feedback: 'Fix the verified regression.' }],
    ['review', { stage: 'review' }], ['continued-review', { stage: 'review', incompleteReview: { reportPath: '/reports/prior.json', summary: 'Checks need dependencies.' } }],
    ['summary-correction', { stage: 'review', summaryCorrection: { reportPath: '/reports/prior.json', actualLength: 2100 } }],
  ]) {
    const staged = { ...task, prePr: { baseSha, headSha, reportPath: '/reports/result.json', round: 2, ...extra } };
    check(`${runtime}/${name}/plugin`, pre(staged, runtime), coding.renderCodingPrompt(input(staged, runtime)));
    check(`${runtime}/${name}/legacy`, pre(staged, runtime), legacy(staged, runtime));
  }
  const reviewing = { ...task, review: true, prNumber: 42, prBranch: 'topic', prHeadSha: headSha,
    reviewOutputPaths: { markdown: '/reports/review.md', comments: '/reports/comments.json' } };
  check(`${runtime}/PR-review/plugin`, pre(reviewing, runtime), review.renderReviewPrompt(input(reviewing, runtime)));
  check(`${runtime}/PR-review/legacy`, pre(reviewing, runtime), legacy(reviewing, runtime));
  check(`${runtime}/direct-author/legacy`, pre(task, runtime), legacy(task, runtime));
  const branch = { ...task, ticketId: 'rerun', prNumber: 42, prBranch: 'topic', task: 'Address review findings' };
  check(`${runtime}/feedback-author/legacy`, pre(branch, runtime), legacy(branch, runtime));
  const snapshot = { repo: branch.repo, prNumber: 42, baseSha, headSha, fingerprint: 'snapshot-1' };
  const author = { stage: 'author', round: 1, snapshot, snapshotPath: '/reports/snapshot.json', feedbackPath: '/reports/feedback.txt' };
  const context = feedbackAuthorContext(author.snapshotPath, author.feedbackPath, headSha, snapshot.fingerprint);
  const taskLine = `- Address this review feedback: ${branch.task}.`;
  check(`${runtime}/feedback-author/plugin`, pre(branch, runtime).replace(taskLine, `${taskLine}\n${context.join('\n')}`),
    coding.renderBranchPrompt(input(branch, runtime, author)));
  for (const decisions of [undefined, { path: '/reports/decisions.json', fingerprint: 'decision-1' }]) {
    const feedback = { stage: 'audit', snapshot, snapshotPath: '/reports/snapshot.json', reportPath: '/reports/audit.json', ...(decisions ? { decisions } : {}) };
    const before = audit({ ...branch, feedbackAudit: feedback }, feedback.snapshotPath, feedback.reportPath, snapshot, runtime);
    check(`${runtime}/feedback-audit${decisions ? '/decisions' : ''}`, before, coding.renderBranchPrompt(input(branch, runtime, feedback)));
  }
}
check('clarification-protocol/source', await readFile(resolve(preRoot, 'server/helmsman/agents/clarification-prompt.ts'), 'utf8'),
  await readFile(resolve(postRoot, 'server/helmsman/agents/clarification-prompt.ts'), 'utf8'));
console.log(`${checks - failures}/${checks} prompt comparisons passed.`);
if (failures) process.exitCode = 1;
