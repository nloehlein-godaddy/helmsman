/** @vitest-environment node */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunRow } from '../db';
import { openPersistence, type Persistence } from '../persistence';
import type { ProviderSession } from './provider-session';
import { createPostmortemRunner, postmortemCapabilityId, type LaunchProviderInput, type PostmortemEvent, type PostmortemLimits, type PostmortemRunner } from './runner';
import { SandboxUnavailableError } from './sandbox';
import { openPostmortemStore, type PostmortemStatus } from './session-store';

type Behavior = (text: string, process: FakeProcess) => Promise<{ costUsd: number | null }> | { costUsd: number | null };
class FakeProcess implements ProviderSession {
  readonly input: LaunchProviderInput;
  readonly turns: string[] = [];
  readonly providerSessionId: string;
  closedCalls = 0;
  private readonly behavior: Behavior;
  private readonly closeGate?: Promise<void>;
  private reject: ((error: Error) => void) | null = null;
  private settle!: (error: Error | null) => void;
  readonly closed = new Promise<Error | null>(resolve => { this.settle = resolve; });
  constructor(input: LaunchProviderInput, behavior: Behavior, closeGate?: Promise<void>) {
    this.input = input; this.behavior = behavior; this.closeGate = closeGate; this.providerSessionId = input.providerSessionId ?? 'thread-1';
  }
  turn(text: string) {
    this.turns.push(text);
    return new Promise<{ costUsd: number | null }>((resolve, reject) => { this.reject = reject; Promise.resolve(this.behavior(text, this)).then(resolve, reject); });
  }
  async close() { this.closedCalls += 1; if (this.closeGate) await this.closeGate; this.reject?.(new Error('Agent stopped')); this.settle(null); }
  crash(error: Error) { this.reject?.(error); this.settle(error); }
}
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const run = (id: string, patch: Partial<RunRow> = {}): RunRow => ({ id, ticketId: 'T-1', repo: 'org/app', adapter: 'feedback:codex', status: 'failed', attempt: 1, prNumber: null,
  startedAt: '2026-10-02T19:44:05.235Z', endedAt: '2026-10-02T19:44:09.706Z', costUsd: null, worktreePath: null, taskJson: '{}', ...patch });
const cleanups: Array<() => void> = [];
const runners: PostmortemRunner[] = [];
afterEach(async () => { await Promise.all(runners.splice(0).map(runner => runner.dispose())); for (const cleanup of cleanups.splice(0)) cleanup(); });
const echo: Behavior = (text, process) => { process.input.onItem({ role: 'agent', kind: 'text', text: `reply to ${text.slice(-12)}` }); return { costUsd: 0.1 }; };

function setup(options: { limits?: Partial<PostmortemLimits>; behavior?: Behavior; preflight?: () => Promise<void>; persistence?: Persistence;
  launchGate?: Promise<void>; closeGate?: Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hm-pm-runner-'));
  const persistence = options.persistence ?? openPersistence(':memory:');
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }); if (!options.persistence) persistence.close(); });
  const store = openPostmortemStore(persistence);
  const runs = new Map(['run-1', 'run-2', 'run-3'].map(id => [id, run(id)] as const));
  runs.set('running', run('running', { status: 'running' })); runs.set('claude', run('claude', { adapter: 'pre-pr:claude-code', status: 'stopped' }));
  const launches: FakeProcess[] = []; const revoked: string[] = [];
  let behavior = options.behavior ?? echo;
  const runner = createPostmortemRunner({ store, runsDir: root, helmsmanRoot: root, getRun: id => runs.get(id) ?? null, listEvents: () => [],
    targetRepoPath: () => null, helmsmanCommit: () => 'abc123', modelGateway: id => ({ url: 'http://127.0.0.1:1/', token: id }), revokeGateway: id => revoked.push(id),
    assertModelReady: () => {},
    launch: async input => {
      if (options.launchGate) await options.launchGate;
      const process = new FakeProcess(input, (text, self) => behavior(text, self), options.closeGate);
      launches.push(process); return process;
    },
    preflight: options.preflight ?? (async () => {}), limits: { idleMs: 60_000, stopGraceMs: 10, ...options.limits } });
  runners.push(runner);
  const status = (id: string, expected: PostmortemStatus) => vi.waitFor(async () => expect((await runner.read(id)).session.status).toBe(expected));
  return { root, store, runner, launches, revoked, status, setBehavior: (next: Behavior) => { behavior = next; } };
}

