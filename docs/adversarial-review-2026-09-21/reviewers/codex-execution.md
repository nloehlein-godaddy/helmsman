# Execution and recovery adversarial review

Reviewed detached HEAD `ec3dd6b544cba1f796c353134dc4af0437cf40a8`, including the aggregate change from `e471d86630d78f2285611e81256ff912e5f57d0e` and inherited execution behavior. Four defects reproduced: three P1s and one P2. No P0 found. No production files changed, commits, pushes, live credentials, network publication, or real Docker/terminal/agent effects.

Worktree: `/private/tmp/helmsman-adversarial-20260921-ec3dd6b/codex_execution`.

## Confirmed defects

### CE-1 — P1: PR rerun force-deletes an unrelated dirty worktree

**Primary location:** `server/helmsman/worktree.ts:35`, `:51`, `:75`.

**Reachable path:** a public run command with `mode: 'rerun'` reads the selected PR and retained head in `application.ts:1208`, then `startRun` → `startDurableRun` → `createWorktreeFromBranch` (`runner.ts:717`, `application.ts:910`). `standaloneWorkspace` also invokes this helper before making a Docker clone.

**Precondition:** the PR's local branch is checked out in an existing unlocked linked worktree. The worktree can be outside `.worktrees`, owned by the developer, and contain tracked modifications or untracked files. There is no active Helmsman reservation required for it.

**Sequence and actual result:** fetch and verify the exact saved PR head; enumerate *all* Git worktrees; find the requested branch; call `git worktree remove --force <existing-path>`; reset/check out the branch for the new run. The existing developer checkout and its uncommitted files are deleted without inspection or a cleanup request.

**Expected:** admission should preserve existing worktrees. An occupied branch should reject the rerun or use a separate safe checkout strategy; deletion should require verified Helmsman ownership, cleanup eligibility, and the appropriate explicit operation. The Local Git page's dirty-worktree/ownership safeguards do not cover this runner path.

**Impact:** irreversible loss of untracked files and uncommitted edits simply by requesting a PR rerun. The branch/head check does not establish ownership of another worktree.

**Reproduction:** settled test `demonstrates a pinned PR rerun deleting an unrelated dirty developer worktree` creates only a temporary local bare remote and checkout. Evidence in `probes/codex_execution/dirty-worktree-rerun.json`:

```json
{"developerWorktreeExists":false,"untrackedFileExists":false,"newWorktreeExists":true}
```

**Falsification/negative control:** the same fixture first submits a stale expected head and verifies rejection preserves the untracked file. Submitting the correct head then deletes it. Thus the new expected-head guard works, but does not repair the deletion flaw. Existing `worktree.test.ts` also passes.

**Fix direction:** remove implicit force-removal from branch preparation. Refuse an occupied branch or create an isolated checkout without taking it away from its owner. Route any necessary cleanup through the same explicit identity and protection checks as Local Git.

**History:** inherited from the baseline; aggregate commit `59f8b76` adds expected-head preparation to this same unsafe path. This is a current inherited defect, not a claim that the aggregate introduced the force-deletion helper.

### CE-2 — P1: definite pre-launch checkout failure permanently consumes execution capacity

**Primary location:** `server/helmsman/runner.ts:707`, `:718`, `:758`; `runner-durability.ts:155`.

**Precondition:** a new admitted run has not launched a worker. Worktree preparation fails, for example because a checkout is temporarily unavailable, Git fetch fails, or creation fails. The same missing-path state is reachable by a crash after attempt preparation and before committing `session.ready`.

**Sequence:** `prepare` persists a running attempt, reservation and pins, and marks admission `started`. The subsequent worktree operation throws while `worktreePath` is still null. `startDurableRun` catches every such error as blocked attachment. On restart, `reattachDurableRun` unconditionally rejects a null worktree path before attempting preparation.

