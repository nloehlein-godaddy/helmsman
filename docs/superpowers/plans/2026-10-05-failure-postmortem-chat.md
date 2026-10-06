# Failure Post-mortem Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user clicks **Ask about this failure** on a `failed`/`stopped` run and converses with a fresh, Seatbelt-sandboxed codex/claude agent seeded with the run's redacted evidence; the agent diagnoses, may run commands, and may author patches it never applies.

**Architecture:** New server module `server/helmsman/postmortem/` (evidence → sandbox → session store → patches → prompt → provider session → runner → routes). It is not a run: no `runs` row, no `ProcessManager`, no workflow snapshot. The provider process is spawned in-process by Helmsman (like `runInteractiveAgent`), routed through the scoped model gateway with a post-mortem-scoped capability, wrapped in `sandbox-exec`. Codex app-server / claude stream-json line framing and RPC correlation are extracted from `interactive-agent.ts` into `agent-protocol.ts` and shared. The run-viewer panel reaches the server through a new public plugin capability `helmsman/postmortem@1` (the panel never calls `fetch` itself; every server call goes through a host service).

**Tech Stack:** TypeScript 6, Node ≥22, better-sqlite3, vitest 4 (jsdom default; `/** @vitest-environment node */` for server tests), macOS `sandbox-exec`.

**Spec:** `docs/superpowers/specs/2026-10-05-failure-postmortem-chat-design.md`

## Global Constraints

- Eligible runs: status `failed` or `stopped`; anything else → `409`. Unknown run → `404`.
- Providers: `'codex' | 'claude-code'`; default = the failed run's provider (adapter with `pre-pr:`/`feedback:` prefix stripped; anything not `claude-code` maps to `codex`); default effort `high`; default model `null` (provider default).
- Session statuses exactly `starting|busy|ready|idle|capped|error`; open = status not in `capped`,`error`; at most one open session per run (partial unique index `postmortem_one_open_per_run`).
- Message kinds exactly `text|tool|command|phase|error|patch`; roles `user|agent|system`; `text` capped at 64 KB (65 536 UTF-8 bytes) with a truncation marker.
- On-disk dir `<runsDir>/<runId>.postmortem/` mode `0700`; `evidence.json` mode `0600`; plus `seed.md`, `profile.sb`, `patches/<n>-<repo>.patch` + `patches/<n>-<repo>.json` (`{repo, baseSha, summary}`), `repo ∈ {helmsman, target}`.
- Endpoints: `POST /api/runs/:id/postmortem`, `GET /api/postmortem/:sid`, `POST /api/postmortem/:sid/messages`, `POST /api/postmortem/:sid/stop`, `GET /api/postmortem/:sid/events` (SSE). Shared start/message/resume errors: `412` sandbox unavailable, `429` concurrency limit; `423` capped; `409` turn in progress.
- Limits (defaults, configurable via runner options): 30 turns, $5 cost, 15 min idle, 2 live processes, stop = close stdin → SIGTERM → SIGKILL after 5 s.
- Sandbox is mandatory: preflight `sandbox-exec -f profile.sb /usr/bin/true` before every start/resume; failure or non-macOS → `412`; never an unsandboxed fallback. Profile text exactly as in the spec "Safety" section, with every path `realpath`ed and escaped for Seatbelt string literals.
- Env scrub: remove `GITHUB_TOKEN`, `GH_TOKEN`, `JIRA_*`, `SLACK_*`, every `*_TOKEN`/`*_SECRET` except model-routing vars; set `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=credential.helper`, `GIT_CONFIG_VALUE_0=`, `GIT_TERMINAL_PROMPT=0`.
- Redaction: `taskJson` keys `/token|secret|password|credential|capability|apikey/i` → `[redacted]`; text regexes for `ghp_…`, `github_pat_…`, `sk-…`, `Bearer …`, `xox[abpr]-…`; spec args → lengths + first 40 chars of non-`--input=` args only.
- Never pass a >1 KB single argv element to a node process; the post-mortem launches only native `sandbox-exec` → provider and asserts every argv element ≤ 1024 bytes.
- No new comment lines (repo hook blocks them) except JSDoc directly above an `export` and trailing comments; node-environment test files start with `/** @vitest-environment node */` (the `//` form is blocked in new files).
- Defensive parsing of every JSON value from disk, network, child stdout (use `protocolRecord`/explicit `typeof` guards).
- macOS-only integration tests: `describe.skipIf(process.platform !== 'darwin' || !hasShebangShims)`.
- Copy: button label **Ask about this failure**; start-over label **Start new post-mortem**; status line words `starting… / thinking… / resuming… / ready / idle / capped / error`.
- Do not change `runInteractiveAgent` behavior (characterization tests first, Task 1).

## Review Focus

1. **Double click / second visit while a session is open** → the same session is returned and no second process spawns. Test: Task 8 "reuses the open session without spawning".
2. **Network retry of a message with the same `clientId`** → exactly one user message and one turn; a different text under the same `clientId` → 409. Tests: Task 4 "is idempotent on clientId", Task 8 "replayed clientId does not start a second turn".
3. **Helmsman restarts mid-turn** → sessions `starting|busy|ready` become `idle`; the next message resumes with the stored provider id. Tests: Task 4 "sweeps live statuses to idle on restart", Task 8 "sweeps live sessions to idle when constructed", Task 8 integration "runs codex: seed, message, idle, resume with the stored thread, patch, stop".
4. **Paths with quotes/backslashes and symlinked temp dirs (`/var` → `/private/var`)** → profile uses realpaths and escaped literals, `.env` regex escapes metacharacters. Test: Task 3 "escapes and realpaths every path".
5. **Agent writes junk into `patches/`** (bad names, traversal-looking names, malformed sidecar, mismatched repo label, >1 MB patch) → listed invalid or ignored, never throws, never reads outside the directory. Test: Task 5 "tolerates junk in the patch directory".

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `server/helmsman/agent-protocol.ts` | create | Line framing (8 MB cap), JSON-record validation, request/ack correlation with timeouts, codex response routing + `-32601` rejection of provider requests, claude user-replay ack |
| `server/helmsman/agent-protocol.test.ts` | create | Unit tests of the connection |
| `server/helmsman/interactive-agent.ts` | modify `:48-258` | Consume `connectAgentProtocol`; behavior unchanged |
| `server/helmsman/interactive-agent.test.ts` | modify (append) | Characterization tests written before extraction |
| `server/helmsman/model-routing-cli.ts` | modify `:44-50,:52-62,:98-126` | Optional persistent provider home (`options.home`) so provider session stores survive process exit |
| `server/helmsman/model-routing.test.ts` | modify (append) | Persistent-home test |
| `server/helmsman/postmortem/evidence.ts` | create | `PostmortemEvidence` builder (pure) + fs reader + redaction + signatures |
| `server/helmsman/postmortem/sandbox.ts` | create | Profile text, escaping, env scrub, command wrap, preflight |
| `server/helmsman/postmortem/session-store.ts` | create | Tables, transitions, idempotent messages, sweep, `PostmortemError` |
| `server/helmsman/postmortem/patches.ts` | create | List + validate patches via temp index; never applies |
| `server/helmsman/postmortem/prompt.ts` | create | Bounded seed prompt |
| `server/helmsman/postmortem/provider-session.ts` | create | One live provider process: command build, init/resume, turns, item mapping, cost, graceful close |
| `server/helmsman/postmortem/runner.ts` | create | Service: eligibility, dir + artifacts, sessions, live map, caps, idle, concurrency, SSE fan-out, restart sweep |
| `server/helmsman/postmortem/routes.ts` | create | JSON endpoints (`handlePostmortemApi`) + SSE (`handlePostmortemEvents`) |
| `server/helmsman/postmortem/*.test.ts` | create | Unit tests per unit |
| `server/helmsman/postmortem/postmortem-sandbox.integration.test.ts` | create | Real Seatbelt behavior |
| `server/helmsman/postmortem/postmortem-runner.integration.test.ts` | create | Real sandboxed fake providers end-to-end |
| `server/helmsman/router.ts` | modify `:105-169,:170-178` | `RouterDeps.postmortem?`, dispatch to `handlePostmortemApi` |
| `server/helmsman/application.ts` | modify `:479-481,:1943,:1964,:2049` | Construct runner, gateway `active` for `pm-` capabilities, SSE route, shutdown |
| `src/plugins/postmortem.ts` | create | Public SDK types + defensive parsers for `helmsman/postmortem@1` |
| `src/plugins/postmortem-service.ts` | create | Host service (`fetch` with `X-Helmsman-Contribution`, SSE reader) |
| `src/plugins/postmortem-service.test.ts` | create | Host service tests with fake fetch |
| `src/plugins/{sdk,composition,manifest,composition-host,services,host-services}.ts` | modify | Register the capability (same places `helmsman/run-instructions` was added in `f4997e0`) |
| `scripts/sdk-compatibility.mjs:80`, `scripts/build-distribution.mjs` (`publicModules`) | modify | Keep SDK compatibility + distribution green |
| `src/plugins/composition-host.test.ts:~332` | modify | Service key list gains `postmortem` |
| `src/plugins/run-viewer/postmortem-chat.ts` | create | Chat component |
| `src/plugins/run-viewer/postmortem-chat.test.ts` | create | jsdom tests |
| `src/plugins/run-viewer/panel.ts` | modify `:21,:58,:373-374,:376-377` | Button + mount chat |
| `src/plugins/run-viewer/panel.test.ts` | modify (append) | Button visibility |
| `src/plugins/run-viewer/plugin-package.json` | modify | Require `helmsman/postmortem@1`, version `0.3.0` |
| `src/plugins/run-viewer/README.md` | modify | One sentence on the capability |

Commands used throughout:

- Single test file: `npx vitest run <path>`
- Typecheck + build: `npm run build` (runs `tsc` over `src` and `server`, then vite)
- Full suite: `npm test`. Known pre-existing failures on this base (memory.md 2026-10-02): `src/builtin-frontend.test.ts`, `src/plugins/builtin-lifecycle.test.ts`. Any other failure is yours.

---

### Task 1: Extract the agent protocol connection (characterize first)

**Files:**
- Modify: `server/helmsman/interactive-agent.test.ts` (append after line 308)
- Create: `server/helmsman/agent-protocol.ts`
- Create: `server/helmsman/agent-protocol.test.ts`
- Modify: `server/helmsman/interactive-agent.ts:1-7` (imports), `:48-258` (`runInteractiveAgent` body)

**Interfaces:**
- Consumes: nothing new.
- Produces (`server/helmsman/agent-protocol.ts`):
  - `type AgentProtocol = 'codex-app-server' | 'claude-stream-json'`
  - `type ProtocolRecord = Record<string, unknown>`
  - `interface ProtocolTimeout { readonly ms: number; readonly error: () => Error }`
  - `interface AgentProtocolConnection { write(value: unknown): void; request(id: string, value: unknown, timeout: ProtocolTimeout | null): Promise<unknown>; rpc(method: string, params: unknown, timeout: ProtocolTimeout | null, id?: string): Promise<unknown>; rejectPending(error: Error): void; pendingCount(): number }`
  - `const AGENT_PROTOCOL_BUFFER_LIMIT = 8 * 1024 * 1024`
  - `function protocolRecord(value: unknown): ProtocolRecord | undefined`
  - `function connectAgentProtocol(child: ChildProcessWithoutNullStreams, options: { protocol: AgentProtocol; onMessage(message: ProtocolRecord): void; onFailure(error: Error): void }): AgentProtocolConnection`
  - Semantics: codex responses (`id` string, no `method`) only settle pending requests; codex provider requests (`id` + `method`) get `{ id, error: { code: -32601, message: 'Helmsman does not support this interactive request' } }` and are not forwarded; every other codex message → `onMessage`. Claude: `onMessage(message)` first, then a `type: 'user'` message with string `uuid` settles that request. Parse/dispatch exceptions and the buffer limit call `onFailure`.

- [ ] **Step 1: Write characterization tests against the current code**

Append to `server/helmsman/interactive-agent.test.ts`:

```ts
function codexScript(body: string) {
  return { cmd: process.execPath, args: ['-e', `
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      ${body}
    });
  `] };
}

describe('interactive agent protocol characterization', () => {
  it('rejects provider-initiated Codex requests, ignores foreign threads and maps command items', async () => {
    const input = await task();
    const agent = run(input, 'codex', codexScript(`
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        send({ id: 'server-1', method: 'item/tool/requestUserInput', params: {} });
      }
      if (message.id === 'server-1') {
        if (message.error?.code !== -32601) process.exit(7);
        send({ method: 'item/started', params: { threadId: 'thread-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'ls', status: 'inProgress' } } });
        send({ method: 'item/completed', params: { threadId: 'other-thread', item: { id: 'x', type: 'agentMessage', text: 'Foreign' } } });
        send({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a', exitCode: 0, status: 'completed' } } });
        send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
      }
    `));
    await agent.promise;
    expect(agent.output.map(line => JSON.parse(line))).toEqual([
      { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'ls', status: 'inProgress' } },
      { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'ls', aggregated_output: 'a', exit_code: 0, status: 'completed' } },
      { type: 'turn.completed', turn_id: 'turn-1' },
    ]);
  });

  it('fails on a non-object protocol line', async () => {
    const agent = run(await task(), 'codex', codexScript(`if (message.method === 'initialize') process.stdout.write('[1]\\n');`));
    await expect(agent.promise).rejects.toThrow('Malformed agent protocol output');
  });

  it('fails on an unparseable protocol line', async () => {
    const agent = run(await task(), 'codex', codexScript(`if (message.method === 'initialize') process.stdout.write('{\\n');`));
    await expect(agent.promise).rejects.toBeInstanceOf(SyntaxError);
  });

  it('fails when unterminated protocol output exceeds 8 MB', async () => {
    const agent = run(await task(), 'codex', codexScript(`if (message.method === 'initialize') process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));`));
    await expect(agent.promise).rejects.toThrow('Agent protocol output exceeded its limit');
  });

  it('times out an unanswered protocol request', async () => {
    const input = await task();
    const abort = new AbortController(); agents.push(abort);
    const promise = runInteractiveAgent({ instructions: input.instructions!, provider: 'fixture/codex', stage: 'implement',
      interactive: { command: codexScript(''), protocol: 'codex-app-server', initialInput: { prompt: 'p', model: null, effort: null } }, transport: null, skillsPath: null },
    { output: () => {}, diagnostic: () => {}, signal: abort.signal, requestTimeoutMs: 50 });
    await expect(promise).rejects.toThrow('Agent protocol request timed out');
  });
});
```

- [ ] **Step 2: Run them against the unmodified code**

Run: `npx vitest run server/helmsman/interactive-agent.test.ts`
Expected: PASS (all existing tests + 5 new). These pin current behavior; if any fails, fix the test expectation to match current behavior, never the code.

- [ ] **Step 3: Commit the characterization**

```bash
git add server/helmsman/interactive-agent.test.ts
git commit -m "test: characterize interactive agent protocol handling"
```

- [ ] **Step 4: Write the failing unit test for the new module**

Create `server/helmsman/agent-protocol.test.ts`:

```ts
/** @vitest-environment node */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { connectAgentProtocol, type ProtocolRecord } from './agent-protocol';

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill('SIGKILL'); });

function child(script: string) {
  const value = spawn(process.execPath, ['-e', `
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const message = JSON.parse(line); ${script} });
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(value);
  return value;
}

