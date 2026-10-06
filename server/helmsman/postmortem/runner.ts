import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RunEventRow, RunRow } from '../db';
import { prepareModelRouting } from '../model-routing-cli';
import { buildEvidence, readEvidenceInput, writeEvidenceFile } from './evidence';
import { listPatches, type PostmortemPatch } from './patches';
import { seedPrompt } from './prompt';
import { openProviderSession, providerCommand, providerTransport, type ProviderItem, type ProviderSession } from './provider-session';
import { preflightSandbox, resolveSandboxPaths, sandboxCommand, SandboxUnavailableError, scrubEnvironment, writeSandboxProfile } from './sandbox';
import { capReached, PostmortemError, type PostmortemKind, type PostmortemMessage, type PostmortemProvider, type PostmortemRole, type PostmortemSession,
  type PostmortemStatus, type PostmortemStore } from './session-store';

export type PostmortemActivity = 'starting' | 'resuming' | 'thinking' | null;
export interface PostmortemSnapshot { session: PostmortemSession; activity: PostmortemActivity; messages: PostmortemMessage[]; patches: PostmortemPatch[] }
export type PostmortemEvent = { type: 'snapshot'; snapshot: PostmortemSnapshot } | { type: 'message'; message: PostmortemMessage }
  | { type: 'status'; session: PostmortemSession; activity: PostmortemActivity } | { type: 'patches'; patches: PostmortemPatch[] };
export interface PostmortemLimits { maxTurns: number; maxCostUsd: number; idleMs: number; maxLive: number; stopGraceMs: number }
export const DEFAULT_POSTMORTEM_LIMITS: PostmortemLimits = { maxTurns: 30, maxCostUsd: 5, idleMs: 900_000, maxLive: 2, stopGraceMs: 5000 };
export const POSTMORTEM_TEXT_LIMIT = 8000;
export interface StartPostmortemInput { provider?: PostmortemProvider; model?: string | null; effort?: string | null; fresh?: boolean }
export interface LaunchProviderInput {
  provider: PostmortemProvider; model: string | null; effort: string | null; repo: string; directory: string; profilePath: string;
  providerSessionId: string | null; resume: boolean; gateway: { url: string; token: string }; stopGraceMs: number; onItem(item: ProviderItem): void;
}
export interface PostmortemRunnerDeps {
  store: PostmortemStore; runsDir: string; helmsmanRoot: string;
  getRun(runId: string): RunRow | null; listEvents(runId: string): RunEventRow[]; targetRepoPath(run: RunRow): string | null; helmsmanCommit(): string | null;
  modelGateway(capabilityId: string): { url: string; token: string }; revokeGateway(capabilityId: string): void; assertModelReady(): void;
  launch?: (input: LaunchProviderInput) => Promise<ProviderSession>; preflight?: (profilePath: string) => Promise<void>;
  limits?: Partial<PostmortemLimits>; git?: string;
}
export type PostmortemRunner = ReturnType<typeof createPostmortemRunner>;
interface LiveProcess { process: ProviderSession; idle: ReturnType<typeof setTimeout> | null; stopping: boolean; baseCost: number }
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function postmortemCapabilityId(sessionId: string): string { return `pm-${sessionId}`; }

export async function launchSandboxedProvider(input: LaunchProviderInput): Promise<ProviderSession> {
  const command = providerCommand({ provider: input.provider, model: input.model, effort: input.effort, repo: input.repo,
    sessionId: input.provider === 'claude-code' ? input.providerSessionId : null, resume: input.resume });
  const routed = await prepareModelRouting({ version: 1, command, transport: providerTransport(input.provider), modelGateway: input.gateway, skillsPath: null },
    { home: join(input.directory, 'provider-home', input.provider) });
  return openProviderSession({ provider: input.provider, command: sandboxCommand(routed.command, input.profilePath), env: scrubEnvironment(routed.environment),
    cwd: input.directory, model: input.model, effort: input.effort, providerSessionId: input.providerSessionId, resume: input.resume, onItem: input.onItem,
    stopGraceMs: input.stopGraceMs });
}

