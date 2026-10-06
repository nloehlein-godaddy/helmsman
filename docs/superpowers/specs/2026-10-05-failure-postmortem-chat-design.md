# Failure post-mortem chat — design

Date: 2026-10-05 · Status: approved design, pending spec review · Branch: `feat/failure-postmortem-chat` (from `fix/chunk-worker-argv`)

## Goal

When a run fails or is stopped, the user clicks **Ask about this failure** in the run viewer and converses with a fresh, sandboxed agent that is seeded with the failed run's evidence. The agent diagnoses the cause, can run diagnostic commands, and can propose patches — it never modifies code itself. Success: the 2026-10-02 incident (feedback runs SIGKILLed at exec by SentinelOne because of a >1 KB argv element, zero agent output) would have been diagnosed from the dashboard without a separate Claude Code session.

### Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Approach | Standalone post-mortem service, not a run type or workflow |
| Agent capability | Read anywhere + run commands; writes confined to the post-mortem directory; may author patches |
| Patch targets | Helmsman repo or the run's target repo; each patch labeled `{repo, baseSha}`; applied manually by the user |
| Lifecycle | Persistent transcript + resumable provider session; process idle-stops after 15 min |
| Eligible runs | `failed`, `stopped` |
| Default agent | The failed run's provider, switchable; high reasoning effort |
| Repo | `helmsman` (rewrite) |

### Non-goals

- Keeping the failed run's own agent process alive or resuming its session.
- Applying patches from the UI (v1 shows the `git apply` command only).
- Non-macOS support (start returns `412 sandbox unavailable`).
- Auto-launching a post-mortem on failure.

## Architecture

New server module `server/helmsman/postmortem/`. It is not a run: no `runs` row, no `ProcessManager` reservation, no per-repo single-flight, no workflow snapshot or `promptCodeHash`, no inherited `maxCostUsd`.

| Unit | Responsibility | Depends on |
|---|---|---|
| `evidence.ts` | Pure builder of `PostmortemEvidence` from a failed run: run row, redacted `taskJson`, `run_events` (last 200), log tail (last 64 KB), exit code (from `.exit`, integer only) and signal (parsed from the `run-wrapper: agent terminated by signal …` log/event line), spec summary (cmd + per-argument lengths + first 40 chars of non-input args), host kind, worktree presence + reason, helmsman commit SHA, derived **signatures** | db, fs (read) |
| `sandbox.ts` | Builds the `sandbox-exec` (Seatbelt) profile and wraps `{cmd,args,env}`; preflight probe; env scrubbing | — |
| `prompt.ts` | Seed prompt: role, evidence summary, artifact paths, patch contract, helmsman source + worktree paths, empty-output guidance | evidence |
| `session-store.ts` | Tables `postmortem_sessions`, `postmortem_messages`; status transitions; idempotent message submission; restart sweep | persistence |
| `runner.ts` | Spawns/resumes the provider via the existing interactive protocols (codex app-server, claude stream-json) inside the sandbox; persists items; idle timer; caps; concurrency limit | sandbox, store, interactive-agent protocol code, model routing |
| `patches.ts` | Patch contract: list, validate (`git apply --check --cached` against a temp index at `baseSha`); never applies | git (read) |
| `routes.ts` | HTTP + SSE endpoints | runner, store, patches |

Public capability: the run-viewer is a separately built plugin that never calls `fetch`; it reaches the server only through declared host services. Post-mortem is therefore exposed as a public `helmsman/postmortem@1` capability (SDK types + host service), registered the same way `run-instructions` was (commit `f4997e0`), including `scripts/sdk-compatibility.mjs` and `scripts/build-distribution.mjs`.

Frontend in `src/plugins/run-viewer/` (consumes `helmsman/postmortem@1`):

- `panel.ts`: **Ask about this failure** button beside **Retry run** (`panel.ts:373`), shown when `status ∈ {failed, stopped}`, using the same `commandDisabled`/`evidenceReady` guard pattern.
- New `postmortem-chat.ts`: transcript, composer, provider/model/effort selects before the first message, status line (starting / thinking / resuming / idle / capped / error), stop button, proposed-patch list with copy-path and copy-`git apply` actions plus valid/invalid badge.

Protocol reuse: the codex app-server and claude stream-json message handling in `interactive-agent.ts` is extracted into a reusable protocol module consumed by both `runInteractiveAgent` and `postmortem/runner.ts`, without behavior change to existing interactive runs.

## Data model

