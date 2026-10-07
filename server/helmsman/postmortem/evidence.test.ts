/** @vitest-environment node */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunEventRow, RunRow } from '../db';
import { buildEvidence, readEvidenceInput, redactText, writeEvidenceFile, type EvidenceInput, type PostmortemSignature } from './evidence';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const RUN_ID = 'ca31adc3-bef2-47e6-b70a-ac53d67a1b03';
const run = (patch: Partial<RunRow> = {}): RunRow => ({ id: RUN_ID, ticketId: 'rerun', repo: 'gdcorp-partners/airo-app-builder', adapter: 'feedback:codex', status: 'failed', attempt: 1,
  prNumber: null, startedAt: '2026-10-02T19:44:05.235Z', endedAt: '2026-10-02T19:44:09.706Z', costUsd: null, worktreePath: '/w/ca31', hostKind: 'detached',
  logPath: '/r/ca31.log', exitPath: '/r/ca31.exit', specPath: '/r/ca31.json',
  taskJson: JSON.stringify({ ticketId: 'rerun', modelRouting: { token: 'abc' }, publicationToken: 'xyz', nested: [{ dockerCapability: 'cap' }], title: 'Bearer abcdefghijklmnop' }), ...patch });
let nextId = 1;
const event = (kind: string, text: string): RunEventRow => ({ id: nextId++, runId: RUN_ID, ts: '2026-10-02T19:44:09.705Z', kind, text });
const killed = [event('log', 'run-wrapper: agent terminated by signal SIGKILL'), event('error', 'Agent process exited with code 1'),
  event('phase', 'Worktree retained for inspection: /w/ca31'), event('run-complete', 'failed')];
const longArg = `{"task":${'x'.repeat(1336)} ghp_abcdefghijklmnopqrst`;
const input = (patch: Partial<EvidenceInput> = {}): EvidenceInput => ({ run: run(), events: killed, log: { text: 'run-wrapper: agent terminated by signal SIGKILL\n', bytes: 49 },
  exitText: '1\n', specText: JSON.stringify({ cmd: '/node', args: ['--import', 'file:///x/tsx', '/x/feedback-update-cli.ts', longArg, '--input=abc'], cwd: '/w/ca31' }),
  worktreeExists: true, helmsmanRoot: '/h', helmsmanCommit: 'abc123', targetRepoPath: '/agents/airo-app-builder', ...patch });

