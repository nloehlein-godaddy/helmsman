# Second adversarial architecture review

Reviewed exact HEAD `e3ccca4d6b31db70974f4c8e70784e491768d9c8`, fixes since `ec3dd6b544cba1f796c353134dc4af0437cf40a8`, and the current architecture introduced throughout A–G since `e471d86630d78f2285611e81256ff912e5f57d0e`. **Two new execution-proven P2 findings. R06, R07, R08 and R09 passed the focused adversarial checks below.** Neither new finding is a restatement of those four fixed defects.

All production code remained unchanged. The assigned detached worktree is clean. No commits, pushes, real external provider requests, credentials, native terminal interactions, model jobs or user runtime access occurred. Installed execution used the root reviewer's freshly built release; all author projects, probes, copied installed fixtures and evidence were confined to the assigned probe directory. Owned test processes and servers were stopped in `finally` blocks.

## Confirmed findings

### ARCH2-1 — P2: shutdown can exit before an already-running plugin cleanup finishes

**Primary location:** `server/helmsman/plugins/backend.ts:231` and `:233`; asynchronous callbacks run at `:247–249`. Runtime shutdown awaits those cleanup functions at `:493`, then `server/helmsman/application.ts:1661` exits the process. The runtime's own concurrent-dispose guard at `backend.ts:490` has the same early-resolution pattern.

**Reachable trigger:** disable an active external backend, allow the coordinator's live-disable listener to begin its asynchronous `onDispose` callback, then stop/restart Helmsman before that callback finishes. The CLI can report disablement before the running server's polling listener has completed cleanup, so disable followed by a service restart is a realistic operator sequence.

The per-plugin cleanup marks `phase = 'disposed'` before awaiting registered callbacks. A simultaneous `backendRuntime.dispose()` calls that same cleanup, sees the phase and immediately returns. It therefore treats an in-progress cleanup as completed. The application SIGTERM handler exits when the runtime's dispose promise resolves, terminating the first cleanup.

**Actual installed-app reproduction:** an inert, valid external pricing plugin registered a cleanup that writes a start marker, waits 1,200 ms and writes a finish marker. Both files were inside the disposable fixture. Normal SIGTERM waited **1,235 ms** and the finish marker existed. In the second run, the real compiled CLI disabled the plugin; the probe waited for the app's start marker, then stopped the app. Shutdown completed in **25 ms**, and the finish marker was still absent after another 1,300 ms. The source-denied installed fixture's external-command log was empty. This establishes actual callback truncation by the real application shutdown, rather than only early promise resolution in a mocked runtime.

**Expected:** every caller awaiting disposal joins the same in-progress cleanup and waits for completion or the documented timeout. Immediate signal/provider invalidation can remain synchronous.

**Impact:** valid plugins lose their promised asynchronous resource cleanup or final flush on a normal disable/restart overlap. The reproduced loss is a cleanup marker; no particular production integration data loss or surviving external process is claimed. Existing shipped packages generally do not register these callbacks, but the public author contract explicitly supports asynchronous `onDispose`.

**Minimal fix direction:** memoize and return a cleanup promise per activation, and a shutdown promise per runtime; do not use a completed/invalidated phase as evidence that asynchronous teardown has finished. Apply the same pattern to retained-session disposers as a consistency improvement, with focused concurrent-disposal coverage.

**History:** the early phase guard and application exit-on-dispose behavior date to Phase B (`8f3d11b2`); live coordinator disablement was added in Phase C. The failure remains in the final inherited code.

**Evidence:** `probes/codex_architecture/installed-cleanup-race.mts` and `installed-cleanup-race.log`.

**Reproduction from the assigned worktree:**

```sh
TMPDIR=/private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/codex_architecture node --import tsx /private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/codex_architecture/installed-cleanup-race.mts
```

### ARCH2-2 — P2: a concurrent enable can be silently overwritten by package replacement

**Primary location:** `server/helmsman/plugins/store.ts:321–323`. The optimistic disabled check is at `:73–79`; the corresponding check is correctly repeated for the uncoordinated path at `:90–92`. `server/helmsman/plugins/lifecycle.ts:145–147` blocks changing a loaded, active artifact but does not block changing an enabled artifact whose runtime health is inactive.

**Reachable interleaving:**