describe('agent protocol connection', () => {
  it('settles codex responses, rejects provider requests and forwards notifications', async () => {
    const messages: ProtocolRecord[] = []; const failures: Error[] = [];
    const process_ = child(`
      if (message.method === 'ping') { send({ id: 'p-1', method: 'approve', params: {} }); send({ method: 'note', params: { n: 1 } }); send({ id: message.id, result: { pong: true } }); }
      if (message.id === 'p-1') send({ method: 'replied', params: { code: message.error.code } });
    `);
    const connection = connectAgentProtocol(process_, { protocol: 'codex-app-server', onMessage: message => messages.push(message), onFailure: error => failures.push(error) });
    expect(await connection.rpc('ping', {}, { ms: 2000, error: () => new Error('late') })).toEqual({ pong: true });
    await expect.poll(() => messages.map(message => message.method)).toEqual(['note', 'replied']);
    expect(messages[1]).toMatchObject({ params: { code: -32601 } });
    expect(failures).toEqual([]);
  });

  it('forwards a claude replay before settling its request', async () => {
    const order: string[] = [];
    const process_ = child(`send({ type: 'user', uuid: message.uuid });`);
    const connection = connectAgentProtocol(process_, { protocol: 'claude-stream-json', onMessage: () => order.push('message'), onFailure: () => {} });
    await connection.request('u-1', { type: 'user', uuid: 'u-1' }, null).then(() => order.push('ack'));
    expect(order).toEqual(['message', 'ack']);
    expect(connection.pendingCount()).toBe(0);
  });

  it('times out, rejects pending requests and reports malformed output', async () => {
    const failures: Error[] = [];
    const process_ = child(`if (message.method === 'bad') process.stdout.write('"text"\\n');`);
    const connection = connectAgentProtocol(process_, { protocol: 'codex-app-server', onMessage: () => {}, onFailure: error => failures.push(error) });
    await expect(connection.rpc('silent', {}, { ms: 20, error: () => new Error('timed out') })).rejects.toThrow('timed out');
    const held = connection.rpc('held', {}, null);
    expect(connection.pendingCount()).toBe(1);
    connection.rejectPending(new Error('gone'));
    await expect(held).rejects.toThrow('gone');
    connection.write({ method: 'bad' });
    await expect.poll(() => failures.map(error => error.message)).toEqual(['Malformed agent protocol output']);
  });

  it('refuses writes after the child exits', async () => {
    const process_ = child('');
    const connection = connectAgentProtocol(process_, { protocol: 'codex-app-server', onMessage: () => {}, onFailure: () => {} });
    process_.kill('SIGKILL');
    await new Promise(resolve => process_.once('exit', resolve));
    expect(() => connection.write({})).toThrow('Agent connection is closed');
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run server/helmsman/agent-protocol.test.ts`
Expected: FAIL — `Failed to resolve import "./agent-protocol"`.

- [ ] **Step 6: Implement `server/helmsman/agent-protocol.ts`**

```ts
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type AgentProtocol = 'codex-app-server' | 'claude-stream-json';
export type ProtocolRecord = Record<string, unknown>;
export interface ProtocolTimeout { readonly ms: number; readonly error: () => Error }
export interface AgentProtocolConnection {
  write(value: unknown): void;
  request(id: string, value: unknown, timeout: ProtocolTimeout | null): Promise<unknown>;
  rpc(method: string, params: unknown, timeout: ProtocolTimeout | null, id?: string): Promise<unknown>;
  rejectPending(error: Error): void;
  pendingCount(): number;
}
export const AGENT_PROTOCOL_BUFFER_LIMIT = 8 * 1024 * 1024;

export function protocolRecord(value: unknown): ProtocolRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ProtocolRecord : undefined;
}

export function connectAgentProtocol(child: ChildProcessWithoutNullStreams, options: {
  protocol: AgentProtocol; onMessage(message: ProtocolRecord): void; onFailure(error: Error): void;
}): AgentProtocolConnection {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }>();
  let buffer = '';
  const write = (value: unknown) => {
    if (child.stdin.destroyed || child.exitCode !== null || child.signalCode !== null) throw new Error('Agent connection is closed');
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const settle = (id: string, result: unknown, error?: Error) => {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(id);
    if (error) entry.reject(error); else entry.resolve(result);
  };
  const request = (id: string, value: unknown, timeout: ProtocolTimeout | null): Promise<unknown> => new Promise((resolve, reject) => {
    const timer = timeout ? setTimeout(() => { pending.delete(id); reject(timeout.error()); }, timeout.ms) : undefined;
    pending.set(id, { resolve, reject, timer });
    try { write(value); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const dispatch = (message: ProtocolRecord) => {
    if (options.protocol === 'claude-stream-json') {
      options.onMessage(message);
      if (message.type === 'user' && typeof message.uuid === 'string') settle(message.uuid, message);
      return;
    }
    if (typeof message.id === 'string' && !message.method) {
      const error = protocolRecord(message.error);
      settle(message.id, message.result, error ? new Error(typeof error.message === 'string' ? error.message : 'Agent rejected the request') : undefined);
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      write({ id: message.id, error: { code: -32601, message: 'Helmsman does not support this interactive request' } });
      return;
    }
    options.onMessage(message);
  };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const message = protocolRecord(JSON.parse(line));
        if (!message) throw new Error('Malformed agent protocol output');
        dispatch(message);
      } catch (error) { options.onFailure(error instanceof Error ? error : new Error(String(error))); }
    }
    if (buffer.length > AGENT_PROTOCOL_BUFFER_LIMIT) options.onFailure(new Error('Agent protocol output exceeded its limit'));
  });
  return {
    write, request,
    rpc: (method, params, timeout, id = randomUUID()) => request(id, { id, method, params }, timeout),
    rejectPending(error) { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); },
    pendingCount: () => pending.size,
  };
}
```

- [ ] **Step 7: Run the unit test**

Run: `npx vitest run server/helmsman/agent-protocol.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Refactor `runInteractiveAgent` onto the connection**

In `server/helmsman/interactive-agent.ts`:
- Remove `import { randomUUID } from 'node:crypto';` only if unused after the edit (it is still used for the claude initial message — keep it).
- Add `import { connectAgentProtocol, type ProtocolTimeout } from './agent-protocol';`.
- Replace lines 65-249 (from `const child = spawn(` through the `try { … await exited;` of the main block) so the function reads as below; lines 48-64 and 250-258 stay as they are.

```ts
  const child = spawn(command.cmd, command.args, { env: routed?.environment ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const connection = connectAgentProtocol(child, { protocol,
    onMessage: message => { if (protocol === 'codex-app-server') codexMessage(message); else claudeMessage(message); },
    onFailure: error => stop(error) });
  let endpoint: Awaited<ReturnType<typeof startInstructionEndpoint>> | undefined;
  let endpointStarting: Promise<void> | undefined;
  let active = false;
  let completed = false;
  let closing = false;
  let failure: Error | undefined;
  let threadId = '';
  let turnId = '';
  let lastUsage: unknown;
  let claudeResult: Record<string, unknown> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const timeout = (instruction: boolean): ProtocolTimeout | null => protocol === 'claude-stream-json' && instruction ? null : {
    ms: (instruction ? options.instructionTimeoutMs : undefined) ?? options.requestTimeoutMs ?? 20_000,
    error: () => instruction ? new InstructionDeliveryUnknownError('Agent did not acknowledge the instruction in time') : new Error('Agent protocol request timed out'),
  };
  const stop = (error: Error) => {
    failure ??= error;
    active = false;
    connection.rejectPending(new InstructionDeliveryUnknownError('Agent disconnected before acknowledging the instruction'));
    child.kill('SIGTERM');
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    stopTimer.unref();
  };
  const openEndpoint = (): Promise<void> => endpointStarting ??= (async () => {
    if (!active || closing) return;
    endpoint = await startInstructionEndpoint({ ...instructions, provider, protocol, stage }, async (text, id) => {
      if (!active || closing) throw new Error('Agent has finished this stage');
      if (protocol === 'codex-app-server') {
        const expectedTurnId = turnId;
        const response = record(await connection.rpc('turn/steer', { threadId, expectedTurnId, clientUserMessageId: id,
          input: [{ type: 'text', text, text_elements: [] }] }, timeout(true)));
        if (response?.turnId !== expectedTurnId) throw new InstructionDeliveryUnknownError('Agent returned an unexpected turn acknowledgment');
      } else {
        await connection.request(id, { type: 'user', uuid: id, session_id: threadId, message: { role: 'user', content: text }, parent_tool_use_id: null }, timeout(true));
      }
    });
    if (!active || closing) await endpoint.close();
  })();
```

Keep `finish` (old lines 129-151) verbatim. Replace `codexMessage` (old 152-186) by dropping its first two `if` blocks (response routing and `-32601` reply now live in the connection); it starts at `const params = record(message.params);` and is otherwise verbatim. In `claudeMessage` (old 187-200) delete the line `if (message.type === 'user' && typeof message.uuid === 'string') receiveAck(message.uuid, message);` and replace both `pending.size === 0` with `connection.pendingCount() === 0`. Delete the old `child.stdout…on('data'…)` block (old 201-214). Then:

```ts
  child.stderr.setEncoding('utf8').on('data', diagnostic);
  child.stdin.on('error', error => {
    connection.rejectPending(new InstructionDeliveryUnknownError('Agent input disconnected before acknowledging the instruction'));
    if (!closing) stop(error);
  });
  child.once('error', error => stop(error));
  child.once('close', (code, signal) => {
    active = false;
    if (stopTimer) clearTimeout(stopTimer);
    if (!completed || code !== 0 && !(protocol === 'codex-app-server' && closing && signal === 'SIGTERM')) failure ??= new Error(`Agent exited ${signal ?? code} before successful completion`);
    if (claudeResult) emit(claudeResult);
    connection.rejectPending(new InstructionDeliveryUnknownError('Agent exited before acknowledging the instruction'));
    resolveExit();
  });
  const abort = () => stop(new Error('Voyage stopped'));
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) abort();
    else if (protocol === 'codex-app-server') {
      await connection.rpc('initialize', { clientInfo: { name: 'helmsman', version: '0.4.0' }, capabilities: {} }, timeout(false));
      connection.write({ method: 'initialized' });
      const { model, effort } = initialInput;
      const result = record(await connection.rpc('thread/start', { cwd: process.cwd(), model, approvalPolicy: 'never', sandbox: 'danger-full-access' }, timeout(false)));
      const thread = record(result?.thread);
      if (typeof thread?.id !== 'string') throw new Error('Agent returned no thread ID');
      threadId = thread.id;
      const started = record(await connection.rpc('turn/start', { threadId, input: [{ type: 'text', text: initialInput.prompt, text_elements: [] }], effort }, timeout(false)));
      const turn = record(started?.turn);
      if (typeof turn?.id !== 'string') throw new Error('Agent returned no turn ID');
      turnId = turn.id;
      if (!closing) { active = true; await openEndpoint(); }
    } else {
      connection.write({ type: 'user', uuid: randomUUID(), session_id: '', message: { role: 'user', content: initialInput.prompt }, parent_tool_use_id: null });
    }
    await exited;
```

Remove the now-unused locals `pending`, `buffer`, `rejectPending`, `write`, `request`, `rpc`, `receiveAck`. `codexMessage`/`claudeMessage` are `const` arrow functions declared after `connection`; they are only invoked from stdout events, which fire after the synchronous body has initialized them.

- [ ] **Step 9: Run all protocol tests**

Run: `npx vitest run server/helmsman/interactive-agent.test.ts server/helmsman/agent-protocol.test.ts server/helmsman/instruction-channel.test.ts`
Expected: PASS, same test count as Step 2 plus 4.

- [ ] **Step 10: Typecheck**

Run: `npx tsc -p tsconfig.json`
Expected: no output, exit 0 (no unused-local errors).

- [ ] **Step 11: Commit**

```bash
git add server/helmsman/agent-protocol.ts server/helmsman/agent-protocol.test.ts server/helmsman/interactive-agent.ts
git commit -m "refactor: extract shared agent protocol connection"
```

---
### Task 2: Evidence bundle

**Files:**
- Create: `server/helmsman/postmortem/evidence.ts`
- Test: `server/helmsman/postmortem/evidence.test.ts`

**Interfaces:**
- Consumes: `RunRow`, `RunEventRow` from `server/helmsman/db.ts:7-35`; `protocolRecord` from Task 1.
- Produces:
  - `type PostmortemSignature = 'exec-kill' | 'spawn-failed' | 'stage-timeout' | 'cost-cap' | 'clarification-unanswered' | 'snapshot-mismatch' | 'gate-blocked'`
  - `interface PostmortemEvidence` (shape in Step 3)
  - `interface EvidenceInput { run: RunRow; events: readonly RunEventRow[]; log: { text: string; bytes: number } | null; exitText: string | null; specText: string | null; worktreeExists: boolean; helmsmanRoot: string; helmsmanCommit: string | null; targetRepoPath: string | null }`
  - `function buildEvidence(input: EvidenceInput): PostmortemEvidence` (pure)
  - `function readEvidenceInput(run: RunRow, deps: { listEvents(runId: string): RunEventRow[]; helmsmanRoot: string; helmsmanCommit: string | null; targetRepoPath: string | null }): EvidenceInput`
  - `function writeEvidenceFile(directory: string, evidence: PostmortemEvidence): string` → absolute path of `evidence.json` (mode 0600)
  - `function redactText(text: string): string`, `function redactValue(value: unknown): unknown`
  - `const EVIDENCE_EVENT_LIMIT = 200`, `const EVIDENCE_LOG_LIMIT = 65_536`

Facts the rules rely on (verified in code): the run wrapper appends `run-wrapper: agent terminated by signal <SIG>` / `run-wrapper: cannot start <cmd>: …` to the log (`server/helmsman/run-wrapper.mjs:45,51`) and the exit file holds only an integer (`runner.ts:185-190`), so the signal comes from log/event text. Cost cap logs `cost cap reached, no further attempts` (`runner.ts:453`); unanswered clarification logs `Required clarification has no answer…` (`runner.ts:158,265`); retained worktrees log `Worktree retained for inspection: <path>` (`runner.ts:325`). The og incident row `ca31adc3` has exactly the events `run-wrapper: agent terminated by signal SIGKILL`, `Agent process exited with code 1`, `Worktree retained…`, `run-complete failed`, duration 4 471 ms, exit file `1`, spec arg 4 = 1 344 chars starting `{"task":`.

- [ ] **Step 1: Write the failing test**

Create `server/helmsman/postmortem/evidence.test.ts`:

```ts
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
    expect(evidence.spec?.args.map(arg => arg.length)).toEqual([8, 13, 26, Buffer.byteLength(longArg), 11]);
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/helmsman/postmortem/evidence.test.ts`
Expected: FAIL — cannot resolve `./evidence`.

- [ ] **Step 3: Implement `server/helmsman/postmortem/evidence.ts`**

```ts
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
```

Note on the log-tail test: 73 548 bytes of ASCII → tail is exactly 65 536 chars; the first (partial) line of a truncated tail is ignored when deciding `agentOutput`, so a cut-off diagnostic line is never mistaken for agent output.

- [ ] **Step 4: Run the test**

Run: `npx vitest run server/helmsman/postmortem/evidence.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/helmsman/postmortem/evidence.ts server/helmsman/postmortem/evidence.test.ts
git commit -m "feat: build redacted post-mortem evidence with failure signatures"
```

---

### Task 3: Seatbelt sandbox

**Files:**
- Create: `server/helmsman/postmortem/sandbox.ts`
- Create: `server/test-support/argv-shim.ts` (shared copy of the `bashShimPassingLongArgvViaFile` helper from `server/helmsman/pre-pr-runtime.integration.test.ts:35-36`; the pre-PR test is left untouched)
- Test: `server/helmsman/postmortem/sandbox.test.ts`
- Test: `server/helmsman/postmortem/postmortem-sandbox.integration.test.ts`

**Interfaces:**
- Produces:
  - `class SandboxUnavailableError extends Error`
  - `interface SandboxPaths { directory: string; tmpdir: string; home: string; helmsmanRoot: string }`
  - `const SANDBOX_ARGUMENT_LIMIT = 1024`
  - `function seatbeltString(value: string): string` (returns a quoted Seatbelt string literal)
  - `function resolveSandboxPaths(directory: string, helmsmanRoot: string): SandboxPaths` (all `realpathSync`)
  - `function sandboxProfile(paths: SandboxPaths): string`
  - `function writeSandboxProfile(paths: SandboxPaths): string` → `<directory>/profile.sb` (mode 0600)
  - `function scrubEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv`
  - `function sandboxCommand(command: { cmd: string; args: readonly string[] }, profilePath: string): { cmd: string; args: string[] }`
  - `function preflightSandbox(profilePath: string, platform?: NodeJS.Platform): Promise<void>` (rejects `SandboxUnavailableError`)
  - `server/test-support/argv-shim.ts`: `function bashShimPassingLongArgvViaFile(script: string): string`

- [ ] **Step 1: Write the failing unit test**

Create `server/helmsman/postmortem/sandbox.test.ts`:

```ts
/** @vitest-environment node */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preflightSandbox, resolveSandboxPaths, sandboxCommand, sandboxProfile, scrubEnvironment, seatbeltString, SandboxUnavailableError } from './sandbox';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('post-mortem sandbox', () => {
  it('emits the spec profile with allow and deny lists', () => {
    expect(sandboxProfile({ directory: '/r/run.postmortem', tmpdir: '/private/var/T', home: '/Users/me', helmsmanRoot: '/src/helmsman' })).toBe([
      '(version 1)', '(allow default)', '(deny file-write*)',
      '(allow file-write* (subpath "/r/run.postmortem") (subpath "/private/var/T") (subpath "/dev")',
      '                   (subpath "/Users/me/.codex") (subpath "/Users/me/.claude"))',
      '(deny file-read* (subpath "/Users/me/.ssh") (subpath "/Users/me/.config/gh") (literal "/Users/me/.netrc")',
      '                 (subpath "/Users/me/.aws") (regex "^/src/helmsman/\\\\.env"))', '',
    ].join('\n'));
  });

  it('escapes and realpaths every path', () => {
    expect(seatbeltString('/a "b"\\c')).toBe('"/a \\"b\\"\\\\c"');
    expect(sandboxProfile({ directory: '/x', tmpdir: '/t', home: '/h', helmsmanRoot: '/src/my.app (1)' })).toContain('(regex "^/src/my\\\\.app \\\\(1\\\\)/\\\\.env")');
    const root = mkdtempSync(join(tmpdir(), 'hm-pm-sandbox-')); roots.push(root);
    const target = join(root, 'real'); mkdirSync(target); symlinkSync(target, join(root, 'link'));
    const paths = resolveSandboxPaths(join(root, 'link'), join(root, 'link'));
    expect(paths).toMatchObject({ directory: realpathSync(target), helmsmanRoot: realpathSync(target), tmpdir: realpathSync(tmpdir()) });
  });

  it('scrubs credentials but keeps model routing and disables git credentials', () => {
    const env = scrubEnvironment({ PATH: '/bin', TMPDIR: '/t', GITHUB_TOKEN: 'g', GH_TOKEN: 'h', JIRA_API_TOKEN: 'j', JIRA_EMAIL: 'e', SLACK_OI_TOKEN_FILE: 's',
      NPM_TOKEN: 'n', CLIENT_SECRET: 'c', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'x', HELMSMAN_MODEL_CAPABILITY: 'cap', OPENAI_API_KEY: 'o', OPENAI_BASE_URL: 'u',
      ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'at', ANTHROPIC_BASE_URL: 'ab', CODEX_HOME: '/c', CLAUDE_CONFIG_DIR: '/cc' });
    expect(env).toEqual({ PATH: '/bin', TMPDIR: '/t', HELMSMAN_MODEL_CAPABILITY: 'cap', OPENAI_API_KEY: 'o', OPENAI_BASE_URL: 'u', ANTHROPIC_API_KEY: 'a',
      ANTHROPIC_AUTH_TOKEN: 'at', ANTHROPIC_BASE_URL: 'ab', CODEX_HOME: '/c', CLAUDE_CONFIG_DIR: '/cc',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0' });
  });

  it('wraps commands natively and refuses oversized argv elements', () => {
    expect(sandboxCommand({ cmd: 'codex', args: ['app-server'] }, '/p/profile.sb')).toEqual({ cmd: '/usr/bin/sandbox-exec', args: ['-f', '/p/profile.sb', 'codex', 'app-server'] });
    expect(() => sandboxCommand({ cmd: 'codex', args: ['x'.repeat(1025)] }, '/p')).toThrow('exceeds 1024 bytes');
  });

  it('refuses to run off macOS', async () => {
    await expect(preflightSandbox('/p/profile.sb', 'linux')).rejects.toBeInstanceOf(SandboxUnavailableError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/helmsman/postmortem/sandbox.test.ts`
Expected: FAIL — cannot resolve `./sandbox`.

- [ ] **Step 3: Implement `server/helmsman/postmortem/sandbox.ts`**

```ts
import { execFile } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export class SandboxUnavailableError extends Error {}
export interface SandboxPaths { directory: string; tmpdir: string; home: string; helmsmanRoot: string }
export const SANDBOX_ARGUMENT_LIMIT = 1024;
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const ROUTING_VARIABLES = new Set(['HELMSMAN_MODEL_CAPABILITY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']);
const CREDENTIAL_VARIABLE = /^(?:GITHUB_TOKEN|GH_TOKEN|JIRA_.*|SLACK_.*|GIT_CONFIG_.*|.*_TOKEN|.*_SECRET)$/;

export function seatbeltString(value: string): string {
  return `"${value.replace(/[\\"]/g, match => `\\${match}`)}"`;
}

const regexLiteral = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function resolveSandboxPaths(directory: string, helmsmanRoot: string): SandboxPaths {
  return { directory: realpathSync(directory), tmpdir: realpathSync(tmpdir()), home: realpathSync(homedir()), helmsmanRoot: realpathSync(helmsmanRoot) };
}

export function sandboxProfile(paths: SandboxPaths): string {
  const home = (suffix: string) => seatbeltString(`${paths.home}/${suffix}`);
  return ['(version 1)', '(allow default)', '(deny file-write*)',
    `(allow file-write* (subpath ${seatbeltString(paths.directory)}) (subpath ${seatbeltString(paths.tmpdir)}) (subpath "/dev")`,
    `                   (subpath ${home('.codex')}) (subpath ${home('.claude')}))`,
    `(deny file-read* (subpath ${home('.ssh')}) (subpath ${home('.config/gh')}) (literal ${home('.netrc')})`,
    `                 (subpath ${home('.aws')}) (regex ${seatbeltString(`^${regexLiteral(paths.helmsmanRoot)}/\\.env`)}))`, ''].join('\n');
}

export function writeSandboxProfile(paths: SandboxPaths): string {
  const path = join(paths.directory, 'profile.sb');
  writeFileSync(path, sandboxProfile(paths), { mode: 0o600 });
  return path;
}

export function scrubEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'
    && (ROUTING_VARIABLES.has(entry[0]) || !CREDENTIAL_VARIABLE.test(entry[0])));
  return { ...Object.fromEntries(kept), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0' };
}

export function sandboxCommand(command: { cmd: string; args: readonly string[] }, profilePath: string): { cmd: string; args: string[] } {
  if ([command.cmd, ...command.args].some(argument => Buffer.byteLength(argument) > SANDBOX_ARGUMENT_LIMIT)) throw new Error(`Post-mortem argv element exceeds ${SANDBOX_ARGUMENT_LIMIT} bytes`);
  return { cmd: SANDBOX_EXEC, args: ['-f', profilePath, command.cmd, ...command.args] };
}

export async function preflightSandbox(profilePath: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== 'darwin') throw new SandboxUnavailableError('Post-mortem sandbox requires macOS');
  await new Promise<void>((resolve, reject) => execFile(SANDBOX_EXEC, ['-f', profilePath, '/usr/bin/true'], { timeout: 10_000 },
    error => error ? reject(new SandboxUnavailableError(`Sandbox preflight failed: ${error.message}`)) : resolve()));
}
```

Note the `.env` regex: `regexLiteral` turns `.` into `\.`; `seatbeltString` doubles every backslash, so the file contains `"^/src/helmsman/\\.env"` exactly as the spec shows.

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run server/helmsman/postmortem/sandbox.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the shared shim helper**

Create `server/test-support/argv-shim.ts`:

```ts
/** Bash shim that forwards its argv to a node script through a NUL-separated file, so long arguments never reach node's own argv. */
export const bashShimPassingLongArgvViaFile = (script: string) => `#!/bin/bash\nf=$(/usr/bin/mktemp)\n[ $# -gt 0 ] && printf '%s\\0' "$@" > "$f"\n`
  + `TEST_ARGS_FILE="$f" TEST_ID="\${0##*/}" exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`;
```

- [ ] **Step 6: Write the macOS integration test**

Create `server/helmsman/postmortem/postmortem-sandbox.integration.test.ts`:

```ts
/** @vitest-environment node */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { hasShebangShims } from '../../test-support/platform';
import { bashShimPassingLongArgvViaFile } from '../../test-support/argv-shim';
import { preflightSandbox, sandboxCommand, writeSandboxProfile } from './sandbox';

