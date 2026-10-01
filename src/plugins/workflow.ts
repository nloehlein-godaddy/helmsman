import type { PluginJson } from './backend';
import { isContributionId } from './source-contract-validation';
import { sourceFields, sourceJson, sourceObject, sourceText } from './source-contract-validation';
import { parseTaskRepo } from './tasks';

export type WorkflowModeV1 = 'coding' | 'review' | 'branch';
export interface WorkflowMetadataV1 {
  readonly version: 1; readonly label: string; readonly modes: readonly WorkflowModeV1[]; readonly execution: 'staged' | 'direct';
  readonly feedbackCompletion?: true;
  readonly requiredSkills: readonly string[]; readonly maxRounds: number; readonly stageTimeoutMinutes: number;
}
export interface WorkflowStageV1 {
  readonly stage: 'implement' | 'review' | 'fix'; readonly baseSha: string; readonly headSha?: string; readonly reportPath: string;
  readonly incompleteReview?: { readonly reportPath: string; readonly summary: string };
  readonly feedback?: string; readonly round?: number; readonly summaryCorrection?: { readonly reportPath: string; readonly actualLength: number };
}
export interface WorkflowPromptInputV1 {
  readonly version: 1;
  readonly runtime: { readonly providerId: string; readonly model: string | null; readonly effort: string | null; readonly reviewDelegation: 'review-agent-skill' | 'native-subagents' | 'none' };
  readonly byline: string; readonly clarificationInstructions: string;
  readonly task: {
    readonly ticketId: string; readonly title: string; readonly repo: string; readonly jiraBaseUrl: string;
    readonly jiraContext?: string; readonly task?: string; readonly prBranch?: string; readonly prNumber?: number; readonly review?: boolean;
    readonly prHeadSha?: string; readonly skillsPath?: string; readonly reviewOutputPaths?: { readonly markdown: string; readonly comments: string };
  };
  readonly stage: WorkflowStageV1 | null;
  readonly feedback?: WorkflowFeedbackStageV1;
}
export interface WorkflowFeedbackStageV1 {
  readonly stage: 'author' | 'audit'; readonly round: number; readonly snapshotPath: string;
  readonly snapshot: { readonly repo: string; readonly prNumber: number; readonly headSha: string; readonly baseSha: string; readonly fingerprint: string };
  readonly feedbackPath?: string; readonly reportPath?: string;
  readonly decisions?: { readonly path: string; readonly fingerprint: string };
}
export interface WorkflowFeedbackStepInputV1 {
  readonly version: 1; readonly repairAttempts: number; readonly decisionRounds: number; readonly evidenceChanged: boolean;
  readonly outcomes: readonly ('completed' | 'changes_remaining' | 'awaiting_decision')[];
}
export type WorkflowFeedbackActionV1 = { readonly kind: 'complete' | 'repair' | 'decide' } | { readonly kind: 'stop'; readonly reason: string };
export interface WorkflowFindingV1 { readonly title: string; readonly body: string; readonly path?: string; readonly line?: number; }
export interface WorkflowReviewReportV1 {
  readonly baseSha: string; readonly headSha: string; readonly verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  readonly summary: string; readonly findings: readonly WorkflowFindingV1[];
}
export interface WorkflowStepInputV1 {
  readonly version: 1; readonly writerId: string; readonly reviewerIds: readonly string[]; readonly round: number; readonly maxRounds: number; readonly implemented: boolean;
  readonly revision: { readonly baseSha: string; readonly headSha: string; readonly branch: string };
  readonly reviews: readonly { readonly reviewer: string; readonly report: WorkflowReviewReportV1 }[];
}
export type WorkflowActionV1 = { readonly kind: 'author'; readonly stage: 'implement' | 'fix' }
  | { readonly kind: 'review'; readonly reviewerId: string } | { readonly kind: 'publish' } | { readonly kind: 'stop'; readonly reason: string };
