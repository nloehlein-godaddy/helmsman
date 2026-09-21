# Second adversarial execution review

Reviewed exact HEAD `e3ccca4d6b31db70974f4c8e70784e491768d9c8`, the corrections since `ec3dd6b544cba1f796c353134dc4af0437cf40a8`, and execution-related A–G history/current inherited paths since `e471d86630d78f2285611e81256ff912e5f57d0e`.

**Three confirmed findings: two P1s and one P2.** No P0. The specific previous R01 rerun deletion, R03 never-launched capacity leak, and R05 cancelled retained parser probes are fixed in their corrected paths. R01 has a separate startup deletion path, and R04 has an installed-package compatibility gap. Neither is a restatement that the changed helper still behaves as before.

Worktree: `/private/tmp/helmsman-adversarial2-20260921-e3ccca4/codex_execution`.

Evidence directory: `/private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/codex_execution`.

No tracked production files were changed, no application/distribution builds or full suites were run, and no commits, pushes, real integrations, credentials, model CLIs, Docker engine or native terminal were used. Process probes use bounded fixture workers; Git and SQLite state are disposable.

## CE2-1 — P1: normal startup still force-deletes unrelated dirty worktrees

**Current locations:** `server/helmsman/worktree.ts:76`, `:111–114`, `:60`; caller `server/helmsman/application.ts:1080–1086`. The permissive absence result used by that caller is `server/helmsman/execution-store.ts:561–576`.

**Reachable trigger:** an inspected/configured galleon has a linked developer checkout whose absolute path contains `/.worktrees/`. It can be outside `AGENTS_ROOT`, on a developer branch, with tracked edits and untracked files, and have no Helmsman run record. Start Helmsman normally.

**Observed chain:** `listAgentWorktrees` treats the pathname substring as sufficient ownership evidence. `sweepOrphanedWorktrees` uses the path basename as a run ID. No matching admission, attempt, reservation, claim or operation makes `cleanupEligibility` return allowed; no matching run makes the application’s remaining guard false. The sweep then calls `git worktree remove --force` through `removeWorktreeAt`.

**Execution proof:** a real local Git fixture created an unrelated dirty checkout at `developer/.worktrees/personal-feature`, outside the galleon’s managed checkout root. The actual listing, sweep and removal functions deleted its tracked edits and untracked file. The database had no `personal-feature` run. A separate active-run checkout was preserved by the same sweep.

Evidence `startup-sweep.json` records:

```json
{
  "developerExists": false,
  "untrackedExists": false,
  "protectedExists": true,
  "knownRun": null
}
```

Root independently reproduced the same result through the **fresh compiled application’s actual normal startup**, with an ordinary sibling developer checkout preserved as an additional control. Root evidence: `probes/root/startup-sweep.json`, `logs/root-startup-sweep.log`; script `integration/review-startup-sweep.ts` under the review root. That is independent confirmation, not a test executed by this reviewer.

**Expected:** automatic cleanup must establish exact Helmsman ownership and eligible settled execution before deleting a checkout, and preserve unknown/developer work and dirty files. A pathname convention plus absence of a reservation does not establish ownership.

**Impact:** irreversible loss of developer changes merely from application startup. The corrected rerun path can now preserve a dirty occupied checkout, but a later startup can delete it through this independent path.

**Minimal fix direction:** require a retained run/workspace binding matching the exact canonical checkout and galleon, and verified cleanup eligibility; preserve unknown paths. Reuse the guarded Local Git cleanup policy rather than implicit force removal. Merely restricting paths to the managed root is insufficient for developer work placed there, and merely checking dirty status still does not prove ownership.

**History:** the substring test and sweep are inherited from before A–G (`git blame` traces this to `62b79709`). R01’s `2b03972` removes destructive rerun preparation but leaves this current startup caller intact.

**Reproduction:** run the audit test with `-t 'startup sweep'` using the command below. Probe source is retained as `adversarial2-execution.audit.test.ts.txt`.

## CE2-2 — P1: a supported historical local-host package bypasses current staged settlement