const exec = promisify(execFile);
const cleanups: string[] = [];
afterEach(() => { for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hm-pm-seatbelt-'))); cleanups.push(root);
  const directory = join(root, 'run.postmortem'); const home = join(root, 'home'); const helmsmanRoot = join(root, 'helmsman');
  for (const path of [directory, join(home, '.ssh'), helmsmanRoot]) mkdirSync(path, { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_test'), 'secret'); writeFileSync(join(helmsmanRoot, '.env'), 'TOKEN=1');
  const profile = writeSandboxProfile({ directory, tmpdir: realpathSync(tmpdir()), home, helmsmanRoot });
  const run = (cmd: string, args: string[]) => { const wrapped = sandboxCommand({ cmd, args }, profile); return exec(wrapped.cmd, wrapped.args); };
  return { directory, home, helmsmanRoot, profile, run };
}

describe.skipIf(process.platform !== 'darwin' || !hasShebangShims)('post-mortem Seatbelt profile', () => {
  it('passes preflight', async () => { await expect(preflightSandbox(fixture().profile)).resolves.toBeUndefined(); });

  it('confines writes to the allowlist', async () => {
    const f = fixture(); const outside = join(homedir(), `.helmsman-pm-probe-${randomUUID()}`); cleanups.push(outside);
    await f.run('/bin/sh', ['-c', `echo ok > '${join(f.directory, 'inside.txt')}'`]);
    expect(readFileSync(join(f.directory, 'inside.txt'), 'utf8')).toBe('ok\n');
    await expect(f.run('/bin/sh', ['-c', `echo no > '${outside}'`])).rejects.toThrow();
    expect(existsSync(outside)).toBe(false);
  });

  it('denies credential and helmsman .env reads', async () => {
    const f = fixture();
    await expect(f.run('/bin/cat', [join(f.home, '.ssh', 'id_test')])).rejects.toThrow();
    await expect(f.run('/bin/cat', [join(f.helmsmanRoot, '.env')])).rejects.toThrow();
  });

  it('runs a node fake behind a bash shim with a long argument', async () => {
    const f = fixture();
    const script = join(f.directory, 'fake.cjs');
    writeFileSync(script, `const fs = require('node:fs'); const args = fs.readFileSync(process.env.TEST_ARGS_FILE, 'utf8').split('\\0').filter(Boolean);
      fs.writeFileSync(${JSON.stringify(join(f.directory, 'length.txt'))}, String(args[0].length));`);
    const shim = join(f.directory, 'fake'); writeFileSync(shim, bashShimPassingLongArgvViaFile(script), { mode: 0o755 });
    await exec('/usr/bin/sandbox-exec', ['-f', f.profile, shim, 'y'.repeat(5000)]);
    expect(readFileSync(join(f.directory, 'length.txt'), 'utf8')).toBe('5000');
  });
});
```

(The long-arg case calls `sandbox-exec` directly because `sandboxCommand` intentionally refuses >1 KB elements; the shim is the process that receives it, which is what the spec requires to survive.)

- [ ] **Step 7: Run the integration test**

Run: `npx vitest run server/helmsman/postmortem/postmortem-sandbox.integration.test.ts`
Expected (macOS): PASS (4 tests). Elsewhere: 4 skipped.

- [ ] **Step 8: Commit**

```bash
git add server/helmsman/postmortem/sandbox.ts server/helmsman/postmortem/sandbox.test.ts server/helmsman/postmortem/postmortem-sandbox.integration.test.ts server/test-support/argv-shim.ts
git commit -m "feat: add Seatbelt sandbox for post-mortem agents"
```

---
### Task 4: Session store

**Files:**
- Create: `server/helmsman/postmortem/session-store.ts`
- Test: `server/helmsman/postmortem/session-store.test.ts`

Pattern followed: `server/helmsman/run-instruction-store.ts:6-14` (`migrateOwned` with `owner`, `version`, `checksum: persistenceHash(DDL)`, `validateTableColumns`). `openPersistence(':memory:')` works in tests (`campaigns-public-service.test.ts:15`).

**Interfaces:**
- Produces:
  - `type PostmortemProvider = 'codex' | 'claude-code'`
  - `type PostmortemStatus = 'starting' | 'busy' | 'ready' | 'idle' | 'capped' | 'error'`
  - `type PostmortemRole = 'user' | 'agent' | 'system'`; `type PostmortemKind = 'text' | 'tool' | 'command' | 'phase' | 'error' | 'patch'`
  - `interface PostmortemSession { id: string; runId: string; provider: PostmortemProvider; model: string | null; effort: string | null; providerSessionId: string | null; status: PostmortemStatus; error: string | null; turns: number; costUsd: number | null; createdAt: string; updatedAt: string }`
  - `interface PostmortemMessage { id: number; sessionId: string; clientId: string | null; role: PostmortemRole; kind: PostmortemKind; text: string; ts: string }`
  - `class PostmortemError extends Error { readonly status: number; constructor(status: number, message: string) }`
  - `const POSTMORTEM_MESSAGE_LIMIT = 65_536`, `const TRUNCATION_MARKER = '\n[truncated]'`
  - `function truncateMessage(text: string): string`
  - `function capReached(session: PostmortemSession, limits: { maxTurns: number; maxCostUsd: number }): boolean`
  - `type PostmortemStore = ReturnType<typeof openPostmortemStore>` with methods `create(input: { runId: string; provider: PostmortemProvider; model: string | null; effort: string | null; providerSessionId: string | null }): PostmortemSession`, `get(id: string): PostmortemSession | null`, `open(runId: string): PostmortemSession | null`, `latest(runId: string): PostmortemSession | null`, `update(id: string, patch: { providerSessionId?: string | null; costUsd?: number | null; turns?: number }): PostmortemSession`, `transition(id: string, status: PostmortemStatus, patch?: { error?: string; providerSessionId?: string | null; costUsd?: number | null; turns?: number }): PostmortemSession`, `append(sessionId: string, input: { role: PostmortemRole; kind: PostmortemKind; text: string; clientId?: string | null }): { message: PostmortemMessage; duplicate: boolean }`, `messages(sessionId: string): PostmortemMessage[]`, `sweep(): number`
  - `function openPostmortemStore(persistence: Persistence, now?: () => string)`

Transition table (spec state machine `starting → busy → ready ⇄ busy → idle → (resume) busy`, terminal `capped`, `error` retryable via resume; stop may land any live state in `idle`):

| from | allowed to |
|---|---|
| starting | busy, idle, error |
| busy | ready, idle, error, capped |
| ready | busy, idle, error, capped |
| idle | busy, error |
| error | busy, error |
| capped | — |

- [ ] **Step 1: Write the failing test**

Create `server/helmsman/postmortem/session-store.test.ts`:

```ts
/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest';
import { openPersistence, type Persistence } from '../persistence';
import { capReached, openPostmortemStore, POSTMORTEM_MESSAGE_LIMIT, PostmortemError, truncateMessage } from './session-store';

const opened: Persistence[] = [];
afterEach(() => { for (const persistence of opened.splice(0)) persistence.close(); });
function setup() {
  const persistence = openPersistence(':memory:'); opened.push(persistence);
  let tick = 0; const store = openPostmortemStore(persistence, () => `2026-10-05T00:00:${String(tick++).padStart(2, '0')}.000Z`);
  return { persistence, store, session: store.create({ runId: 'run-1', provider: 'codex', model: null, effort: 'high', providerSessionId: null }) };
}

describe('post-mortem session store', () => {
  it('creates one open session per run and allows a new one after a terminal state', () => {
    const f = setup();
    expect(f.session).toMatchObject({ runId: 'run-1', provider: 'codex', status: 'starting', turns: 0, costUsd: null, error: null });
    expect(() => f.store.create({ runId: 'run-1', provider: 'codex', model: null, effort: null, providerSessionId: null })).toThrow(PostmortemError);
    expect(f.store.open('run-1')?.id).toBe(f.session.id);
    f.store.transition(f.session.id, 'error', { error: 'auth failed' });
    expect(f.store.open('run-1')).toBeNull();
    const next = f.store.create({ runId: 'run-1', provider: 'claude-code', model: 'opus', effort: 'high', providerSessionId: '00000000-0000-4000-8000-000000000001' });
    expect(f.store.latest('run-1')?.id).toBe(next.id);
    expect(f.store.get(f.session.id)).toMatchObject({ status: 'error', error: 'auth failed' });
  });

  it('follows the state machine and keeps capped terminal', () => {
    const f = setup(); const id = f.session.id;
    expect(() => f.store.transition(id, 'ready')).toThrow(/starting to ready/);
    f.store.transition(id, 'busy'); f.store.transition(id, 'ready', { turns: 1, costUsd: 0.5 });
    f.store.transition(id, 'busy'); f.store.transition(id, 'idle'); f.store.transition(id, 'busy');
    expect(f.store.transition(id, 'capped', { turns: 30 })).toMatchObject({ status: 'capped', turns: 30, costUsd: 0.5 });
    for (const status of ['busy', 'idle', 'error', 'ready'] as const) expect(() => f.store.transition(id, status)).toThrow(PostmortemError);
  });

  it('refuses to reopen an errored session while another session is open', () => {
    const f = setup();
    f.store.transition(f.session.id, 'error', { error: 'x' });
    f.store.create({ runId: 'run-1', provider: 'codex', model: null, effort: null, providerSessionId: null });
    expect(() => f.store.transition(f.session.id, 'busy')).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('is idempotent on clientId', () => {
    const f = setup(); const clientId = '00000000-0000-4000-8000-0000000000aa';
    const first = f.store.append(f.session.id, { role: 'user', kind: 'text', text: 'Why?', clientId });
    const again = f.store.append(f.session.id, { role: 'user', kind: 'text', text: 'Why?', clientId });
    expect(first.duplicate).toBe(false); expect(again).toEqual({ message: first.message, duplicate: true });
    expect(() => f.store.append(f.session.id, { role: 'user', kind: 'text', text: 'Other', clientId })).toThrow(expect.objectContaining({ status: 409 }));
    f.store.append(f.session.id, { role: 'agent', kind: 'text', text: 'Because.' });
    f.store.append(f.session.id, { role: 'agent', kind: 'text', text: 'Also.' });
    expect(f.store.messages(f.session.id).map(message => message.text)).toEqual(['Why?', 'Because.', 'Also.']);
  });

  it('caps message text at 64 KB with a marker', () => {
    const f = setup();
    const { message } = f.store.append(f.session.id, { role: 'agent', kind: 'command', text: '😀'.repeat(20_000) });
    expect(Buffer.byteLength(message.text)).toBeLessThanOrEqual(POSTMORTEM_MESSAGE_LIMIT);
    expect(message.text.endsWith('\n[truncated]')).toBe(true);
    expect(message.text).not.toContain('�');
    expect(truncateMessage('short')).toBe('short');
  });

  it('sweeps live statuses to idle on restart', () => {
    const f = setup();
    const ready = f.store.create({ runId: 'run-2', provider: 'codex', model: null, effort: null, providerSessionId: null });
    f.store.transition(ready.id, 'busy'); f.store.transition(ready.id, 'ready');
    const capped = f.store.create({ runId: 'run-3', provider: 'codex', model: null, effort: null, providerSessionId: null });
    f.store.transition(capped.id, 'busy'); f.store.transition(capped.id, 'capped');
    expect(f.store.sweep()).toBe(2);
    expect([f.store.get(f.session.id)?.status, f.store.get(ready.id)?.status, f.store.get(capped.id)?.status]).toEqual(['idle', 'idle', 'capped']);
  });

  it('reports cap enforcement on turns and cost', () => {
    const f = setup(); const limits = { maxTurns: 30, maxCostUsd: 5 };
    expect(capReached({ ...f.session, turns: 29, costUsd: 4.99 }, limits)).toBe(false);
    expect(capReached({ ...f.session, turns: 30, costUsd: null }, limits)).toBe(true);
    expect(capReached({ ...f.session, turns: 1, costUsd: 5 }, limits)).toBe(true);
  });

  it('reopens an existing database without migration drift', () => {
    const f = setup();
    expect(() => openPostmortemStore(f.persistence)).not.toThrow();
    expect(openPostmortemStore(f.persistence).get(f.session.id)?.id).toBe(f.session.id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/helmsman/postmortem/session-store.test.ts`
Expected: FAIL — cannot resolve `./session-store`.

- [ ] **Step 3: Implement `server/helmsman/postmortem/session-store.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { migrateOwned, validateTableColumns } from '../migrations';
import { persistenceHash, type Persistence } from '../persistence';

export type PostmortemProvider = 'codex' | 'claude-code';
export type PostmortemStatus = 'starting' | 'busy' | 'ready' | 'idle' | 'capped' | 'error';
export type PostmortemRole = 'user' | 'agent' | 'system';
export type PostmortemKind = 'text' | 'tool' | 'command' | 'phase' | 'error' | 'patch';
export interface PostmortemSession {
  id: string; runId: string; provider: PostmortemProvider; model: string | null; effort: string | null; providerSessionId: string | null;
  status: PostmortemStatus; error: string | null; turns: number; costUsd: number | null; createdAt: string; updatedAt: string;
}
export interface PostmortemMessage { id: number; sessionId: string; clientId: string | null; role: PostmortemRole; kind: PostmortemKind; text: string; ts: string }
export class PostmortemError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const POSTMORTEM_MESSAGE_LIMIT = 65_536;
export const TRUNCATION_MARKER = '\n[truncated]';
const TRANSITIONS: Record<PostmortemStatus, readonly PostmortemStatus[]> = {
  starting: ['busy', 'idle', 'error'], busy: ['ready', 'idle', 'error', 'capped'], ready: ['busy', 'idle', 'error', 'capped'],
  idle: ['busy', 'error'], error: ['busy', 'error'], capped: [],
};
const DDL = `CREATE TABLE postmortem_sessions (
  id TEXT PRIMARY KEY, runId TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, effort TEXT, providerSessionId TEXT,
  status TEXT NOT NULL, error TEXT, turns INTEGER NOT NULL DEFAULT 0, costUsd REAL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX postmortem_one_open_per_run ON postmortem_sessions(runId) WHERE status NOT IN ('capped', 'error');
CREATE TABLE postmortem_messages (
  id INTEGER PRIMARY KEY, sessionId TEXT NOT NULL, clientId TEXT, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, ts TEXT NOT NULL,
  UNIQUE(sessionId, clientId)
)`;

export function truncateMessage(text: string): string {
  if (Buffer.byteLength(text) <= POSTMORTEM_MESSAGE_LIMIT) return text;
  const kept = Buffer.from(text).subarray(0, POSTMORTEM_MESSAGE_LIMIT - Buffer.byteLength(TRUNCATION_MARKER)).toString('utf8').replace(/�+$/, '');
  return `${kept}${TRUNCATION_MARKER}`;
}

export function capReached(session: PostmortemSession, limits: { maxTurns: number; maxCostUsd: number }): boolean {
  return session.turns >= limits.maxTurns || session.costUsd !== null && session.costUsd >= limits.maxCostUsd;
}

const uniqueViolation = (error: unknown) => (error as { code?: unknown })?.code === 'SQLITE_CONSTRAINT_UNIQUE';

export function openPostmortemStore(persistence: Persistence, now: () => string = () => new Date().toISOString()) {
  const { sql } = persistence;
  migrateOwned(sql, { owner: 'core.postmortem', version: 1, checksum: persistenceHash(DDL), tables: ['postmortem_sessions', 'postmortem_messages'],
    validateLegacy: () => null, apply: () => sql.exec(DDL),
    validateCurrent: () => {
      validateTableColumns(sql, 'postmortem_sessions', ['id', 'runId', 'provider', 'model', 'effort', 'providerSessionId', 'status', 'error', 'turns', 'costUsd', 'createdAt', 'updatedAt']);
      validateTableColumns(sql, 'postmortem_messages', ['id', 'sessionId', 'clientId', 'role', 'kind', 'text', 'ts']);
    } });
  const get = (id: string) => (sql.prepare('SELECT * FROM postmortem_sessions WHERE id=?').get(id) as PostmortemSession | undefined) ?? null;
  const required = (id: string) => { const session = get(id); if (!session) throw new PostmortemError(404, 'Post-mortem not found'); return session; };
  function write(id: string, values: Partial<PostmortemSession>): PostmortemSession {
    const next = { ...required(id), ...values, updatedAt: now() };
    try {
      sql.prepare('UPDATE postmortem_sessions SET providerSessionId=@providerSessionId,status=@status,error=@error,turns=@turns,costUsd=@costUsd,updatedAt=@updatedAt WHERE id=@id').run(next);
    } catch (error) {
      if (uniqueViolation(error)) throw new PostmortemError(409, 'This run already has an open post-mortem');
      throw error;
    }
    return next;
  }
  return {
    get,
    create(input: { runId: string; provider: PostmortemProvider; model: string | null; effort: string | null; providerSessionId: string | null }): PostmortemSession {
      const at = now();
      const session: PostmortemSession = { id: randomUUID(), ...input, status: 'starting', error: null, turns: 0, costUsd: null, createdAt: at, updatedAt: at };
      try { sql.prepare('INSERT INTO postmortem_sessions VALUES (@id,@runId,@provider,@model,@effort,@providerSessionId,@status,@error,@turns,@costUsd,@createdAt,@updatedAt)').run(session); }
      catch (error) {
        if (uniqueViolation(error)) throw new PostmortemError(409, 'This run already has an open post-mortem');
        throw error;
      }
      return session;
    },
    open: (runId: string) => (sql.prepare("SELECT * FROM postmortem_sessions WHERE runId=? AND status NOT IN ('capped','error')").get(runId) as PostmortemSession | undefined) ?? null,
    latest: (runId: string) => (sql.prepare('SELECT * FROM postmortem_sessions WHERE runId=? ORDER BY createdAt DESC, rowid DESC LIMIT 1').get(runId) as PostmortemSession | undefined) ?? null,
    update: (id: string, patch: { providerSessionId?: string | null; costUsd?: number | null; turns?: number }) => write(id, patch),
    transition(id: string, status: PostmortemStatus, patch: { error?: string; providerSessionId?: string | null; costUsd?: number | null; turns?: number } = {}): PostmortemSession {
      const current = required(id);
      if (!TRANSITIONS[current.status].includes(status)) throw new PostmortemError(409, `Cannot move post-mortem from ${current.status} to ${status}`);
      const { error, ...rest } = patch;
      return write(id, { ...rest, status, error: status === 'error' ? error ?? 'Post-mortem failed' : null });
    },
    append(sessionId: string, input: { role: PostmortemRole; kind: PostmortemKind; text: string; clientId?: string | null }): { message: PostmortemMessage; duplicate: boolean } {
      const text = truncateMessage(input.text); const clientId = input.clientId ?? null;
      if (clientId) {
        const previous = sql.prepare('SELECT * FROM postmortem_messages WHERE sessionId=? AND clientId=?').get(sessionId, clientId) as PostmortemMessage | undefined;
        if (previous && previous.text !== text) throw new PostmortemError(409, 'Message ID already belongs to a different message');
        if (previous) return { message: previous, duplicate: true };
      }
      const ts = now();
      const result = sql.prepare('INSERT INTO postmortem_messages (sessionId,clientId,role,kind,text,ts) VALUES (?,?,?,?,?,?)').run(sessionId, clientId, input.role, input.kind, text, ts);
      return { message: { id: Number(result.lastInsertRowid), sessionId, clientId, role: input.role, kind: input.kind, text, ts }, duplicate: false };
    },
    messages: (sessionId: string) => sql.prepare('SELECT * FROM postmortem_messages WHERE sessionId=? ORDER BY id').all(sessionId) as PostmortemMessage[],
    sweep: () => sql.prepare("UPDATE postmortem_sessions SET status='idle', updatedAt=? WHERE status IN ('starting','busy','ready')").run(now()).changes,
  };
}
export type PostmortemStore = ReturnType<typeof openPostmortemStore>;
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run server/helmsman/postmortem/session-store.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/helmsman/postmortem/session-store.ts server/helmsman/postmortem/session-store.test.ts
git commit -m "feat: persist post-mortem sessions and transcripts"
```

---

### Task 5: Patch contract

**Files:**
- Create: `server/helmsman/postmortem/patches.ts`
- Test: `server/helmsman/postmortem/patches.test.ts`

**Interfaces:**
- Consumes: `protocolRecord` (Task 1).
- Produces:
  - `type PatchRepo = 'helmsman' | 'target'`
  - `interface PostmortemPatch { file: string; path: string; number: number; repo: PatchRepo; baseSha: string | null; summary: string; valid: boolean; reason: string | null; applyCommand: string | null }`
  - `const PATCH_SIZE_LIMIT = 1_048_576`, `const PATCH_COUNT_LIMIT = 100`
  - `function validatePatch(repoPath: string, baseSha: string, patchPath: string, git?: string): Promise<string | null>` — `null` = applies; otherwise the invalid reason (`'base not found'` or `'does not apply: …'`)
  - `function listPatches(directory: string, repos: Record<PatchRepo, string | null>, git?: string): Promise<PostmortemPatch[]>` — `directory` is the post-mortem dir; reads `directory/patches`; sorted by number then repo; never throws for content problems; never applies

- [ ] **Step 1: Write the failing test**

Create `server/helmsman/postmortem/patches.test.ts`:

```ts
/** @vitest-environment node */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitBin } from '../../test-support/platform';
import { listPatches, validatePatch } from './patches';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const GIT = gitBin();
const diff = (from: string, to: string) => `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hm-pm-patches-')); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync(GIT, ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'one\n'); git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.txt'), 'two\n'); git('commit', '-am', 'later');
  const directory = join(root, 'run.postmortem'); mkdirSync(join(directory, 'patches'), { recursive: true });
  const put = (name: string, patch: string, sidecar?: unknown) => {
    writeFileSync(join(directory, 'patches', `${name}.patch`), patch);
    if (sidecar !== undefined) writeFileSync(join(directory, 'patches', `${name}.json`), typeof sidecar === 'string' ? sidecar : JSON.stringify(sidecar));
  };
  return { root, repo, git, base, directory, put };
}

describe('post-mortem patches', () => {
  it('validates against a temporary index at the base without touching the repository', async () => {
    const f = fixture();
    const patch = join(f.directory, 'patches', 'p.patch'); writeFileSync(patch, diff('one', 'three'));
    expect(await validatePatch(f.repo, f.base, patch, GIT)).toBeNull();
    writeFileSync(patch, diff('zzz', 'three'));
    expect(await validatePatch(f.repo, f.base, patch, GIT)).toMatch(/^does not apply: /);
    expect(await validatePatch(f.repo, 'f'.repeat(40), patch, GIT)).toBe('base not found');
    expect(readFileSync(join(f.repo, 'a.txt'), 'utf8')).toBe('two\n');
    expect(f.git('status', '--porcelain')).toBe('');
  });

  it('lists patches in order with apply commands and badges', async () => {
    const f = fixture();
    f.put('10-target', diff('one', 'ten'), { repo: 'target', baseSha: f.base, summary: 'Ten' });
    f.put('2-target', diff('zzz', 'two'), { repo: 'target', baseSha: f.base, summary: 'Conflicts' });
    f.put('2-helmsman', diff('one', 'h'), { repo: 'helmsman', baseSha: f.base, summary: 'Chunk argv' });
    const patches = await listPatches(f.directory, { helmsman: f.repo, target: null }, GIT);
    expect(patches.map(patch => [patch.file, patch.valid, patch.reason])).toEqual([
      ['2-helmsman.patch', true, null], ['2-target.patch', false, 'repository not available'], ['10-target.patch', false, 'repository not available']]);
    expect(patches[0]).toMatchObject({ number: 2, repo: 'helmsman', baseSha: f.base, summary: 'Chunk argv',
      applyCommand: `git -C '${f.repo}' apply '${join(f.directory, 'patches', '2-helmsman.patch')}'` });
    const both = await listPatches(f.directory, { helmsman: f.repo, target: f.repo }, GIT);
    expect(both.map(patch => patch.valid)).toEqual([true, false, true]);
  });

  it('tolerates junk in the patch directory', async () => {
    const f = fixture();
    f.put('evil', diff('one', 'x'), { repo: 'target', baseSha: f.base, summary: '' });
    f.put('3-other', diff('one', 'x'), { repo: 'target', baseSha: f.base, summary: '' });
    f.put('4-target', diff('one', 'x'), { repo: 'helmsman', baseSha: f.base, summary: 'label mismatch' });
    f.put('5-target', diff('one', 'x'));
    f.put('6-target', diff('one', 'x'), '{not json');
    f.put('7-target', 'x'.repeat(1_048_577), { repo: 'target', baseSha: f.base, summary: 'huge' });
    f.put('8-target', diff('one', 'x'), { repo: 'target', baseSha: 'not-a-sha', summary: 'bad sha' });
    writeFileSync(join(f.root, 'outside.patch'), diff('one', 'x'));
    symlinkSync(join(f.root, 'outside.patch'), join(f.directory, 'patches', '9-target.patch'));
    writeFileSync(join(f.directory, 'patches', '9-target.json'), JSON.stringify({ repo: 'target', baseSha: f.base, summary: 'link' }));
    const patches = await listPatches(f.directory, { helmsman: f.repo, target: f.repo }, GIT);
    expect(patches.map(patch => [patch.file, patch.reason])).toEqual([
      ['4-target.patch', 'invalid sidecar'], ['5-target.patch', 'missing sidecar'], ['6-target.patch', 'invalid sidecar'],
      ['7-target.patch', 'patch too large'], ['8-target.patch', 'invalid sidecar'], ['9-target.patch', 'not a regular file']]);
  });

  it('returns an empty list when no patches directory exists', async () => {
    expect(await listPatches(join(tmpdir(), 'hm-pm-missing-dir'), { helmsman: null, target: null }, GIT)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/helmsman/postmortem/patches.test.ts`
Expected: FAIL — cannot resolve `./patches`.

- [ ] **Step 3: Implement `server/helmsman/postmortem/patches.ts`**

```ts
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { protocolRecord } from '../agent-protocol';

export type PatchRepo = 'helmsman' | 'target';
export interface PostmortemPatch {
  file: string; path: string; number: number; repo: PatchRepo; baseSha: string | null; summary: string; valid: boolean; reason: string | null; applyCommand: string | null;
}
export const PATCH_SIZE_LIMIT = 1_048_576;
export const PATCH_COUNT_LIMIT = 100;
const PATCH_NAME = /^([1-9]\d{0,5})-(helmsman|target)\.patch$/;
const SHA = /^[0-9a-f]{7,64}$/i;
const SIDECAR_LIMIT = 16_384;
const execute = promisify(execFile);
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export async function validatePatch(repoPath: string, baseSha: string, patchPath: string, git = 'git'): Promise<string | null> {
  try { await execute(git, ['-C', repoPath, 'cat-file', '-e', `${baseSha}^{commit}`], { timeout: 10_000 }); }
  catch { return 'base not found'; }
  const index = await mkdtemp(join(tmpdir(), 'hm-pm-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(index, 'index') };
  try {
    await execute(git, ['-C', repoPath, 'read-tree', baseSha], { env, timeout: 10_000 });
    await execute(git, ['-C', repoPath, 'apply', '--check', '--cached', patchPath], { env, timeout: 10_000 });
    return null;
  } catch (error) {
    const detail = String((error as { stderr?: unknown })?.stderr ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? 'patch does not apply';
    return `does not apply: ${detail.slice(0, 200)}`;
  } finally { await rm(index, { recursive: true, force: true }); }
}

async function sidecar(path: string, repo: PatchRepo): Promise<{ baseSha: string; summary: string } | 'missing' | 'invalid'> {
  const info = await lstat(path).catch(() => null);
  if (!info) return 'missing';
  if (!info.isFile() || info.size > SIDECAR_LIMIT) return 'invalid';
  let value: Record<string, unknown> | undefined;
  try { value = protocolRecord(JSON.parse(await readFile(path, 'utf8'))); } catch { return 'invalid'; }
  if (!value || value.repo !== repo || typeof value.baseSha !== 'string' || !SHA.test(value.baseSha) || typeof value.summary !== 'string' || value.summary.length > 500) return 'invalid';
  return { baseSha: value.baseSha, summary: value.summary };
}

export async function listPatches(directory: string, repos: Record<PatchRepo, string | null>, git = 'git'): Promise<PostmortemPatch[]> {
  const folder = join(directory, 'patches');
  let names: string[];
  try { names = await readdir(folder); } catch { return []; }
  const candidates = names.flatMap(name => { const match = name.match(PATCH_NAME); return match ? [{ name, number: Number(match[1]), repo: match[2] as PatchRepo }] : []; })
    .sort((a, b) => a.number - b.number || a.repo.localeCompare(b.repo)).slice(0, PATCH_COUNT_LIMIT);
  const patches: PostmortemPatch[] = [];
  for (const { name, number, repo } of candidates) {
    const path = join(folder, name); const repoPath = repos[repo];
    const base = { file: name, path, number, repo, baseSha: null, summary: '', applyCommand: repoPath ? `git -C ${shellQuote(repoPath)} apply ${shellQuote(path)}` : null };
    const invalid = (reason: string, extra: Partial<PostmortemPatch> = {}): PostmortemPatch => ({ ...base, ...extra, valid: false, reason });
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) { patches.push(invalid('not a regular file')); continue; }
    if (info.size > PATCH_SIZE_LIMIT) { patches.push(invalid('patch too large')); continue; }
    const meta = await sidecar(path.replace(/\.patch$/, '.json'), repo);
    if (meta === 'missing') { patches.push(invalid('missing sidecar')); continue; }
    if (meta === 'invalid') { patches.push(invalid('invalid sidecar')); continue; }
    if (!repoPath) { patches.push(invalid('repository not available', meta)); continue; }
    const reason = await validatePatch(repoPath, meta.baseSha, path, git);
    patches.push({ ...base, ...meta, valid: reason === null, reason });
  }
  return patches;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run server/helmsman/postmortem/patches.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/helmsman/postmortem/patches.ts server/helmsman/postmortem/patches.test.ts
git commit -m "feat: list and validate post-mortem patches without applying them"
```

---
### Task 6: Seed prompt

**Files:**
- Create: `server/helmsman/postmortem/prompt.ts`
- Test: `server/helmsman/postmortem/prompt.test.ts`

**Interfaces:**
- Consumes: `PostmortemEvidence`, `buildEvidence` (Task 2).
- Produces:
  - `const SEED_PROMPT_LIMIT = 24_000`
  - `const SEED_PROMPT_ENDING = 'Give your diagnosis first — likely cause, evidence, confidence — then what you would check next.'`
  - `const EMPTY_OUTPUT_NOTE = 'No agent output — consider exec-level causes: host, spec argv (lengths are listed), endpoint protection, PATH, provider auth.'`
  - `interface SeedPromptInput { evidence: PostmortemEvidence; directory: string; evidencePath: string; priorTranscript?: readonly { role: string; kind: string; text: string }[] }`
  - `function seedPrompt(input: SeedPromptInput): string` — ≤ `SEED_PROMPT_LIMIT` chars, always ends with `SEED_PROMPT_ENDING`; summary inline, full artifacts by path.

- [ ] **Step 1: Write the failing test**

Create `server/helmsman/postmortem/prompt.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/helmsman/postmortem/prompt.test.ts`
Expected: FAIL — cannot resolve `./prompt`.

- [ ] **Step 3: Implement `server/helmsman/postmortem/prompt.ts`**

```ts
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
```

The literal `${DIR}/patches/<n>-<repo>.patch` expected by the test is produced by `join(directory, 'patches')` + `/<n>-<repo>.patch`.

- [ ] **Step 4: Run the test**

Run: `npx vitest run server/helmsman/postmortem/prompt.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/helmsman/postmortem/prompt.ts server/helmsman/postmortem/prompt.test.ts
git commit -m "feat: compose bounded post-mortem seed prompt"
```

---

### Task 7: Provider session (+ persistent provider home)

**Files:**
- Modify: `server/helmsman/model-routing-cli.ts:1` (imports), `:44-62` (`linkSkills`, `codexEnvironment`), `:98-126` (`prepareModelRouting`)
- Modify: `server/helmsman/model-routing.test.ts:9` (import) + append a describe block
- Create: `server/helmsman/postmortem/provider-session.ts`
- Test: `server/helmsman/postmortem/provider-session.test.ts`

**Why the routing change (spec assumption corrected):** the spec says resume relies on provider storage under `~/.codex`/`~/.claude`. In this codebase every agent is GoCaaS-routed, and `prepareModelRouting` (`model-routing-cli.ts:52-62,111-120`) points `CODEX_HOME`/`CLAUDE_CONFIG_DIR` at a fresh `mkdtemp` directory and deletes it in `cleanup()`. Rollouts/sessions therefore live in that temp home and vanish when the process stops, so `thread/resume` / `--resume` would always fail. Fix: an optional `home` that is reused and never deleted; the post-mortem uses `<pmDir>/provider-home/<provider>` (already inside the sandbox write allowlist). Existing callers pass no option → unchanged behavior.

**Interfaces:**
- Consumes: `connectAgentProtocol`, `protocolRecord`, `ProtocolTimeout` (Task 1); `estimateUnreportedUsage` (`server/helmsman/cost-estimates.ts:4`); `codexAgentProvider` (`src/plugins/agent-codex/provider.ts:65-75`), `claudeAgentProvider` (`src/plugins/agent-claude/provider.ts:34-42`); `PostmortemProvider`, `PostmortemKind` (Task 4).
- Produces:
  - `prepareModelRouting(value: unknown, options?: { home?: string })` (same return type)
  - `interface ProviderItem { role: 'agent' | 'system'; kind: PostmortemKind; text: string }`
  - `function providerCommand(input: { provider: PostmortemProvider; model: string | null; effort: string | null; repo: string; sessionId: string | null; resume: boolean }): { cmd: string; args: string[] }`
  - `function providerTransport(provider: PostmortemProvider): 'openai-responses' | 'anthropic-messages'`
  - `interface ProviderSession { readonly providerSessionId: string; turn(text: string): Promise<{ costUsd: number | null }>; close(): Promise<void>; readonly closed: Promise<Error | null> }` — `costUsd` is cumulative for this process; `closed` resolves `null` after `close()`, else the exit error
  - `interface OpenProviderSessionInput { provider: PostmortemProvider; command: { cmd: string; args: readonly string[] }; env: NodeJS.ProcessEnv; cwd: string; model: string | null; effort: string | null; providerSessionId: string | null; resume: boolean; onItem(item: ProviderItem): void; requestTimeoutMs?: number; stopGraceMs?: number }`
  - `function openProviderSession(input: OpenProviderSessionInput): Promise<ProviderSession>`

Protocol facts reused from `interactive-agent.ts`: codex `initialize` → `initialized` → `thread/start {cwd, model, approvalPolicy:'never', sandbox:'danger-full-access'}` → `turn/start {threadId, input:[{type:'text', text, text_elements:[]}], effort}`; `thread/tokenUsage/updated` carries `tokenUsage.total {inputTokens, cachedInputTokens, outputTokens}`; turn ends with `turn/completed {turn:{id,status}}`. Claude: newline JSON user messages `{type:'user', uuid, session_id, message:{role:'user', content}, parent_tool_use_id:null}`; a turn ends with `type:'result'` carrying cumulative `total_cost_usd`. Codex `sandbox:'danger-full-access'` is deliberate: the outer Seatbelt is the boundary and Seatbelt cannot nest.

- [ ] **Step 1: Write the failing routing test**

In `server/helmsman/model-routing.test.ts` change line 9 to:

```ts
import { claudeCommand, codexCommand, prepareModelRouting, runModelRoutingCli } from './model-routing-cli';
```

and append:

```ts
describe('persistent provider home', () => {
  it.each(['openai-responses', 'anthropic-messages'] as const)('reuses and keeps the %s home across preparations', async transport => {
    const home = mkdtempSync(join(tmpdir(), 'hm-routing-home-'));
    try {
      const codex = transport === 'openai-responses';
      const command = codex ? { cmd: 'codex', args: ['app-server', '--stdio'] } : { cmd: 'claude', args: ['-p'] };
      for (let round = 0; round < 2; round += 1) {
        const routed = await prepareModelRouting({ version: 1, command, transport, modelGateway: gateway, skillsPath: null }, { home });
        expect(routed.environment[codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']).toBe(home);
        await routed.cleanup();
      }
      expect(existsSync(join(home, codex ? 'config.toml' : 'settings.json'))).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/helmsman/model-routing.test.ts -t "persistent provider home"`
Expected: FAIL — `CODEX_HOME` is a `helmsman-codex-home-*` temp path, not `home`.

- [ ] **Step 3: Implement the option in `model-routing-cli.ts`**

Change line 1 to `import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';`. Replace lines 52-62 (`codexEnvironment`) and 98-126 (`prepareModelRouting`) with:

```ts
async function providerHome(prefix: string, home: string | undefined): Promise<{ path: string; cleanup(): Promise<void> }> {
  if (!home) {
    const path = await mkdtemp(join(tmpdir(), prefix));
    return { path, cleanup: async () => { await rm(path, { recursive: true, force: true }); } };
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  await rm(join(home, 'skills'), { force: true });
  return { path: home, cleanup: async () => undefined };
}

async function codexEnvironment(environment: NodeJS.ProcessEnv, url: string, token: string, skillsPath: string | null, homeOption?: string): Promise<() => Promise<void>> {
  const { path: home, cleanup } = await providerHome('helmsman-codex-home-', homeOption);
  const baseUrl = endpoint(url, 'openai/v1');
  await writeFile(join(home, 'config.toml'), `model_provider = "helmsman"\n[model_providers.helmsman]\nname = "Helmsman"\nbase_url = ${JSON.stringify(baseUrl)}\nenv_key = "HELMSMAN_MODEL_CAPABILITY"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  environment.CODEX_HOME = home;
  environment.HELMSMAN_MODEL_CAPABILITY = token;
  environment.OPENAI_BASE_URL = baseUrl;
  environment.OPENAI_API_KEY = token;
  await linkSkills(home, skillsPath);
  return cleanup;
}
```

```ts
export async function prepareModelRouting(value: unknown, options: { home?: string } = {}): Promise<{ command: Input['command']; environment: NodeJS.ProcessEnv; cleanup(): Promise<void> }> {
  const routed = input(value);
  const token = routed.modelGateway.token;
  const environment = cleanedEnvironment();
  let cleanup: () => Promise<void> = async () => undefined;
  let command = routed.command;
  if (routed.transport === 'openai-responses') cleanup = await codexEnvironment(environment, routed.modelGateway.url, token, routed.skillsPath, options.home);
  else {
    environment.ANTHROPIC_BASE_URL = endpoint(routed.modelGateway.url, 'anthropic');
    environment.ANTHROPIC_API_KEY = token;
    environment.ANTHROPIC_AUTH_TOKEN = token;
    environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    environment.CLAUDE_CODE_USE_FOUNDRY = '0';
    const home = await providerHome('helmsman-claude-home-', options.home);
    environment.CLAUDE_CONFIG_DIR = home.path;
    await linkSkills(home.path, routed.skillsPath);
    const settingsPath = join(home.path, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: environment.ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY: token, ANTHROPIC_AUTH_TOKEN: token,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
    } }), { mode: 0o600 });
    command = claudeCommand(command, settingsPath);
    cleanup = home.cleanup;
  }
  try {
    command = routed.transport === 'openai-responses' ? codexCommand(command, routed.modelGateway.url) : command;
    return { command, environment, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
```

`runModelRoutingCli` keeps calling `prepareModelRouting(JSON.parse(raw || 'null'))` (no option).

- [ ] **Step 4: Run all routing tests**

Run: `npx vitest run server/helmsman/model-routing.test.ts server/helmsman/model-routing.integration.test.ts server/helmsman/interactive-agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing provider-session test**

Create `server/helmsman/postmortem/provider-session.test.ts`:

```ts
/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openProviderSession, providerCommand, type ProviderItem, type ProviderSession } from './provider-session';

const sessions: ProviderSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close())); });
const node = (body: string) => ({ cmd: process.execPath, args: ['-e', `
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const message = JSON.parse(line); ${body} });
`] });
const codex = node(`
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (message.params.approvalPolicy !== 'never' || message.params.sandbox !== 'danger-full-access' || message.params.cwd !== process.cwd()) process.exit(9);
    send({ id: message.id, result: { thread: { id: message.method === 'thread/resume' ? message.params.threadId : 'thread-1' } } });
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-' + message.params.input[0].text } } });
    const notify = (method, params) => send({ method, params: { threadId: message.params.threadId, ...params } });
    notify('item/completed', { item: { id: 'c', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a.txt', exitCode: 0 } });
    notify('item/completed', { item: { id: 'm', type: 'agentMessage', text: 'Diagnosis: exec kill' } });
    notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 1000000, cachedInputTokens: 0, outputTokens: 0 } } });
    notify('turn/completed', { turn: { id: 'turn-' + message.params.input[0].text, status: message.params.input[0].text === 'fail' ? 'failed' : 'completed', error: { message: 'Provider model failed' } } });
  }
`);
async function open(command: { cmd: string; args: string[] }, extra: Partial<Parameters<typeof openProviderSession>[0]> = {}) {
  const items: ProviderItem[] = [];
  const session = await openProviderSession({ provider: 'codex', command, env: process.env, cwd: process.cwd(), model: 'gpt-6-astra', effort: 'high',
    providerSessionId: null, resume: false, onItem: item => items.push(item), stopGraceMs: 200, ...extra });
  sessions.push(session);
  return { session, items };
}

describe('post-mortem provider session', () => {
  it('starts a codex thread, maps items and prices usage', async () => {
    const f = await open(codex);
    expect(f.session.providerSessionId).toBe('thread-1');
    expect(await f.session.turn('one')).toEqual({ costUsd: 10 });
    expect(f.items).toEqual([{ role: 'agent', kind: 'command', text: '$ ls\na.txt\n(exit 0)' }, { role: 'agent', kind: 'text', text: 'Diagnosis: exec kill' }]);
    await expect(f.session.turn('fail')).rejects.toThrow('Provider model failed');
    await f.session.close();
    expect(await f.session.closed).toBeNull();
  });

  it('resumes a stored codex thread', async () => {
    const f = await open(codex, { providerSessionId: 'thread-9', resume: true });
    expect(f.session.providerSessionId).toBe('thread-9');
    await expect(f.session.turn('two')).resolves.toEqual({ costUsd: 10 });
  });

  it('runs claude turns on the pre-assigned session and reports cumulative cost', async () => {
    const id = randomUUID();
    const claude = node(`
      if (message.session_id !== ${JSON.stringify(id)}) process.exit(9);
      send({ type: 'user', uuid: message.uuid, message: message.message });
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
      send({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: message.message.content === 'one' ? 0.12 : 0.3 });
    `);
    const f = await open(claude, { provider: 'claude-code', providerSessionId: id, model: null });
    expect(f.session.providerSessionId).toBe(id);
    expect(await f.session.turn('one')).toEqual({ costUsd: 0.12 });
    expect(await f.session.turn('two')).toEqual({ costUsd: 0.3 });
    expect(f.items.slice(0, 2)).toEqual([{ role: 'agent', kind: 'text', text: 'Looking' }, { role: 'agent', kind: 'tool', text: 'Bash: ls' }]);
  });

  it('reports an unexpected exit and refuses later turns', async () => {
    const f = await open(node(`if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 't' } } }); setTimeout(() => process.exit(3), 20); }`));
    expect((await f.session.closed)?.message).toMatch(/Agent exited 3/);
    await expect(f.session.turn('x')).rejects.toThrow();
  });

  it('escalates to SIGKILL when the provider ignores SIGTERM', async () => {
    const f = await open(node(`if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'thread/start') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); send({ id: message.id, result: { thread: { id: 't' } } }); }`));
    const started = Date.now(); await f.session.close();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('builds provider commands with pre-assigned or resumed claude sessions', () => {
    const id = randomUUID();
    expect(providerCommand({ provider: 'claude-code', model: 'opus', effort: 'high', repo: 'org/app', sessionId: id, resume: false }).args.slice(-2)).toEqual(['--session-id', id]);
    expect(providerCommand({ provider: 'claude-code', model: null, effort: null, repo: 'org/app', sessionId: id, resume: true }).args.slice(-2)).toEqual(['--resume', id]);
    expect(providerCommand({ provider: 'codex', model: null, effort: 'high', repo: 'org/app', sessionId: null, resume: false }))
      .toEqual({ cmd: 'codex', args: ['-c', 'model_reasoning_effort="high"', 'app-server', '--stdio'] });
    expect(() => providerCommand({ provider: 'codex', model: null, effort: 'bogus', repo: 'org/app', sessionId: null, resume: false })).toThrow('Unsupported Codex reasoning effort');
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run server/helmsman/postmortem/provider-session.test.ts`
Expected: FAIL — cannot resolve `./provider-session`.