1. V1 is installed and disabled; no server is running, so runtime health is inactive.
2. A V2 install passes the initial catalog check and begins asynchronous archive publication.
3. Another CLI/coordinator connection enables V1 and reports success.
4. The original install enters the authoritative transaction, reads the now-enabled lifecycle row, and applies V2 with `desiredEnabled: false` without checking that V1 remained disabled.

Both commands succeed; final state is V2 disabled. This violates the replacement operation's stated prerequisite to disable the existing package first and loses the successful enable transition. Installing after enable has already completed correctly rejects, so the result specifically depends on the missing check at commit time.

**Reproduction:** the fresh distribution's actual `installPlugin` wrapper and two real SQLite persistence/coordinator connections share an isolated store. A real filesystem watcher fires when replacement archive staging begins, which places enablement after the wrapper's disabled check and before lifecycle commit. The observed event order is `replacement publication started`, `enable v1 reported success`, `install v2 reported success`; catalog and lifecycle both select V2 disabled. An already-enabled control rejects V3 with `Disable the plugin before installing another version`. No production source mocks, database triggers, invalid packages or archive tampering are involved.

**Expected:** recheck authoritative desired enablement under the install transaction before switching hashes, or enforce the original revision/disabled precondition. If enable wins, replacement must conflict instead of clearing it. Identical-hash reinstall should still preserve enablement.

**Impact:** concurrent operator/automation lifecycle commands can silently replace the just-enabled artifact and leave the selected provider unavailable after restart. No running-work loss is demonstrated; the existing health and pin checks still limit replacement of a loaded or retained artifact.

**Minimal fix direction:** add the desired-enabled precondition to coordinated replacement under the same persistence lock as selection, with a two-connection install/enable race regression. Preserve the existing same-hash fast path, active-health checks and execution pins.

**History:** introduced by the coordinated installation path in Phase C (`200c57b4`), unchanged by R06–R09.

**Evidence:** `probes/codex_architecture/install-enable-race.mjs` and `install-enable-race.log`.

```sh
node /private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/codex_architecture/install-enable-race.mjs
```

## Adversarial verification of prior fixes

| Fix | Fresh-release probe and actual result |
|---|---|
| R06: pending projections protect artifact GC | `projection-and-safe-start.mjs`: inject plugin-data projection failure, disable V1, install V2, and attempt V1 GC through three fresh CLI coordinator lifetimes. All three reject; original bytes remain. Remove only the fault, enable V2, then collect V1 successfully. Pending intents are empty and no artifact restoration is needed. |
| R07: stable ESM identity and independent sessions | `retained-sessions.mjs`: 116 retained activations in addition to an ordinary activation, eight concurrent sessions per wave, different captured settings, delayed cleanup, overlapping acquisition and release, and 32 additional materialization races. Exactly one module evaluation; 117 cleanup calls; ordinary and retained settings remain separate. After forced GC, array-buffer change was 729,088 bytes, below the 2 MiB bound rather than proportional to activations. Runtime directories are empty after final release. |
| R08: safe-start slot validation | `projection-and-safe-start.mjs`: all **19** supported slots survive read-only HTTP catalog/recovery reads with unchanged catalog hash and intact installed-plugin diagnostics. An unknown slot is rejected without mutation. POST remains blocked. |
| R09: retained Node compatibility | `closure-matrix.mjs`: agent, execution-host, native-terminal and workflow loaders each reject both old-only and future-only ranges, directly and through incompatible dependencies in either closure order. **24** incompatible cases reject before module evaluation; four compatible control artifacts reach their deliberate evaluation marker/error. |

`retained-sessions.mjs` also rejects missing and cyclic closures and a pre-aborted load. A top-level-error artifact evaluated once across three retries, demonstrating stable cached failure rather than introducing fresh ESM identities. That process-lifetime error cache is explicitly documented in the current backend guide and is **not** reported as a defect. Existing author guidance correctly requires activation-local mutable state.

## Other executable controls

