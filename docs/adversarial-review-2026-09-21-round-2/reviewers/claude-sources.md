# Adversarial Review — Round 2 — Domain/Data Correctness (Sources, Claims, Retry, Settlement)

Reviewer scope: Jira/Todos sources, identity/claims/source-command journals, command retry/reconciliation,
settings/adoption, campaign scheduling, clarification/contact and task-view scope, usage/pricing/outcomes.
Audited HEAD `e3ccca4d6b31db70974f4c8e70784e491768d9c8`, the full diff since prior-reviewed `ec3dd6b`, and the
A–G rewrite lineage inherited into this area.

## Result

No new confirmed defects. All candidate hypotheses I raised were disproved by direct code tracing and/or
executable probes against real (non-mocked) SQLite-backed stores. This corroborates my round‑1 finding for
this area (also clean) and confirms the R03/R05 fixes hold at the specific domain boundaries I was asked to
stress: never-launched settlement interacting with source claims, reservations, unresolved legacy operations,
and retry.

## Areas inspected

- `server/helmsman/execution-store.ts` (`hasUnlaunchedOutcome`, `validateOutcome`, reservation/pin release)
- `server/helmsman/runner-durability.ts` (full file — `session()`, `terminalUnlaunched`, `finalize`, `prepare`, `recover`)
- `server/helmsman/runner.ts` (`claimTicket`/`SourceClaimUnresolvedError`, `settleUnlaunchedAttempt`, `startDurableRun`, `reattachDurableRun`, `monitorDurableAttempt`, `finalizeDurableAttempt`)
- `server/helmsman/run-lifetime.ts` (admission vs. provider `AbortController` split — R05)
- `server/helmsman/task-source-runtime.ts` (full file — `reserve`, `prepare`, `abort`, `prepareFinalization`, `finalize`, `drain`, `recoverAdmissions`, `retrySettlement`)
- `server/helmsman/task-source-execution.ts` (`sourceExecutionTask`, `sourceExecutionSnapshot`)
- `server/helmsman/legacy-run-effects.ts` (full file — legacy `jira.assign`/`jira.transition` "run-claim" operations, `prepareFinalizationLookups`, `finalizationKinds`)
- `server/helmsman/operations.ts` (`lease`, `settle`, `retry`, `resolve` — full state machine incl. `definitely-not-applied` → `pending` redispatch)
- `server/helmsman/operation-dispatcher.ts` (full file)
- `server/helmsman/recovery-service.ts` (operator escape-hatch actions, incl. `resolve-operation`, `retry-source-settlement`)
- `server/helmsman/application.ts` — `launch()` closure (lines ~1140–1330: reservation/admission transaction, async execution kickoff, outer catch → `taskSourceRuntime.abort()`), `effectsFor()`/`runEffects` cache, `runnerDurability()`/`baseRunnerDeps()` wiring of `finalize`/`prepareFinalization`, `drainEffects`
- `server/helmsman/task-sources/store.ts` (schema — `work_claims` table, `active_source_work` unique index)
- Diff `ec3dd6b..HEAD` full file list (58 files) to scope exactly what changed this round: confirmed **no changes** to `src/plugins/jira/*`, `src/plugins/todos/*`, `src/plugins/scheduling/*`, `src/plugins/pricing/*`, `clarification-protocol-store.ts`, `task-edit-service.ts`, `activity-read-service.ts`, `outcomes.ts`/`outcome-service.ts`, `run-telemetry.ts`, `task-source-schedule.ts`, `source-command-coordinator.ts`, `source-admin-service.ts`. My round‑1 findings for those files stand unchanged (no new code, no new risk surface); this round's real churn in my domain is concentrated in `execution-store.ts`, `runner-durability.ts`, `runner.ts`, `run-lifetime.ts`, `task-source-runtime.ts` (R03/R05 fix commits `50b588f`, `f262636`, `47355a0`).
- Test files read in full and cross-referenced against hand-traced code: `runner-preparation.test.ts` (5 tests), `runner-durability.test.ts` (the `terminalUnlaunched`/lease-fencing block), `task-source-runtime.test.ts` (all 14 tests, including the `it.each(['failed','stopped'])` never-launched pre-PR settlement test and the "retains partially applied remote abort obligations" restart test).