export interface WorkflowProviderV1 {
  readonly metadata: WorkflowMetadataV1;
  renderPrompt(input: WorkflowPromptInputV1): string;
  next(input: WorkflowStepInputV1): WorkflowActionV1;
  nextFeedback?(input: WorkflowFeedbackStepInputV1): WorkflowFeedbackActionV1;
}
export interface WorkflowDeclarationV1 { readonly access: readonly ['workflow-policy']; }
export interface WorkflowBackendContextV1 {
  readonly pluginId: string; readonly signal: AbortSignal; readonly settings: Readonly<Record<string, PluginJson>>;
  registerWorkflow(localId: string, provider: WorkflowProviderV1): void;
  onDispose(cleanup: () => void | Promise<void>): void;
}
export interface WorkflowBackendModuleV1 { activate(context: WorkflowBackendContextV1): void | Promise<void>; }
export const WORKFLOW_LIMITS_V1: Readonly<Record<'prompt' | 'input' | 'reviewers' | 'findings' | 'skills', number>> = Object.freeze({ prompt: 256 * 1024, input: 1024 * 1024, reviewers: 8, findings: 40, skills: 64 });

function invalid(): never { throw new TypeError('Invalid workflow contract'); }
function text(value: unknown, maximum: number, empty = false, byteBound = true): string {
  if (typeof value !== 'string' || value.length > maximum || byteBound && new TextEncoder().encode(value).byteLength > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || !empty && !value.trim()) invalid(); return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(); return value;
}
function sha(value: unknown): string { if (typeof value !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(value)) invalid(); return value; }
function providerId(value: unknown): string { if (!isContributionId(value)) invalid(); return value; }
function path(value: unknown): string {
  const result = sourceText(value, 4096);
  if (!/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(result) || result.split(/[\\/]/).some(part => part === '..' || part === '.')) invalid(); return result;
}
export function parseWorkflowModeV1(value: unknown): WorkflowModeV1 {
  if (value !== 'coding' && value !== 'review' && value !== 'branch') invalid(); return value;
}
export function parseWorkflowMetadataV1(input: unknown): WorkflowMetadataV1 {
  const value = sourceObject(sourceJson(input)); sourceFields(value, ['version', 'label', 'modes', 'execution', 'requiredSkills', 'maxRounds', 'stageTimeoutMinutes'], ['feedbackCompletion']);
  if (value.version !== 1 || !Array.isArray(value.modes) || !value.modes.length || value.modes.length > 3 || new Set(value.modes).size !== value.modes.length
    || value.execution !== 'staged' && value.execution !== 'direct' || !Array.isArray(value.requiredSkills) || value.requiredSkills.length > WORKFLOW_LIMITS_V1.skills
    || value.requiredSkills.some(skill => typeof skill !== 'string' || !/^[a-z][a-z\d-]{0,63}$/.test(skill)) || new Set(value.requiredSkills).size !== value.requiredSkills.length) invalid();
  const modes = value.modes.map(parseWorkflowModeV1);
  if (modes.some(mode => (mode === 'coding') !== (value.execution === 'staged'))) throw new TypeError('Workflow execution does not match its declared modes');
  if (Object.hasOwn(value, 'feedbackCompletion') && (value.feedbackCompletion !== true || value.execution !== 'direct'
    || modes.length !== 1 || modes[0] !== 'branch')) throw new TypeError('Feedback completion requires a direct branch workflow');
  return Object.freeze({ version: 1, label: sourceText(value.label, 128), modes: Object.freeze(modes), execution: value.execution,
    ...(value.feedbackCompletion === true ? { feedbackCompletion: true as const } : {}),
    requiredSkills: value.requiredSkills as readonly string[], maxRounds: integer(value.maxRounds, 1, 5), stageTimeoutMinutes: integer(value.stageTimeoutMinutes, 5, 180) });
}
export function parseWorkflowStageV1(input: unknown): WorkflowStageV1 {
  const value = sourceObject(sourceJson(input, WORKFLOW_LIMITS_V1.input)); sourceFields(value, ['stage', 'baseSha', 'reportPath'], ['headSha', 'feedback', 'round', 'summaryCorrection', 'incompleteReview']);
  if (!['implement', 'review', 'fix'].includes(String(value.stage))) invalid();
  sha(value.baseSha); path(value.reportPath);
  if (Object.hasOwn(value, 'headSha')) sha(value.headSha);
  if (Object.hasOwn(value, 'feedback')) text(value.feedback, 256 * 1024, true);
  if (Object.hasOwn(value, 'round')) integer(value.round, 0, 5);
  if (Object.hasOwn(value, 'incompleteReview')) {
    const prior = sourceObject(value.incompleteReview); sourceFields(prior, ['reportPath', 'summary']);
    path(prior.reportPath); text(prior.summary, 2000);
    if (value.stage !== 'review' || prior.reportPath === value.reportPath || Object.hasOwn(value, 'summaryCorrection')) invalid();
  }
  if (Object.hasOwn(value, 'summaryCorrection')) {
    const correction = sourceObject(value.summaryCorrection); sourceFields(correction, ['reportPath', 'actualLength']);
    path(correction.reportPath); integer(correction.actualLength, 1, Number.MAX_SAFE_INTEGER);
    if (value.stage !== 'review' || correction.reportPath === value.reportPath) invalid();
  }
  if (value.stage === 'review' && !Object.hasOwn(value, 'headSha')) invalid();
  return value as unknown as WorkflowStageV1;
}
export function parseWorkflowPromptInputV1(input: unknown): WorkflowPromptInputV1 {
  const value = sourceObject(sourceJson(input, WORKFLOW_LIMITS_V1.input)); sourceFields(value, ['version', 'runtime', 'byline', 'clarificationInstructions', 'task', 'stage'], ['feedback']);
  if (value.version !== 1) invalid();
  const runtime = sourceObject(value.runtime); sourceFields(runtime, ['providerId', 'model', 'effort', 'reviewDelegation']);
  providerId(runtime.providerId); if (runtime.model !== null) sourceText(runtime.model, 128); if (runtime.effort !== null) sourceText(runtime.effort, 64);
  if (!['review-agent-skill', 'native-subagents', 'none'].includes(String(runtime.reviewDelegation))) invalid();
  text(value.byline, 1024); text(value.clarificationInstructions, 64 * 1024, true);
  const task = sourceObject(value.task); sourceFields(task, ['ticketId', 'title', 'repo', 'jiraBaseUrl'], ['jiraContext', 'task', 'prBranch', 'prNumber', 'review', 'prHeadSha', 'skillsPath', 'reviewOutputPaths']);
  sourceText(task.ticketId, 512); text(task.title, 4096); parseTaskRepo(task.repo); text(task.jiraBaseUrl, 4096, true);
  if (task.jiraBaseUrl) {
    let url: URL; try { url = new URL(task.jiraBaseUrl as string); } catch { invalid(); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) invalid();
  }
  if (Object.hasOwn(task, 'jiraContext')) text(task.jiraContext, 256 * 1024, true);
  if (Object.hasOwn(task, 'task')) text(task.task, 256 * 1024, true);
  if (Object.hasOwn(task, 'prBranch')) sourceText(task.prBranch, 255);
  if (Object.hasOwn(task, 'prNumber')) integer(task.prNumber, 1, Number.MAX_SAFE_INTEGER);
  if (Object.hasOwn(task, 'review') && typeof task.review !== 'boolean') invalid();
  if (Object.hasOwn(task, 'prHeadSha')) sha(task.prHeadSha);
  if (Object.hasOwn(task, 'skillsPath')) path(task.skillsPath);
  if (Object.hasOwn(task, 'reviewOutputPaths')) { const paths = sourceObject(task.reviewOutputPaths); sourceFields(paths, ['markdown', 'comments']); path(paths.markdown); path(paths.comments); }
  if (value.stage !== null) parseWorkflowStageV1(value.stage);
  if (Object.hasOwn(value, 'feedback')) {
    const feedback = parseWorkflowFeedbackStageV1(value.feedback);
    if (value.stage !== null || feedback.snapshot.repo !== task.repo || feedback.snapshot.prNumber !== task.prNumber || !task.prBranch) invalid();
  }
  return value as unknown as WorkflowPromptInputV1;
}
export function parseWorkflowFeedbackStageV1(input: unknown): WorkflowFeedbackStageV1 {
  const value = sourceObject(sourceJson(input, WORKFLOW_LIMITS_V1.input));
  sourceFields(value, ['stage', 'round', 'snapshotPath', 'snapshot'], ['feedbackPath', 'reportPath', 'decisions']);
  if (value.stage !== 'author' && value.stage !== 'audit') invalid();
  integer(value.round, 1, 10); path(value.snapshotPath);
  const snapshot = sourceObject(value.snapshot); sourceFields(snapshot, ['repo', 'prNumber', 'headSha', 'baseSha', 'fingerprint']);
  parseTaskRepo(snapshot.repo); integer(snapshot.prNumber, 1, Number.MAX_SAFE_INTEGER); sha(snapshot.headSha); sha(snapshot.baseSha);
  if (typeof snapshot.fingerprint !== 'string' || !/^[a-f\d]{64}$/.test(snapshot.fingerprint)) invalid();
  const paths = [value.snapshotPath];
  for (const key of ['feedbackPath', 'reportPath'] as const) if (Object.hasOwn(value, key)) { path(value[key]); paths.push(value[key]); }
  if (value.stage === 'audit' && (!Object.hasOwn(value, 'reportPath') || Object.hasOwn(value, 'feedbackPath'))
    || value.stage === 'author' && (!Object.hasOwn(value, 'feedbackPath') || Object.hasOwn(value, 'reportPath'))) invalid();
  if (Object.hasOwn(value, 'decisions')) {
    const decisions = sourceObject(value.decisions); sourceFields(decisions, ['path', 'fingerprint']); path(decisions.path); paths.push(decisions.path);
    if (typeof decisions.fingerprint !== 'string' || !/^[a-f\d]{64}$/.test(decisions.fingerprint)) invalid();
  }
  if (new Set(paths).size !== paths.length) invalid();
  return value as unknown as WorkflowFeedbackStageV1;
}
export function parseWorkflowFeedbackStepInputV1(input: unknown): WorkflowFeedbackStepInputV1 {
  const value = sourceObject(sourceJson(input, 8192)); sourceFields(value, ['version', 'repairAttempts', 'decisionRounds', 'evidenceChanged', 'outcomes']);
  if (value.version !== 1 || typeof value.evidenceChanged !== 'boolean' || !Array.isArray(value.outcomes)
    || !value.outcomes.length || value.outcomes.length > WORKFLOW_LIMITS_V1.reviewers
    || value.outcomes.some(outcome => !['completed', 'changes_remaining', 'awaiting_decision'].includes(String(outcome)))) invalid();
  integer(value.repairAttempts, 0, 5); integer(value.decisionRounds, 0, 5);
  return value as unknown as WorkflowFeedbackStepInputV1;
}
export function parseWorkflowFeedbackActionV1(input: unknown): WorkflowFeedbackActionV1 {
  const value = sourceObject(sourceJson(input, 8192));
  if (value.kind === 'stop') { sourceFields(value, ['kind', 'reason']); text(value.reason, 4096); }
  else { sourceFields(value, ['kind']); if (!['complete', 'repair', 'decide'].includes(String(value.kind))) invalid(); }
  return value as unknown as WorkflowFeedbackActionV1;
}
export function parseWorkflowPromptV1(value: unknown): string { return text(value, WORKFLOW_LIMITS_V1.prompt); }
export function parseWorkflowReviewReportV1(input: unknown): WorkflowReviewReportV1 {
  const value = sourceObject(sourceJson(input, WORKFLOW_LIMITS_V1.input)); sourceFields(value, ['baseSha', 'headSha', 'verdict', 'summary', 'findings']);
  sha(value.baseSha); sha(value.headSha); text(value.summary, 2000, false, false);
  if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(String(value.verdict)) || !Array.isArray(value.findings) || value.findings.length > WORKFLOW_LIMITS_V1.findings) invalid();
  for (const input of value.findings) {
    const finding = sourceObject(input); sourceFields(finding, ['title', 'body'], ['path', 'line']); text(finding.title, 180, false, false); text(finding.body, 4000, false, false);
    if (Object.hasOwn(finding, 'path')) { const file = text(finding.path, 1024, false, false); if (/^[\\/]|^[a-z]:|[\r\n\\]/i.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) invalid(); }
    if (Object.hasOwn(finding, 'line')) { integer(finding.line, 1, Number.MAX_SAFE_INTEGER); if (!Object.hasOwn(finding, 'path')) invalid(); }
  }
  if (value.verdict === 'APPROVE' && value.findings.length || value.verdict === 'REQUEST_CHANGES' && !value.findings.length) invalid();
  return value as unknown as WorkflowReviewReportV1;
}
export function parseWorkflowStepInputV1(input: unknown): WorkflowStepInputV1 {
  const value = sourceObject(sourceJson(input, WORKFLOW_LIMITS_V1.input)); sourceFields(value, ['version', 'writerId', 'reviewerIds', 'round', 'maxRounds', 'implemented', 'revision', 'reviews']);
  if (value.version !== 1 || typeof value.implemented !== 'boolean' || !Array.isArray(value.reviewerIds) || !value.reviewerIds.length || value.reviewerIds.length > WORKFLOW_LIMITS_V1.reviewers
    || new Set(value.reviewerIds).size !== value.reviewerIds.length || !Array.isArray(value.reviews) || value.reviews.length > value.reviewerIds.length) invalid();
  providerId(value.writerId); value.reviewerIds.forEach(providerId); integer(value.maxRounds, 1, 5); integer(value.round, 0, Number(value.maxRounds));
  const revision = sourceObject(value.revision); sourceFields(revision, ['baseSha', 'headSha', 'branch']); sha(revision.baseSha); sha(revision.headSha); sourceText(revision.branch, 255);
  const seen = new Set<string>();
  for (const input of value.reviews) {
    const review = sourceObject(input); sourceFields(review, ['reviewer', 'report']); const reviewer = providerId(review.reviewer);
    if (!value.reviewerIds.includes(reviewer) || seen.has(reviewer)) invalid(); seen.add(reviewer);
    const report = parseWorkflowReviewReportV1(review.report); if (report.baseSha !== revision.baseSha || report.headSha !== revision.headSha) invalid();
  }
  if (!value.implemented && (value.round !== 0 || value.reviews.length) || value.implemented && value.round === 0) invalid();
  return value as unknown as WorkflowStepInputV1;
}
export function parseWorkflowActionV1(input: unknown): WorkflowActionV1 {
  const value = sourceObject(sourceJson(input, 8192));
  if (value.kind === 'author') { sourceFields(value, ['kind', 'stage']); if (value.stage !== 'implement' && value.stage !== 'fix') invalid(); }
  else if (value.kind === 'review') { sourceFields(value, ['kind', 'reviewerId']); providerId(value.reviewerId); }
  else if (value.kind === 'publish') sourceFields(value, ['kind']);
  else if (value.kind === 'stop') { sourceFields(value, ['kind', 'reason']); text(value.reason, 4096); }
  else invalid();
  return value as unknown as WorkflowActionV1;
}