- [ ] **Step 7: Implement `server/helmsman/postmortem/provider-session.ts`**

```ts
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { claudeAgentProvider } from '../../../src/plugins/agent-claude/provider';
import { codexAgentProvider } from '../../../src/plugins/agent-codex/provider';
import { connectAgentProtocol, protocolRecord, type ProtocolRecord, type ProtocolTimeout } from '../agent-protocol';
import { estimateUnreportedUsage } from '../cost-estimates';
import type { PostmortemKind, PostmortemProvider } from './session-store';

export interface ProviderItem { role: 'agent' | 'system'; kind: PostmortemKind; text: string }
export interface ProviderSession {
  readonly providerSessionId: string;
  turn(text: string): Promise<{ costUsd: number | null }>;
  close(): Promise<void>;
  readonly closed: Promise<Error | null>;
}
export interface OpenProviderSessionInput {
  provider: PostmortemProvider; command: { cmd: string; args: readonly string[] }; env: NodeJS.ProcessEnv; cwd: string;
  model: string | null; effort: string | null; providerSessionId: string | null; resume: boolean;
  onItem(item: ProviderItem): void; requestTimeoutMs?: number; stopGraceMs?: number;
}
const CODEX_DEFAULT_MODEL = 'gpt-6-astra';
const COMMAND_OUTPUT_CHARS = 4000;
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function providerTransport(provider: PostmortemProvider): 'openai-responses' | 'anthropic-messages' {
  return provider === 'codex' ? 'openai-responses' : 'anthropic-messages';
}

export function providerCommand(input: { provider: PostmortemProvider; model: string | null; effort: string | null; repo: string; sessionId: string | null; resume: boolean }): { cmd: string; args: string[] } {
  const request = { version: 1 as const, prompt: 'Failure post-mortem', model: input.model, effort: input.effort, stage: 'direct' as const, summaryCorrection: false,
    task: { ticketId: 'postmortem', repo: input.repo, title: 'Failure post-mortem' } };
  if (input.provider === 'codex') {
    const interactive = codexAgentProvider.buildInteractiveCommand!(request);
    return { cmd: interactive.command.cmd, args: [...interactive.command.args] };
  }
  if (!input.sessionId) throw new Error('Claude post-mortem requires a session ID');
  const interactive = claudeAgentProvider.buildInteractiveCommand!(request);
  return { cmd: interactive.command.cmd, args: [...interactive.command.args, input.resume ? '--resume' : '--session-id', input.sessionId] };
}

function commandText(item: ProtocolRecord): string {
  return [`$ ${String(item.command)}`, typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(-COMMAND_OUTPUT_CHARS) : '',
    typeof item.exitCode === 'number' ? `(exit ${item.exitCode})` : ''].filter(Boolean).join('\n');
}

export async function openProviderSession(input: OpenProviderSessionInput): Promise<ProviderSession> {
  const protocol = input.provider === 'codex' ? 'codex-app-server' : 'claude-stream-json';
  const model = input.provider === 'codex' ? input.model ?? CODEX_DEFAULT_MODEL : input.model;
  const timeout: ProtocolTimeout = { ms: input.requestTimeoutMs ?? 20_000, error: () => new Error('Agent protocol request timed out') };
  const child = spawn(input.command.cmd, [...input.command.args], { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let current: { resolve(value: { costUsd: number | null }): void; reject(error: Error): void; turnId: string } | null = null;
  let threadId = input.provider === 'codex' ? '' : input.providerSessionId ?? '';
  let usage: ProtocolRecord | undefined;
  let claudeCost: number | null = null;
  let turnError: Error | null = null;
  let failure: Error | null = null;
  let closing = false;
  let exited = false;
  let stderr = '';
  let closingPromise: Promise<void> | undefined;
  let resolveClosed!: (error: Error | null) => void;
  const closed = new Promise<Error | null>(resolve => { resolveClosed = resolve; });
  const codexCost = () => usage ? estimateUnreportedUsage({ runId: 'postmortem', attempt: 1, eventId: 'postmortem', provider: 'codex', model,
    inputTokens: count(usage.inputTokens), cachedInputTokens: count(usage.cachedInputTokens), outputTokens: count(usage.outputTokens), totalTokens: null, costUsd: null }) : null;
  const settle = (error: Error | null, value?: { costUsd: number | null }) => {
    const turn = current; current = null;
    if (!turn) return;
    if (error) turn.reject(error); else turn.resolve(value ?? { costUsd: null });
  };
  const fail = (error: Error) => {
    failure ??= error;
    settle(error);
    if (!exited) child.kill('SIGTERM');
  };
  const codexMessage = (message: ProtocolRecord) => {
    const params = protocolRecord(message.params);
    if (!params || params.threadId !== threadId) return;
    const item = protocolRecord(params.item);
    if (message.method === 'thread/tokenUsage/updated') usage = protocolRecord(protocolRecord(params.tokenUsage)?.total);
    if (message.method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) input.onItem({ role: 'agent', kind: 'text', text: item.text });
    if (message.method === 'item/completed' && item?.type === 'commandExecution' && typeof item.command === 'string') input.onItem({ role: 'agent', kind: 'command', text: commandText(item) });
    if (message.method === 'error') {
      const error = protocolRecord(params.error); const text = typeof error?.message === 'string' ? error.message : 'Agent reported an error';
      input.onItem({ role: 'system', kind: 'error', text });
      if (params.willRetry !== true) turnError ??= new Error(text);
    }
    if (message.method === 'turn/completed') {
      const turn = protocolRecord(params.turn);
      if (!current || current.turnId && turn?.id !== current.turnId) return;
      const error = turn?.status === 'completed' && !turnError ? null : turnError
        ?? new Error(typeof protocolRecord(turn?.error)?.message === 'string' ? String(protocolRecord(turn?.error)?.message) : `Agent turn ${String(turn?.status ?? 'failed')}`);
      turnError = null;
      settle(error, { costUsd: codexCost() });
    }
  };
  const claudeMessage = (message: ProtocolRecord) => {
    if (message.type === 'assistant') {
      const content = protocolRecord(message.message)?.content;
      for (const block of Array.isArray(content) ? content : []) {
        const item = protocolRecord(block);
        if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) input.onItem({ role: 'agent', kind: 'text', text: item.text.trim() });
        if (item?.type === 'tool_use' && typeof item.name === 'string') {
          const args = protocolRecord(item.input);
          const detail = typeof args?.command === 'string' ? args.command : typeof args?.file_path === 'string' ? args.file_path : '';
          input.onItem({ role: 'agent', kind: 'tool', text: detail ? `${item.name}: ${detail}` : item.name });
        }
      }
    }
    if (message.type === 'result') {
      if (typeof message.total_cost_usd === 'number' && Number.isFinite(message.total_cost_usd) && message.total_cost_usd >= 0) claudeCost = message.total_cost_usd;
      const failed = message.is_error === true || typeof message.subtype === 'string' && message.subtype.startsWith('error');
      settle(failed ? new Error(typeof message.result === 'string' && message.result ? message.result : 'Agent reported an unsuccessful result') : null, { costUsd: claudeCost });
    }
  };
  const connection = connectAgentProtocol(child, { protocol, onFailure: fail,
    onMessage: message => { if (protocol === 'codex-app-server') codexMessage(message); else claudeMessage(message); } });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  child.stdin.on('error', error => { if (!closing) fail(error); });
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    const detail = stderr.trim().split('\n').pop();
    const error = closing ? null : failure ?? new Error(`Agent exited ${signal ?? code}${detail ? `: ${detail}` : ''}`);
    connection.rejectPending(error ?? new Error('Agent stopped'));
    settle(error ?? new Error('Agent stopped'));
    resolveClosed(error);
  };
  child.once('error', error => { fail(error); if (child.pid === undefined) finish(null, null); });
  child.once('close', finish);
  const session: ProviderSession = {
    get providerSessionId() { return threadId; },
    closed,
    turn(text) {
      if (current) return Promise.reject(new Error('A turn is already in progress'));
      if (exited || failure) return Promise.reject(failure ?? new Error('Agent connection is closed'));
      return new Promise((resolve, reject) => {
        const turn = { resolve, reject, turnId: '' }; current = turn;
        if (protocol === 'codex-app-server') {
          connection.rpc('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], ...(input.effort ? { effort: input.effort } : {}) }, timeout)
            .then(result => { const id = protocolRecord(protocolRecord(result)?.turn)?.id; if (typeof id !== 'string') throw new Error('Agent returned no turn ID'); turn.turnId = id; })
            .catch(error => fail(asError(error)));
        } else {
          try { connection.write({ type: 'user', uuid: randomUUID(), session_id: threadId, message: { role: 'user', content: text }, parent_tool_use_id: null }); }
          catch (error) { fail(asError(error)); }
        }
      });
    },
    close() {
      closingPromise ??= (async () => {
        closing = true;
        if (exited) return;
        child.stdin.end();
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), input.stopGraceMs ?? 5000); timer.unref();
        await closed; clearTimeout(timer);
      })();
      return closingPromise;
    },
  };
  if (protocol === 'codex-app-server') {
    try {
      await connection.rpc('initialize', { clientInfo: { name: 'helmsman', version: '0.4.0' }, capabilities: {} }, timeout);
      connection.write({ method: 'initialized' });
      if (input.resume && !input.providerSessionId) throw new Error('No stored thread to resume');
      const params = { cwd: input.cwd, model, approvalPolicy: 'never', sandbox: 'danger-full-access' };
      const result = protocolRecord(await connection.rpc(input.resume ? 'thread/resume' : 'thread/start', input.resume ? { threadId: input.providerSessionId, ...params } : params, timeout));
      const id = protocolRecord(result?.thread)?.id;
      if (typeof id !== 'string' || input.resume && id !== input.providerSessionId) throw new Error('Agent returned no thread ID');
      threadId = id;
    } catch (error) {
      fail(asError(error));
      await closed;
      throw failure ?? asError(error);
    }
  }
  return session;
}
```