## Hypotheses raised and disproved (negative controls)

1. **Suspected double Jira claim for task-source runs.** The legacy `claimTicket()` path in `runner.ts:743` fires when `!task.todoId && !task.task && !task.prBranch`. Since `sourceExecutionTask()` (`task-source-execution.ts:30-41`) unconditionally sets a non-empty `task.task` string for *every* task-source claim (both Jira-ticket-mode and Todo-mode), the legacy guard is always false for source-claim tasks — confirmed by reading the code and by the "reserves capacity before Jira alias lookup" test's fetcher-call assertions (exactly one PUT + one POST, matching only the new-path claim, never a third call from the legacy path). No double-claim/duplicate-effect risk.

2. **Suspected cross-galleon (cross-repo) double claim on the same external ticket.** `work_claims` has `CREATE UNIQUE INDEX active_source_work ON work_claims(sourceId,externalId) WHERE state != 'settled'` (`task-sources/store.ts:74`) — a DB-level constraint, not just application logic, globally preventing two concurrently-active claims on the same `(sourceId, externalId)` regardless of repo.

3. **Suspected crash window between source-claim commit and execution-attempt creation** (process dies after `taskSourceRuntime.prepare()` commits a `claimed` claim but before `startDurableRun` creates the execution row). Traced `recoverAdmissions()` (`task-source-runtime.ts:285-295`): it iterates pending admissions with no execution attempt and either a claim or a `sourceInstanceId`, calls `abort()`, and marks the admission `failed` — correctly reconciling this exact window on restart. This is also effectively what "retains partially applied remote abort obligations while releasing proven-unstarted capacity on restart" already tests for the earlier failure point (claim commit itself failing); I additionally traced (not just tested) the later window and found the same recovery path applies.

4. **Suspected `taskSourceRuntime.finalize()` error-swallowing was a new gap introduced by the R03 fix**, since it never rethrows a settlement-commit failure to the caller that just released execution-capacity pins. Diffed `git show 50b588f -- server/helmsman/task-source-runtime.ts`: the only change to that region was the `hasUnlaunchedOutcome` bypass condition inside `prepareFinalization`; the swallow-and-report behavior in `finalize()` is byte-for-byte pre-existing. Consistent with the documented invariant that execution capacity and source-claim pins release independently (source claim keeps its own `dependency` pin until `drain()`/`retrySettlement()` succeeds) — matches `task-source-runtime.test.ts`'s "releases never-launched capacity while retaining a failed source settlement and its pins for retry" test. Out of scope for this round; not a new defect.

5. **Suspected a `worktree` variable reused across retry attempts in `startDurableRun`** (declared outside the `for` loop, assigned once) could let a later per-attempt failure route through `settleUnlaunchedAttempt` with `row.worktreePath` already set, contradicting "never launched." Traced: `hasUnlaunchedOutcome` never inspects `worktreePath`, only `hostRef === null` plus the recorded evidence kind — and `session.hostRef` can only be set via `launched()`, which is only called *after* the worker process is actually spawned. A worktree existing without a host reference is deliberately still "no partial worker progress" by this design's own definition (nothing the worker wrote is trusted until launch). Confirmed by the existing "settles a definite checkout failure" test using a fixed `createWorktree` on retry and by my own understanding of the state machine; not a bug, just a naming-implies-more-than-it-guarantees observation (see low-severity note below).

## Executable probes (new, this round)

Both probes use real `openPersistence`/`openExecutionStore`/`openAdmissionStore`/`createRunnerDurability` against temp-dir SQLite files (no mocks of the persistence layer). Written to
`/private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/claude_sources/adversarial-probe.test.ts`,
result captured in `adversarial-probe.result.txt` in the same directory. Both passed.

