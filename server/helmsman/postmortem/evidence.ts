import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEventRow, RunRow } from '../db';
import { protocolRecord } from '../agent-protocol';

export type PostmortemSignature = 'exec-kill' | 'spawn-failed' | 'stage-timeout' | 'cost-cap' | 'clarification-unanswered' | 'snapshot-mismatch' | 'gate-blocked';
export interface PostmortemEvidence {
  readonly version: 1;
  readonly run: { id: string; ticketId: string; repo: string; adapter: string; status: string; attempt: number; prNumber: number | null;
    startedAt: string; endedAt: string | null; durationMs: number | null; costUsd: number | null };
  readonly task: unknown;
  readonly events: readonly { id: number; ts: string; kind: string; text: string }[];
  readonly eventsTotal: number;
  readonly logTail: { text: string; bytes: number; truncated: boolean } | null;
  readonly exit: { code: number | null; signal: string | null };
  readonly spec: { cmd: string; cwd: string | null; args: readonly { length: number; preview: string | null }[] } | null;
  readonly host: string | null;
  readonly worktree: { path: string | null; state: 'present' | 'missing'; reason: string | null };
  readonly helmsman: { root: string; commit: string | null };
  readonly targetRepoPath: string | null;
  readonly agentOutput: boolean;
  readonly signatures: readonly PostmortemSignature[];
  readonly artifacts: { log: string | null; exit: string | null; spec: string | null };
}
export interface EvidenceInput {
  run: RunRow; events: readonly RunEventRow[]; log: { text: string; bytes: number } | null; exitText: string | null; specText: string | null;
  worktreeExists: boolean; helmsmanRoot: string; helmsmanCommit: string | null; targetRepoPath: string | null;
}
export const EVIDENCE_EVENT_LIMIT = 200;
export const EVIDENCE_LOG_LIMIT = 65_536;
const SPEC_READ_LIMIT = 1024 * 1024;
const SECRET_KEY = /token|secret|password|credential|capability|apikey/i;
const SECRET_TEXT: readonly RegExp[] = [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, /\bghp_[A-Za-z0-9]{8,}/g, /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, /\bxox[abpr]-[A-Za-z0-9-]{8,}/g];
const DIAGNOSTIC_LINE = /^(?:run-wrapper|model-routing):/;
const OUTPUT_EVENT_KINDS = new Set(['log', 'tool', 'result', 'usage']);
const EVENT_SIGNATURES: readonly [PostmortemSignature, string][] = [
  ['stage-timeout', 'Agent stage timed out'], ['cost-cap', 'cost cap reached'], ['clarification-unanswered', 'Required clarification has no answer'],
  ['snapshot-mismatch', 'Prompt implementation does not match the saved workflow snapshot'], ['gate-blocked', 'publication gate did not pass'],
];
const RETAINED_WORKTREE = 'Worktree retained for inspection';

export function redactText(text: string): string {
  return SECRET_TEXT.reduce((value, pattern) => value.replace(pattern, '[redacted]'), text);
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (depth > 32 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redactValue(item, depth + 1)]));
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

function specSummary(text: string | null): PostmortemEvidence['spec'] {
  const spec = protocolRecord(parseJson(text));
  if (!spec || typeof spec.cmd !== 'string' || !Array.isArray(spec.args)) return null;
  return { cmd: redactText(spec.cmd), cwd: typeof spec.cwd === 'string' ? spec.cwd : null,
    args: spec.args.map(arg => typeof arg !== 'string' ? { length: 0, preview: null }
      : { length: Buffer.byteLength(arg), preview: arg.startsWith('--input=') ? null : redactText(arg.slice(0, 40)) }) };
}

function worktreeState(run: RunRow, exists: boolean, events: readonly RunEventRow[]): PostmortemEvidence['worktree'] {
  if (!run.worktreePath) return { path: null, state: 'missing', reason: 'no worktree recorded' };
  if (exists) return { path: run.worktreePath, state: 'present', reason: null };
  return { path: run.worktreePath, state: 'missing',
    reason: events.some(item => item.text.startsWith(RETAINED_WORKTREE)) ? 'swept at startup' : 'removed on non-retaining failure' };
}

