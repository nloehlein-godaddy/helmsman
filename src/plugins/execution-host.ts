import type { PluginJson } from './backend';
import { sourceFields, sourceJson, sourceObject, sourceText } from './source-contract-validation';
import { parseTaskRepo } from './tasks';

export interface ExecutionHostMetadataV1 { readonly version: 1; readonly label: string; readonly workspace: 'worktree' | 'clone'; readonly stageExecution: 'local' | 'isolated'; }
export interface ExecutionHostPrepareRunInputV1 { readonly version: 1; readonly runId: string; readonly repo: string; readonly mode: 'coding' | 'review' | 'branch'; }
export interface ExecutionHostIdentityV1 { readonly runId: string; readonly launchId: string; readonly attempt: number; readonly receiptPath: string; }
export interface ExecutionHostCommandV1 { readonly cmd: string; readonly args: readonly string[]; }
export interface ExecutionHostLaunchSpecV1 extends ExecutionHostIdentityV1, ExecutionHostCommandV1 {
  readonly version: 1; readonly cwd: string; readonly logPath: string; readonly exitPath: string; readonly specPath: string; readonly wrapperPath: string;
  readonly coordinator: boolean; readonly configuration: PluginJson;
}
export interface ExecutionHostReferenceV1 { readonly version: 1; readonly identity: ExecutionHostIdentityV1; readonly state: PluginJson; }
export type ExecutionHostDiscoveryV1 =
  | { readonly status: 'found'; readonly ref: ExecutionHostReferenceV1; readonly evidence: { readonly launchId: string; readonly runId: string; readonly attempt: number; readonly state: 'running' | 'exited'; readonly exitCode?: number } }
  | { readonly status: 'absent'; readonly evidence: string }
  | { readonly status: 'unknown'; readonly reason: string };
export interface ExecutionHostStagePathsV1 {
  readonly skillsPath: string | null; readonly reportPath: string | null; readonly priorReportPath: string | null;
  readonly reviewOutputPaths: { readonly markdown: string; readonly comments: string } | null;
  readonly clarification: { readonly questionsPath: string; readonly answersPath: string } | null;
}
export interface ExecutionHostStageInputV1 extends ExecutionHostStagePathsV1 {
  readonly version: 1; readonly runId: string; readonly repo: string; readonly cwd: string; readonly runtimeRoot: string;
  readonly gateway: { readonly url: string; readonly capability: string }; readonly configuration: PluginJson;
  readonly transport: 'openai-responses' | 'anthropic-messages'; readonly stage: 'implement' | 'review' | 'fix' | 'pr-review';
}
export interface ExecutionHostStageV1 { readonly command: ExecutionHostCommandV1; stop(): Promise<void>; cleanup(success: boolean): Promise<void>; }
export interface ExecutionHostProviderV1 {
  readonly metadata: ExecutionHostMetadataV1;
  prepareRun(input: ExecutionHostPrepareRunInputV1): Promise<PluginJson>;
  launch(spec: ExecutionHostLaunchSpecV1): Promise<ExecutionHostReferenceV1>;
  discover(spec: ExecutionHostLaunchSpecV1, ref?: ExecutionHostReferenceV1): Promise<ExecutionHostDiscoveryV1>;
  isAlive(ref: ExecutionHostReferenceV1): Promise<boolean>;
  stop(ref: ExecutionHostReferenceV1): Promise<void>;
  prepareStage?(input: ExecutionHostStageInputV1, renderCommand: (paths: ExecutionHostStagePathsV1) => ExecutionHostCommandV1): Promise<ExecutionHostStageV1>;
  stopStages?(runId: string): Promise<void>;
}
export interface ExecutionHostDeclarationV1 { readonly access: readonly ['execution']; }
export interface ExecutionHostBackendContextV1 {
  readonly pluginId: string; readonly signal: AbortSignal; readonly settings: Readonly<Record<string, PluginJson>>;
  registerExecutionHost(localId: string, provider: ExecutionHostProviderV1): void;
  onDispose(cleanup: () => void | Promise<void>): void;
}
export interface ExecutionHostBackendModuleV1 { activate(context: ExecutionHostBackendContextV1): void | Promise<void>; }