export function createPostmortemRunner(deps: PostmortemRunnerDeps) {
  const limits: PostmortemLimits = { ...DEFAULT_POSTMORTEM_LIMITS, ...deps.limits };
  const launch = deps.launch ?? launchSandboxedProvider;
  const preflight = deps.preflight ?? (path => preflightSandbox(path));
  const live = new Map<string, LiveProcess>();
  const slots = new Set<symbol>();
  const spawning = new Set<string>();
  const stopRequested = new Set<string>();
  const activity = new Map<string, PostmortemActivity>();
  const patchCache = new Map<string, PostmortemPatch[]>();
  const listeners = new Map<string, Set<(event: PostmortemEvent) => void>>();
  const pending = new Map<string, Promise<void>>();
  let disposed = false;
  deps.store.sweep();

  function background(sessionId: string, promise: Promise<void>): void {
    pending.set(sessionId, promise);
    void promise.finally(() => { if (pending.get(sessionId) === promise) pending.delete(sessionId); });
  }

  const directoryFor = (runId: string) => resolve(deps.runsDir, `${runId}.postmortem`);
  const emit = (sessionId: string, event: PostmortemEvent) => { for (const listener of listeners.get(sessionId) ?? []) { try { listener(event); } catch {} } };
  const required = (sessionId: string) => { const session = deps.store.get(sessionId); if (!session) throw new PostmortemError(404, 'Post-mortem not found'); return session; };
  const runOf = (session: PostmortemSession) => { const run = deps.getRun(session.runId); if (!run) throw new PostmortemError(404, 'Run not found'); return run; };
  const repos = (run: RunRow) => ({ helmsman: deps.helmsmanRoot, target: deps.targetRepoPath(run) });
  const announce = (sessionId: string, next: PostmortemActivity) => { activity.set(sessionId, next); emit(sessionId, { type: 'status', session: required(sessionId), activity: next }); };
  const setStatus = (sessionId: string, status: PostmortemStatus, patch: { error?: string } = {}, next: PostmortemActivity = null) => {
    const session = deps.store.transition(sessionId, status, patch); activity.set(sessionId, next); emit(sessionId, { type: 'status', session, activity: next }); return session;
  };
  const record = (sessionId: string, item: { role: PostmortemRole; kind: PostmortemKind; text: string; clientId?: string }) => {
    const result = deps.store.append(sessionId, item);
    if (!result.duplicate) emit(sessionId, { type: 'message', message: result.message });
    return result;
  };
  function reserve(): symbol {
    if (live.size + slots.size >= limits.maxLive) throw new PostmortemError(429, `At most ${limits.maxLive} post-mortems can run at once. Stop one and try again.`);
    const slot = Symbol('postmortem-slot'); slots.add(slot); return slot;
  }
  function modelReady(): void {
    try { deps.assertModelReady(); } catch (error) { throw new PostmortemError(503, errorText(error)); }
  }
  async function sandboxReady(directory: string): Promise<string> {
    mkdirSync(join(directory, 'patches'), { recursive: true, mode: 0o700 });
    const profilePath = writeSandboxProfile(resolveSandboxPaths(directory, deps.helmsmanRoot));
    try { await preflight(profilePath); }
    catch (error) { throw new PostmortemError(412, error instanceof SandboxUnavailableError ? error.message : `Sandbox unavailable: ${errorText(error)}`); }
    return profilePath;
  }
  function prepare(run: RunRow, priorTranscript?: PostmortemMessage[]): string {
    const directory = directoryFor(run.id);
    mkdirSync(join(directory, 'patches'), { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    const evidence = buildEvidence(readEvidenceInput(run, { listEvents: deps.listEvents, helmsmanRoot: deps.helmsmanRoot, helmsmanCommit: deps.helmsmanCommit(), targetRepoPath: deps.targetRepoPath(run) }));
    const seed = seedPrompt({ evidence, directory, evidencePath: writeEvidenceFile(directory, evidence), priorTranscript });
    writeFileSync(join(directory, 'seed.md'), seed, { mode: 0o600 });
    return seed;
  }
  const seedFor = (run: RunRow) => { try { return readFileSync(join(directoryFor(run.id), 'seed.md'), 'utf8'); } catch { return prepare(run); } };
  async function patches(session: PostmortemSession): Promise<PostmortemPatch[]> {
    const cached = patchCache.get(session.id); if (cached) return cached;
    const run = deps.getRun(session.runId);
    const list = run ? await listPatches(directoryFor(run.id), repos(run), deps.git) : [];
    patchCache.set(session.id, list); return list;
  }
  async function rescan(session: PostmortemSession): Promise<void> {
    const run = deps.getRun(session.runId); if (!run) return;
    const list = await listPatches(directoryFor(run.id), repos(run), deps.git);
    const announced = new Set(deps.store.messages(session.id).filter(message => message.kind === 'patch').map(message => message.text.split(' ')[2]));
    for (const patch of list) if (!announced.has(patch.file)) record(session.id, { role: 'system', kind: 'patch',
      text: `Proposed patch ${patch.file} (${patch.repo}${patch.baseSha ? ` @ ${patch.baseSha.slice(0, 12)}` : ''}): ${patch.valid ? 'valid' : `invalid: ${patch.reason}`}` });
    patchCache.set(session.id, list);
    emit(session.id, { type: 'patches', patches: list });
  }
  async function snapshot(sessionId: string): Promise<PostmortemSnapshot> {
    const session = required(sessionId);
    return { session, activity: activity.get(sessionId) ?? null, messages: deps.store.messages(sessionId), patches: await patches(session) };
  }
  async function shutdown(sessionId: string): Promise<void> {
    const entry = live.get(sessionId); if (!entry) return;
    entry.stopping = true; if (entry.idle) clearTimeout(entry.idle); entry.idle = null;
    await entry.process.close();
  }
  function exited(sessionId: string, entry: LiveProcess): void {
    if (live.get(sessionId) !== entry) return;
    live.delete(sessionId); if (entry.idle) clearTimeout(entry.idle);
    deps.revokeGateway(postmortemCapabilityId(sessionId));
    const status = deps.store.get(sessionId)?.status;
    if (status === 'ready' || status === 'busy' && entry.stopping) setStatus(sessionId, 'idle');
  }
  async function drive(sessionId: string, text: string | null, slot: symbol | null, firstLaunch: boolean): Promise<void> {
    let entry = live.get(sessionId);
    let granted = false;
    try {
      let session = required(sessionId);
      const run = runOf(session);
      if (!entry) {
        const fresh = session.turns === 0 || !session.providerSessionId;
        const providerSessionId = !fresh ? session.providerSessionId : session.provider === 'codex' ? null : firstLaunch ? session.providerSessionId : randomUUID();
        if (providerSessionId !== session.providerSessionId) session = deps.store.update(sessionId, { providerSessionId });
        const directory = directoryFor(run.id);
        spawning.add(sessionId);
        let spawned: ProviderSession;
        try {
          const gateway = deps.modelGateway(postmortemCapabilityId(sessionId));
          granted = true;
          spawned = await launch({ provider: session.provider, model: session.model, effort: session.effort, repo: run.repo, directory,
            profilePath: writeSandboxProfile(resolveSandboxPaths(directory, deps.helmsmanRoot)), providerSessionId, resume: !fresh,
            gateway, stopGraceMs: limits.stopGraceMs, onItem: item => record(sessionId, item) });
        } finally { spawning.delete(sessionId); }
        if (live.get(sessionId) || disposed) {
          if (slot) slots.delete(slot);
          const alreadyLive = Boolean(live.get(sessionId));
          if (!alreadyLive) deps.revokeGateway(postmortemCapabilityId(sessionId));
          if (disposed && !alreadyLive) { try { setStatus(sessionId, 'idle'); } catch {} }
          try { await spawned.close(); } catch {}
          return;
        }
        const created: LiveProcess = { process: spawned, idle: null, stopping: false, baseCost: session.costUsd ?? 0 };
        entry = created;
        live.set(sessionId, created);
        if (slot) slots.delete(slot);
        void spawned.closed.then(() => exited(sessionId, created));
        session = deps.store.update(sessionId, { providerSessionId: spawned.providerSessionId });
        if (stopRequested.delete(sessionId)) { await shutdown(sessionId); return; }
      } else if (slot) slots.delete(slot);
      const prompt = session.turns === 0 ? [seedFor(run), text].filter(Boolean).join('\n\n---\n\n') : text ?? '';
      if (session.status === 'starting') session = setStatus(sessionId, 'busy', {}, 'thinking'); else announce(sessionId, 'thinking');
      const result = await entry.process.turn(prompt);
      session = deps.store.update(sessionId, { turns: required(sessionId).turns + 1, costUsd: result.costUsd === null ? session.costUsd : entry.baseCost + result.costUsd });
      if (capReached(session, limits)) {
        try { await rescan(session); } catch {}
        setStatus(sessionId, 'capped');
        await shutdown(sessionId);
        return;
      }
      await rescan(session);
      setStatus(sessionId, 'ready');
      const idleEntry = entry;
      idleEntry.idle = setTimeout(() => { void shutdown(sessionId); }, limits.idleMs);
      idleEntry.idle.unref?.();
    } catch (error) {
      if (slot) slots.delete(slot);
      stopRequested.delete(sessionId);
      if (!entry && granted) deps.revokeGateway(postmortemCapabilityId(sessionId));
      const current = deps.store.get(sessionId);
      if (entry?.stopping || !current || current.status === 'idle' || current.status === 'capped') return;
      setStatus(sessionId, 'error', { error: errorText(error) });
      record(sessionId, { role: 'system', kind: 'error', text: errorText(error) });
      await shutdown(sessionId);
    }
  }
  return {
    async start(runId: string, input: StartPostmortemInput = {}): Promise<PostmortemSnapshot> {
      if (disposed) throw new PostmortemError(503, 'Post-mortem runner is shutting down.');
      const run = deps.getRun(runId);
      if (!run) throw new PostmortemError(404, 'Run not found');
      if (run.status !== 'failed' && run.status !== 'stopped') throw new PostmortemError(409, 'Only failed or stopped runs can be investigated');
      const open = deps.store.open(runId);
      if (open && input.fresh) throw new PostmortemError(409, 'This run already has an open post-mortem');
      if (open) return snapshot(open.id);
      const provider = input.provider ?? (run.adapter.replace(/^(?:pre-pr|feedback):/, '') === 'claude-code' ? 'claude-code' : 'codex');
      const model = input.model ?? null; const effort = input.effort === undefined ? 'high' : input.effort;
      try { providerCommand({ provider, model, effort, repo: run.repo, sessionId: randomUUID(), resume: false }); }
      catch (error) { throw new PostmortemError(400, errorText(error)); }
      modelReady();
      const slot = reserve();
      try {
        const prior = input.fresh ? deps.store.latest(runId) : null;
        prepare(run, prior ? deps.store.messages(prior.id) : undefined);
        await sandboxReady(directoryFor(runId));
        if (disposed) throw new PostmortemError(503, 'Post-mortem runner is shutting down.');
        let session: PostmortemSession;
        try { session = deps.store.create({ runId, provider, model, effort, providerSessionId: provider === 'claude-code' ? randomUUID() : null }); }
        catch (error) {
          const existing = deps.store.open(runId);
          if (error instanceof PostmortemError && error.status === 409 && existing) { slots.delete(slot); return snapshot(existing.id); }
          throw error;
        }
        activity.set(session.id, 'starting');
        background(session.id, drive(session.id, null, slot, true));
        return snapshot(session.id);
      } catch (error) { slots.delete(slot); throw error; }
    },
    read: snapshot,
    async send(sessionId: string, input: { clientId: unknown; text: unknown }): Promise<PostmortemSnapshot> {
      if (disposed) throw new PostmortemError(503, 'Post-mortem runner is shutting down.');
      const session = required(sessionId);
      const { clientId, text } = input;
      if (typeof clientId !== 'string' || !UUID.test(clientId) || typeof text !== 'string' || !text.trim() || text.length > POSTMORTEM_TEXT_LIMIT) {
        throw new PostmortemError(400, `Enter a message of 1–${POSTMORTEM_TEXT_LIMIT} characters with a valid message ID.`);
      }
      const previous = deps.store.messages(sessionId).find(message => message.clientId === clientId);
      if (previous && previous.text !== text) throw new PostmortemError(409, 'Message ID already belongs to a different message');
      if (previous) return snapshot(sessionId);
      if (session.status === 'capped' || capReached(session, limits)) throw new PostmortemError(423, 'This post-mortem reached its cap. Start a new post-mortem to continue.');
      if (session.status === 'busy' || session.status === 'starting') throw new PostmortemError(409, 'Wait for the current turn to finish.');
      if (pending.has(sessionId) || live.get(sessionId)?.stopping) throw new PostmortemError(409, 'Wait for the current turn to finish.');
      const resuming = !live.has(sessionId);
      let slot: symbol | null = null;
      if (resuming) {
        modelReady();
        slot = reserve();
        try { await sandboxReady(directoryFor(runOf(session).id)); } catch (error) { slots.delete(slot); throw error; }
        if (disposed) { slots.delete(slot); throw new PostmortemError(503, 'Post-mortem runner is shutting down.'); }
        const retried = deps.store.messages(sessionId).find(message => message.clientId === clientId);
        if (retried && retried.text !== text) { slots.delete(slot); throw new PostmortemError(409, 'Message ID already belongs to a different message'); }
        if (retried) { slots.delete(slot); return snapshot(sessionId); }
      }
      try {
        const current = required(sessionId);
        if (current.status === 'busy' || current.status === 'starting') throw new PostmortemError(409, 'Wait for the current turn to finish.');
        if (current.status === 'capped') throw new PostmortemError(423, 'This post-mortem reached its cap. Start a new post-mortem to continue.');
        const entry = live.get(sessionId);
        if (entry?.idle) { clearTimeout(entry.idle); entry.idle = null; }
        setStatus(sessionId, 'busy', {}, resuming ? 'resuming' : 'thinking');
        record(sessionId, { role: 'user', kind: 'text', text, clientId });
      } catch (error) { if (slot) slots.delete(slot); throw error; }
      background(sessionId, drive(sessionId, text, slot, false));
      return snapshot(sessionId);
    },
    async stop(sessionId: string): Promise<PostmortemSnapshot> {
      const session = required(sessionId);
      if (live.has(sessionId)) await shutdown(sessionId);
      else if (session.status === 'starting' || session.status === 'busy') stopRequested.add(sessionId);
      const current = required(sessionId);
      if (current.status === 'starting' || current.status === 'busy' || current.status === 'ready') setStatus(sessionId, 'idle');
      return snapshot(sessionId);
    },
    subscribe(sessionId: string, listener: (event: PostmortemEvent) => void): () => void {
      required(sessionId);
      const set = listeners.get(sessionId) ?? new Set(); set.add(listener); listeners.set(sessionId, set);
      return () => { set.delete(listener); if (!set.size && listeners.get(sessionId) === set) listeners.delete(sessionId); };
    },
    isLiveCapability(capabilityId: string): boolean {
      const sessionId = capabilityId.startsWith('pm-') ? capabilityId.slice(3) : '';
      return Boolean(sessionId) && (live.has(sessionId) || spawning.has(sessionId));
    },
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.all([...live.keys()].map(shutdown));
      await Promise.all([...pending.values()]);
      await Promise.all([...live.keys()].map(shutdown));
    },
  };
}