**Current locations:** `server/helmsman/run-wrapper.mjs:21`, `:37–41`, `:88`, `:112–117`; provider boundary `server/helmsman/execution-host-execution.ts:62–63`. Current admission still accepts `helmsman/execution-host@1`, and `src/plugins/execution-host.ts:78–84` validates the input boolean but cannot verify its serialization by the provider.

**Reachable precondition:** an operator independently built/installed the shipped local-host author package before the fixes and continues selecting that external artifact for new runs after updating core. This is explicitly supported package authoring/selection, not hypothetical malicious plugin code. The exact historical descriptor, backend and provider at `ec3dd6b` remain usable after changing only the reserved namespace for external installation and performing the package’s usual SDK bundling.

**Public acceptance proof:** the fresh compiled release CLI successfully performs `pack`, `install`, `enable`, and `select-execution-host` on that historical author package. The normal backend activation loader registers all its hosts without errors. `resolveExecutionHostSelection` and `assertExecutionHostSelectionCurrent` accept its detached provider for admission with contract version 1 and original metadata/settings. Evidence: `historical-host-public-selection.json`.

**Fault sequence:**

1. Core’s current `executionHostAdapter` correctly classifies a `pre-pr-cli.js` command and supplies `coordinator: true` and the current wrapper.
2. The installed historical provider’s actual `writeSpec` serializes the identity, command and paths but omits `coordinator`. That omission was present in the previously shipped author package.
3. The current wrapper interprets the missing field as ordinary direct execution. It gives the coordinator no IPC channel and considers numeric coordinator exit sufficient settlement.
4. The fixture coordinator starts a separate bounded stage group, matching core’s staged execution shape, then throws an unexpected exception. The stage continues writing.
5. The wrapper writes a matching terminal receipt with exit code 1. The retained provider discovers `found/exited`, while that stage is still mutating the fixture workspace.

**Execution evidence:** `coordinator-provider-old.json` contains:

```json
{
  "oldProvider": true,
  "installedAndLoaded": true,
  "inputCoordinator": true,
  "serializedCoordinator": null,
  "exitReceiptExists": true,
  "stageStillWriting": true
}
```

The process test uses the real artifact installer, retained-provider loader, current adapter and current wrapper. Historical provider source is preserved in `old-host-local-provider.ts`; the historical descriptor/backend are preserved alongside it. The test’s subprocess coordinator and stage are local fixtures, not model agents. The stage’s separate group is the normal core coordinator pattern, not an agent deliberately escaping containment.

**Negative controls:** the same coordinator exception under the **current** provider produces no terminal receipt and `discover: unknown` (`coordinator-provider-new.json`). An ordinary current direct worker correctly produces an exited-zero receipt (`direct-current-control.json`). Thus the proposed requirement is staged cleanup acknowledgement, not rejection of all ordinary exits or all installed providers.

**Expected:** supported older packages must either preserve the new supervisor requirement through a compatible core-owned protocol or be rejected for new staged admissions before launch. A missing coordinator marker cannot authorize the weaker direct-worker settlement path.

**Impact:** terminal evidence can release capacity and allow finalization/workspace effects while an independently grouped stage remains active. The missing marker also re-enables the outer five-second escalation deadline that the staged-cleanup correction removed. The latter deadline race is statically established by line 21; this probe demonstrates the stronger false-receipt outcome after a coordinator exception.

**Minimal fix direction:** version or negotiate the wrapper/supervision contract, retain core-owned coordinator classification independently of provider serialization, and fail closed when the wrapper cannot establish that classification. Add a historical externally installed host-package compatibility regression. Do not silently rebind retained running work or treat all trusted plugins as adversaries.

**History:** the wrapper’s reliance on the marker and new acknowledgement semantics come from `2b03972`, `e663b07`, and `c7f85c8`. Fixing only the current host package’s `writeSpec` leaves previously built external copies accepted under the unchanged v1 capability. This is a correction/compatibility interaction.

**Scope of proof:** public CLI installation/selection and real provider/adapter/wrapper execution are separately proven. This reviewer did not submit this package through a full application HTTP new-run flow. The selected record is accepted by the same admission selection functions, so no unsupported package or private test-only provider bypass is needed.

**Reproduction:** run the audit with `-t 'coordinator crash|historical author|ordinary current direct'`.

