/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import type { RunEventRow, RunRow } from '../db';
import { buildEvidence, type EvidenceInput } from './evidence';
import { EMPTY_OUTPUT_NOTE, SEED_PROMPT_ENDING, SEED_PROMPT_LIMIT, seedPrompt } from './prompt';

const run: RunRow = { id: 'ca31adc3', ticketId: 'rerun', repo: 'org/app', adapter: 'feedback:codex', status: 'failed', attempt: 1, prNumber: null,
  startedAt: '2026-10-02T19:44:05.235Z', endedAt: '2026-10-02T19:44:09.706Z', costUsd: null, worktreePath: '/w/ca31', hostKind: 'detached',
  logPath: '/r/ca31.log', exitPath: '/r/ca31.exit', specPath: '/r/ca31.json', taskJson: '{}' };
const event = (id: number, kind: string, text: string): RunEventRow => ({ id, runId: run.id, ts: '2026-10-02T19:44:09.705Z', kind, text });
const evidence = (patch: Partial<EvidenceInput> = {}) => buildEvidence({ run, events: [event(1, 'log', 'run-wrapper: agent terminated by signal SIGKILL')],
  log: { text: 'run-wrapper: agent terminated by signal SIGKILL\n', bytes: 49 }, exitText: '1',
  specText: JSON.stringify({ cmd: '/node', args: ['--import', `{"task":${'x'.repeat(1336)}`], cwd: '/w/ca31' }), worktreeExists: true,
  helmsmanRoot: '/src/helmsman', helmsmanCommit: 'abc123', targetRepoPath: '/agents/app', ...patch });
const DIR = '/runs/ca31.postmortem';

describe('post-mortem seed prompt', () => {
  it('summarizes evidence, lists artifacts and states the patch contract', () => {
    const prompt = seedPrompt({ evidence: evidence(), directory: DIR, evidencePath: `${DIR}/evidence.json` });
    for (const text of ['ca31adc3', 'feedback:codex', 'signal SIGKILL', 'exec-kill', '4471 ms', '1: 1344 bytes', `${DIR}/evidence.json`, '/r/ca31.log',
      '/src/helmsman (abc123)', '/agents/app', `${DIR}/patches/<n>-<repo>.patch`, '"baseSha"', 'Never apply patches', EMPTY_OUTPUT_NOTE]) expect(prompt).toContain(text);
    expect(prompt.endsWith(SEED_PROMPT_ENDING)).toBe(true);
    expect(prompt).not.toContain('worktree is missing');
  });

  it('notes a missing worktree and omits the empty-output note when the agent spoke', () => {
    const prompt = seedPrompt({ evidence: evidence({ worktreeExists: false, log: { text: 'Planning the change\n', bytes: 20 } }), directory: DIR, evidencePath: `${DIR}/evidence.json` });
    expect(prompt).toContain("The run's worktree is missing (removed on non-retaining failure)");
    expect(prompt).not.toContain(EMPTY_OUTPUT_NOTE);
  });

  it('includes a bounded prior transcript for a fresh session', () => {
    const prompt = seedPrompt({ evidence: evidence(), directory: DIR, evidencePath: `${DIR}/evidence.json`,
      priorTranscript: [{ role: 'user', kind: 'text', text: 'Why was it killed?' }, { role: 'agent', kind: 'text', text: 'Endpoint protection.' }] });
    expect(prompt).toContain('## Previous post-mortem transcript');
    expect(prompt).toContain('user: Why was it killed?');
  });

  it('respects the size bound for huge evidence', () => {
    const huge = evidence({ events: Array.from({ length: 300 }, (_, index) => event(index, 'log', 'e'.repeat(2000))), log: { text: 'l'.repeat(65_536), bytes: 900_000 },
      specText: JSON.stringify({ cmd: '/node', args: Array.from({ length: 500 }, () => 'a'.repeat(100)), cwd: '/w' }) });
    const prompt = seedPrompt({ evidence: huge, directory: DIR, evidencePath: `${DIR}/evidence.json`,
      priorTranscript: Array.from({ length: 100 }, () => ({ role: 'agent', kind: 'text', text: 't'.repeat(5000) })) });
    expect(prompt.length).toBeLessThanOrEqual(SEED_PROMPT_LIMIT);
    expect(prompt.endsWith(SEED_PROMPT_ENDING)).toBe(true);
  });
});