- **Probe 1 — cross-process lease contention on never-launched settlement.** Opens a first coordinator, prepares an attempt (`ready`), and — without closing its session (simulating a coordinator mid-flight on a slow `prepareFinalization`) — opens a second coordinator against the same on-disk state and asserts `recover()` throws `'Another coordinator owns this execution attempt'`. Then the first coordinator settles (`terminalUnlaunched` → `finalize` → `close`), and a fresh reattach afterward never calls `launch`/`createWorktree`. Confirms no double-settlement / no torn state across two "processes" racing for the same attempt.
- **Probe 2 — malformed on-disk outcome evidence.** After a genuine `terminalUnlaunched` settlement, directly overwrites the `execution_attempts.json` blob's `outcome.evidence` with a bare string (`'not-an-object'`) via raw SQL — simulating disk corruption or a hand-edited row, bypassing all in-process validation. Confirms `executions.attempt()` does not throw and `hasUnlaunchedOutcome`'s `object()` guard degrades safely (returns non-never-launched) rather than crashing or silently mis-classifying the row.

Repro:
```
cd /private/tmp/helmsman-adversarial2-20260921-e3ccca4/claude_sources
cp /private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/claude_sources/adversarial-probe.test.ts server/helmsman/adversarial-probe.test.ts
npx vitest run server/helmsman/adversarial-probe.test.ts --reporter=verbose
rm server/helmsman/adversarial-probe.test.ts   # not part of the tracked suite
```

## Tests actually executed (this round)

All run from `/private/tmp/helmsman-adversarial2-20260921-e3ccca4/claude_sources` via `npx vitest run ... --reporter=dot`:

- `runner-preparation.test.ts`, `runner-durability.test.ts`, `task-source-runtime.test.ts`, `run-lifetime.test.ts`, `operations.test.ts`, `operation-dispatcher.test.ts`, `legacy-run-effects.test.ts`, `recovery-service.test.ts` → **85/85 passed**
- `src/plugins/jira/**`, `src/plugins/todos/**`, `src/plugins/scheduling/**`, `server/helmsman/task-source*`, `server/helmsman/outcome*`, `run-telemetry.test.ts`, `clarification-protocol-store.test.ts`, `task-edit-service.test.ts`, `activity-read-service.test.ts`, `source-command-coordinator.test.ts`, `source-admin-service.test.ts`, `src/plugins/activity-read.test.ts` → **33 files / 444 tests passed**
- New adversarial probe file → **2/2 passed**

No full suite, distribution, or app build was run (root-owned, per instructions).

## Low-severity observations (not defects)

- `hasUnlaunchedOutcome`'s name implies "the worker never ran," but its actual guarantee is narrower and correct: "no host reference was ever recorded." A worktree checkout can exist on disk for a never-launched attempt (see hypothesis 5 above); this is intentional (nothing on disk is trusted without a host reference) but could mislead a future maintainer skimming the name in isolation. No behavior change suggested; a one-line comment at the definition (`execution-store.ts:48`) stating "worktree presence is irrelevant — only host attachment establishes worker progress" would pre-empt a future regression where someone "fixes" it to also check `worktreePath`.
- Carried over from round 1, still applicable, unchanged this round: `aggregateOutcomes` duplicate-runId collapse via `Map` last-write-wins (`outcomes.ts:166-172`); minor error-message wording inconsistency between `usage-service.ts` and `outcomes.ts`; Todos `localHistory` O(n log n) eviction (`provider.ts:161-165`). No code changed in these files since round 1 (confirmed via `git diff ec3dd6b..HEAD` file list); re-listing for completeness only, not re-verified line-by-line this round since there is zero diff to re-check against.

## Gaps / limitations

- Did not build or run the full distribution/installed-browser artifact (out of scope for this reviewer per instructions; root owns that build).
- Did not fuzz the Jira REST mock surface (rate-limit/5xx/partial-body responses) beyond what the existing `task-source-runtime.test.ts` fixture already exercises (`loseAssignResponse`, disabled-instance mid-flight, planner-rejection paths) — those existing tests already cover the "remote effect uncertain/lost" cases directly relevant to my assignment, and I did not find an untested variant worth adding given the DB-level unique-index and lease-fencing guarantees verified above.
- Did not re-derive the campaign-scheduling/contact/task-view/pricing math from scratch this round since those files have zero diff since my clean round-1 review; I verified via `git diff --stat` rather than re-reading every line, which I'm treating as sufficient given the explicit "no changes" evidence, but flagging it as a scope trade-off rather than claiming a fresh full re-read.

_Helmsman · Claude Sonnet 5 - medium_