export function buildEvidence(input: EvidenceInput): PostmortemEvidence {
  const { run, events } = input;
  const logTruncated = Boolean(input.log && input.log.bytes > Buffer.byteLength(input.log.text));
  const logLines = input.log ? input.log.text.split('\n').slice(logTruncated ? 1 : 0) : [];
  const eventTexts = events.map(item => item.text);
  const allText = [...logLines, ...eventTexts];
  const signal = allText.map(line => line.match(/terminated by signal (SIG[A-Z0-9]+)/)?.[1]).find(Boolean) ?? null;
  const parsedCode = Number.parseInt(input.exitText?.trim() ?? '', 10);
  const code = Number.isSafeInteger(parsedCode) ? parsedCode : null;
  const started = Date.parse(run.startedAt); const ended = run.endedAt ? Date.parse(run.endedAt) : Number.NaN;
  const durationMs = Number.isFinite(started) && Number.isFinite(ended) ? ended - started : null;
  const agentOutput = [...logLines, ...events.filter(item => OUTPUT_EVENT_KINDS.has(item.kind)).map(item => item.text)]
    .some(line => line.trim() !== '' && !DIAGNOSTIC_LINE.test(line.trim()));
  const signatures: PostmortemSignature[] = [];
  if (signal === 'SIGKILL' && durationMs !== null && durationMs < 5000 && !agentOutput) signatures.push('exec-kill');
  if (code === 127 || allText.some(line => line.includes('cannot start'))) signatures.push('spawn-failed');
  for (const [signature, needle] of EVENT_SIGNATURES) if (eventTexts.some(text => text.includes(needle))) signatures.push(signature);
  const recent = events.slice(-EVIDENCE_EVENT_LIMIT);
  return {
    version: 1,
    run: { id: run.id, ticketId: run.ticketId, repo: run.repo, adapter: run.adapter, status: run.status, attempt: run.attempt, prNumber: run.prNumber,
      startedAt: run.startedAt, endedAt: run.endedAt, durationMs, costUsd: run.costUsd },
    task: redactValue(parseJson(run.taskJson)),
    events: recent.map(item => ({ id: item.id, ts: item.ts, kind: item.kind, text: redactText(item.text) })),
    eventsTotal: events.length,
    logTail: input.log ? { text: redactText(input.log.text), bytes: input.log.bytes, truncated: logTruncated } : null,
    exit: { code, signal },
    spec: specSummary(input.specText),
    host: run.hostKind ?? null,
    worktree: worktreeState(run, input.worktreeExists, events),
    helmsman: { root: input.helmsmanRoot, commit: input.helmsmanCommit },
    targetRepoPath: input.targetRepoPath,
    agentOutput,
    signatures,
    artifacts: { log: run.logPath ?? null, exit: run.exitPath ?? null, spec: run.specPath ?? null },
  };
}

function readTail(path: string | null | undefined): EvidenceInput['log'] {
  if (!path) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const bytes = fstatSync(fd).size;
    const length = Math.min(bytes, EVIDENCE_LOG_LIMIT);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, bytes - length);
    return { text: buffer.toString('utf8'), bytes };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function readSmall(path: string | null | undefined): string | null {
  if (!path) return null;
  try {
    const text = readFileSync(path);
    return text.length > SPEC_READ_LIMIT ? null : text.toString('utf8');
  } catch { return null; }
}

export function readEvidenceInput(run: RunRow, deps: { listEvents(runId: string): RunEventRow[]; helmsmanRoot: string; helmsmanCommit: string | null; targetRepoPath: string | null }): EvidenceInput {
  return { run, events: deps.listEvents(run.id), log: readTail(run.logPath), exitText: readSmall(run.exitPath), specText: readSmall(run.specPath),
    worktreeExists: Boolean(run.worktreePath && existsSync(run.worktreePath)), helmsmanRoot: deps.helmsmanRoot, helmsmanCommit: deps.helmsmanCommit,
    targetRepoPath: deps.targetRepoPath };
}

export function writeEvidenceFile(directory: string, evidence: PostmortemEvidence): string {
  const path = join(directory, 'evidence.json');
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return path;
}