- [ ] **Step 8: Run the test**

Run: `npx vitest run server/helmsman/postmortem/provider-session.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Commit**

```bash
git add server/helmsman/model-routing-cli.ts server/helmsman/model-routing.test.ts server/helmsman/postmortem/provider-session.ts server/helmsman/postmortem/provider-session.test.ts
git commit -m "feat: drive resumable sandboxed provider sessions for post-mortems"
```

---
### Task 8: Post-mortem runner

**Files:**
- Create: `server/helmsman/postmortem/runner.ts`
- Test: `server/helmsman/postmortem/runner.test.ts`
- Test: `server/helmsman/postmortem/postmortem-runner.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-7 (`buildEvidence`, `readEvidenceInput`, `writeEvidenceFile`; `resolveSandboxPaths`, `writeSandboxProfile`, `sandboxCommand`, `scrubEnvironment`, `preflightSandbox`, `SandboxUnavailableError`; `PostmortemStore`, `PostmortemError`, `capReached`; `listPatches`, `PostmortemPatch`; `seedPrompt`; `openProviderSession`, `providerCommand`, `providerTransport`, `ProviderSession`, `ProviderItem`; `prepareModelRouting(value, { home })`).
- Produces:
  - `type PostmortemActivity = 'starting' | 'resuming' | 'thinking' | null`
  - `interface PostmortemSnapshot { session: PostmortemSession; activity: PostmortemActivity; messages: PostmortemMessage[]; patches: PostmortemPatch[] }`
  - `type PostmortemEvent = { type: 'snapshot'; snapshot: PostmortemSnapshot } | { type: 'message'; message: PostmortemMessage } | { type: 'status'; session: PostmortemSession; activity: PostmortemActivity } | { type: 'patches'; patches: PostmortemPatch[] }`
  - `interface PostmortemLimits { maxTurns: number; maxCostUsd: number; idleMs: number; maxLive: number; stopGraceMs: number }`, `const DEFAULT_POSTMORTEM_LIMITS: PostmortemLimits = { maxTurns: 30, maxCostUsd: 5, idleMs: 900_000, maxLive: 2, stopGraceMs: 5000 }`
  - `interface StartPostmortemInput { provider?: PostmortemProvider; model?: string | null; effort?: string | null; fresh?: boolean }`
  - `interface LaunchProviderInput { provider: PostmortemProvider; model: string | null; effort: string | null; repo: string; directory: string; profilePath: string; providerSessionId: string | null; resume: boolean; gateway: { url: string; token: string }; stopGraceMs: number; onItem(item: ProviderItem): void }`
  - `function launchSandboxedProvider(input: LaunchProviderInput): Promise<ProviderSession>`
  - `interface PostmortemRunnerDeps { store: PostmortemStore; runsDir: string; helmsmanRoot: string; getRun(runId: string): RunRow | null; listEvents(runId: string): RunEventRow[]; targetRepoPath(run: RunRow): string | null; helmsmanCommit(): string | null; modelGateway(capabilityId: string): { url: string; token: string }; revokeGateway(capabilityId: string): void; assertModelReady(): void; launch?: (input: LaunchProviderInput) => Promise<ProviderSession>; preflight?: (profilePath: string) => Promise<void>; limits?: Partial<PostmortemLimits>; git?: string }`
  - `function createPostmortemRunner(deps: PostmortemRunnerDeps): PostmortemRunner` where `PostmortemRunner = { start(runId: string, input?: StartPostmortemInput): Promise<PostmortemSnapshot>; read(sessionId: string): Promise<PostmortemSnapshot>; send(sessionId: string, input: { clientId: unknown; text: unknown }): Promise<PostmortemSnapshot>; stop(sessionId: string): Promise<PostmortemSnapshot>; subscribe(sessionId: string, listener: (event: PostmortemEvent) => void): () => void; isLiveCapability(capabilityId: string): boolean; dispose(): Promise<void> }`
  - `function postmortemCapabilityId(sessionId: string): string` → `pm-<sessionId>` (matches the gateway's `/^[a-z\d_-]{1,128}$/i` run-id rule, `scoped-gateway.ts:146`)
  - `const POSTMORTEM_TEXT_LIMIT = 8000` (same as `INSTRUCTION_LIMIT`, `instruction-channel.ts:31`)

Behavior decisions (resolving spec gaps):
- `start` validates eligibility, returns the open session (no spawn) if one exists; `fresh: true` with an open session → 409. Otherwise it writes `evidence.json`/`seed.md`/`profile.sb`, preflights (412), reserves a live slot (429), creates the session (`starting`) and returns immediately; spawning and the seed turn run in the background. With `fresh: true` the latest prior session's transcript goes into the seed.
- A session whose `turns === 0` (seed never completed) or has no stored provider id is relaunched fresh (codex `thread/start`; claude new `--session-id`, except the very first launch which uses the pre-assigned id) and its first turn is the seed followed by the user's text. Otherwise relaunch resumes (`thread/resume` / `--resume`).
- Cost = cost stored when the process was spawned + the process's cumulative cost. For codex after `thread/resume` this may count restored usage twice; that over-estimates and caps early, the safe direction.
- New patches found after a turn are announced once as a `system`/`patch` message (`Proposed patch <file> …`); announcement dedupe reads existing `patch` messages so restarts do not repeat them.

- [ ] **Step 1: Write the failing unit test**

Create `server/helmsman/postmortem/runner.test.ts`:

```ts
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
  private reject: ((error: Error) => void) | null = null;
  private settle!: (error: Error | null) => void;
  readonly closed = new Promise<Error | null>(resolve => { this.settle = resolve; });
  constructor(input: LaunchProviderInput, behavior: Behavior) { this.input = input; this.behavior = behavior; this.providerSessionId = input.providerSessionId ?? 'thread-1'; }
  turn(text: string) {
    this.turns.push(text);
    return new Promise<{ costUsd: number | null }>((resolve, reject) => { this.reject = reject; Promise.resolve(this.behavior(text, this)).then(resolve, reject); });
  }
  async close() { this.closedCalls += 1; this.reject?.(new Error('Agent stopped')); this.settle(null); }
  crash(error: Error) { this.reject?.(error); this.settle(error); }
}
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const run = (id: string, patch: Partial<RunRow> = {}): RunRow => ({ id, ticketId: 'T-1', repo: 'org/app', adapter: 'feedback:codex', status: 'failed', attempt: 1, prNumber: null,
  startedAt: '2026-10-02T19:44:05.235Z', endedAt: '2026-10-02T19:44:09.706Z', costUsd: null, worktreePath: null, taskJson: '{}', ...patch });
const cleanups: Array<() => void> = [];
const runners: PostmortemRunner[] = [];
afterEach(async () => { await Promise.all(runners.splice(0).map(runner => runner.dispose())); for (const cleanup of cleanups.splice(0)) cleanup(); });
const echo: Behavior = (text, process) => { process.input.onItem({ role: 'agent', kind: 'text', text: `reply to ${text.slice(-12)}` }); return { costUsd: 0.1 }; };

function setup(options: { limits?: Partial<PostmortemLimits>; behavior?: Behavior; preflight?: () => Promise<void>; persistence?: Persistence } = {}) {
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
    assertModelReady: () => {}, launch: async input => { const process = new FakeProcess(input, (text, self) => behavior(text, self)); launches.push(process); return process; },
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
    for (const file of ['evidence.json', 'seed.md', 'profile.sb']) expect(existsSync(join(directory, file))).toBe(true);
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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/helmsman/postmortem/runner.test.ts`
Expected: FAIL — cannot resolve `./runner`.

- [ ] **Step 3: Implement `server/helmsman/postmortem/runner.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  deps.store.sweep();

  const directoryFor = (runId: string) => join(deps.runsDir, `${runId}.postmortem`);
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
          spawned = await launch({ provider: session.provider, model: session.model, effort: session.effort, repo: run.repo, directory,
            profilePath: writeSandboxProfile(resolveSandboxPaths(directory, deps.helmsmanRoot)), providerSessionId, resume: !fresh,
            gateway: deps.modelGateway(postmortemCapabilityId(sessionId)), stopGraceMs: limits.stopGraceMs, onItem: item => record(sessionId, item) });
        } finally { spawning.delete(sessionId); }
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
      await rescan(session);
      if (capReached(session, limits)) { setStatus(sessionId, 'capped'); await shutdown(sessionId); return; }
      setStatus(sessionId, 'ready');
      const idleEntry = entry;
      idleEntry.idle = setTimeout(() => { void shutdown(sessionId); }, limits.idleMs);
      idleEntry.idle.unref?.();
    } catch (error) {
      if (slot) slots.delete(slot);
      stopRequested.delete(sessionId);
      const current = deps.store.get(sessionId);
      if (entry?.stopping || !current || current.status === 'idle' || current.status === 'capped') return;
      setStatus(sessionId, 'error', { error: errorText(error) });
      record(sessionId, { role: 'system', kind: 'error', text: errorText(error) });
      await shutdown(sessionId);
    }
  }
  return {
    async start(runId: string, input: StartPostmortemInput = {}): Promise<PostmortemSnapshot> {
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
        let session: PostmortemSession;
        try { session = deps.store.create({ runId, provider, model, effort, providerSessionId: provider === 'claude-code' ? randomUUID() : null }); }
        catch (error) {
          const existing = deps.store.open(runId);
          if (error instanceof PostmortemError && error.status === 409 && existing) { slots.delete(slot); return snapshot(existing.id); }
          throw error;
        }
        activity.set(session.id, 'starting');
        void drive(session.id, null, slot, true);
        return snapshot(session.id);
      } catch (error) { slots.delete(slot); throw error; }
    },
    read: snapshot,
    async send(sessionId: string, input: { clientId: unknown; text: unknown }): Promise<PostmortemSnapshot> {
      const session = required(sessionId);
      const { clientId, text } = input;
      if (typeof clientId !== 'string' || !UUID.test(clientId) || typeof text !== 'string' || !text.trim() || text.length > POSTMORTEM_TEXT_LIMIT) {
        throw new PostmortemError(400, `Enter a message of 1–${POSTMORTEM_TEXT_LIMIT} characters with a valid message ID.`);
      }
      const previous = deps.store.messages(sessionId).find(message => message.clientId === clientId);
      if (previous && previous.text !== text) throw new PostmortemError(409, 'Message ID already belongs to a different message');
      if (previous) return snapshot(sessionId);
      if (session.status === 'capped') throw new PostmortemError(423, 'This post-mortem reached its cap. Start a new post-mortem to continue.');
      if (session.status === 'busy' || session.status === 'starting') throw new PostmortemError(409, 'Wait for the current turn to finish.');
      const resuming = !live.has(sessionId);
      let slot: symbol | null = null;
      if (resuming) {
        modelReady();
        slot = reserve();
        try { await sandboxReady(directoryFor(runOf(session).id)); } catch (error) { slots.delete(slot); throw error; }
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
      void drive(sessionId, text, slot, false);
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
      return () => { set.delete(listener); if (!set.size) listeners.delete(sessionId); };
    },
    isLiveCapability(capabilityId: string): boolean {
      const sessionId = capabilityId.startsWith('pm-') ? capabilityId.slice(3) : '';
      return Boolean(sessionId) && (live.has(sessionId) || spawning.has(sessionId));
    },
    async dispose(): Promise<void> { await Promise.all([...live.keys()].map(shutdown)); },
  };
}
```

Two subtleties the tests pin: (a) the idle timer is armed only after `ready`, and `send` clears it before the next turn; (b) when a stopped busy process rejects its turn, `entry.stopping` makes `drive` return without recording an error.

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run server/helmsman/postmortem/runner.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Write the macOS integration test**

Create `server/helmsman/postmortem/postmortem-runner.integration.test.ts`:

```ts
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
log({ argv });
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
  const transcript = join(root, 'transcript.jsonl');
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`); vi.stubEnv('TEST_TRANSCRIPT', transcript); vi.stubEnv('TEST_BASE_SHA', git('rev-parse', 'HEAD'));
  const persistence = openPersistence(':memory:'); cleanups.push(() => persistence.close());
  const runs = new Map<string, RunRow>(['codex', 'claude-code'].map(adapter => [adapter, { id: adapter, ticketId: 'T-1', repo: 'org/app', adapter, status: 'failed', attempt: 1,
    prNumber: null, startedAt: '2026-10-02T19:44:05.235Z', endedAt: '2026-10-02T19:44:09.706Z', costUsd: null, worktreePath: null, taskJson: '{}' }]));
  const runner = createPostmortemRunner({ store: openPostmortemStore(persistence), runsDir: join(root, 'runs'), helmsmanRoot: root, getRun: id => runs.get(id) ?? null,
    listEvents: () => [], targetRepoPath: () => repo, helmsmanCommit: () => null, modelGateway: () => ({ url: 'http://127.0.0.1:9/', token: 'a'.repeat(64) }),
    revokeGateway: () => {}, assertModelReady: () => {}, git: gitBin(), limits: { idleMs: limits.idleMs ?? 60_000, maxTurns: limits.maxTurns ?? 30, stopGraceMs: 500 } });
  mkdirSync(join(root, 'runs')); runners.push(runner);
  const status = (id: string, expected: PostmortemStatus) => vi.waitFor(async () => expect((await runner.read(id)).session.status).toBe(expected), { timeout: 15_000, interval: 50 });
  const entries = () => existsSync(transcript) ? readFileSync(transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : [];
  return { runner, status, entries };
}

describe.skipIf(process.platform !== 'darwin' || !hasShebangShims)('post-mortem runner with sandboxed fake providers', () => {
  it('runs codex: seed, message, idle, resume with the stored thread, patch, stop', async () => {
    const f = setup({ idleMs: 300 });
    const { session } = await f.runner.start('codex'); await f.status(session.id, 'ready');
    await f.runner.send(session.id, { clientId: UUID(1), text: 'Why?' }); await f.status(session.id, 'ready');
    await f.status(session.id, 'idle');
    await f.runner.send(session.id, { clientId: UUID(2), text: 'Now write a patch' }); await f.status(session.id, 'ready');
    const resumed = f.entries().filter(entry => entry.method === 'thread/resume');
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.params).toMatchObject({ threadId: 'thread-fake-1' });
    const snapshot = await f.runner.read(session.id);
    expect(snapshot.messages.map(message => message.text)).toContain('outside write denied');
    expect(snapshot.patches).toEqual([expect.objectContaining({ file: '1-target.patch', valid: true })]);
    expect((await f.runner.stop(session.id)).session.status).toBe('idle');
  }, 60_000);

  it('runs claude with --session-id first and --resume after idle', async () => {
    const f = setup({ idleMs: 300 });
    const { session } = await f.runner.start('claude-code'); await f.status(session.id, 'ready');
    await f.status(session.id, 'idle');
    await f.runner.send(session.id, { clientId: UUID(1), text: 'Still there?' }); await f.status(session.id, 'ready');
    const argvs = f.entries().filter(entry => Array.isArray(entry.argv)).map(entry => entry.argv as string[]);
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
```

- [ ] **Step 6: Run the integration test**

Run: `npx vitest run server/helmsman/postmortem/postmortem-runner.integration.test.ts`
Expected (macOS): PASS (3 tests). Elsewhere: 3 skipped. If `thread/resume` is missing, check that `provider-home/codex` persisted (Task 7) and that the idle timer fired.

- [ ] **Step 7: Commit**

```bash
git add server/helmsman/postmortem/runner.ts server/helmsman/postmortem/runner.test.ts server/helmsman/postmortem/postmortem-runner.integration.test.ts
git commit -m "feat: run sandboxed post-mortem sessions with caps, idle stop and resume"
```

---
### Task 9: HTTP routes, SSE and application wiring

**Files:**
- Create: `server/helmsman/postmortem/routes.ts`
- Test: `server/helmsman/postmortem/routes.test.ts`
- Modify: `server/helmsman/postmortem/runner.ts` (append `postmortemLimitsFromEnv`), `server/helmsman/postmortem/runner.test.ts` (append one test)
- Modify: `server/helmsman/router.ts:1-2` (imports), `:105-169` (`RouterDeps`), `:177-178` (dispatch in `handleApi`)
- Modify: `server/helmsman/application.ts:90-93` (imports), `:479-481` (gateway `active`), after `:566` (construct runner), `:1943` (SSE route), `:1964-1971` (handleApi deps), `:2049`, `:2050-2055` (shutdown)

**Why a post-mortem capability id (spec assumption corrected):** the spec says routing is prepared "exactly as normal runs do". Normal runs get `gateway.issue(runId, …)` (`application.ts:1584`), and the gateway authorizes every request with `active: runId => db.getRun(runId)?.status === 'running' && !stopRequested(runId)` (`application.ts:480`). A failed run is never `running`, so a capability issued for the failed run's id would be rejected with `401 Inactive capability` on the first model call. The post-mortem therefore issues capabilities for `pm-<sessionId>`, and `active` also accepts ids for which `postmortems.isLiveCapability(id)` is true. `scope(id)` stays `db.getRun(id)`-based, which is `null` for `pm-` ids, so publication, `git/push` and GitHub reads stay denied (`scoped-gateway.ts:60,82,110-114`); only the model endpoints are reachable.

**Interfaces:**
- Consumes: `PostmortemRunner`, `PostmortemEvent`, `StartPostmortemInput`, `PostmortemLimits` (Task 8); `PostmortemError` (Task 4); `protocolRecord` (Task 1); `ApiResult` (`router.ts:65-68`).
- Produces:
  - `function handlePostmortemApi(input: { method: string; path: string; body?: unknown; caller?: string; service?: PostmortemRunner }): Promise<ApiResult | null>` — `null` for paths it does not own; 403 without caller (same idiom as `run-instruction-routes.ts:14-15`); 503 without service; `PostmortemError.status` passthrough; 500 otherwise
  - `function handlePostmortemEvents(req: IncomingMessage, res: ServerResponse, pathname: string, input: { caller?: string; service?: PostmortemRunner }): Promise<boolean>` — SSE `data: <json>\n\n` frames; first frame `{ type: 'snapshot' }`, then live events; same SSE headers and 2 MB back-pressure cut-off as `run-log.ts:62,78-81`
  - `RouterDeps.postmortem?: PostmortemRunner`, `RouterDeps.postmortemCaller?: string`
  - `function postmortemLimitsFromEnv(env: NodeJS.ProcessEnv): Partial<PostmortemLimits>` — `HELMSMAN_POSTMORTEM_MAX_TURNS` (int ≥1), `HELMSMAN_POSTMORTEM_MAX_COST_USD` (>0), `HELMSMAN_POSTMORTEM_IDLE_MINUTES` (>0), `HELMSMAN_POSTMORTEM_MAX_LIVE` (int ≥1); invalid values ignored

- [ ] **Step 1: Write the failing route test**

Create `server/helmsman/postmortem/routes.test.ts`:

```ts
/** @vitest-environment node */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlePostmortemApi, handlePostmortemEvents } from './routes';
import type { PostmortemEvent, PostmortemRunner, PostmortemSnapshot } from './runner';
import { PostmortemError } from './session-store';

const SID = '00000000-0000-4000-8000-000000000001';
const snapshot = { session: { id: SID, status: 'ready' }, activity: null, messages: [], patches: [] } as unknown as PostmortemSnapshot;
function service(overrides: Partial<PostmortemRunner> = {}) {
  let listener: ((event: PostmortemEvent) => void) | undefined;
  const value = { start: vi.fn(async () => snapshot), read: vi.fn(async () => snapshot), send: vi.fn(async () => snapshot), stop: vi.fn(async () => snapshot),
    subscribe: vi.fn((_id: string, next: (event: PostmortemEvent) => void) => { listener = next; return () => { listener = undefined; }; }),
    isLiveCapability: vi.fn(() => false), dispose: vi.fn(async () => {}), ...overrides } as unknown as PostmortemRunner;
  return { value, emit: (event: PostmortemEvent) => listener?.(event), listening: () => listener !== undefined };
}
const call = (method: string, path: string, body: unknown, value: PostmortemRunner, caller: string | undefined = 'helmsman.run-viewer/panel') =>
  handlePostmortemApi({ method, path, body, caller, service: value });
const failing = (status: number) => vi.fn(async () => { throw new PostmortemError(status, `status ${status}`); });
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });

describe('post-mortem routes', () => {
  it('ignores unrelated paths and requires a contribution caller', async () => {
    const f = service();
    expect(await call('GET', '/api/runs/abc/feedback-snapshot', null, f.value)).toBeNull();
    expect(await call('POST', '/api/runs/run-1/postmortem', null, f.value, undefined)).toEqual({ status: 403, json: { error: 'forbidden' } });
    expect(await handlePostmortemApi({ method: 'GET', path: `/api/postmortem/${SID}`, caller: 'x' })).toMatchObject({ status: 503 });
  });

  it('starts or reuses a session with validated options', async () => {
    const f = service();
    expect(await call('POST', '/api/runs/run-1/postmortem', { provider: 'claude-code', model: 'opus', effort: 'high', fresh: true }, f.value)).toEqual({ status: 200, json: snapshot });
    expect(f.value.start).toHaveBeenCalledWith('run-1', { provider: 'claude-code', model: 'opus', effort: 'high', fresh: true });
    expect(await call('POST', '/api/runs/run-1/postmortem', null, f.value)).toEqual({ status: 200, json: snapshot });
    expect(f.value.start).toHaveBeenLastCalledWith('run-1', {});
    for (const body of [{ provider: 'gpt' }, { model: '--danger' }, { effort: 'HIGH!' }, { fresh: 'yes' }, { extra: 1 }, [1]]) {
      expect(await call('POST', '/api/runs/run-1/postmortem', body, f.value)).toMatchObject({ status: 400 });
    }
  });

  it.each([[404, 'unknown run'], [409, 'ineligible run'], [412, 'sandbox unavailable'], [429, 'concurrency limit']])('maps start %s (%s)', async status => {
    expect(await call('POST', '/api/runs/run-1/postmortem', {}, service({ start: failing(status) }).value)).toEqual({ status, json: { error: `status ${status}` } });
  });

  it.each([[409, 'turn in progress'], [423, 'capped'], [412, 'sandbox unavailable'], [429, 'concurrency limit'], [400, 'invalid message']])('maps message %s (%s)', async status => {
    expect(await call('POST', `/api/postmortem/${SID}/messages`, { clientId: SID, text: 'hi' }, service({ send: failing(status) }).value)).toMatchObject({ status });
  });

  it('reads, sends, stops and rejects other methods', async () => {
    const f = service();
    expect(await call('GET', `/api/postmortem/${SID}`, null, f.value)).toEqual({ status: 200, json: snapshot });
    await call('POST', `/api/postmortem/${SID}/messages`, { clientId: SID, text: 'Why?' }, f.value);
    expect(f.value.send).toHaveBeenCalledWith(SID, { clientId: SID, text: 'Why?' });
    expect(await call('POST', `/api/postmortem/${SID}/stop`, null, f.value)).toEqual({ status: 200, json: snapshot });
    expect(await call('DELETE', `/api/postmortem/${SID}`, null, f.value)).toMatchObject({ status: 405 });
    expect(await call('GET', '/api/postmortem/not-a-uuid', null, f.value)).toBeNull();
    expect(await call('GET', `/api/postmortem/${SID}`, null, service({ read: vi.fn(async () => { throw new Error('boom'); }) }).value)).toMatchObject({ status: 500 });
  });

  it('streams a snapshot then live events over SSE and unsubscribes on close', async () => {
    const f = service();
    const server = createServer((req, res) => { void handlePostmortemEvents(req, res, new URL(req.url ?? '/', 'http://x').pathname,
      { caller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined, service: f.value }); });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
    const url = `http://127.0.0.1:${address.port}/api/postmortem/${SID}/events`;
    expect((await fetch(url)).status).toBe(403);
    const abort = new AbortController();
    const response = await fetch(url, { headers: { 'X-Helmsman-Contribution': 'helmsman.run-viewer/panel' }, signal: abort.signal });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader(); const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    expect(JSON.parse(text.replace(/^data: /, '').trim())).toEqual({ type: 'snapshot', snapshot });
    f.emit({ type: 'patches', patches: [] });
    text = decoder.decode((await reader.read()).value);
    expect(text).toBe(`data: ${JSON.stringify({ type: 'patches', patches: [] })}\n\n`);
    abort.abort();
    await vi.waitFor(() => expect(f.listening()).toBe(false));
    const missing = service({ read: failing(404) });
    expect(await new Promise<boolean>(resolve => {
      const req = { method: 'GET' } as never; const res = { writeHead: vi.fn(() => res), end: vi.fn(() => resolve(true)) } as never;
      void handlePostmortemEvents(req, res, `/api/postmortem/${SID}/events`, { caller: 'c', service: missing.value });
    })).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/helmsman/postmortem/routes.test.ts`
Expected: FAIL — cannot resolve `./routes`.

- [ ] **Step 3: Implement `server/helmsman/postmortem/routes.ts`**

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { protocolRecord } from '../agent-protocol';
import type { ApiResult } from '../router';
import type { PostmortemEvent, PostmortemRunner, StartPostmortemInput } from './runner';
import { PostmortemError } from './session-store';

const RUN_PATH = /^\/api\/runs\/([a-z\d_-]{1,128})\/postmortem$/i;
const SESSION_PATH = /^\/api\/postmortem\/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(?:\/(messages|stop))?$/i;
const EVENTS_PATH = /^\/api\/postmortem\/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\/events$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;
const EFFORT = /^[a-z]{1,16}$/;
const START_FIELDS = new Set(['provider', 'model', 'effort', 'fresh']);
const STREAM_BACKLOG_LIMIT = 2 * 1024 * 1024;

function startInput(body: unknown): StartPostmortemInput {
  if (body === null || body === undefined) return {};
  const value = protocolRecord(body);
  const invalid = () => new PostmortemError(400, 'Choose a supported provider, model and effort.');
  if (!value || Object.keys(value).some(key => !START_FIELDS.has(key))) throw invalid();
  const { provider, model, effort, fresh } = value;
  if (provider !== undefined && provider !== 'codex' && provider !== 'claude-code') throw invalid();
  if (model !== undefined && model !== null && (typeof model !== 'string' || !MODEL.test(model))) throw invalid();
  if (effort !== undefined && effort !== null && (typeof effort !== 'string' || !EFFORT.test(effort))) throw invalid();
  if (fresh !== undefined && typeof fresh !== 'boolean') throw invalid();
  return { ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }), ...(fresh === undefined ? {} : { fresh }) };
}

export async function handlePostmortemApi(input: { method: string; path: string; body?: unknown; caller?: string; service?: PostmortemRunner }): Promise<ApiResult | null> {
  const run = input.path.match(RUN_PATH); const session = input.path.match(SESSION_PATH);
  if (!run && !session) return null;
  if (!input.caller) return { status: 403, json: { error: 'forbidden' } };
  if (!input.service) return { status: 503, json: { error: 'Post-mortems are unavailable.' } };
  try {
    if (run && input.method === 'POST') return { status: 200, json: await input.service.start(run[1]!, startInput(input.body)) };
    if (session && !session[2] && input.method === 'GET') return { status: 200, json: await input.service.read(session[1]!) };
    if (session?.[2] === 'messages' && input.method === 'POST') {
      const body = protocolRecord(input.body);
      return { status: 200, json: await input.service.send(session[1]!, { clientId: body?.clientId, text: body?.text }) };
    }
    if (session?.[2] === 'stop' && input.method === 'POST') return { status: 200, json: await input.service.stop(session[1]!) };
    return { status: 405, json: { error: 'Method not allowed.' } };
  } catch (error) {
    if (error instanceof PostmortemError) return { status: error.status, json: { error: error.message } };
    return { status: 500, json: { error: 'Post-mortem request failed.' } };
  }
}

export async function handlePostmortemEvents(req: IncomingMessage, res: ServerResponse, pathname: string, input: { caller?: string; service?: PostmortemRunner }): Promise<boolean> {
  const match = pathname.match(EVENTS_PATH);
  if (!match || req.method !== 'GET') return false;
  const reply = (status: number, error: string) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error })); };
  if (!input.caller) { reply(403, 'forbidden'); return true; }
  if (!input.service) { reply(503, 'Post-mortems are unavailable.'); return true; }
  const service = input.service; const sessionId = match[1]!;
  const write = (event: PostmortemEvent) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > STREAM_BACKLOG_LIMIT) { res.destroy(); return; }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const buffered: PostmortemEvent[] = [];
  let streaming = false;
  let off: (() => void) | undefined;
  try {
    off = service.subscribe(sessionId, event => { if (streaming) write(event); else buffered.push(event); });
    const snapshot = await service.read(sessionId);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    write({ type: 'snapshot', snapshot });
    for (const event of buffered.splice(0)) write(event);
    streaming = true;
    res.on('close', () => off?.());
  } catch (error) {
    off?.();
    reply(error instanceof PostmortemError ? error.status : 500, error instanceof PostmortemError ? error.message : 'Post-mortem request failed.');
  }
  return true;
}
```

Events buffered between `subscribe` and `read` may duplicate messages already in the snapshot; the client merges by message `id` (Task 11).

- [ ] **Step 4: Run the route test**

Run: `npx vitest run server/helmsman/postmortem/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Add env limits (test first)**

Append to `server/helmsman/postmortem/runner.test.ts`:

```ts
describe('post-mortem limits from env', () => {
  it('reads valid overrides and ignores invalid ones', async () => {
    const { postmortemLimitsFromEnv } = await import('./runner');
    expect(postmortemLimitsFromEnv({ HELMSMAN_POSTMORTEM_MAX_TURNS: '10', HELMSMAN_POSTMORTEM_MAX_COST_USD: '2.5', HELMSMAN_POSTMORTEM_IDLE_MINUTES: '1', HELMSMAN_POSTMORTEM_MAX_LIVE: '3' }))
      .toEqual({ maxTurns: 10, maxCostUsd: 2.5, idleMs: 60_000, maxLive: 3 });
    expect(postmortemLimitsFromEnv({ HELMSMAN_POSTMORTEM_MAX_TURNS: '0.5', HELMSMAN_POSTMORTEM_MAX_COST_USD: '-1', HELMSMAN_POSTMORTEM_IDLE_MINUTES: 'x', HELMSMAN_POSTMORTEM_MAX_LIVE: '' })).toEqual({});
  });
});
```

Run: `npx vitest run server/helmsman/postmortem/runner.test.ts -t "limits from env"` → FAIL (`postmortemLimitsFromEnv is not a function`). Then append to `server/helmsman/postmortem/runner.ts`:

```ts
export function postmortemLimitsFromEnv(env: NodeJS.ProcessEnv): Partial<PostmortemLimits> {
  const number = (key: string) => { const raw = env[key]?.trim(); const value = raw ? Number(raw) : Number.NaN; return Number.isFinite(value) && value > 0 ? value : null; };
  const integer = (key: string) => { const value = number(key); return value !== null && Number.isSafeInteger(value) ? value : null; };
  const maxTurns = integer('HELMSMAN_POSTMORTEM_MAX_TURNS'); const maxCostUsd = number('HELMSMAN_POSTMORTEM_MAX_COST_USD');
  const idleMinutes = number('HELMSMAN_POSTMORTEM_IDLE_MINUTES'); const maxLive = integer('HELMSMAN_POSTMORTEM_MAX_LIVE');
  return { ...(maxTurns === null ? {} : { maxTurns }), ...(maxCostUsd === null ? {} : { maxCostUsd }),
    ...(idleMinutes === null ? {} : { idleMs: idleMinutes * 60_000 }), ...(maxLive === null ? {} : { maxLive }) };
}
```

Run the same command → PASS.

- [ ] **Step 6: Wire `router.ts`**

Add imports after line 2:

```ts
import { handlePostmortemApi } from './postmortem/routes';
import type { PostmortemRunner } from './postmortem/runner';
```

Add to `RouterDeps` (after `runInstructions?` at line 107):

```ts
  postmortem?: PostmortemRunner;
  postmortemCaller?: string;
```

In `handleApi`, right after `if (instructionsResult) return instructionsResult;` (line 178):

```ts
  const postmortemResult = await handlePostmortemApi({ method, path, body: _body, caller: deps.postmortemCaller, service: deps.postmortem });
  if (postmortemResult) return postmortemResult;
```

- [ ] **Step 7: Wire `application.ts`**

Imports (next to lines 90-93):

```ts
import { execFileSync } from 'node:child_process';
import { createPostmortemRunner, postmortemLimitsFromEnv } from './postmortem/runner';
import { handlePostmortemEvents } from './postmortem/routes';
import { openPostmortemStore } from './postmortem/session-store';
```

Gateway `active` (line 480) becomes:

```ts
  active: runId => postmortems.isLiveCapability(runId) || db.getRun(runId)?.status === 'running' && !stopRequested(runId),
```

Directly after `const gatewayUrl = …` (line 566):

```ts
const helmsmanCommit = (() => {
  try { return execFileSync('git', ['-C', applicationRoot(), 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim() || null; } catch { return null; }
})();
const postmortems = createPostmortemRunner({ store: openPostmortemStore(persistence), runsDir: RUNS_DIR, helmsmanRoot: applicationRoot(),
  getRun: id => db.getRun(id), listEvents: id => db.listEvents(id),
  targetRepoPath: run => { const path = join(AGENTS_ROOT, repoBasename(run.repo)); return existsSync(path) ? path : null; },
  helmsmanCommit: () => helmsmanCommit,
  modelGateway: id => ({ url: `http://127.0.0.1:${gatewayPort}`, token: gateway.issue(id, 86_400_000).token }),
  revokeGateway: id => gateway.revokeRun(id), assertModelReady: () => goCaas.assertReady(), limits: postmortemLimitsFromEnv(process.env) });
```

(`postmortems` is referenced inside the `active` closure declared earlier; the closure only runs on gateway requests, after module initialization.)

After `if (await handleRunLog(req, res, url.pathname, db, bus)) return;` (line 1943):

```ts
    if (await handlePostmortemEvents(req, res, url.pathname, { service: postmortems,
      caller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined })) return;
```

In the `handleApi(…, {` deps object (line 1964), next to `runInstructions`:

```ts
      postmortem: postmortems, postmortemCaller: typeof req.headers['x-helmsman-contribution'] === 'string' ? req.headers['x-helmsman-contribution'] : undefined,
```

Shutdown: line 2049 gains `void postmortems.dispose();` inside the `server.on('close', …)` body, and line 2054 becomes:

```ts
  void Promise.all([backendPlugins.dispose(), postmortems.dispose()]).finally(() => process.exit(0));
```

- [ ] **Step 8: Typecheck, build and run server tests**

Run: `npm run build`
Expected: exit 0.
Run: `npx vitest run server/helmsman/postmortem server/helmsman/router.test.ts server/helmsman/scoped-gateway.test.ts`
Expected: PASS (`scoped-gateway.test.ts` is unaffected; skip it if absent).

- [ ] **Step 9: Smoke the wired endpoints**

Run in one terminal: `HELMSMAN_PORT=8799 HELMSMAN_DB=/tmp/pm-smoke.sqlite RUNS_DIR=/tmp/pm-smoke-runs npm run serve`
Then: `curl -s -X POST -H 'X-Helmsman-Contribution: helmsman.run-viewer/panel' http://127.0.0.1:8799/api/runs/nope/postmortem`
Expected: `{"error":"Run not found"}`. Without the header: `{"error":"forbidden"}`. Stop the server, `rm -rf /tmp/pm-smoke.sqlite* /tmp/pm-smoke-runs`.

- [ ] **Step 10: Commit**

```bash
git add server/helmsman/postmortem/routes.ts server/helmsman/postmortem/routes.test.ts server/helmsman/postmortem/runner.ts server/helmsman/postmortem/runner.test.ts server/helmsman/router.ts server/helmsman/application.ts
git commit -m "feat: expose post-mortem endpoints and scoped model capability"
```

---
### Task 10: Public `helmsman/postmortem@1` capability and host service

**Why (spec gap):** the spec places the UI in `src/plugins/run-viewer/`, but that panel is an independently built plugin that never calls `fetch`; every server call goes through capability-gated host services declared in its manifest (`plugin-package.json` `requires`, checked by `composition-host.ts:207`, `manifest.ts:77`). A new capability is required, added in exactly the places `helmsman/run-instructions` was added in commit `f4997e0`.

**Files:**
- Create: `src/plugins/postmortem.ts`
- Create: `src/plugins/postmortem-service.ts`
- Test: `src/plugins/postmortem-service.test.ts`
- Modify: `src/plugins/sdk.ts:152` (export), `src/plugins/composition.ts:1,36,142`, `src/plugins/manifest.ts:77`, `src/plugins/composition-host.ts:1,207,249`, `src/plugins/services.ts:1,49`, `src/plugins/host-services.ts:1,123`, `src/plugins/composition-host.test.ts:332`, `scripts/sdk-compatibility.mjs:80`, `scripts/build-distribution.mjs` (`publicModules` set)

**Interfaces:**
- Consumes: `RunReadScopeV1` (`src/plugins/run-read-service.ts:8`), `isContributionId` (`src/plugins/manifest.ts:2`).
- Produces (`src/plugins/postmortem.ts`, re-exported from `@helmsman/plugin-sdk`):
  - `type PostmortemProviderV1 = 'codex' | 'claude-code'`; `type PostmortemStatusV1 = 'starting' | 'busy' | 'ready' | 'idle' | 'capped' | 'error'`; `type PostmortemActivityV1 = 'starting' | 'resuming' | 'thinking' | null`
  - `interface PostmortemSessionV1 { id: string; runId: string; provider: PostmortemProviderV1; model: string | null; effort: string | null; status: PostmortemStatusV1; error: string | null; turns: number; costUsd: number | null }` (readonly fields)
  - `interface PostmortemMessageV1 { id: number; clientId: string | null; role: 'user' | 'agent' | 'system'; kind: 'text' | 'tool' | 'command' | 'phase' | 'error' | 'patch'; text: string; ts: string }`
  - `interface PostmortemPatchV1 { file: string; path: string; repo: 'helmsman' | 'target'; baseSha: string | null; summary: string; valid: boolean; reason: string | null; applyCommand: string | null }`
  - `interface PostmortemSnapshotV1 { session: PostmortemSessionV1; activity: PostmortemActivityV1; messages: readonly PostmortemMessageV1[]; patches: readonly PostmortemPatchV1[] }`
  - `type PostmortemEventV1 = { type: 'snapshot'; snapshot: PostmortemSnapshotV1 } | { type: 'message'; message: PostmortemMessageV1 } | { type: 'status'; session: PostmortemSessionV1; activity: PostmortemActivityV1 } | { type: 'patches'; patches: readonly PostmortemPatchV1[] }`
  - `type PostmortemResultV1<T> = { status: 'available'; value: T } | { status: 'unavailable'; code: number; message: string }` (`code` = HTTP status, `0` = unreachable)
  - `interface PostmortemStartInputV1 { repo: string; runId: string; provider?: PostmortemProviderV1; model?: string | null; effort?: string | null; fresh?: boolean }`, `interface PostmortemSessionQueryV1 { repo: string; sessionId: string }`
  - `interface PostmortemServiceV1 { version: 1; start(input: PostmortemStartInputV1, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>>; read(input: PostmortemSessionQueryV1, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>>; send(input: PostmortemSessionQueryV1 & { clientId: string; text: string }, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>>; stop(input: PostmortemSessionQueryV1, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>>; watch(input: PostmortemSessionQueryV1, listener: (event: PostmortemEventV1) => void, signal: AbortSignal): Promise<void> }`
  - `function parsePostmortemSnapshotV1(value: unknown): PostmortemSnapshotV1` (throws `TypeError`), `function parsePostmortemEventV1(value: unknown): PostmortemEventV1 | null`
- Produces (`src/plugins/postmortem-service.ts`): `function createHostPostmortemService(lifetime: AbortSignal, options: { caller: string; scope(): RunReadScopeV1; fetch?: typeof globalThis.fetch }): PostmortemServiceV1`; `PluginPanelServices.postmortem?` and `PluginPageServices.postmortem?`.

- [ ] **Step 1: Write the failing host-service test**

Create `src/plugins/postmortem-service.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { parsePostmortemEventV1, parsePostmortemSnapshotV1, type PostmortemEventV1 } from './postmortem';
import { createHostPostmortemService } from './postmortem-service';

const SID = '00000000-0000-4000-8000-000000000001';
const session = { id: SID, runId: 'run-1', provider: 'codex', model: null, effort: 'high', status: 'ready', error: null, turns: 1, costUsd: 0.1, providerSessionId: 't', createdAt: 'a', updatedAt: 'b' };
const snapshot = { session, activity: null, messages: [{ id: 1, sessionId: SID, clientId: null, role: 'agent', kind: 'text', text: 'Exec kill', ts: 't' }],
  patches: [{ file: '1-target.patch', path: '/p/1-target.patch', number: 1, repo: 'target', baseSha: 'abc1234', summary: 's', valid: true, reason: null, applyCommand: "git -C '/r' apply '/p'" }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function setup(fetch: typeof globalThis.fetch, repo: string | null = 'org/app') {
  const lifetime = new AbortController(); const activity = new AbortController();
  return createHostPostmortemService(lifetime.signal, { caller: 'helmsman.run-viewer/panel', fetch, scope: () => ({ repo, epoch: 1, active: true, signal: activity.signal }) });
}

describe('host post-mortem service', () => {
  it('parses snapshots defensively', () => {
    expect(parsePostmortemSnapshotV1(snapshot)).toMatchObject({ session: { id: SID, status: 'ready' }, messages: [{ text: 'Exec kill' }], patches: [{ valid: true }] });
    for (const bad of [null, [], { ...snapshot, session: { ...session, status: 'weird' } }, { ...snapshot, messages: [{ id: 'x' }] }]) expect(() => parsePostmortemSnapshotV1(bad)).toThrow(TypeError);
    expect(parsePostmortemEventV1({ type: 'nope' })).toBeNull();
    expect(parsePostmortemEventV1({ type: 'status', session, activity: 'resuming' })).toMatchObject({ type: 'status', activity: 'resuming' });
  });

  it('starts with the contribution header and maps errors to codes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(snapshot));
    const service = setup(fetch);
    expect(await service.start({ repo: 'org/app', runId: 'run-1', effort: 'high' })).toMatchObject({ status: 'available', value: { session: { id: SID } } });
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe('/api/runs/run-1/postmortem');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ effort: 'high' }), headers: expect.objectContaining({ 'X-Helmsman-Contribution': 'helmsman.run-viewer/panel' }) });
    fetch.mockResolvedValueOnce(json({ error: 'Post-mortem sandbox requires macOS' }, 412));
    expect(await service.send({ repo: 'org/app', sessionId: SID, clientId: SID, text: 'Why?' })).toEqual({ status: 'unavailable', code: 412, message: 'Post-mortem sandbox requires macOS' });
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/postmortem/${SID}/messages`);
    fetch.mockRejectedValueOnce(new Error('offline'));
    expect(await service.stop({ repo: 'org/app', sessionId: SID })).toMatchObject({ status: 'unavailable', code: 0 });
    fetch.mockResolvedValueOnce(json({ nonsense: true }));
    expect(await service.read({ repo: 'org/app', sessionId: SID })).toMatchObject({ status: 'unavailable', message: 'Invalid post-mortem response.' });
  });

  it('refuses runs outside the galleon scope without a request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await setup(fetch).start({ repo: 'org/other', runId: 'run-1' })).toMatchObject({ status: 'unavailable', code: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('streams SSE frames across chunk boundaries and skips malformed frames', async () => {
    const frames = [`data: ${JSON.stringify({ type: 'snapshot', snapshot })}\n\ndata: {bad}\n\nda`, `ta: ${JSON.stringify({ type: 'patches', patches: [] })}\n\n`];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } }));
    const events: PostmortemEventV1[] = [];
    await setup(fetch).watch({ repo: 'org/app', sessionId: SID }, event => events.push(event), new AbortController().signal);
    expect(events.map(event => event.type)).toEqual(['snapshot', 'patches']);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/postmortem/${SID}/events`);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/plugins/postmortem-service.test.ts`
Expected: FAIL — cannot resolve `./postmortem`.

- [ ] **Step 3: Implement `src/plugins/postmortem.ts`**

```ts
export type PostmortemProviderV1 = 'codex' | 'claude-code';
export type PostmortemStatusV1 = 'starting' | 'busy' | 'ready' | 'idle' | 'capped' | 'error';
export type PostmortemActivityV1 = 'starting' | 'resuming' | 'thinking' | null;
export interface PostmortemSessionV1 {
  readonly id: string; readonly runId: string; readonly provider: PostmortemProviderV1; readonly model: string | null; readonly effort: string | null;
  readonly status: PostmortemStatusV1; readonly error: string | null; readonly turns: number; readonly costUsd: number | null;
}
export interface PostmortemMessageV1 {
  readonly id: number; readonly clientId: string | null; readonly role: 'user' | 'agent' | 'system';
  readonly kind: 'text' | 'tool' | 'command' | 'phase' | 'error' | 'patch'; readonly text: string; readonly ts: string;
}
export interface PostmortemPatchV1 {
  readonly file: string; readonly path: string; readonly repo: 'helmsman' | 'target'; readonly baseSha: string | null; readonly summary: string;
  readonly valid: boolean; readonly reason: string | null; readonly applyCommand: string | null;
}
export interface PostmortemSnapshotV1 { readonly session: PostmortemSessionV1; readonly activity: PostmortemActivityV1; readonly messages: readonly PostmortemMessageV1[]; readonly patches: readonly PostmortemPatchV1[] }
export type PostmortemEventV1 = { readonly type: 'snapshot'; readonly snapshot: PostmortemSnapshotV1 } | { readonly type: 'message'; readonly message: PostmortemMessageV1 }
  | { readonly type: 'status'; readonly session: PostmortemSessionV1; readonly activity: PostmortemActivityV1 } | { readonly type: 'patches'; readonly patches: readonly PostmortemPatchV1[] };
export type PostmortemResultV1<T> = { readonly status: 'available'; readonly value: T } | { readonly status: 'unavailable'; readonly code: number; readonly message: string };
export interface PostmortemStartInputV1 { readonly repo: string; readonly runId: string; readonly provider?: PostmortemProviderV1; readonly model?: string | null; readonly effort?: string | null; readonly fresh?: boolean }
export interface PostmortemSessionQueryV1 { readonly repo: string; readonly sessionId: string }
export interface PostmortemServiceV1 {
  readonly version: 1;
  start(input: PostmortemStartInputV1, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>>;
  read(input: PostmortemSessionQueryV1, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>>;
  send(input: PostmortemSessionQueryV1 & { readonly clientId: string; readonly text: string }, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>>;
  stop(input: PostmortemSessionQueryV1, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>>;
  watch(input: PostmortemSessionQueryV1, listener: (event: PostmortemEventV1) => void, signal: AbortSignal): Promise<void>;
}
const STATUSES = new Set(['starting', 'busy', 'ready', 'idle', 'capped', 'error']);
const ROLES = new Set(['user', 'agent', 'system']);
const KINDS = new Set(['text', 'tool', 'command', 'phase', 'error', 'patch']);
const ACTIVITIES = new Set(['starting', 'resuming', 'thinking']);
const invalid = (): never => { throw new TypeError('Invalid post-mortem response'); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const string = (value: unknown): string => typeof value === 'string' ? value : invalid();
const nullableString = (value: unknown): string | null => value === null || value === undefined ? null : string(value);
const nullableNumber = (value: unknown): number | null => value === null || value === undefined ? null : typeof value === 'number' && Number.isFinite(value) ? value : invalid();
const member = <T extends string>(set: Set<string>, value: unknown): T => typeof value === 'string' && set.has(value) ? value as T : invalid();
const activity = (value: unknown): PostmortemActivityV1 => value === null || value === undefined ? null : member(ACTIVITIES, value);

function session(raw: unknown): PostmortemSessionV1 {
  const value = object(raw);
  return Object.freeze({ id: string(value.id), runId: string(value.runId), provider: value.provider === 'claude-code' ? 'claude-code' as const : value.provider === 'codex' ? 'codex' as const : invalid(),
    model: nullableString(value.model), effort: nullableString(value.effort), status: member<PostmortemStatusV1>(STATUSES, value.status), error: nullableString(value.error),
    turns: typeof value.turns === 'number' && Number.isSafeInteger(value.turns) && value.turns >= 0 ? value.turns : invalid(), costUsd: nullableNumber(value.costUsd) });
}
function message(raw: unknown): PostmortemMessageV1 {
  const value = object(raw);
  return Object.freeze({ id: typeof value.id === 'number' && Number.isSafeInteger(value.id) ? value.id : invalid(), clientId: nullableString(value.clientId),
    role: member<PostmortemMessageV1['role']>(ROLES, value.role), kind: member<PostmortemMessageV1['kind']>(KINDS, value.kind), text: string(value.text), ts: string(value.ts) });
}
function patch(raw: unknown): PostmortemPatchV1 {
  const value = object(raw);
  return Object.freeze({ file: string(value.file), path: string(value.path), repo: value.repo === 'helmsman' || value.repo === 'target' ? value.repo : invalid(),
    baseSha: nullableString(value.baseSha), summary: string(value.summary), valid: typeof value.valid === 'boolean' ? value.valid : invalid(),
    reason: nullableString(value.reason), applyCommand: nullableString(value.applyCommand) });
}
const list = <T>(value: unknown, parse: (item: unknown) => T): readonly T[] => Array.isArray(value) ? Object.freeze(value.map(parse)) : invalid();

export function parsePostmortemSnapshotV1(raw: unknown): PostmortemSnapshotV1 {
  const value = object(raw);
  return Object.freeze({ session: session(value.session), activity: activity(value.activity), messages: list(value.messages, message), patches: list(value.patches, patch) });
}
export function parsePostmortemEventV1(raw: unknown): PostmortemEventV1 | null {
  try {
    const value = object(raw);
    if (value.type === 'snapshot') return { type: 'snapshot', snapshot: parsePostmortemSnapshotV1(value.snapshot) };
    if (value.type === 'message') return { type: 'message', message: message(value.message) };
    if (value.type === 'status') return { type: 'status', session: session(value.session), activity: activity(value.activity) };
    if (value.type === 'patches') return { type: 'patches', patches: list(value.patches, patch) };
    return null;
  } catch { return null; }
}
```

- [ ] **Step 4: Implement `src/plugins/postmortem-service.ts`**

```ts
import { isContributionId } from './manifest';
import { parsePostmortemEventV1, parsePostmortemSnapshotV1, type PostmortemResultV1, type PostmortemServiceV1, type PostmortemSnapshotV1 } from './postmortem';
import type { RunReadScopeV1 } from './run-read-service';

const RESPONSE_LIMIT = 4 * 1024 * 1024;
const unavailable = (code: number, message: string): PostmortemResultV1<never> => Object.freeze({ status: 'unavailable', code, message });

export function createHostPostmortemService(lifetime: AbortSignal, options: { caller: string; scope(): RunReadScopeV1; fetch?: typeof globalThis.fetch }): PostmortemServiceV1 {
  if (!isContributionId(options.caller)) throw new TypeError('Invalid post-mortem contribution');
  const fetcher = options.fetch ?? globalThis.fetch;
  const allowed = (repo: string) => { const scope = options.scope(); return scope.active && !scope.signal.aborted && (scope.repo === null || scope.repo === repo); };
  const headers = (accept: string, body: boolean) => ({ Accept: accept, 'X-Helmsman-Contribution': options.caller, ...(body ? { 'Content-Type': 'application/json' } : {}) });
  async function request(repo: string, path: string, payload: unknown, signal?: AbortSignal): Promise<PostmortemResultV1<PostmortemSnapshotV1>> {
    if (!allowed(repo)) return unavailable(403, 'This run is outside the current galleon scope.');
    const combined = AbortSignal.any([lifetime, options.scope().signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    let response: Response;
    try {
      response = await fetcher(path, { method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: combined,
        headers: headers('application/json', payload !== undefined), ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    } catch (error) {
      if (lifetime.aborted || options.scope().signal.aborted || signal?.aborted) throw error;
      return unavailable(0, 'Post-mortem service is unreachable.');
    }
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    try { body = text && text.length <= RESPONSE_LIMIT ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) {
      const error = body && typeof body === 'object' && !Array.isArray(body) ? (body as { error?: unknown }).error : undefined;
      return unavailable(response.status, typeof error === 'string' ? error : `Post-mortem request failed (${response.status}).`);
    }
    try { return Object.freeze({ status: 'available' as const, value: parsePostmortemSnapshotV1(body) }); }
    catch { return unavailable(response.status, 'Invalid post-mortem response.'); }
  }
  const session = (sessionId: string) => `/api/postmortem/${encodeURIComponent(sessionId)}`;
  return Object.freeze<PostmortemServiceV1>({
    version: 1,
    start: (input, signal) => {
      const { repo, runId, ...body } = input;
      return request(repo, `/api/runs/${encodeURIComponent(runId)}/postmortem`, body, signal);
    },
    read: (input, signal) => request(input.repo, session(input.sessionId), undefined, signal),
    send: (input, signal) => request(input.repo, `${session(input.sessionId)}/messages`, { clientId: input.clientId, text: input.text }, signal),
    stop: (input, signal) => request(input.repo, `${session(input.sessionId)}/stop`, {}, signal),
    async watch(input, listener, signal) {
      if (!allowed(input.repo)) throw new TypeError('This run is outside the current galleon scope.');
      const combined = AbortSignal.any([lifetime, options.scope().signal, signal]);
      const response = await fetcher(`${session(input.sessionId)}/events`, { credentials: 'same-origin', signal: combined, headers: headers('text/event-stream', false) });
      if (!response.ok || !response.body) throw new Error(`Post-mortem events are unavailable (${response.status}).`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          buffer += decoder.decode(next.value, { stream: true });
          if (buffer.length > RESPONSE_LIMIT) throw new Error('Post-mortem event exceeds its limit');
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const data = buffer.slice(0, index).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
            buffer = buffer.slice(index + 2);
            if (!data) continue;
            let event = null;
            try { event = parsePostmortemEventV1(JSON.parse(data)); } catch { event = null; }
            if (event) listener(event);
          }
        }
      } finally { void reader.cancel().catch(() => {}); }
    },
  });
}
```

Cancellation by the caller, the panel scope or the host lifetime is rethrown so callers can tell it apart from failure; a timeout or network error returns `code: 0`.

- [ ] **Step 5: Run the host-service test**

Run: `npx vitest run src/plugins/postmortem-service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Register the capability**

1. `src/plugins/sdk.ts` after line 152 (`export * from './run-instructions';`): `export * from './postmortem';`
2. `src/plugins/composition.ts`: add `import type { PostmortemServiceV1 } from './postmortem';` at the top; in the requirement `id` union on line 36 add `| 'helmsman/postmortem'` after `'helmsman/run-instructions'`; after line 142 add `  readonly postmortem?: PostmortemServiceV1;`.
3. `src/plugins/manifest.ts:77`: add `'helmsman/postmortem'` after `'helmsman/run-instructions'` in the allowlist array.
4. `src/plugins/composition-host.ts`: add `import { createHostPostmortemService } from './postmortem-service';` at the top; add `'helmsman/postmortem'` after `'helmsman/run-instructions'` in the array on line 207; after the `runInstructions:` line (~249) add `        postmortem: createHostPostmortemService(lifetime, { scope: activity, caller: instance.contributionId }),`.
5. `src/plugins/services.ts`: add `import type { PostmortemServiceV1 } from './postmortem';`; after line 49 add `  readonly postmortem?: PostmortemServiceV1;`.
6. `src/plugins/host-services.ts`: add `import { createHostPostmortemService } from './postmortem-service';`; after the `runInstructions:` line (123) add `        postmortem: createHostPostmortemService(lifetime, { scope, caller }),`.
7. `src/plugins/composition-host.test.ts:332`: insert `'postmortem'` between `'localGit'` and `'profile'` in the expected key list.
8. `scripts/sdk-compatibility.mjs:80`: extend the `Exclude<T[K], …>` union with `| 'helmsman/postmortem'`.
9. `scripts/build-distribution.mjs`: add `'postmortem.ts'` to the `publicModules` set next to `'run-instructions.ts'`.

- [ ] **Step 7: Typecheck and run plugin tests**

Run: `npm run build`
Expected: exit 0.
Run: `npx vitest run src/plugins`
Expected: PASS except the known pre-existing `src/plugins/builtin-lifecycle.test.ts` failure (unchanged count).
Run: `npm run build:distribution`
Expected: exit 0 (SDK compatibility check passes with the new additive capability).

- [ ] **Step 8: Commit**

```bash
git add src/plugins/postmortem.ts src/plugins/postmortem-service.ts src/plugins/postmortem-service.test.ts src/plugins/sdk.ts src/plugins/composition.ts src/plugins/manifest.ts src/plugins/composition-host.ts src/plugins/services.ts src/plugins/host-services.ts src/plugins/composition-host.test.ts scripts/sdk-compatibility.mjs scripts/build-distribution.mjs
git commit -m "feat: add public post-mortem plugin capability"
```

---
### Task 11: Run-viewer chat and **Ask about this failure** button

**Files:**
- Create: `src/plugins/run-viewer/postmortem-chat.ts`
- Test: `src/plugins/run-viewer/postmortem-chat.test.ts`
- Modify: `src/plugins/run-viewer/panel.ts:1` (import), `:21` (field), `:58` (constructor), `:79` (dispose), `:373-374` (button), `:376-377` (mount chat), `:387` (focus restore)
- Modify: `src/plugins/run-viewer/panel.test.ts:23` (`mount` gains `status` option) + append a describe block
- Modify: `src/plugins/run-viewer/plugin-package.json` (version `0.3.0`, add requirement), `src/plugins/run-viewer/README.md` (one sentence)

**Interfaces:**
- Consumes: `PostmortemServiceV1`, `PostmortemSnapshotV1`, `PostmortemEventV1`, `PostmortemMessageV1`, `PostmortemPatchV1`, `PostmortemProviderV1`, `PluginPanelState` from `@helmsman/plugin-sdk` (Task 10); `context.services.postmortem`.
- Produces:
  - `interface PostmortemTarget { readonly repo: string; readonly runId: string }`
  - `function postmortemStatusText(snapshot: PostmortemSnapshotV1 | null): string` — `starting…`, `thinking…`, `resuming…`, `ready`, `idle`, `capped`, `error: <message>`
  - `class PostmortemChat { readonly element: HTMLElement; constructor(service: PostmortemServiceV1 | undefined); open(target: PostmortemTarget): void; update(state: PluginPanelState, target: PostmortemTarget | null): void; dispose(): void }`

UI rules (from the spec): selects (provider/model/effort) only before the first session; composer disabled while `starting`/`busy`/`capped` or while a request is in flight; `error` keeps the composer enabled (sending resumes) and also offers **Start new post-mortem** (`fresh: true`), as does `capped`; stop button for `starting`/`busy`/`ready`; patch list with valid/invalid badge, **Copy path**, **Copy git apply**. A failed send keeps its `clientId` until success or until the text changes, so a retry is idempotent server-side.

- [ ] **Step 1: Write the failing component test**

Create `src/plugins/run-viewer/postmortem-chat.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginPanelState, PostmortemEventV1, PostmortemServiceV1, PostmortemSnapshotV1 } from '@helmsman/plugin-sdk';
import { PostmortemChat, postmortemStatusText } from './postmortem-chat';

const chats: PostmortemChat[] = [];
afterEach(() => { chats.splice(0).forEach(chat => chat.dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const SID = '00000000-0000-4000-8000-000000000001';
const target = { repo: 'org/app', runId: 'run-1' };
const session = { id: SID, runId: 'run-1', provider: 'codex' as const, model: null, effort: 'high', status: 'ready' as const, error: null, turns: 1, costUsd: 0.1 };
const snapshot = (patch: Partial<PostmortemSnapshotV1> = {}): PostmortemSnapshotV1 => ({ session, activity: null,
  messages: [{ id: 1, clientId: null, role: 'agent', kind: 'text', text: 'Likely cause: <img src=x> exec SIGKILL', ts: 't' }], patches: [], ...patch });
const available = (value: PostmortemSnapshotV1) => ({ status: 'available' as const, value });
function setup() {
  const activity = new AbortController();
  const state: PluginPanelState = { repo: 'org/app', visible: true, themeId: 'default', pirateMode: false, pane: null, instanceId: 'viewer', savedState: null,
    activity: { repo: 'org/app', epoch: 1, active: true, signal: activity.signal } };
  let listener: ((event: PostmortemEventV1) => void) | undefined;
  const service: PostmortemServiceV1 = { version: 1, start: vi.fn(async () => available(snapshot())), read: vi.fn(async () => available(snapshot())),
    send: vi.fn(async () => available(snapshot({ session: { ...session, status: 'busy' } }))), stop: vi.fn(async () => available(snapshot({ session: { ...session, status: 'idle' } }))),
    watch: vi.fn((_input, next, signal) => { listener = next; return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }) };
  const chat = new PostmortemChat(service); chats.push(chat); document.body.append(chat.element); chat.update(state, target);
  const button = (text: string) => [...chat.element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text);
  const emit = (event: PostmortemEventV1) => listener?.(event);
  return { chat, service, state, activity, button, emit, editor: () => chat.element.querySelector('textarea')! };
}
async function started(f: ReturnType<typeof setup>) {
  f.chat.open(target); f.button('Start post-mortem')!.click();
  await vi.waitFor(() => expect(f.chat.element.textContent).toContain('Likely cause'));
}

describe('post-mortem chat', () => {
  it('stays hidden until opened and starts with the chosen provider, model and effort', async () => {
    const f = setup();
    expect(f.chat.element.hidden).toBe(true);
    f.chat.open(target); expect(f.chat.element.hidden).toBe(false);
    const [provider, model, effort] = [...f.chat.element.querySelectorAll('select')];
    provider!.value = 'claude-code'; provider!.dispatchEvent(new Event('change'));
    expect([...model!.options].map(option => option.value)).toEqual(['', 'opus', 'sonnet']);
    model!.value = 'opus'; expect(effort!.value).toBe('high');
    f.button('Start post-mortem')!.click();
    await vi.waitFor(() => expect(f.service.start).toHaveBeenCalledWith({ repo: 'org/app', runId: 'run-1', provider: 'claude-code', model: 'opus', effort: 'high' }, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(f.chat.element.querySelectorAll('select')).toHaveLength(0));
  });

  it('renders the transcript as inert text and merges streamed messages by id', async () => {
    const f = setup(); await started(f);
    expect(f.chat.element.querySelector('img')).toBeNull();
    f.emit({ type: 'message', message: { id: 1, clientId: null, role: 'agent', kind: 'text', text: 'Likely cause: <img src=x> exec SIGKILL', ts: 't' } });
    f.emit({ type: 'message', message: { id: 2, clientId: null, role: 'agent', kind: 'command', text: '$ ls', ts: 't' } });
    expect(f.chat.element.querySelectorAll('[data-message-id]')).toHaveLength(2);
  });

  it('disables the composer while busy and shows thinking or resuming', async () => {
    const f = setup(); await started(f);
    f.emit({ type: 'status', session: { ...session, status: 'busy' }, activity: 'thinking' });
    expect(f.editor().disabled).toBe(true); expect(f.chat.element.textContent).toContain('thinking…');
    f.emit({ type: 'status', session: { ...session, status: 'busy' }, activity: 'resuming' });
    expect(f.chat.element.textContent).toContain('resuming…');
    f.emit({ type: 'status', session, activity: null });
    expect(f.editor().disabled).toBe(false);
  });

  it('reuses the clientId when a send must be retried', async () => {
    const f = setup(); await started(f);
    vi.mocked(f.service.send).mockResolvedValueOnce({ status: 'unavailable', code: 0, message: 'Post-mortem service is unreachable.' });
    f.editor().value = 'Why?'; f.editor().dispatchEvent(new Event('input')); f.button('Send')!.click();
    await vi.waitFor(() => expect(f.chat.element.querySelector('[role=alert]')?.textContent).toBe('Post-mortem service is unreachable.'));
    f.button('Send')!.click();
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(2));
    const ids = vi.mocked(f.service.send).mock.calls.map(call => call[0].clientId);
    expect(ids[0]).toBe(ids[1]);
    await vi.waitFor(() => expect(f.editor().value).toBe(''));
  });

  it('lists patches with badges and copies the apply command', async () => {
    const writeText = vi.fn(async () => {}); vi.stubGlobal('navigator', { clipboard: { writeText } });
    const f = setup(); await started(f);
    f.emit({ type: 'patches', patches: [
      { file: '1-target.patch', path: '/p/1-target.patch', repo: 'target', baseSha: 'abc1234def5678', summary: 'Chunk argv', valid: true, reason: null, applyCommand: "git -C '/r' apply '/p/1-target.patch'" },
      { file: '2-helmsman.patch', path: '/p/2-helmsman.patch', repo: 'helmsman', baseSha: null, summary: '', valid: false, reason: 'missing sidecar', applyCommand: null }] });
    expect(f.chat.element.textContent).toContain('valid'); expect(f.chat.element.textContent).toContain('invalid: missing sidecar');
    f.button('Copy git apply')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("git -C '/r' apply '/p/1-target.patch'"));
    f.button('Copy path')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('/p/1-target.patch'));
    expect([...f.chat.element.querySelectorAll<HTMLButtonElement>('button')].filter(item => item.textContent === 'Copy git apply').map(item => item.disabled)).toEqual([false, true]);
  });

  it('shows capped and error states with a fresh start', async () => {
    const f = setup(); await started(f);
    f.emit({ type: 'status', session: { ...session, status: 'capped' }, activity: null });
    expect(f.editor().disabled).toBe(true); expect(f.chat.element.textContent).toContain('capped');
    f.emit({ type: 'status', session: { ...session, status: 'error', error: 'auth failed' }, activity: null });
    expect(f.editor().disabled).toBe(false); expect(f.chat.element.textContent).toContain('error: auth failed');
    f.button('Start new post-mortem')!.click();
    await vi.waitFor(() => expect(f.service.start).toHaveBeenLastCalledWith({ repo: 'org/app', runId: 'run-1', effort: 'high', fresh: true }, expect.any(AbortSignal)));
  });

  it('reports start failures and stops on request', async () => {
    const f = setup();
    vi.mocked(f.service.start).mockResolvedValueOnce({ status: 'unavailable', code: 412, message: 'Post-mortem sandbox requires macOS' });
    f.chat.open(target); f.button('Start post-mortem')!.click();
    await vi.waitFor(() => expect(f.chat.element.querySelector('[role=alert]')?.textContent).toBe('Post-mortem sandbox requires macOS'));
    f.button('Start post-mortem')!.click(); await vi.waitFor(() => expect(f.button('Stop')?.disabled).toBe(false));
    f.button('Stop')!.click();
    await vi.waitFor(() => expect(f.service.stop).toHaveBeenCalledWith({ repo: 'org/app', sessionId: SID }, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(f.chat.element.textContent).toContain('idle'));
  });

  it('resets and aborts the stream when the target or scope changes', async () => {
    const f = setup(); await started(f);
    const signal = vi.mocked(f.service.watch).mock.calls[0]?.[2];
    f.chat.update(f.state, { repo: 'org/app', runId: 'run-2' });
    expect(signal?.aborted).toBe(true); expect(f.chat.element.hidden).toBe(true);
    expect(postmortemStatusText(null)).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/plugins/run-viewer/postmortem-chat.test.ts`
Expected: FAIL — cannot resolve `./postmortem-chat`.

- [ ] **Step 3: Implement `src/plugins/run-viewer/postmortem-chat.ts`**

```ts
import type { PluginPanelState, PostmortemEventV1, PostmortemMessageV1, PostmortemPatchV1, PostmortemProviderV1, PostmortemServiceV1, PostmortemSnapshotV1 } from '@helmsman/plugin-sdk';

export interface PostmortemTarget { readonly repo: string; readonly runId: string }
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
const option = (value: string, label: string) => { const item = node('option', label); item.value = value; return item; };
const MODELS: Record<PostmortemProviderV1, readonly string[]> = { codex: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra'], 'claude-code': ['opus', 'sonnet'] };
const COMPOSER_BLOCKED = new Set(['starting', 'busy', 'capped']);
const STOPPABLE = new Set(['starting', 'busy', 'ready']);
const sameTarget = (a: PostmortemTarget | null, b: PostmortemTarget | null) => a?.repo === b?.repo && a?.runId === b?.runId;

export function postmortemStatusText(snapshot: PostmortemSnapshotV1 | null): string {
  if (!snapshot) return '';
  const { session, activity } = snapshot;
  if (session.status === 'starting') return 'starting…';
  if (session.status === 'busy') return activity === 'resuming' ? 'resuming…' : 'thinking…';
  if (session.status === 'error') return `error: ${session.error ?? 'unknown'}`;
  return session.status;
}

export class PostmortemChat {
  readonly element = node('section');
  private readonly service: PostmortemServiceV1 | undefined;
  private readonly provider = node('select');
  private readonly model = node('select');
  private readonly effort = node('select');
  private readonly editor = node('textarea');
  private target: PostmortemTarget | null = null;
  private snapshot: PostmortemSnapshotV1 | null = null;
  private activity: AbortSignal | null = null;
  private controller = new AbortController();
  private opened = false;
  private busy = false;
  private error = '';
  private notice = '';
  private clientId: string | null = null;
  constructor(service: PostmortemServiceV1 | undefined) {
    this.service = service;
    this.element.className = 'run-postmortem'; this.element.hidden = true;
    this.provider.setAttribute('aria-label', 'Post-mortem agent'); this.model.setAttribute('aria-label', 'Post-mortem model'); this.effort.setAttribute('aria-label', 'Post-mortem reasoning effort');
    this.provider.append(option('', "Run's provider"), option('codex', 'Codex'), option('claude-code', 'Claude Code'));
    this.effort.append(option('high', 'High effort'), option('medium', 'Medium effort'), option('low', 'Low effort'));
    this.provider.addEventListener('change', () => this.models()); this.models();
    this.editor.maxLength = 8000; this.editor.rows = 3; this.editor.setAttribute('aria-label', 'Message to the post-mortem agent');
    this.editor.addEventListener('input', () => { this.clientId = null; this.draw(); });
  }
  open(target: PostmortemTarget) {
    if (!sameTarget(target, this.target)) { this.reset(); this.target = target; }
    this.opened = true; this.draw();
  }
  update(state: PluginPanelState, target: PostmortemTarget | null) {
    const current = state.visible && state.activity.active && !state.activity.signal.aborted ? target : null;
    if (sameTarget(current, this.target) && this.activity === state.activity.signal) return;
    this.activity?.removeEventListener('abort', this.dispose);
    this.reset(); this.activity = state.activity.signal; this.activity.addEventListener('abort', this.dispose, { once: true });
    this.target = current; this.draw();
  }
  dispose = () => { this.controller.abort(); this.activity?.removeEventListener('abort', this.dispose); };
  private reset() {
    this.controller.abort(); this.controller = new AbortController();
    this.snapshot = null; this.opened = false; this.busy = false; this.error = ''; this.notice = ''; this.clientId = null; this.editor.value = '';
  }
  private models() {
    const provider = this.provider.value as PostmortemProviderV1 | '';
    this.model.replaceChildren(option('', 'Provider default'), ...(provider ? MODELS[provider].map(model => option(model, model)) : []));
  }
  private async start(fresh: boolean) {
    const service = this.service; const target = this.target; const signal = this.controller.signal;
    if (!service || !target || this.busy) return;
    this.busy = true; this.error = ''; this.draw();
    const result = await service.start({ ...target, ...(this.provider.value ? { provider: this.provider.value as PostmortemProviderV1 } : {}),
      ...(this.model.value ? { model: this.model.value } : {}), effort: this.effort.value, ...(fresh ? { fresh: true } : {}) }, signal).catch(() => null);
    if (signal.aborted) return;
    this.busy = false;
    if (result?.status === 'available') { this.apply({ type: 'snapshot', snapshot: result.value }); this.watch(result.value.session.id); }
    else this.error = result?.message ?? 'Post-mortem service is unreachable.';
    this.draw();
  }
  private watch(sessionId: string) {
    this.controller.abort(); this.controller = new AbortController();
    const service = this.service; const target = this.target; const signal = this.controller.signal;
    if (!service || !target) return;
    const loop = async () => {
      while (!signal.aborted) {
        await service.watch({ repo: target.repo, sessionId }, event => { if (!signal.aborted) this.apply(event); }, signal).catch(() => undefined);
        if (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 2000));
      }
    };
    void loop();
  }
  private apply(event: PostmortemEventV1) {
    const current = this.snapshot;
    if (event.type === 'snapshot') this.snapshot = event.snapshot;
    else if (!current) return;
    else if (event.type === 'message') this.snapshot = { ...current, messages: [...current.messages.filter(message => message.id !== event.message.id), event.message].sort((a, b) => a.id - b.id) };
    else if (event.type === 'status') this.snapshot = { ...current, session: event.session, activity: event.activity };
    else this.snapshot = { ...current, patches: event.patches };
    this.draw();
  }
  private async send() {
    const service = this.service; const target = this.target; const snapshot = this.snapshot; const signal = this.controller.signal;
    const text = this.editor.value;
    if (!service || !target || !snapshot || this.busy || !text.trim()) return;
    this.clientId ??= crypto.randomUUID();
    this.busy = true; this.error = ''; this.draw();
    const result = await service.send({ repo: target.repo, sessionId: snapshot.session.id, clientId: this.clientId, text }, signal).catch(() => null);
    if (signal.aborted) return;
    this.busy = false;
    if (result?.status === 'available') { this.editor.value = ''; this.clientId = null; this.apply({ type: 'snapshot', snapshot: result.value }); }
    else this.error = result?.message ?? 'Post-mortem service is unreachable.';
    this.draw();
  }
  private async stop() {
    const service = this.service; const target = this.target; const snapshot = this.snapshot; const signal = this.controller.signal;
    if (!service || !target || !snapshot) return;
    const result = await service.stop({ repo: target.repo, sessionId: snapshot.session.id }, signal).catch(() => null);
    if (signal.aborted) return;
    if (result?.status === 'available') this.apply({ type: 'snapshot', snapshot: result.value }); else { this.error = result?.message ?? 'Post-mortem service is unreachable.'; this.draw(); }
  }
  private copy(text: string) {
    const signal = this.controller.signal;
    if (!navigator.clipboard?.writeText) { this.notice = 'Clipboard unavailable.'; this.draw(); return; }
    void navigator.clipboard.writeText(text).then(() => { if (!signal.aborted) { this.notice = 'Copied.'; this.draw(); } }, () => { if (!signal.aborted) { this.notice = 'Clipboard unavailable.'; this.draw(); } });
  }
  private button(text: string, action: () => void, disabled = false) {
    const item = node('button', text); item.type = 'button'; item.disabled = disabled; item.addEventListener('click', action); return item;
  }
  private message(message: PostmortemMessageV1) {
    const row = node('article'); row.dataset.messageId = String(message.id); row.dataset.role = message.role; row.dataset.kind = message.kind;
    row.append(node('small', `${message.role} · ${message.kind}`), node('p', message.text)); return row;
  }
  private patch(patch: PostmortemPatchV1) {
    const row = node('article'); row.dataset.patch = patch.file;
    const badge = node('span', patch.valid ? 'valid' : `invalid: ${patch.reason ?? 'unknown'}`); badge.dataset.valid = String(patch.valid);
    row.append(node('p', `${patch.file} · ${patch.repo} · ${patch.baseSha ? patch.baseSha.slice(0, 12) : 'no base'}`), badge, ...(patch.summary ? [node('p', patch.summary)] : []),
      this.button('Copy path', () => this.copy(patch.path)), this.button('Copy git apply', () => { if (patch.applyCommand) this.copy(patch.applyCommand); }, !patch.applyCommand));
    return row;
  }
  private draw() {
    this.element.hidden = !this.service || !this.target || !this.opened;
    const snapshot = this.snapshot; const status = snapshot?.session.status;
    const children: HTMLElement[] = [node('style', '.plugin-run-viewer .run-postmortem textarea{font:inherit;color:var(--text);background:var(--face-hi);border:1px solid var(--line-strong);border-radius:var(--radius,4px);padding:6px 10px;display:block;width:100%;box-sizing:border-box;min-height:5em}.plugin-run-viewer .run-postmortem article{border-top:1px solid var(--line);padding-block:.5rem;overflow-wrap:anywhere}.plugin-run-viewer .run-postmortem article p{white-space:pre-wrap}.plugin-run-viewer .run-postmortem [data-valid=false]{color:var(--bad)}'),
      node('h3', 'Failure post-mortem')];
    if (this.error) { const alert = node('p', this.error); alert.setAttribute('role', 'alert'); children.push(alert); }
    if (this.notice) { const notice = node('p', this.notice); notice.setAttribute('role', 'status'); children.push(notice); }
    if (!snapshot) {
      const setup = node('div'); setup.className = 'run-tools';
      setup.append(this.provider, this.model, this.effort, this.button('Start post-mortem', () => { void this.start(false); }, this.busy));
      children.push(setup);
    } else {
      const line = node('p', postmortemStatusText(snapshot)); line.setAttribute('role', 'status'); children.push(line);
      const transcript = node('div'); transcript.append(...snapshot.messages.map(message => this.message(message))); children.push(transcript);
      if (snapshot.patches.length) { const patches = node('div'); patches.append(node('h4', 'Proposed patches'), ...snapshot.patches.map(patch => this.patch(patch))); children.push(patches); }
      this.editor.disabled = this.busy || COMPOSER_BLOCKED.has(status ?? '');
      const tools = node('div'); tools.className = 'run-tools';
      tools.append(this.button('Send', () => { void this.send(); }, this.editor.disabled || !this.editor.value.trim()),
        this.button('Stop', () => { void this.stop(); }, !STOPPABLE.has(status ?? '')));
      if (status === 'capped' || status === 'error') tools.append(this.button('Start new post-mortem', () => { void this.start(true); }, this.busy));
      children.push(this.editor, tools);
    }
    this.element.replaceChildren(...children);
  }
}
```

The fresh-start expectation in the test (`{ …, effort: 'high', fresh: true }` without provider/model) holds because the selects keep their default values after the first start.

- [ ] **Step 4: Run the component test**

Run: `npx vitest run src/plugins/run-viewer/postmortem-chat.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing panel test**

In `src/plugins/run-viewer/panel.test.ts`, extend `mount`'s options type with `status?: RunReadSummaryV1['status']` and change the `runs.load` line (23) so the summary honors it:

```ts
  const runs = { version: 1 as const, list: vi.fn(), log: vi.fn(), load: vi.fn(async (input: { runId: string }) => available({ version: 1 as const, repo: 'org/a', runId: input.runId, run: { ...summary(input.runId), ...(options.status ? { status: options.status } : {}) } })), watchList: vi.fn(), watchLoad: vi.fn(), watchLog: vi.fn() };
```

Append:

```ts
describe('post-mortem entry point', () => {
  it.each([['failed', true], ['stopped', true], ['running', false], ['succeeded', false]] as const)('for a %s run shows Ask about this failure: %s', async (status, shown) => {
    const f = await mount({ status });
    await vi.waitFor(() => expect(f.container.textContent).toContain(`Worker: ${status}`));
    expect(Boolean(button(f.container, 'Ask about this failure'))).toBe(shown);
    if (shown) expect(button(f.container, 'Ask about this failure')?.disabled).toBe(true);
  });
});
```

(The disabled assertion holds because `mount` supplies no `postmortem` service.)

Run: `npx vitest run src/plugins/run-viewer/panel.test.ts -t "post-mortem entry point"`
Expected: FAIL — the `failed`/`stopped` cases find no button.

- [ ] **Step 6: Wire the panel**

In `src/plugins/run-viewer/panel.ts`:
- line 1 add `import { PostmortemChat } from './postmortem-chat.js';`
- after line 21 (`private readonly instructions: RunInstructions;`) add `  private readonly postmortem: PostmortemChat;`
- in the constructor after `this.instructions = new RunInstructions(context.services.runInstructions);` (line 58) add `this.postmortem = new PostmortemChat(context.services.postmortem);`
- in `dispose` (line 79) change `this.instructions.dispose();` to `this.instructions.dispose(); this.postmortem.dispose();`
- after the Retry line (374) add:

```ts
      if (tab.summary?.status === 'failed' || tab.summary?.status === 'stopped') tools.append(this.button('Ask about this failure', () => { this.postmortem.open({ repo: tab.repo, runId: tab.runId }); }, commandDisabled || !this.context.services.postmortem));
```

- after `root.append(this.instructions.element);` (line 377) add:

```ts
    this.postmortem.update(this.state, tab ? { repo: tab.repo, runId: tab.runId } : null);
    root.append(this.postmortem.element);
```

- line 387: `else if (focused?.isConnected && (this.instructions.element.contains(focused) || this.postmortem.element.contains(focused))) focused.focus({ preventScroll: true });`

In `src/plugins/run-viewer/plugin-package.json`: `"version": "0.3.0"` and append to the panel `requires` array:

```json
          {
            "id": "helmsman/postmortem",
            "version": 1
          }
```

In `src/plugins/run-viewer/README.md`, extend the `requires` sentence with `and helmsman/postmortem@1`, and add after the live-instructions paragraph: `Failed and stopped runs offer **Ask about this failure**, a sandboxed post-mortem chat whose agent may propose patches but never applies them; the panel shows each patch's validation and the git apply command.`

- [ ] **Step 7: Run panel tests, typecheck and the plugin build**

Run: `npx vitest run src/plugins/run-viewer`
Expected: PASS.
Run: `npm run build && node src/plugins/run-viewer/build.mjs`
Expected: both exit 0 (the independent author build compiles `postmortem-chat.ts` transitively). Then `rm -rf src/plugins/run-viewer/dist`.

- [ ] **Step 8: Commit**

```bash
git add src/plugins/run-viewer/postmortem-chat.ts src/plugins/run-viewer/postmortem-chat.test.ts src/plugins/run-viewer/panel.ts src/plugins/run-viewer/panel.test.ts src/plugins/run-viewer/plugin-package.json src/plugins/run-viewer/README.md
git commit -m "feat: ask about a failed run from the run viewer"
```

---
### Task 12: Full validation and live verification

**Files:** none created in the repo. Scratch lives under `/tmp/pm-live/`. Never open or modify `/Users/nloehlein/workspace/ai/projects/helmsman-pre-rewrite/.helmsman.sqlite` except to copy it. Do not edit `/Users/nloehlein/workspace/ai/projects/helmsman/` (another session owns it, including its `memory.md`); report results to the user instead.

**Interfaces:** consumes the whole feature (Tasks 1-11).

- [ ] **Step 1: Full build and suite**

Run: `npm run build && npm test`
Expected: build exit 0; vitest failures limited to the pre-existing `src/builtin-frontend.test.ts` and `src/plugins/builtin-lifecycle.test.ts`. Run `npx vitest run server/helmsman/postmortem` separately and confirm the two integration files ran (not skipped) on this Mac.

- [ ] **Step 2: Build an isolated DB containing the og exec-kill run**

```bash
R=ca31adc3-bef2-47e6-b70a-ac53d67a1b03; OG=/Users/nloehlein/workspace/ai/projects/helmsman-pre-rewrite
rm -rf /tmp/pm-live && mkdir -p /tmp/pm-live/runs /tmp/pm-live/og
cp "$OG/.helmsman.sqlite" /tmp/pm-live/og/og.sqlite; for s in -wal -shm; do [ -f "$OG/.helmsman.sqlite$s" ] && cp "$OG/.helmsman.sqlite$s" "/tmp/pm-live/og/og.sqlite$s"; done
cp "$OG/.helmsman-runs/$R.log" "$OG/.helmsman-runs/$R.exit" "$OG/.helmsman-runs/$R.json" /tmp/pm-live/runs/
sqlite3 /tmp/pm-live/og/og.sqlite "SELECT 'INSERT INTO runs (id,ticketId,repo,adapter,status,attempt,prNumber,startedAt,endedAt,costUsd,worktreePath,hostKind,logPath,exitPath,specPath,taskJson) VALUES ('||quote(id)||','||quote(ticketId)||','||quote(repo)||','||quote(adapter)||','||quote(status)||','||attempt||','||quote(prNumber)||','||quote(startedAt)||','||quote(endedAt)||','||quote(costUsd)||','||quote(worktreePath)||','||quote(hostKind)||','||quote('/tmp/pm-live/runs/'||id||'.log')||','||quote('/tmp/pm-live/runs/'||id||'.exit')||','||quote('/tmp/pm-live/runs/'||id||'.json')||','||quote(taskJson)||');' FROM runs WHERE id='$R'; SELECT 'INSERT INTO run_events (runId,ts,kind,text) VALUES ('||quote(runId)||','||quote(ts)||','||quote(kind)||','||quote(text)||');' FROM run_events WHERE runId='$R' ORDER BY id;" > /tmp/pm-live/seed.sql
wc -l /tmp/pm-live/seed.sql
```

Expected: `5 /tmp/pm-live/seed.sql` (1 run + 4 events).

Create the schema by starting and stopping Helmsman once, then load the rows while it is stopped:

```bash
cd /Users/nloehlein/workspace/ai/projects/helmsman-postmortem
HELMSMAN_PORT=8798 HELMSMAN_DB=/tmp/pm-live/helmsman.sqlite RUNS_DIR=/tmp/pm-live/runs npm run serve   # wait for "Helmsman on :8798", then Ctrl-C
sqlite3 /tmp/pm-live/helmsman.sqlite < /tmp/pm-live/seed.sql
sqlite3 /tmp/pm-live/helmsman.sqlite "SELECT status, adapter FROM runs WHERE id='$R'"
```

Expected: `failed|feedback:codex`. If startup later rejects the imported row (legacy adoption audit), report the exact error to the user and stop; do not edit the DB by hand beyond this insert.

- [ ] **Step 3: Start Helmsman with real GoCaaS routing and a 1-minute idle**

```bash
HELMSMAN_PORT=8798 HELMSMAN_DB=/tmp/pm-live/helmsman.sqlite RUNS_DIR=/tmp/pm-live/runs HELMSMAN_POSTMORTEM_IDLE_MINUTES=1 \
  GITHUB_REPO=gdcorp-partners/airo-app-builder npm run serve
```

Use the shell environment that normally runs Helmsman (GoCaaS credentials present). Expected: `Helmsman on :8798`.

- [ ] **Step 4: Start a real codex post-mortem**

```bash
H='X-Helmsman-Contribution: helmsman.run-viewer/panel'
curl -s -X POST -H "$H" -H 'Content-Type: application/json' -d '{"provider":"codex","effort":"high"}' \
  http://127.0.0.1:8798/api/runs/ca31adc3-bef2-47e6-b70a-ac53d67a1b03/postmortem | tee /tmp/pm-live/start.json | jq '.session | {id,status,provider}'
SID=$(jq -r .session.id /tmp/pm-live/start.json)
curl -sN -H "$H" http://127.0.0.1:8798/api/postmortem/$SID/events | grep --line-buffered -o '"status":"[a-z]*"' | head -5
```

Expected: start returns `starting`; the stream shows `busy` then `ready` within a few minutes. `ls -la /tmp/pm-live/runs/ca31adc3-bef2-47e6-b70a-ac53d67a1b03.postmortem` shows mode `drwx------`, `evidence.json` `-rw-------`, `seed.md`, `profile.sb`, `patches/`, `provider-home/codex/`.

- [ ] **Step 5: Confirm the diagnosis came from evidence alone**

```bash
curl -s -H "$H" http://127.0.0.1:8798/api/postmortem/$SID | jq -r '.messages[] | select(.role=="agent" and .kind=="text") | .text' | head -40
```

Checklist (all must hold; otherwise report what the agent said):
- [ ] names an exec-time `SIGKILL` with no agent output (signature `exec-kill`)
- [ ] points at the oversized argv element (the 1 344-byte JSON argument / >1 KB single argument) and/or endpoint protection
- [ ] states a confidence and next checks (seed ending honored)

- [ ] **Step 6: Confirm writes outside the allowlist are denied**

```bash
curl -s -X POST -H "$H" -H 'Content-Type: application/json' -d "{\"clientId\":\"$(uuidgen | tr A-Z a-z)\",\"text\":\"Run exactly: touch ~/pm-denied-probe; then report the command's exact error output.\"}" \
  http://127.0.0.1:8798/api/postmortem/$SID/messages | jq -r .session.status
```

Wait for `ready` (re-run the events command), then:

```bash
test ! -e ~/pm-denied-probe && echo "outside write denied"
curl -s -H "$H" http://127.0.0.1:8798/api/postmortem/$SID | jq -r '.messages[-3:][] | .text' | grep -i "not permitted"
```

Expected: `outside write denied` and an `Operation not permitted` line from the agent's command item.

- [ ] **Step 7: Idle stop**

Wait 70 seconds, then:

```bash
curl -s -H "$H" http://127.0.0.1:8798/api/postmortem/$SID | jq -r .session.status
pgrep -fl 'codex.*app-server' || echo "no live codex"
```

Expected: `idle` and `no live codex` (unless another unrelated codex is running — then confirm none has `ca31adc3…postmortem` as cwd via `lsof -c codex | grep postmortem`).

- [ ] **Step 8: Resume**

```bash
curl -s -X POST -H "$H" -H 'Content-Type: application/json' -d "{\"clientId\":\"$(uuidgen | tr A-Z a-z)\",\"text\":\"In one sentence, what did you conclude in your first answer?\"}" \
  http://127.0.0.1:8798/api/postmortem/$SID/messages | jq '{status: .session.status, activity}'
```

Expected: `{"status":"busy","activity":"resuming"}`; after `ready`, the latest agent text restates the first diagnosis (proves `thread/resume` restored context) and `ls /tmp/pm-live/runs/ca31adc3-bef2-47e6-b70a-ac53d67a1b03.postmortem/provider-home/codex/sessions` is non-empty.

- [ ] **Step 9: UI pass**

Open `http://127.0.0.1:8798/run-viewer?repo=gdcorp-partners/airo-app-builder&runRepo=gdcorp-partners/airo-app-builder&run=ca31adc3-bef2-47e6-b70a-ac53d67a1b03` (Playwright MCP is fine). Confirm: **Ask about this failure** sits beside **Retry run**; clicking it shows the chat; **Start post-mortem** returns the open session (same `$SID`, transcript visible, no second codex process); the composer disables while `thinking…`; **Stop** moves to `idle`. Take one screenshot for the user.

- [ ] **Step 10: Optional claude pass and cleanup**

If the user's environment routes Claude through GoCaaS, repeat Steps 4 and 8 with `"provider":"claude-code"` after stopping the codex session (`curl -s -X POST -H "$H" http://127.0.0.1:8798/api/postmortem/$SID/stop`) and starting with `"fresh":true` only if the codex session is capped/errored; otherwise expect 409 for `fresh` and skip. Stop the server (Ctrl-C), `rm -f ~/pm-denied-probe`, keep `/tmp/pm-live` for the user to inspect, and report each checklist result with the commit SHA under test.

- [ ] **Step 11: Final commit (only if verification required fixes)**

Any fix found here gets its own failing test first in the owning task's test file, then:

```bash
git add <files>
git commit -m "fix: <what live verification found>"
```

Do not push.