**Actual result:** run stays `running`, attempt stays `prepared`, admission stays `started`, and global/repository capacity stays reserved indefinitely. Fixing the checkout and using Retry attachment does not try the checkout again. Cancel admission calls `abandonAdmission`, which rejects any existing attempt; `releaseReservation` rejects because there is no outcome. Run-command Retry accepts only failed runs. Stop has no worker/attached handle to settle. The Recovery action set contains no prepared-attempt resolution or workspace-adoption operation.

**Expected:** retain uncertainty where a launch may have happened, but provide a safe retry or audited cancellation for an attempt proven not to have crossed `markLaunching`. Persist enough workspace intent to reconcile creation idempotently if creation itself was interrupted.

**Impact:** one ordinary preparation error can disable all launches at concurrency 1, or permanently consume one slot and lock its galleon at larger limits. Provider upgrades remain blocked by the execution pins. This is new, known-unlaunched work; it is not the documented deliberate block on historical executions with missing provenance.

**Reproduction:** `demonstrates permanent capacity retention after a definitely pre-launch checkout failure`. The test uses the real durable coordinator/stores, closes and reopens an isolated SQLite file, repairs the checkout callback, retries attachment three times, and attempts the supported cancellation/release paths. Evidence in `probes/codex_execution/preparation-failure-restart.json`:

```json
{
  "admissionState":"started",
  "runState":"running",
  "preparation":"prepared",
  "checkoutCalls":1,
  "launchCalls":0,
  "recoveries":[
    {"status":"blocked","reason":"Prepared worktree requires reconciliation before attachment"},
    {"status":"blocked","reason":"Prepared worktree requires reconciliation before attachment"},
    {"status":"blocked","reason":"Prepared worktree requires reconciliation before attachment"}
  ]
}
```

**Falsification:** the host launch callback was never called; recovery uses the same available snapshot and no missing-provider/schema precondition. Cancellation and reservation release reject through real store guards. A different galleon's new admission also rejects at capacity 1. Existing tests validate intentional protection after an ambiguous *launch*; they do not provide a remedy for this definite *pre-launch* failure.

**Fix direction:** distinguish prepared/ready failures from launching/launched uncertainty. Add lease-fenced, evidence-backed retry/cancellation of a never-launched attempt, including source-claim settlement and pin/reservation release. For interrupted worktree creation, persist the intended path/branch and reconcile it before using or deleting it. Do not weaken protection of unknown launched workers.

**History:** introduced with the durable runner and coordinator in `200c57b`; retained in the reviewed HEAD.

### CE-3 — P1: extracted detached-host Stop leaves ordinary descendant processes alive after terminal evidence

**Primary location:** `src/plugins/host-local/provider.ts:168-173`; interacting wrapper `server/helmsman/run-wrapper.mjs:40-43`.

**Precondition:** use the detached host with a direct agent/workflow whose process launches an ordinary subprocess. The descendant need not detach, ignore signals, or evade the host. This finding applies to direct execution, such as direct review/branch/custom workflows; the separate staged pre-PR supervisor has additional process-group cleanup.

**Sequence:** the host verifies wrapper ownership, but signals only `state.pid`. The wrapper forwards SIGTERM only to its immediate child. Once that child exits, the wrapper writes a valid terminal receipt and exits without waiting for or stopping its descendants. `monitorDurableAttempt` accepts that receipt and can finalize/release the reservation and clean the workspace.

**Actual result:** a normal descendant remains alive and performs a local write after the wrapper's terminal receipt. The extracted provider weakened the prior detached-host behavior, which signaled the owned process group (`server/helmsman/run-host.ts:130`, also present in the baseline).

**Expected:** Stop must terminate the owned execution tree before reporting its resources safe for release. Preserve process-identity checks; use an owned process group/job or a wrapper that supervises and settles its descendants, with bounded escalation.

**Impact:** work can continue after Stop and after capacity is released; files can be changed concurrently with cleanup or a later run, and compute can continue outside run accounting. No arbitrary PID kill or escaped-process hypothesis is required.

**Reproduction:** `demonstrates wrapper stop recording terminal exit while an ordinary descendant keeps writing` spawns the repository's real wrapper through a test-owned child handle, launches a fake Node worker with one ordinary child, verifies the receipt PID equals that handle, and invokes the actual `createDetachedExecutionHost().stop`. The descendant self-exits after its delayed write. Evidence in `probes/codex_execution/descendant-after-stop.json`:

