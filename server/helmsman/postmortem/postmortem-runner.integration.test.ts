/** @vitest-environment node */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunRow } from '../db';
import { openPersistence } from '../persistence';
import { bashShimPassingLongArgvViaFile } from '../../test-support/argv-shim';
import { gitBin, hasShebangShims } from '../../test-support/platform';
import { createPostmortemRunner, type PostmortemRunner } from './runner';
import { openPostmortemStore, type PostmortemStatus } from './session-store';

const cleanups: Array<() => void> = [];
const runners: PostmortemRunner[] = [];
afterEach(async () => { await Promise.all(runners.splice(0).map(runner => runner.dispose())); for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllEnvs(); });
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const FAKE = `
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const argv = fs.existsSync(process.env.TEST_ARGS_FILE) ? fs.readFileSync(process.env.TEST_ARGS_FILE, 'utf8').split('\\0').filter(Boolean) : [];
const log = value => fs.appendFileSync(process.env.TEST_TRANSCRIPT, JSON.stringify({ id: process.env.TEST_ID, pid: process.pid, ...value }) + '\\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
log({ argv, tmpdir: process.env.TMPDIR });
const act = text => {
  if (!text.includes('write a patch')) return 'noted';
  const denied = path.join(os.homedir(), '.hm-pm-denied-' + process.pid);
  let blocked = false; try { fs.writeFileSync(denied, 'x'); fs.rmSync(denied); } catch { blocked = true; }
  fs.writeFileSync('patches/1-target.patch', 'diff --git a/a.txt b/a.txt\\n--- a/a.txt\\n+++ b/a.txt\\n@@ -1 +1 @@\\n-one\\n+two\\n');
  fs.writeFileSync('patches/1-target.json', JSON.stringify({ repo: 'target', baseSha: process.env.TEST_BASE_SHA, summary: 'fix' }));
  return blocked ? 'outside write denied' : 'outside write allowed';
};
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (process.env.TEST_ID === 'claude') {
    log({ user: message.message.content.slice(-40), session: message.session_id });
    send({ type: 'user', uuid: message.uuid });
    send({ type: 'assistant', message: { content: [{ type: 'text', text: act(message.message.content) }] } });
    return send({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.01 });
  }
  log({ method: message.method, params: message.params });
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-fake-1' } } });
  if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-' + message.id } } });
    const reply = act(message.params.input[0].text);
    send({ method: 'item/completed', params: { threadId: message.params.threadId, item: { id: 'm', type: 'agentMessage', text: reply } } });
    send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'turn-' + message.id, status: 'completed' } } });
  }
});
`;