function invalid(): never { throw new TypeError('Invalid execution host contract'); }
function version(value: Record<string, unknown>): void { if (value.version !== 1) invalid(); }
export function parseExecutionHostRunIdV1(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(value)) invalid(); return value;
}
function path(value: unknown): string {
  const result = sourceText(value, 4096);
  if (!/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(result)) invalid(); return result;
}
function positive(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(); return value; }
function nullablePath(value: unknown): string | null { return value === null ? null : path(value); }
export function parseExecutionHostConfigurationV1(value: unknown): PluginJson { return sourceJson(value, 64 * 1024) as PluginJson; }
export function parseExecutionHostMetadataV1(input: unknown): ExecutionHostMetadataV1 {
  const value = sourceObject(input); sourceFields(value, ['version', 'label', 'workspace', 'stageExecution']); version(value);
  if (value.workspace !== 'worktree' && value.workspace !== 'clone' || value.stageExecution !== 'local' && value.stageExecution !== 'isolated') invalid();
  return Object.freeze({ version: 1, label: sourceText(value.label, 128), workspace: value.workspace, stageExecution: value.stageExecution });
}
export function parseExecutionHostPrepareRunInputV1(input: unknown): ExecutionHostPrepareRunInputV1 {
  const value = sourceObject(input); sourceFields(value, ['version', 'runId', 'repo', 'mode']); version(value);
  if (value.mode !== 'coding' && value.mode !== 'review' && value.mode !== 'branch') invalid();
  return Object.freeze({ version: 1, runId: parseExecutionHostRunIdV1(value.runId), repo: parseTaskRepo(value.repo), mode: value.mode });
}
export function parseExecutionHostIdentityV1(input: unknown): ExecutionHostIdentityV1 {
  const value = sourceObject(input); sourceFields(value, ['runId', 'launchId', 'attempt', 'receiptPath']);
  return Object.freeze({ runId: parseExecutionHostRunIdV1(value.runId), launchId: parseExecutionHostRunIdV1(value.launchId), attempt: positive(value.attempt), receiptPath: path(value.receiptPath) });
}
export function parseExecutionHostCommandV1(input: unknown): ExecutionHostCommandV1 {
  const value = sourceObject(sourceJson(input, 1024 * 1024)); sourceFields(value, ['cmd', 'args']);
  if (!Array.isArray(value.args) || value.args.length > 256 || value.args.some(item => typeof item !== 'string' || item.length > 256 * 1024 || item.includes('\0'))) invalid();
  return Object.freeze({ cmd: sourceText(value.cmd, 4096), args: Object.freeze([...value.args]) as readonly string[] });
}
export function parseExecutionHostLaunchSpecV1(input: unknown): ExecutionHostLaunchSpecV1 {
  const value = sourceObject(sourceJson(input, 2 * 1024 * 1024));
  sourceFields(value, ['version', 'runId', 'launchId', 'attempt', 'receiptPath', 'cmd', 'args', 'cwd', 'logPath', 'exitPath', 'specPath', 'wrapperPath', 'coordinator', 'configuration']); version(value);
  if (typeof value.coordinator !== 'boolean') invalid();
  return Object.freeze({ version: 1, ...parseExecutionHostIdentityV1({ runId: value.runId, launchId: value.launchId, attempt: value.attempt, receiptPath: value.receiptPath }),
    ...parseExecutionHostCommandV1({ cmd: value.cmd, args: value.args }), cwd: path(value.cwd), logPath: path(value.logPath), exitPath: path(value.exitPath), specPath: path(value.specPath), wrapperPath: path(value.wrapperPath),
    coordinator: value.coordinator, configuration: parseExecutionHostConfigurationV1(value.configuration) });
}
export function parseExecutionHostReferenceV1(input: unknown): ExecutionHostReferenceV1 {
  const value = sourceObject(sourceJson(input, 96 * 1024)); sourceFields(value, ['version', 'identity', 'state']); version(value);
  return Object.freeze({ version: 1, identity: parseExecutionHostIdentityV1(value.identity), state: sourceJson(value.state, 64 * 1024) as PluginJson });
}
export function parseExecutionHostDiscoveryV1(input: unknown): ExecutionHostDiscoveryV1 {
  const value = sourceObject(sourceJson(input, 128 * 1024));
  if (value.status === 'absent') { sourceFields(value, ['status', 'evidence']); return Object.freeze({ status: 'absent', evidence: sourceText(value.evidence, 4096) }); }
  if (value.status === 'unknown') { sourceFields(value, ['status', 'reason']); return Object.freeze({ status: 'unknown', reason: sourceText(value.reason, 4096) }); }
  if (value.status !== 'found') invalid(); sourceFields(value, ['status', 'ref', 'evidence']);
  const evidence = sourceObject(value.evidence); sourceFields(evidence, ['launchId', 'runId', 'attempt', 'state'], ['exitCode']);
  if (evidence.state !== 'running' && evidence.state !== 'exited' || evidence.exitCode !== undefined && (evidence.state !== 'exited' || typeof evidence.exitCode !== 'number' || !Number.isSafeInteger(evidence.exitCode) || evidence.exitCode < 0 || evidence.exitCode > 255)) invalid();
  const ref = parseExecutionHostReferenceV1(value.ref);
  const parsed = { launchId: parseExecutionHostRunIdV1(evidence.launchId), runId: parseExecutionHostRunIdV1(evidence.runId), attempt: positive(evidence.attempt), state: evidence.state as 'running' | 'exited', ...(evidence.exitCode === undefined ? {} : { exitCode: evidence.exitCode as number }) };
  if (parsed.launchId !== ref.identity.launchId || parsed.runId !== ref.identity.runId || parsed.attempt !== ref.identity.attempt) invalid();
  return Object.freeze({ status: 'found', ref, evidence: Object.freeze(parsed) });
}
export function parseExecutionHostStagePathsV1(input: unknown): ExecutionHostStagePathsV1 {
  const value = sourceObject(input); sourceFields(value, ['skillsPath', 'reportPath', 'priorReportPath', 'reviewOutputPaths', 'clarification']);
  const review = value.reviewOutputPaths === null ? null : sourceObject(value.reviewOutputPaths);
  const clarification = value.clarification === null ? null : sourceObject(value.clarification);
  if (review) sourceFields(review, ['markdown', 'comments']); if (clarification) sourceFields(clarification, ['questionsPath', 'answersPath']);
  return Object.freeze({ skillsPath: nullablePath(value.skillsPath), reportPath: nullablePath(value.reportPath), priorReportPath: nullablePath(value.priorReportPath),
    reviewOutputPaths: review ? Object.freeze({ markdown: path(review.markdown), comments: path(review.comments) }) : null,
    clarification: clarification ? Object.freeze({ questionsPath: path(clarification.questionsPath), answersPath: path(clarification.answersPath) }) : null });
}
export function parseExecutionHostStageInputV1(input: unknown): ExecutionHostStageInputV1 {
  const value = sourceObject(sourceJson(input, 128 * 1024));
  sourceFields(value, ['version', 'runId', 'repo', 'cwd', 'runtimeRoot', 'gateway', 'configuration', 'transport', 'stage', 'skillsPath', 'reportPath', 'priorReportPath', 'reviewOutputPaths', 'clarification']); version(value);
  if (value.transport !== 'openai-responses' && value.transport !== 'anthropic-messages' || value.stage !== 'implement' && value.stage !== 'review' && value.stage !== 'fix' && value.stage !== 'pr-review') invalid();
  const gateway = sourceObject(value.gateway); sourceFields(gateway, ['url', 'capability']);
  const url = new URL(sourceText(gateway.url, 4096));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) invalid();
  return Object.freeze({ version: 1, runId: parseExecutionHostRunIdV1(value.runId), repo: parseTaskRepo(value.repo), cwd: path(value.cwd), runtimeRoot: path(value.runtimeRoot),
    gateway: Object.freeze({ url: url.href, capability: sourceText(gateway.capability, 4096) }), configuration: parseExecutionHostConfigurationV1(value.configuration), transport: value.transport, stage: value.stage,
    ...parseExecutionHostStagePathsV1({ skillsPath: value.skillsPath, reportPath: value.reportPath, priorReportPath: value.priorReportPath, reviewOutputPaths: value.reviewOutputPaths, clarification: value.clarification }) });
}