```json
{"receipt":{"exitCode":1},"mutationAtTerminalReceipt":false,"mutationAfterStop":"mutation after stop"}
```

**Falsification/limits:** the descendant was created without `detached: true` and had no custom signal handler. The wrapper had the same detached launch shape used by the real provider. The test calls the actual provider Stop method, not a replacement. This does not prove the same orphaning for stages supervised by `executePrePrStage`, which explicitly kills its stage group.

**Fix direction:** retain exact ownership verification while restoring owned process-tree termination. Do not simply signal a terminal-wide group that could contain unrelated panes; give worker descendants a dedicated supervised group and wait for its termination before the terminal receipt.

**History:** provider change introduced in execution-host extraction `615a077`. The baseline detached implementation attempted `process.kill(-ref.pid, 'SIGTERM')`; the new implementation only calls `process.kill(state.pid, 'SIGTERM')`.

### CE-4 — P2: stopping a direct run aborts the retained parser needed to drain its final output

**Primary location:** `server/helmsman/application.ts:1180`, `:1187`; `agent-retained-loader.ts:113`; final drain `runner.ts:645`.

**Precondition:** a newly launched direct run uses a retained agent provider and produces a line of final stdout on shutdown or leaves a line unread when Stop is requested.

**Sequence:** initial admission loads agents using `admissionController.signal`. The run keeps those provider instances for execution. Stop sets the durable stop intent and aborts that same controller. The retained provider's `parseLine` then throws before parsing any later line. Even with a matching launch/exit receipt and a stopped worker, the terminal drain fails before `session.terminal`.

**Actual result:** `running` run, `blocked` attachment, no recorded attempt outcome, retained reservation, and diagnostic `This operation was aborted`. Initial launch's `finally` removes the in-memory attachment; the operator must recover a worker that already stopped. The host loader also inherits the admission signal, so its discovery lifetime should be addressed with the same correction.

**Expected:** cancel outstanding admission and execution work while keeping the retained parser/ownership observer usable until terminal logs, usage, clarification records, and outcome have been settled. A stopped worker should reach `stopped` without a new recovery action.

**Impact:** direct Stop can appear ineffective and block further work, and final usage is not drained until recovery. Unlike CE-2, this one has a supported recovery path.

**Reproduction:** `demonstrates user Stop aborting the retained parser before terminal output can drain` installs an isolated external agent archive with the real artifact installer, loads it with `loadRetainedAgentProvider`, adapts it with `agentProviderAdapter`, and runs the real durable runner against a fake worker/valid receipts. Evidence in `probes/codex_execution/stop-aborts-parser.json` records `beforeRecovery.status = "running"`, `beforeRecovery.attempt.outcome = null`, and the abort diagnostic.

**Falsification/negative control:** the test disposes the aborted instance, loads the *same exact retained artifact and settings* without the expired admission signal, calls `reattachRun` with the saved stop state, and verifies `status = "stopped"` and no reservations. No worker relaunch or provider rebinding is needed. This proves a lifetime error, not invalid worker evidence or deliberate historical recovery blocking.

**Fix direction:** give admission preparation and retained execution/finalization separate cancellation lifetimes. Once admission transfers to a prepared attempt, Stop should signal the worker without invalidating the parser/discovery contracts needed to settle it. Dispose retained providers after settlement or a deliberate detach.

**History:** the shared cancellation controller predates agent extraction; the signal-checking retained parser was added in `a8baf84`, making the existing Stop abort reach output parsing.

## Reproduction and checks

Settled runnable probe file:

`codex_execution/server/helmsman/adversarial-execution.audit.test.ts`

Run from the detached worktree:

```sh
node_modules/.bin/vitest run server/helmsman/adversarial-execution.audit.test.ts --maxWorkers=1
```