function setup(limits: { maxTurns?: number; idleMs?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hm-pm-runner-it-'))); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); const repo = join(root, 'target'); mkdirSync(bin); mkdirSync(repo);
  const script = join(root, 'fake.cjs'); writeFileSync(script, FAKE);
  for (const name of ['codex', 'claude']) writeFileSync(join(bin, name), bashShimPassingLongArgvViaFile(script), { mode: 0o755 });
  const git = (...args: string[]) => execFileSync(gitBin(), ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'one\n'); git('add', '.'); git('commit', '-m', 'base');
  const runsDir = join(root, 'runs');
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`); vi.stubEnv('TEST_TRANSCRIPT', 'transcript.jsonl'); vi.stubEnv('TEST_BASE_SHA', git('rev-parse', 'HEAD'));
  const persistence = openPersistence(':memory:'); cleanups.push(() => persistence.close());
  const runs = new Map<string, RunRow>(['codex', 'claude-code'].map(adapter => [adapter, { id: adapter, ticketId: 'T-1', repo: 'org/app', adapter, status: 'failed', attempt: 1,
    prNumber: null, startedAt: '2026-10-02T19:44:05.235Z', endedAt: '2026-10-02T19:44:09.706Z', costUsd: null, worktreePath: null, taskJson: '{}' }]));
  const runner = createPostmortemRunner({ store: openPostmortemStore(persistence), runsDir, helmsmanRoot: root, getRun: id => runs.get(id) ?? null,
    listEvents: () => [], targetRepoPath: () => repo, helmsmanCommit: () => null, modelGateway: () => ({ url: 'http://127.0.0.1:9/', token: 'a'.repeat(64) }),
    revokeGateway: () => {}, assertModelReady: () => {}, git: gitBin(), limits: { idleMs: limits.idleMs ?? 60_000, maxTurns: limits.maxTurns ?? 30, stopGraceMs: 500 } });
  mkdirSync(runsDir); runners.push(runner);
  const status = (id: string, expected: PostmortemStatus) => vi.waitFor(async () => expect((await runner.read(id)).session.status).toBe(expected), { timeout: 15_000, interval: 50 });
  const transcript = (runId: string) => join(runsDir, `${runId}.postmortem`, 'transcript.jsonl');
  const entries = (runId: string) => existsSync(transcript(runId)) ? readFileSync(transcript(runId), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : [];
  return { runner, status, entries, runsDir };
}

describe.skipIf(process.platform !== 'darwin' || !hasShebangShims)('post-mortem runner with sandboxed fake providers', () => {
  it('runs codex: seed, message, idle, resume with the stored thread, patch, stop', async () => {
    const f = setup({ idleMs: 300 });
    const { session } = await f.runner.start('codex'); await f.status(session.id, 'ready');
    await f.runner.send(session.id, { clientId: UUID(1), text: 'Why?' }); await f.status(session.id, 'ready');
    await f.status(session.id, 'idle');
    await f.runner.send(session.id, { clientId: UUID(2), text: 'Now write a patch' }); await f.status(session.id, 'ready');
    const resumed = f.entries('codex').filter(entry => entry.method === 'thread/resume');
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.params).toMatchObject({ threadId: 'thread-fake-1' });
    const snapshot = await f.runner.read(session.id);
    expect(snapshot.messages.map(message => message.text)).toContain('outside write denied');
    expect(snapshot.patches).toEqual([expect.objectContaining({ file: '1-target.patch', valid: true })]);
    expect((await f.runner.stop(session.id)).session.status).toBe('idle');
    const temps = f.entries('codex').filter(entry => 'tmpdir' in entry).map(entry => entry.tmpdir);
    expect(temps.length).toBeGreaterThan(0);
    for (const value of temps) expect(value).toBe(join(f.runsDir, 'codex.postmortem', 'tmp'));
  }, 60_000);

  it('runs claude with --session-id first and --resume after idle', async () => {
    const f = setup({ idleMs: 300 });
    const { session } = await f.runner.start('claude-code'); await f.status(session.id, 'ready');
    await f.status(session.id, 'idle');
    await f.runner.send(session.id, { clientId: UUID(1), text: 'Still there?' }); await f.status(session.id, 'ready');
    const argvs = f.entries('claude-code').filter(entry => Array.isArray(entry.argv)).map(entry => entry.argv as string[]);
    expect(argvs[0]?.slice(argvs[0].indexOf('--session-id'), argvs[0].indexOf('--session-id') + 2)).toEqual(['--session-id', session.providerSessionId]);
    expect(argvs[1]?.slice(argvs[1].indexOf('--resume'), argvs[1].indexOf('--resume') + 2)).toEqual(['--resume', session.providerSessionId]);
  }, 60_000);

  it('caps at the turn limit', async () => {
    const f = setup({ maxTurns: 2 });
    const { session } = await f.runner.start('codex'); await f.status(session.id, 'ready');
    await f.runner.send(session.id, { clientId: UUID(1), text: 'one more' }); await f.status(session.id, 'capped');
    await expect(f.runner.send(session.id, { clientId: UUID(2), text: 'again' })).rejects.toMatchObject({ status: 423 });
  }, 60_000);
});