describe('post-mortem runner', () => {
  it('rejects unknown and ineligible runs', async () => {
    const f = setup();
    await expect(f.runner.start('missing')).rejects.toMatchObject({ status: 404 });
    await expect(f.runner.start('running')).rejects.toMatchObject({ status: 409 });
  });

  it('starts with evidence, sends the seed first and becomes ready', async () => {
    const f = setup();
    const started = await f.runner.start('run-1');
    expect(started.session).toMatchObject({ status: 'starting', provider: 'codex', effort: 'high', model: null });
    await f.status(started.session.id, 'ready');
    const directory = join(f.root, 'run-1.postmortem');
    for (const file of ['evidence.json', 'seed.md']) expect(existsSync(join(directory, file))).toBe(true);
    expect(existsSync(`${directory}.sb`)).toBe(true);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(f.launches[0]?.input).toMatchObject({ provider: 'codex', resume: false, providerSessionId: null, directory, gateway: { token: postmortemCapabilityId(started.session.id) } });
    expect(f.launches[0]?.turns[0]).toBe(readFileSync(join(directory, 'seed.md'), 'utf8'));
    const snapshot = await f.runner.read(started.session.id);
    expect(snapshot.session).toMatchObject({ turns: 1, costUsd: 0.1, providerSessionId: 'thread-1' });
    expect(snapshot.messages.map(message => [message.role, message.kind])).toEqual([['agent', 'text']]);
  });

  it('defaults claude runs to claude-code with a pre-assigned session id', async () => {
    const f = setup();
    const started = await f.runner.start('claude');
    await f.status(started.session.id, 'ready');
    expect(started.session.providerSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.launches[0]?.input).toMatchObject({ provider: 'claude-code', resume: false, providerSessionId: started.session.providerSessionId });
  });

  it('reuses the open session without spawning', async () => {
    const f = setup();
    const first = await f.runner.start('run-1'); await f.status(first.session.id, 'ready');
    expect((await f.runner.start('run-1', { provider: 'claude-code' })).session.id).toBe(first.session.id);
    expect(f.launches).toHaveLength(1);
    await expect(f.runner.start('run-1', { fresh: true })).rejects.toMatchObject({ status: 409 });
  });

  it('replayed clientId does not start a second turn', async () => {
    const f = setup();
    const { session } = await f.runner.start('run-1'); await f.status(session.id, 'ready');
    await f.runner.send(session.id, { clientId: UUID(1), text: 'Why SIGKILL?' }); await f.status(session.id, 'ready');
    await f.runner.send(session.id, { clientId: UUID(1), text: 'Why SIGKILL?' });
    expect(f.launches[0]?.turns).toHaveLength(2);
    await expect(f.runner.send(session.id, { clientId: UUID(1), text: 'Different' })).rejects.toMatchObject({ status: 409 });
    await expect(f.runner.send(session.id, { clientId: 'nope', text: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(f.runner.send(session.id, { clientId: UUID(2), text: 'x'.repeat(8001) })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a second message while a turn runs and caps after the turn limit', async () => {
    let release!: () => void;
    const f = setup({ limits: { maxTurns: 2 } });
    const { session } = await f.runner.start('run-1'); await f.status(session.id, 'ready');
    f.setBehavior(() => new Promise(resolve => { release = () => resolve({ costUsd: 0.2 }); }));
    await f.runner.send(session.id, { clientId: UUID(1), text: 'first' });
    await expect(f.runner.send(session.id, { clientId: UUID(2), text: 'second' })).rejects.toMatchObject({ status: 409 });
    release(); await f.status(session.id, 'capped');
    expect(f.launches[0]?.closedCalls).toBe(1);
    await expect(f.runner.send(session.id, { clientId: UUID(3), text: 'third' })).rejects.toMatchObject({ status: 423 });
  });

  it('caps on reported cost', async () => {
    const f = setup({ behavior: () => ({ costUsd: 6 }) });
    const { session } = await f.runner.start('run-1');
    await f.status(session.id, 'capped');
    expect((await f.runner.read(session.id)).session.costUsd).toBe(6);
  });

  it('idles out, revokes the capability and resumes with the stored ids', async () => {
    const f = setup({ limits: { idleMs: 20 } });
    const events: PostmortemEvent[] = [];
    const { session } = await f.runner.start('run-1'); f.runner.subscribe(session.id, event => events.push(event));
    await f.status(session.id, 'idle');
    expect(f.revoked).toContain(postmortemCapabilityId(session.id));
    expect(f.runner.isLiveCapability(postmortemCapabilityId(session.id))).toBe(false);
    await f.runner.send(session.id, { clientId: UUID(1), text: 'Still there?' });
    await vi.waitFor(() => expect(f.launches[1]?.turns).toEqual(['Still there?']));
    expect(f.launches[1]?.input).toMatchObject({ resume: true, providerSessionId: 'thread-1' });
    expect(events.some(event => event.type === 'status' && event.activity === 'resuming')).toBe(true);
  });

  it('limits live processes', async () => {
    const f = setup();
    for (const id of ['run-1', 'run-2']) await f.status((await f.runner.start(id)).session.id, 'ready');
    await expect(f.runner.start('run-3')).rejects.toMatchObject({ status: 429 });
    expect(f.store.open('run-3')).toBeNull();
  });

  it('returns 412 when the sandbox is unavailable', async () => {
    let available = true;
    const f = setup({ limits: { idleMs: 20 }, preflight: async () => { if (!available) throw new SandboxUnavailableError('no seatbelt'); } });
    const { session } = await f.runner.start('run-1'); await f.status(session.id, 'idle');
    available = false;
    await expect(f.runner.start('run-2')).rejects.toMatchObject({ status: 412 });
    await expect(f.runner.send(session.id, { clientId: UUID(1), text: 'resume' })).rejects.toMatchObject({ status: 412 });
    expect(f.store.messages(session.id).some(message => message.role === 'user')).toBe(false);
  });

  it('records provider failure as a resumable error that reseeds when the seed never completed', async () => {
    const f = setup({ behavior: () => { throw new Error('model unavailable'); } });
    const { session } = await f.runner.start('claude'); await f.status(session.id, 'error');
    const failed = await f.runner.read(session.id);
    expect(failed.session.error).toBe('model unavailable');
    expect(failed.messages.at(-1)).toMatchObject({ role: 'system', kind: 'error', text: 'model unavailable' });
    f.setBehavior(echo);
    await f.runner.send(session.id, { clientId: UUID(1), text: 'Try again' }); await f.status(session.id, 'ready');
    expect(f.launches[1]?.input).toMatchObject({ resume: false });
    expect(f.launches[1]?.input.providerSessionId).not.toBe(session.providerSessionId);
    expect(f.launches[1]?.turns[0]).toMatch(/Give your diagnosis first[\s\S]*Try again$/);
  });

  it('stops to idle and becomes idle when the process dies while ready', async () => {
    const f = setup();
    const { session } = await f.runner.start('run-1'); await f.status(session.id, 'ready');
    expect((await f.runner.stop(session.id)).session.status).toBe('idle');
    expect(f.launches[0]?.closedCalls).toBe(1);
    await f.runner.send(session.id, { clientId: UUID(1), text: 'again' }); await f.status(session.id, 'ready');
    f.launches[1]?.crash(new Error('Agent exited 1'));
    await f.status(session.id, 'idle');
  });

  it('seeds a fresh session with the prior transcript', async () => {
    const f = setup({ behavior: () => { throw new Error('session pruned'); } });
    const { session } = await f.runner.start('run-1'); await f.status(session.id, 'error');
    f.setBehavior(echo);
    const fresh = await f.runner.start('run-1', { fresh: true });
    expect(fresh.session.id).not.toBe(session.id);
    await f.status(fresh.session.id, 'ready');
    expect(f.launches[1]?.turns[0]).toContain('## Previous post-mortem transcript');
    expect((await f.runner.read(session.id)).session.status).toBe('error');
  });

  it('sweeps live sessions to idle when constructed', async () => {
    const persistence = openPersistence(':memory:'); cleanups.push(() => persistence.close());
    const store = openPostmortemStore(persistence);
    const stale = store.create({ runId: 'run-1', provider: 'codex', model: null, effort: 'high', providerSessionId: null });
    store.transition(stale.id, 'busy');
    const f = setup({ persistence });
    expect((await f.runner.read(stale.id)).session.status).toBe('idle');
  });

  it('rejects a send racing a stop during spawn and never launches a second process', async () => {
    let releaseLaunch!: () => void;
    const gate = new Promise<void>(resolve => { releaseLaunch = resolve; });
    const f = setup({ launchGate: gate });
    const started = await f.runner.start('run-1');
    expect(started.session.status).toBe('starting');
    expect((await f.runner.stop(started.session.id)).session.status).toBe('idle');
    await expect(f.runner.send(started.session.id, { clientId: UUID(1), text: 'hi' })).rejects.toMatchObject({ status: 409 });
    releaseLaunch();
    await f.status(started.session.id, 'idle');
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]?.turns).toHaveLength(0);
    expect(f.launches[0]?.closedCalls).toBe(1);
  });

  it('rejects send while the live process is still closing', async () => {
    let releaseClose!: () => void;
    const gate = new Promise<void>(resolve => { releaseClose = resolve; });
    const f = setup({ closeGate: gate });
    const { session } = await f.runner.start('run-1'); await f.status(session.id, 'ready');
    const stopping = f.runner.stop(session.id);
    await vi.waitFor(() => expect(f.launches[0]?.closedCalls).toBe(1));
    expect((await f.runner.read(session.id)).session.status).toBe('ready');
    await expect(f.runner.send(session.id, { clientId: UUID(1), text: 'hi' })).rejects.toMatchObject({ status: 409 });
    releaseClose();
    await stopping;
  });

  it('rejects send once the cap is reached while status drifted to idle', async () => {
    const f = setup({ limits: { idleMs: 20 } });
    const { session } = await f.runner.start('run-1'); await f.status(session.id, 'idle');
    f.store.update(session.id, { turns: 30 });
    await expect(f.runner.send(session.id, { clientId: UUID(1), text: 'x' })).rejects.toMatchObject({ status: 423 });
  });

  it('rejects send once the cap is reached while status drifted to error', async () => {
    const f = setup({ behavior: () => { throw new Error('boom'); } });
    const { session } = await f.runner.start('run-1'); await f.status(session.id, 'error');
    f.store.update(session.id, { turns: 30 });
    await expect(f.runner.send(session.id, { clientId: UUID(1), text: 'x' })).rejects.toMatchObject({ status: 423 });
  });

  it('closes a process launched during dispose and never adopts it', async () => {
    let releaseLaunch!: () => void;
    const gate = new Promise<void>(resolve => { releaseLaunch = resolve; });
    const f = setup({ launchGate: gate });
    const started = await f.runner.start('run-1');
    const disposing = f.runner.dispose();
    releaseLaunch();
    await disposing;
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]?.turns).toHaveLength(0);
    expect(f.launches[0]?.closedCalls).toBe(1);
    expect(f.runner.isLiveCapability(postmortemCapabilityId(started.session.id))).toBe(false);
    expect((await f.runner.read(started.session.id)).session.status).toBe('idle');
    await expect(f.runner.start('run-2')).rejects.toMatchObject({ status: 503 });
    await expect(f.runner.send(started.session.id, { clientId: UUID(1), text: 'x' })).rejects.toMatchObject({ status: 503 });
  });

  it('rejects a start parked in sandboxReady once dispose fires, without leaking its slot', async () => {
    let releasePreflight!: () => void;
    const gate = new Promise<void>(resolve => { releasePreflight = resolve; });
    const f = setup({ limits: { maxLive: 1 }, preflight: async () => { await gate; } });
    const starting = f.runner.start('run-1');
    await expect(f.runner.start('run-2')).rejects.toMatchObject({ status: 429 });
    const disposing = f.runner.dispose();
    releasePreflight();
    await expect(starting).rejects.toMatchObject({ status: 503 });
    await disposing;
    expect(f.launches).toHaveLength(0);
  });

  it('rejects a send resume parked in sandboxReady once dispose fires, without leaking its slot', async () => {
    let gateSend = false;
    let releasePreflight!: () => void;
    let preflightGate = Promise.resolve();
    const f = setup({ limits: { idleMs: 20, maxLive: 1 }, preflight: async () => { if (gateSend) await preflightGate; } });
    const { session } = await f.runner.start('run-1'); await f.status(session.id, 'idle');
    preflightGate = new Promise(resolve => { releasePreflight = resolve; });
    gateSend = true;
    const sending = f.runner.send(session.id, { clientId: UUID(1), text: 'hi' });
    await expect(f.runner.start('run-2')).rejects.toMatchObject({ status: 429 });
    const disposing = f.runner.dispose();
    releasePreflight();
    await expect(sending).rejects.toMatchObject({ status: 503 });
    await disposing;
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]?.turns).toHaveLength(1);
  });

  it('keeps a fresh subscriber alive after a stale unsubscribe double-call', async () => {
    const f = setup();
    const { session } = await f.runner.start('run-1'); await f.status(session.id, 'ready');
    const oldEvents: PostmortemEvent[] = [];
    const unsubOld = f.runner.subscribe(session.id, event => oldEvents.push(event));
    unsubOld();
    const newEvents: PostmortemEvent[] = [];
    f.runner.subscribe(session.id, event => newEvents.push(event));
    unsubOld();
    await f.runner.send(session.id, { clientId: UUID(1), text: 'hi' });
    await f.status(session.id, 'ready');
    expect(newEvents.length).toBeGreaterThan(0);
  });

  it('accumulates cost across a resume on top of the stored base', async () => {
    const f = setup({ behavior: () => ({ costUsd: 0.4 }) });
    const { session } = await f.runner.start('run-1'); await f.status(session.id, 'ready');
    expect((await f.runner.read(session.id)).session.costUsd).toBe(0.4);
    await f.runner.stop(session.id);
    await f.runner.send(session.id, { clientId: UUID(1), text: 'again' });
    await f.status(session.id, 'ready');
    expect((await f.runner.read(session.id)).session.costUsd).toBeCloseTo(0.8);
  });
});

describe('post-mortem limits from env', () => {
  it('reads valid overrides and ignores invalid ones', async () => {
    const { postmortemLimitsFromEnv } = await import('./runner');
    expect(postmortemLimitsFromEnv({ HELMSMAN_POSTMORTEM_MAX_TURNS: '10', HELMSMAN_POSTMORTEM_MAX_COST_USD: '2.5', HELMSMAN_POSTMORTEM_IDLE_MINUTES: '1', HELMSMAN_POSTMORTEM_MAX_LIVE: '3' }))
      .toEqual({ maxTurns: 10, maxCostUsd: 2.5, idleMs: 60_000, maxLive: 3 });
    expect(postmortemLimitsFromEnv({ HELMSMAN_POSTMORTEM_MAX_TURNS: '0.5', HELMSMAN_POSTMORTEM_MAX_COST_USD: '-1', HELMSMAN_POSTMORTEM_IDLE_MINUTES: 'x', HELMSMAN_POSTMORTEM_MAX_LIVE: '' })).toEqual({});
  });
});