The four tests are observation probes: they pass when the documented defective behavior occurs. They deliberately do not imply a production fix. Latest local run: **4/4 passed**, 1.72 seconds. Log: `probes/codex_execution/confirmed-probes.log`. All fixtures are isolated beneath that probe directory; temporary repositories, databases and workers are cleaned up. The retained JSON evidence remains.

Focused existing checks: **84 tests in 8 files passed**, 2.99 seconds:

```sh
node_modules/.bin/vitest run \
  server/helmsman/runner-durable.test.ts \
  server/helmsman/runner-durability.test.ts \
  server/helmsman/execution-store.test.ts \
  server/helmsman/worktree.test.ts \
  server/helmsman/campaign-dispatcher.test.ts \
  server/helmsman/execution-host-execution.test.ts \
  src/plugins/host-local/provider.test.ts \
  src/plugins/host-docker/provider.test.ts --maxWorkers=2
```

Log: `probes/codex_execution/focused-baseline.log`. The production build/full-suite/distribution artifacts are root-owned integration work; this reviewer did not repeat them. The exact reviewed HEAD remained unchanged; the only worktree addition is the audit probe test.

## Coverage, history, and limits

Read repository `AGENTS.md`, plugin architecture, delivery/implementation ledger, remaining-delivery plan, recovery guide and relevant author contracts before following production call paths. Compared aggregate history and used `git blame`/baseline source to distinguish inherited behavior from C/F/G changes.

Production review covered admission and execution stores; runner/coordinator and recovery actions; reservations, lease renewal/fencing, attempts and checkpoint continuation; retained agents/workflows/hosts, reviewer identity, staged gate and report manifests; local/Docker hosts and wrapper process ownership; native-terminal selection/service/provider identity; scheduling decisions, campaign dispatch, trigger provenance and application admission; worktrees and Local Git safeguards. Focused passing tests include stale/superseded leases, atomic pin handoff, checkpoint drain, source-operation barriers, ambiguous launch protection, campaign expiry/disable/reconciliation and bounded Docker configuration/staging with fake Docker commands.

No additional confirmed defect is claimed for the reviewed reviewer-order/current-revision gates, immutable artifact verification, exact host-reference validation, or operation/checkpoint retention rules. Preserving uncertain legacy executions, missing historical provider artifacts, unresolved external effects, or incomplete clarification records is intentional safety behavior and is not counted as a defect here.

Execution limits: no live Docker engine, cmux/WezTerm UI, remote GitHub/Jira/Slack, real model CLI, cross-platform Windows/Linux run, or full installed application restart scenario was exercised by this reviewer. The physical worker probe ran on macOS. Docker/native-terminal analysis used source and existing focused tests; no claim of live integration coverage. Remote-effect publication/clarification semantics were assigned to other reviewers. Lease expiry and cancellation were inspected and covered by existing focused tests, not exhaustively model-checked across all interleavings.

## Secondary concerns / follow-up, not counted defects

- **Checkout basename aliasing:** `loadConfig` accepts `owner-a/repo` and `owner-b/repo`, while workspace helpers select `AGENTS_ROOT/repo` and admission keys capacity by full name. No central duplicate-basename/origin guard was found in `launch` or the workspace callbacks. `server/local-git.ts` has an explicit duplicate-name and origin guard, but runner helpers do not use it. Staged pre-PR execution separately validates its remote before author work, which limits that path. Direct authored workflows need a complete scope/checkout reproduction before assigning severity; this concern is not included in the four confirmed findings.
- **Retry/checkpoint follow-up:** recovery of an already launched failed direct attempt goes straight to finalization rather than through `startDurableRun`'s automatic-retry loop. Repeated failed pre-PR continuations can also retain checkpoints older than the immediate predecessor; explicit checkpoint retirement exists. These were inspected but not given new fault probes or promoted to defects in this report.
- **Test coverage gap:** existing preparation tests emphasize retaining resources under ambiguity, while the new probes show the missing distinction between known-unlaunched failures, stopped workers whose parser was cancelled, and a terminal immediate child whose descendants remain alive.

_Helmsman · gpt-6-astra - high_