describe('post-mortem evidence', () => {
  it('derives the exec-kill shape of the 2026-10-02 incident', () => {
    const evidence = buildEvidence(input());
    expect(evidence.signatures).toEqual(['exec-kill']);
    expect(evidence.exit).toEqual({ code: 1, signal: 'SIGKILL' });
    expect(evidence.run.durationMs).toBe(4471);
    expect(evidence.agentOutput).toBe(false);
    expect(evidence.spec?.args.map(arg => arg.length)).toEqual([8, 13, 25, Buffer.byteLength(longArg), 11]);
    expect(evidence.spec?.args[3]?.preview).toBe(longArg.slice(0, 40));
    expect(evidence.spec?.args[4]?.preview).toBeNull();
    expect(evidence.worktree).toEqual({ path: '/w/ca31', state: 'present', reason: null });
    expect(evidence.host).toBe('detached');
  });

  it.each<[PostmortemSignature, Partial<EvidenceInput>]>([
    ['spawn-failed', { events: [event('log', 'run-wrapper: cannot start codex: ENOENT')], log: null, exitText: '127' }],
    ['stage-timeout', { events: [event('error', 'Agent stage timed out')], log: { text: 'working\n', bytes: 8 } }],
    ['cost-cap', { events: [event('log', 'cost cap reached, no further attempts')], log: { text: 'working\n', bytes: 8 } }],
    ['clarification-unanswered', { events: [event('error', 'Required clarification has no answer; task cannot complete')], log: { text: 'working\n', bytes: 8 } }],
    ['snapshot-mismatch', { events: [event('error', 'Prompt implementation does not match the saved workflow snapshot; explicit continuation is required to upgrade it.')], log: { text: 'working\n', bytes: 8 } }],
    ['gate-blocked', { events: [event('error', 'Clarification publication gate did not pass; publication blocked. x')], log: { text: 'working\n', bytes: 8 } }],
  ])('fires only %s for its fixture', (signature, patch) => {
    expect(buildEvidence(input({ exitText: '1', run: run({ endedAt: '2026-10-02T19:54:09.706Z' }), ...patch })).signatures).toEqual([signature]);
  });

  it('does not report exec-kill when the agent produced output or ran long', () => {
    expect(buildEvidence(input({ log: { text: 'Thinking about it\nrun-wrapper: agent terminated by signal SIGKILL\n', bytes: 60 } })).signatures).toEqual([]);
    expect(buildEvidence(input({ run: run({ endedAt: '2026-10-02T19:44:15.000Z' }) })).signatures).toEqual([]);
  });

  it('keeps the last 200 events but scans all of them for signatures', () => {
    const many = [event('error', 'Agent stage timed out'), ...Array.from({ length: 249 }, (_, index) => event('log', `line ${index}`))];
    const evidence = buildEvidence(input({ events: many, log: null }));
    expect(evidence.events).toHaveLength(200);
    expect(evidence.eventsTotal).toBe(250);
    expect(evidence.signatures).toContain('stage-timeout');
  });

  it.each([
    [{ worktreeExists: false }, { state: 'missing', reason: 'swept at startup' }],
    [{ worktreeExists: false, events: [event('log', 'x')] }, { state: 'missing', reason: 'removed on non-retaining failure' }],
    [{ worktreeExists: false, run: run({ worktreePath: null }) }, { state: 'missing', reason: 'no worktree recorded' }],
  ])('records a missing worktree with its reason', (patch, expected) => {
    expect(buildEvidence(input(patch as Partial<EvidenceInput>)).worktree).toMatchObject(expected);
  });

  it('redacts secrets from task, events, log and spec previews', () => {
    const secrets = ['ghp_abcdefghijklmnopqrst', 'github_pat_11ABCDEFG0123456789_abcdef', 'sk-proj-abcdefghijklmnop', 'xoxb-1234-5678-abcdefgh', 'abcdefghijklmnop'];
    const evidence = buildEvidence(input({
      events: [event('log', `token ${secrets[0]} and ${secrets[1]}`), event('log', `key ${secrets[2]}`)],
      log: { text: `Authorization: Bearer ${secrets[4]}\nslack ${secrets[3]}\n`, bytes: 80 },
      specText: JSON.stringify({ cmd: '/node', args: [`${secrets[0]} trailing text that is long`], cwd: '/w' }) }));
    const serialized = JSON.stringify(evidence);
    for (const secret of [...secrets, 'xyz', '"abc"', '"cap"']) expect(serialized).not.toContain(secret);
    expect(evidence.task).toMatchObject({ modelRouting: { token: '[redacted]' }, publicationToken: '[redacted]', nested: [{ dockerCapability: '[redacted]' }] });
    expect(redactText('plain text')).toBe('plain text');
  });

  it('tolerates malformed task, spec and exit content', () => {
    const evidence = buildEvidence(input({ run: run({ taskJson: '{not json' }), specText: '[1,2]', exitText: 'nope' }));
    expect(evidence.task).toBeNull();
    expect(evidence.spec).toBeNull();
    expect(evidence.exit.code).toBeNull();
  });

  it('reads only the log tail and writes evidence with private permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'hm-pm-evidence-')); roots.push(root);
    const logPath = join(root, 'run.log'); writeFileSync(logPath, `${'run-wrapper: padding\n'.repeat(3500)}run-wrapper: agent terminated by signal SIGKILL\n`);
    writeFileSync(join(root, 'run.exit'), '1');
    const read = readEvidenceInput(run({ logPath, exitPath: join(root, 'run.exit'), specPath: join(root, 'missing.json'), worktreePath: join(root, 'gone') }),
      { listEvents: () => killed, helmsmanRoot: '/h', helmsmanCommit: null, targetRepoPath: null });
    expect(read.log?.text.length).toBe(65_536);
    expect(read.log?.bytes).toBe(73_548);
    expect(read.specText).toBeNull();
    expect(read.worktreeExists).toBe(false);
    const path = writeEvidenceFile(root, buildEvidence(read));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).signatures).toEqual(['exec-kill']);
  });
});