## CE2-3 — P2: terminal cost reporting bypasses the retry cap

**Current locations:** `server/helmsman/runner.ts:648–654` and `:758`.

**Reachable trigger:** an existing-PR direct workflow permits multiple attempts; a failed worker reports usage/cost in its final output, and its exit receipt is present before the monitor next polls. This is ordinary behavior for providers that report their total when finishing.

**Observed interleaving:** `monitorDurableAttempt` reads the exit receipt, drains final output and correctly persists the newly reported cost, then returns the earlier `capped` value. The cap calculation is below the terminal return. `startDurableRun` trusts `outcome.capped` and starts another attempt even though the run’s already recorded cost is over the cap. Subsequent attempts can repeat the same sequence.

**Execution proof:** the real durable coordinator, SQLite attempt/reservation stores, `openUsageStore` and `openRunTelemetry` process matching local fake-worker receipts. With `maxCostUsd: 0.5`, `maxAttempts: 3`, and each failed attempt reporting `0.75` in its final line, all three attempts launch:

```json
{
  "maxCostUsd": 0.5,
  "launches": [
    { "attempt": 1, "priorCost": null },
    { "attempt": 2, "priorCost": 0.75 },
    { "attempt": 3, "priorCost": 1.5 }
  ],
  "finalStatus": "failed",
  "finalAttempt": 3,
  "finalCost": 2.25
}
```

Evidence `terminal-cost-capped.json` also records all three production telemetry usage entries, each at `0.75`. This disproves missing usage accounting or a test-only cost accumulator as the explanation.

**Expected:** the first attempt can exceed an approximate asynchronous cap before reporting, but no second attempt should launch once its final known cost exceeds the configured limit. Stop/failure finalization should occur after the first attempt here.

**Negative control:** an otherwise identical `maxCostUsd: null` run correctly uses all three allowed attempts (`terminal-cost-uncapped.json`). Existing cost/poll behavior does not repair the terminal branch: it returns before reaching that calculation.

**Impact:** additional model work and charges beyond a configured per-run spending bound. The recorded cost remains correct; enforcement at the retry boundary is incorrect.

**Minimal fix direction:** recompute the cap after terminal output is fully drained, and recheck the persisted current cost before preparing/launching another attempt. Preserve uncapped retry behavior and avoid changing already established execution outcomes.

**History:** introduced by the durable runner in `200c57b`; unchanged by the latest corrections. The earlier non-durable retry implementation separately considered accumulated cost. This was not one of the first review’s twelve confirmed findings.

**Reproduction:** run the audit with `-t 'final-output cost'`.

## Tests executed and durable reproduction

From the detached worktree:

```sh
TMPDIR=/private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/codex_execution \
  node_modules/.bin/vitest run server/helmsman/adversarial2-execution.audit.test.ts --maxWorkers=1
```

Final custom audit: **7/7 passed**, 6.41 seconds. These are observation probes that pass when the documented behaviors and their controls occur. Log: `confirmed-probes.log`. The probe is also copied as `adversarial2-execution.audit.test.ts.txt`. Public CLI proof expects the root-built fresh release at `integration/release` with its READY marker; it does not build another release.

Focused existing checks: **235 tests in 12 files passed**, 25.83 seconds, with no unhandled failures. Log: `focused-tests.log`.

```sh
node_modules/.bin/vitest run \
  server/helmsman/runner-preparation.test.ts \
  server/helmsman/runner-durability.test.ts \
  server/helmsman/runner-durable.test.ts \
  server/helmsman/execution-store.test.ts \
  server/helmsman/worktree.test.ts \
  server/helmsman/execution-host-execution.test.ts \
  src/plugins/host-local/provider.test.ts \
  src/plugins/host-docker/provider.test.ts \
  server/helmsman/pre-pr-runtime.test.ts \
  server/helmsman/pre-pr-workflow.test.ts \
  server/helmsman/coordinator-settlement.test.ts \
  server/helmsman/run-lifetime.test.ts --maxWorkers=2
```

The early installed-provider probe failed because its first fixture omitted the required SDK runtime bundling. The fixture was corrected to mirror the author build’s relative SDK import; that was a probe construction error, not a production finding. Final acceptance and process evidence above use the corrected fixture.