```sql
CREATE TABLE postmortem_sessions (
  id TEXT PRIMARY KEY,           -- uuid
  runId TEXT NOT NULL,           -- failed run
  provider TEXT NOT NULL,        -- 'codex' | 'claude-code'
  model TEXT, effort TEXT,
  providerSessionId TEXT,        -- codex threadId | claude session uuid (pre-assigned)
  status TEXT NOT NULL,          -- starting|busy|ready|idle|capped|error
  error TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  costUsd REAL,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX postmortem_one_open_per_run ON postmortem_sessions(runId) WHERE status NOT IN ('capped', 'error');
CREATE TABLE postmortem_messages (
  id INTEGER PRIMARY KEY,
  sessionId TEXT NOT NULL,
  clientId TEXT,                 -- idempotency key for user messages
  role TEXT NOT NULL,            -- user|agent|system
  kind TEXT NOT NULL,            -- text|tool|command|phase|error|patch
  text TEXT NOT NULL,            -- capped at 64 KB, truncated with marker
  ts TEXT NOT NULL,
  UNIQUE(sessionId, clientId)
);
```

On disk, per failed run: the sandbox profile `<runsDir>/<runId>.postmortem.sb` (0600, Helmsman-owned, outside the agent-writable dir) and `<runsDir>/<runId>.postmortem/` (mode 0700) containing `evidence.json` (0600), `seed.md`, `tmp/` (the agent's `TMPDIR`), `provider-home/<provider>/`, and `patches/<n>-<repo>.patch` + `patches/<n>-<repo>.json` (`{repo, baseSha, summary}`).

## Endpoints

| Method + path | Behavior |
|---|---|
| `POST /api/runs/:id/postmortem` `{provider?, model?, effort?, fresh?}` | 404 unknown run; 409 unless status `failed`/`stopped`; returns the run's open session (status not `capped`/`error`) if one exists; else creates and starts one. `fresh: true` is only accepted when no open session exists (prior sessions stay readable) |
| `GET /api/postmortem/:sid` | Session, transcript, patches |
| `POST /api/postmortem/:sid/messages` `{clientId, text}` | Idempotent on `clientId`; 409 if a turn is in progress; 423 if `capped`; resumes the process if not alive |
| `POST /api/postmortem/:sid/stop` | Graceful stop; session stays resumable |
| `GET /api/postmortem/:sid/events` | SSE: message items, status changes, patch list updates |

Every call is bound to a repository the same way run instructions are: POST bodies carry `repo` and `scopeRepo` (`null` outside a galleon), GET/SSE calls carry `?repo=` and optional `&scopeRepo=`. The server checks them against the configured repositories (`403` scope not permitted, `404` repo not permitted or outside the scope) and `404`s when the run's (or the session's run's) repo differs from `repo`.

Error statuses shared by start/message/resume: `412` sandbox unavailable, `429` concurrency limit reached, `503` GoCaaS model routing not configured. User message text is limited to 8000 chars (same as live instructions).

`fresh` semantics: a new session is created whenever the run has no open session. `fresh: true` additionally seeds the new session with the latest prior session's transcript and is rejected with 409 if an open session exists. If a session's seed turn never completed (`turns === 0`), the next launch starts a new provider session (claude gets a new `--session-id`) instead of resuming, and its first turn is the seed followed by the user's text.

Limits are env-configurable: `HELMSMAN_POSTMORTEM_MAX_TURNS` (30), `HELMSMAN_POSTMORTEM_MAX_COST_USD` (5), `HELMSMAN_POSTMORTEM_IDLE_MINUTES` (15), `HELMSMAN_POSTMORTEM_MAX_LIVE` (2).

## Data flow

**Start**

1. Validate run eligibility; reuse the open session if present.
2. `evidence.ts` builds the bundle → `evidence.json`; `prompt.ts` writes `seed.md`; insert session (`starting`).
3. `runner.ts` prepares GoCaaS model routing via `prepareModelRouting` with two post-mortem-specific differences:
   - **Persistent provider home.** Normal runs get a temp `CODEX_HOME` / `CLAUDE_CONFIG_DIR` that cleanup deletes (`model-routing-cli.ts`), which would destroy the provider session and make resume impossible. `prepareModelRouting` gains an optional `{ home }`; post-mortems pass `<runsDir>/<runId>.postmortem/provider-home/<provider>`, which is reused across processes and never deleted by cleanup. Existing callers are unchanged.
   - **Session-scoped gateway token.** The model gateway only admits tokens whose run is `running` (`application.ts` `active`), and the failed run is not. Tokens are issued for the id `pm-<sessionId>`; the gateway's `active` predicate also admits `pm-*` ids while that session has a live process. `pm-*` ids have no `runs` row, so publication, `git/push` and GitHub reads stay denied — only model endpoints are reachable.

   It then builds the provider's interactive command, wraps it with `sandbox.ts`, and spawns with cwd = the post-mortem directory.
4. Protocol init: codex `initialize` → `thread/start` (store threadId); claude started with `--session-id <uuid>` generated and stored up front.
5. First turn = seed prompt, ending: "Give your diagnosis first — likely cause, evidence, confidence — then what you would check next."
6. Each agent item is persisted to `postmortem_messages` and broadcast over SSE. On turn completion: `ready`, idle timer (15 min) starts, patches rescanned.

**Message**

- One turn at a time (409 while `busy`; UI disables the composer).
- Live process: codex `turn/start` on the stored thread; claude stream-json user message on stdin.
- No live process (idle, stopped, restarted): spawn a new sandboxed process and resume — codex `thread/resume {threadId}`, claude `--resume <uuid>` — then send. UI shows "resuming…".
- After each turn: `patches.ts` rescans and validates; SSE pushes the list.

**Idle / stop / caps / restart**

- Idle 15 min or stop: close stdin → SIGTERM → SIGKILL after 5 s; status `idle`.
- Caps (defaults, configurable): 30 turns; $5 where the provider reports cost (claude `total_cost_usd`; codex token usage priced with existing helmsman pricing). Reaching a cap → `capped`; transcript and patches retained; further messages 423.
- Concurrency: at most 2 sessions with live processes; a third start/resume → 429.
- Helmsman restart: sessions in `starting|busy|ready` → `idle`; no reattach; next message resumes.

State machine: `starting → busy → ready ⇄ busy → idle → (resume) busy …`; terminal `capped`, `error` (error is retryable via resume).

## Safety

**Sandbox (mandatory).** Before every start/resume, the profile is regenerated and preflighted with `sandbox-exec -f <runsDir>/<runId>.postmortem.sb /usr/bin/true`; any failure or non-macOS → 412, never an unsandboxed fallback. The profile lives **outside** the agent-writable directory (a sibling of `<runId>.postmortem/`) and is written by removing any existing entry and creating it exclusively (`flag: 'wx'`, mode 0600), so the agent can neither swap in a permissive profile nor plant a symlink that Helmsman would write through. Profile:

```scheme
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "<runsDir>/<runId>.postmortem") (subpath "/dev"))
(deny file-read* (subpath "<HOME>/.ssh") (subpath "<HOME>/.config/gh") (literal "<HOME>/.netrc")
                 (subpath "<HOME>/.aws") (regex "^<helmsmanRoot>/\\.env"))
```

Every path is `realpath`ed and escaped for Seatbelt string literals. Each credential path that exists is denied both as joined and as its realpath (symlinked `~/.ssh` etc.), and symlinked `<helmsmanRoot>/.env*` entries additionally deny their realpath targets (`literal` for a file, `subpath` for a directory). The global per-user `$TMPDIR` is **not** writable — it holds cmux CLI shims that sit first on `PATH` and the temp provider homes of normal runs, so writing there would be a persistence escape; the agent instead gets `TMPDIR=<runsDir>/<runId>.postmortem/tmp`. Tools that ignore `TMPDIR` in favour of `confstr(_CS_DARWIN_USER_TEMP_DIR)` (e.g. macOS `mktemp` without an explicit template path) fail with `Operation not permitted`; acceptable. Before every start/resume Helmsman re-walks every path it owns inside the post-mortem directory (the directory itself, `patches/`, `tmp/`, `provider-home/<provider>/`) with `lstat`, replacing any symlink or non-directory with a fresh 0700 directory, and writes `seed.md`, `evidence.json` and provider config by removing the entry and creating it exclusively after proving its parent's realpath stays inside the directory, so an agent-planted symlink is never written or removed through. `~/.codex` and `~/.claude` are **not** writable: provider state lives in the persistent provider home inside the post-mortem directory, and a writable `~/.claude`/`~/.codex` would let the agent plant settings or hooks that run in the user's next unsandboxed session. Git commands that need index locks degrade to warnings; acceptable.

**Remote-mutation guard.** The write jail does not stop network actions. Mitigations: strip from the agent env, except the model-routing allowlist: `SSH_AUTH_SOCK` (blocks ssh-agent `git push`), any `*ASKPASS`, any `VSCODE_GIT_*`, and any key matching `/(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)(?:_|$)/i` (covers `GITHUB_TOKEN`, `GH_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `AWS_ACCESS_KEY_ID`, …); disable git credentials (`GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=credential.helper`, `GIT_CONFIG_VALUE_0=`) and `GIT_TERMINAL_PROMPT=0`; deny reads of credential files (above); prompt instructs diagnosis only, no external system contact. **Residual risk:** this is not a hard boundary against a hostile model (credentials elsewhere on disk, keychain; `(allow default)` permits mach/IPC, so `launchctl submit` or `open` via LaunchServices could start processes outside the sandbox — untested). It is strictly tighter than normal runs, which execute with `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`.

**Evidence redaction.** `taskJson` keys matching `/token|secret|password|credential|capability|apikey/i` → `[redacted]` (publication token, docker capability, model gateway token). Log tail and events: regex redaction of `ghp_…`, `github_pat_…`, `sk-…`, `Bearer …`, `xox[abpr]-…`. Spec args: lengths plus first 40 chars of non-input args only.

**Missing worktree.** Evidence records `worktree: missing` with reason (removed on non-retaining failure / swept at startup); prompt states it. Target-repo patches still allowed against an explicit `baseSha`. Validation never needs a worktree: `GIT_INDEX_FILE=<tmp> git read-tree <baseSha>` then `git apply --check --cached <patch>`; unknown base → `invalid: base not found`.

**Zero-output failures.** Signatures always present in evidence:

| Signature | Rule |
|---|---|
| `exec-kill` | signal SIGKILL, duration < 5 s, no agent output lines |
| `spawn-failed` | exit 127 or log contains `cannot start` |
| `stage-timeout` | event text `Agent stage timed out` |
| `cost-cap` | run capped by cost |
| `clarification-unanswered` | required clarification unanswered at finalize |
| `snapshot-mismatch` | event text `Prompt implementation does not match the saved workflow snapshot` |
| `gate-blocked` | event text `publication gate did not pass` |

When the log has no agent output, the prompt adds: "No agent output — consider exec-level causes: host, spec argv (lengths are listed), endpoint protection, PATH, provider auth."

**Agent/protocol errors.** Provider auth/model failure → `error` with message, resumable. Oversize/malformed protocol lines use `interactive-agent`'s existing limits. Seed prompt bounded (summary inline, full artifacts by path). `sandbox-exec` is native; any node wrapper beneath (GoCaaS routing) already uses chunked argv (see memory.md 2026-10-02 decision).

## Testing

Unit (colocated vitest):

- `evidence.test.ts` — fixtures: exec-kill (`ca31adc3` shape), timeout, snapshot mismatch, missing worktree; each signature fires only where expected; redaction leaves no token substrings; spec args reduced to lengths.
- `sandbox.test.ts` — profile allow/deny lists and path escaping; non-macOS refusal; env scrub removes token vars, keeps routing vars.
- `session-store.test.ts` — transitions, `clientId` idempotency, restart sweep → `idle`, cap enforcement.
- `patches.test.ts` — sidecar validation, temp-index `git apply --check --cached` (valid / conflicting / missing base), ordering.
- `prompt.test.ts` — includes evidence summary, patch contract, missing-worktree and empty-output notes; respects size bound.
- `routes.test.ts` — non-eligible run 409, session reuse, 409 during turn, 423 capped, 429 concurrency, 412 sandbox unavailable.

Integration (real processes, real Seatbelt; skipped off macOS like `hasShebangShims`):

- `postmortem-sandbox.integration.test.ts` — under the generated profile: write outside allowlist fails, inside succeeds; `~/.ssh` and helmsman `.env` reads fail; long-arg via bash shim survives.
- `postmortem-runner.integration.test.ts` — fake codex/claude (bash shim + args file, per `bashShimPassingLongArgvViaFile`) speaking app-server / stream-json: start → seed turn → message → idle → resume (asserts `thread/resume` / `--resume <uuid>` with stored ids), stop, turn-cap, patch written → listed + validated.

Frontend (jsdom):

- `postmortem-chat.test.ts` — transcript render, composer disabled while busy, resuming state, patch list + apply command, error/capped states.
- `panel.test.ts` — button shown only for `failed`/`stopped`.

Live verification before done: recreate an exec-kill run (or use a copy of the og DB row `ca31adc3`), start a post-mortem with real codex via GoCaaS, confirm the diagnosis names the exec-time SIGKILL / argv length from evidence alone, confirm an attempted write outside the allowlist is denied, idle, resume.

## Open risks

- Seatbelt (`sandbox-exec`) is deprecated by Apple but functional and used by codex itself; if removed in a future macOS, start returns 412 until an alternative sandbox is added.
- Cost scope differs by provider. Codex `thread/tokenUsage/updated` totals are thread-cumulative across processes, so after a resume the stored cost becomes `max(stored, reported)` (no double count; a failed turn's usage is picked up by the next successful one). Claude `total_cost_usd` is per process, so the stored cost becomes `stored-at-process-start + reported`; unverified live until a claude post-mortem completes a resumed turn.
- Unverified until live check: whether the real codex app-server accepts `thread/resume` with start-time overrides (`cwd`, `model`, …) alongside `threadId`.
- Resuming depends on provider session storage in the persistent provider home (`<pmDir>/provider-home/<provider>`); if the provider prunes it, resume fails → session `error`; the UI offers **Start new post-mortem** (`fresh: true`), seeded with the same evidence plus the prior transcript; the old transcript stays readable.