- `validation-negatives.mjs`: **13** archive/import controls passed against the fresh release: traversal, encoded traversal, duplicate files, missing entries, reserved namespace, unsupported SDK/dependency declarations, bare/escaping/computed/missing imports, browser Node imports, and a valid bundled local helper. This probe was replayed from the historical durable source against current code.
- `sdk-author.mjs`: two fresh projects copied only from the release (`scope-panel` and `flat-pricing`) compile with the distributed SDK and TypeScript. The compiler inventories contain no host application source imports. Both pack/install/enable through the compiled CLI. The page/panel metadata is present; the configured pricing provider returns $7 for one million unpriced tokens on two independent runtime activations, persists `last-rate = 7`, and leaves the supplied measured usage unchanged. This is author-build/runtime proof, not a new visual-rendering claim. Compiler inventories are retained as `compiler-scope-panel.log` and `compiler-flat-pricing.log`.
- `install-enable-race.mjs`: the non-racing enabled-install control rejects, limiting ARCH2-2 to the missing authoritative recheck.
- `installed-cleanup-race.mts`: ordinary shutdown waits for the same cleanup, limiting ARCH2-1 to overlapping disposal. The initial probe used a `.ts` entry outside an ESM package and was rejected by tsx before execution; changing the probe extension to `.mts` corrected this fixture issue. No application change was needed.

All final probe commands exited successfully with assertion-based evidence. The application/distribution build and full unit suite were left to the root reviewer; this reviewer did not run another aggregate gate.

Additional replay commands:

```sh
node --expose-gc /private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/codex_architecture/retained-sessions.mjs
node /private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/codex_architecture/projection-and-safe-start.mjs
node /private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/codex_architecture/closure-matrix.mjs
node /private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/codex_architecture/sdk-author.mjs
node /private/tmp/helmsman-adversarial2-20260921-e3ccca4/probes/codex_architecture/validation-negatives.mjs
```

## Coverage, negative conclusions and gaps

Read repository instructions, architecture/lifecycle plan sections, A–G implementation ledger and final limitations, prior architecture/consolidated reports, fix ledger, package/backend/SDK compatibility/quickstart guides and relevant source tests. Inspected history from the A foundations through B backend composition, C lifecycle/persistence, D/E provider and page extraction, F retained providers and G distribution/SDK stabilization, then reviewed the exact final implementation. Relevant checkpoints include `768c21b`, `2e8d8ff`, `8f3d11b`, `200c57b`, `2e9bd57`, `a1fb976`, `a8baf84`, `615a077`, `7a5450c`, `568cd82`, `2b10ce0`, `59f8b76` and the R06–R09 fix `228b7e6`. Git blame establishes both new findings predate the fix series.

Inspected archive publication/read/packing, import graphs, package/manifest validation, frontend registry/modules/catalog selection, backend activation/publication/storage/disposal, lifecycle coordinator projections and GC, checkpoint migration APIs, retained closure loaders/provider records, application lifecycle and communication retained-session reachability, safe-start diagnostics, distribution building and SDK packaging. Cross-domain run execution and integration publication semantics remain other reviewers' lanes.

No Node compatibility bypass was established. Pending projection hashes now block collection inside the transaction; archive installation still checks that published bytes exist under that same authority before selecting them. Retained sessions share code without cross-contaminating correctly activation-local settings. Missing explicit selections remain unavailable, which is intended. General package dependency resolution and semver negotiation are explicitly out of v1 scope, and trusted plugin execution is not a sandbox claim.

Secondary, **unconfirmed/static-only** improvement ideas:

- Before exposing checkpoint migration as an operator route, couple migration-target byte availability to GC/pinning. `migrateCheckpoint` checks registered metadata, while collection leaves artifact metadata registered; a future caller could otherwise target collected bytes. Current production callers/registered migration validators were not found beyond tests, so this was not promoted as a reachable defect.
- The coordinated enable path delegates directly to `coordinator.change`, unlike the uncoordinated path's Node/import checks. Actual evaluation still fails closed through snapshot/backend/retained compatibility checks. Align CLI enable validation with the guide's stated early rejection for clearer operator diagnostics; no incompatible execution was found here.

Limits: macOS arm64 / Node 24.17.0 only. No multi-Node process upgrade, Linux/Windows process teardown, real terminal/provider cleanup, filesystem power-loss testing, exhaustive migration matrix, every frontend mount race, or independent visual/browser rendering was executed in this lane. SDK structural compatibility's broader gate is root-owned. The review inspected risk-selected historical changes and current implementations, not every changed line across A–G.

_Helmsman · gpt-6-astra - high_