## Corrections verified, negative conclusions and coverage

- **R01:** actual Git tests pass for stale retained heads, dirty tracked/untracked occupied developer checkouts, and clean occupied rerun worktrees. The destructive finding above is the still-live startup sweep, not the corrected branch helper.
- **R03 and its two corrections:** reviewed never-launched evidence recording, immutable terminal projection, preparation-state fence, lease checks, claim-operation barrier, finalization transaction and pin/reservation release. Passing focused tests prove definite checkout failure releases capacity after restart; unknown launches remain reserved; terminal preparation outcomes cannot be changed to success or late Stop; failed obligation commit preserves pins; and unresolved legacy claims stay protected until their exact operation is reconciled. I did not reproduce a remaining legitimate never-launched recovery that is permanently stuck under those prerequisites.
- **R05:** the retained parser fixture now drains final output after Stop with its provider signal still live and releases reservations/pins without a new recovery operation. Admission cancellation and provider disposal are separately exercised. Current application launch transfers the lifetime before durable execution; retained recovery does not reuse a cancelled admission signal.
- **R04 and acknowledgement correction:** real existing process tests pass for ordinary descendant termination, TERM resistance, natural exit cleanup, wrong ownership, wrapper crash, supervisor crash, explicit stage acknowledgement and numeric coordinator exception/early-exit cases. Current same-version staged crashes correctly withhold terminal evidence. The compatibility finding concerns an accepted historical external package dropping the marker.
- Inspected admission reservations and atomic pin handoff, attempt leases and renewals, source-operation barriers, finalization order, recovery handshake deduplication, prepared/launching/launched branches, Stop intent, retry and pre-PR continuation, retained agent/host/workflow boundaries, stage setup/cleanup, runtime path remapping, source effects before release, and worktree creation/removal.
- Consulted repository AGENTS, architecture plan and A–G ledger entries, recovery/agent/workflow/execution-host guides, previous execution report, fix ledger and exact correction diffs. Used history/blame to distinguish inherited sweep, Phase C retry defect, and new wrapper compatibility interaction.
- A candidate lost-cancellation race during asynchronous stage setup was **disproved**: `executePrePrStage` checks the aborted signal again after installing its listener, so a Stop already received during preparation invokes cleanup.
- A candidate old-core coordinator/new-wrapper recovery mismatch was **disproved for normal retained recovery**: `runnerDurability.verify` requires the original core runtime hash to match the current runtime. Old already-launched workers retain their original wrapper. Missing historical runtime is intentional blocked recovery, not silent rebinding. The confirmed external host-package compatibility case concerns a fresh admission using the current core.
- The fallback runner cumulative-cost accumulator looked suspicious across attempts, but application execution uses production telemetry grouped by attempt. It was not promoted as a finding; the proven retry-cap issue persists with production telemetry enabled.

## Explicit gaps and secondary follow-up

No live Docker, cmux/WezTerm, Windows/Linux process behavior, real model output stream, GitHub/Jira/Slack or remote publication was exercised. Physical process probes ran on macOS. Docker and isolated-host behavior beyond the local coordinator model is covered by source inspection and existing mock-based tests only. Browser/visual, fresh distribution builds and the aggregate suite are root-owned and not claimed as this reviewer’s validation.

The tests do not exhaustively enumerate all crash/lease/source-effect interleavings. They preserve uncertainty rather than infer safe release from missing evidence. Deliberately daemonized agent descendants are outside the documented local supervisor scope and are not a finding here.

A crashed direct supervisor with surviving workers correctly withholds completion while that group remains active. Its wrapper’s Stop forwarding still targets the dead supervisor, so improved owned-group recovery/control would be useful; the documented uncertainty and existing bounded-crash test are not counted as another proven release defect. Likewise, old-runtime restoration, missing artifacts and unresolved claim reconciliation remain deliberate protections.

Automatic retries on recovery go directly through reattachment finalization rather than the fresh-run retry loop, and galleons sharing a basename still deserve an independent scope/origin fixture. Neither concern received a sufficient independent fault probe here and neither is counted among the three findings.

_Helmsman · gpt-6-astra - high_
