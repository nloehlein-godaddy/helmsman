import { join } from 'node:path';
import type { PostmortemEvidence } from './evidence';

export const SEED_PROMPT_LIMIT = 24_000;
export const SEED_PROMPT_ENDING = 'Give your diagnosis first — likely cause, evidence, confidence — then what you would check next.';
export const EMPTY_OUTPUT_NOTE = 'No agent output — consider exec-level causes: host, spec argv (lengths are listed), endpoint protection, PATH, provider auth.';
export interface SeedPromptInput {
  evidence: PostmortemEvidence; directory: string; evidencePath: string; priorTranscript?: readonly { role: string; kind: string; text: string }[];
}
const INLINE_EVENTS = 20;
const INLINE_EVENT_CHARS = 300;
const INLINE_LOG_CHARS = 4000;
const INLINE_ARGS = 32;
const TRANSCRIPT_MESSAGES = 40;
const TRANSCRIPT_MESSAGE_CHARS = 2000;
const TRANSCRIPT_CHARS = 6000;
const clip = (text: string, maximum: number) => text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
const tail = (text: string, maximum: number) => text.length > maximum ? `…${text.slice(-(maximum - 1))}` : text;
const oneLine = (text: string) => text.replace(/\s+/g, ' ');

export function seedPrompt(input: SeedPromptInput): string {
  const { evidence: e, directory } = input;
  const spec = e.spec ? [`Command ${e.spec.cmd} (cwd ${e.spec.cwd ?? 'unknown'}), ${e.spec.args.length} arguments:`,
    ...e.spec.args.slice(0, INLINE_ARGS).map((arg, index) => `  ${index}: ${arg.length} bytes${arg.preview === null ? '' : ` "${oneLine(arg.preview)}"`}`),
    ...(e.spec.args.length > INLINE_ARGS ? [`  … ${e.spec.args.length - INLINE_ARGS} more in evidence.json`] : [])].join('\n') : 'Spec file unavailable.';
  const events = e.events.slice(-INLINE_EVENTS).map(item => `[${item.ts}] ${item.kind}: ${clip(oneLine(item.text), INLINE_EVENT_CHARS)}`).join('\n') || 'No events.';
  const log = e.logTail ? tail(e.logTail.text, INLINE_LOG_CHARS) : 'Log file unavailable.';
  const target = e.targetRepoPath ?? 'not available';
  const notes = [
    ...(e.worktree.state === 'missing' ? [`The run's worktree is missing (${e.worktree.reason ?? 'unknown reason'}). Target-repo patches are still allowed against an explicit baseSha in ${target}.`] : []),
    ...(e.agentOutput ? [] : [EMPTY_OUTPUT_NOTE]),
  ];
  const transcript = input.priorTranscript?.length ? tail(input.priorTranscript.slice(-TRANSCRIPT_MESSAGES)
    .map(message => `${message.role}: ${clip(message.text, TRANSCRIPT_MESSAGE_CHARS)}`).join('\n'), TRANSCRIPT_CHARS) : null;
  const sections = [
    `You are diagnosing a failed Helmsman run. Diagnosis only: you may read anywhere and run diagnostic commands, but do not modify anything outside ${directory}, and do not push, publish, comment on, or otherwise contact GitHub, Jira, Slack or any other external system.`,
    ['## Evidence summary',
      `Run ${e.run.id} · ${e.run.repo} · ${e.run.adapter} · status ${e.run.status} · attempt ${e.run.attempt} · ticket ${e.run.ticketId}`,
      `Started ${e.run.startedAt} · ended ${e.run.endedAt ?? 'unknown'} · duration ${e.run.durationMs === null ? 'unknown' : `${e.run.durationMs} ms`}`,
      `Exit code ${e.exit.code ?? 'unknown'} · signal ${e.exit.signal ?? 'none'} · host ${e.host ?? 'unknown'}`,
      `Signatures: ${e.signatures.length ? e.signatures.join(', ') : 'none'}`,
      `Worktree: ${e.worktree.path ?? 'none'} (${e.worktree.state}${e.worktree.reason ? `, ${e.worktree.reason}` : ''})`,
      `Helmsman source: ${e.helmsman.root} (${e.helmsman.commit ?? 'commit unknown'}) · target repository: ${target}`,
      `Spec: ${spec}`].join('\n'),
    `## Last events (${e.eventsTotal} total)\n${events}`,
    `## Log tail\n${log}`,
    ['## Artifacts', `- Full evidence: ${input.evidencePath}`, `- Run log: ${e.artifacts.log ?? 'none'}`, `- Exit file: ${e.artifacts.exit ?? 'none'}`,
      `- Launch spec: ${e.artifacts.spec ?? 'none'}`, `- Worktree: ${e.worktree.path ?? 'none'}`].join('\n'),
    ['## Proposing patches', 'Never apply patches, commit, or edit either repository. To propose a change, write two files:',
      `- ${join(directory, 'patches')}/<n>-<repo>.patch — a unified diff for repo "helmsman" (${e.helmsman.root}) or "target" (${target}); n starts at 1 and increases.`,
      `- ${join(directory, 'patches')}/<n>-<repo>.json — {"repo": "<repo>", "baseSha": "<commit the diff applies to>", "summary": "<one line>"}.`,
      'Helmsman checks each patch with git apply --check against baseSha and shows the user the git apply command.'].join('\n'),
    ...(notes.length ? [`## Notes\n${notes.join('\n')}`] : []),
    ...(transcript ? [`## Previous post-mortem transcript\n${transcript}`] : []),
  ];
  const body = sections.join('\n\n');
  const room = SEED_PROMPT_LIMIT - SEED_PROMPT_ENDING.length - 2;
  return `${body.length > room ? body.slice(0, room) : body}\n\n${SEED_PROMPT_ENDING}`;
}
