# Adversarial architecture review

Reviewed exact `ec3dd6b544cba1f796c353134dc4af0437cf40a8`, including aggregate changes from `e471d86630d78f2285611e81256ff912e5f57d0e` and the complete current implementation of the assigned plugin loading/lifecycle/SDK boundaries. Four confirmed P2 findings; no confirmed P0/P1 in this review lane. No production files, dependencies, credentials, commits, remote services or live application data were changed. The reviewer worktree remains clean.

All runnable evidence below uses the root reviewer's fresh distribution at `/private/tmp/helmsman-adversarial-20260921-ec3dd6b/integration/release`. Reproduction scripts, logs and isolated SQLite/artifact fixtures are retained under `/private/tmp/helmsman-adversarial-20260921-ec3dd6b/probes/codex_architecture`. These are assertion-based adversarial probes, not production fixes.

## Confirmed findings

### ARCH-1 — P2: artifact collection can delete bytes still required by a pending lifecycle projection

**Location:** `server/helmsman/plugins/lifecycle.ts:244` (`canCollect`), `server/helmsman/plugins/store.ts:356` (`collect`). Supporting paths: `store.ts:289` rereads the artifact before replaying a projection; `store.ts:307` denies activation while any intent for the plugin remains pending; `store.ts:367` records bootstrap reconciliation failures without preventing subsequent CLI operations.

**Trigger:** an installation has an unresolved projection failure across disablement and replacement installation, and the operator collects the previous hash. This is specifically an incomplete projection/recovery case, not a settled ordinary uninstall.

The collector checks the currently selected artifact and execution pins but does not treat unacknowledged persistence intents as references. The authoritative lifecycle and catalog can already select v2 while an older v1 projection still needs v1's archive. Collection then reports success and deletes v1. Even after the original storage fault is repaired, reconciliation fails with `ENOENT` before it can acknowledge the older intent. Enabling v2 leaves the catalog enabled but `canActivate` false. Restoring only the collected bytes repairs the failure.

**Exact CLI-level reproduction:** `lifecycle-gc-cli.mjs` calls the compiled `pluginCommand` with explicit isolated `--dir` and `--db`. It installs v1; injects a SQLite trigger that makes plugin-data projection INSERTs fail; disables v1 (error after catalog commit); installs v2 (same projection error, new catalog hash committed); runs `collect <v1Hash>` successfully; removes the injected fault; and runs `enable <id>`, which continues failing on the missing v1 archive. It asserts that only the old revision-2 intent remains, republishes only v1's original bytes and proves enablement then succeeds. The trigger models a persistent projection-write failure; the observed irreversible dependency loss is caused by collection, not by the injected failure remaining active. `lifecycle-gc.mjs` independently reproduces the same state using the existing projection crash hook.

**Expected:** retain hashes referenced by pending intents under the same lock as collection, or durably supersede/settle those intents before allowing collection. A recoverable secondary-store fault must not become unrecoverable through a successful GC command.

**Evidence:** `lifecycle-gc-cli.log` and `lifecycle-gc.log`; both scripts exit 0. The code was introduced in Phase C (`200c57b4`).

### ARCH-2 — P2: retained external-provider loads permanently accumulate distinct ESM modules

**Location:** `server/helmsman/plugins/materialize.ts:9` and `:16`; external import at `server/helmsman/native-terminal-retained-loader.ts:80`. The same materializer is used by agent, execution-host and workflow retained loaders.

Every load of the same artifact uses `mkdtemp`, so every `import(materialized.href)` has a new URL. Node retains each distinct ESM module in its module map. `dispose` removes the files and invokes registered instance cleanup, but it cannot evict these module records or their immutable module-level data.

This happens on a repeated production path, not just an operator repeatedly restarting plugins: `communication-provider-effects.ts:196` creates a retained session for each delivery/reconciliation invocation, and `communication-runtime.ts:77` loads its external native/browser provider each time. Each invocation disposes the session in a `finally`, but the module instance remains in the long-running server. Larger bundles or ordinary module-scoped immutable lookup data amplify the leak.

**Reproduction:** `retained-loader.mjs` creates a valid external native/browser provider with a 1 MiB immutable module-level typed-array lookup table. It loads and disposes the same artifact 64 times, drops returned instances and explicitly performs GC. The module evaluation counter increases by 64; retained `arrayBuffers` increases by **67,116,848 bytes**; the runtime directory is empty. Thus filesystem cleanup succeeds while memory remains proportional to invocation count.

**Expected:** repeated activations of identical immutable code should not create an unbounded number of permanently cached module identities. Stable artifact module URLs with appropriately separate activation contexts, or an unloadable execution boundary, need an explicit lifecycle strategy.

**Evidence:** `retained-loader.log`; `node --expose-gc .../retained-loader.mjs` exits 0. The probe uses local inert methods and performs no terminal/browser action. This proves accumulation and a repeatable production call site, not a measured production OOM threshold. Materialization was factored in during agent extraction (`a8baf84c`); native retained loading was added by `7a5450c7`.

### ARCH-3 — P2: safe start treats valid non-Costs page bindings as corrupt metadata

**Location:** `server/helmsman/safe-start.ts:75`.

`readPlugins` accepts only `COSTS_PAGE_SLOT`, although the normal catalog and CLI support the full shipped slot list. Persisting a valid Helm, Runs, Todos or another non-Costs selection makes the entire read throw. The read-only fallback returns no installed plugins and no bindings; `/api/recovery` reports a generic metadata-read error. `/api/plugins/catalog` also loses all selected bindings in its response. This breaks the dedicated recovery view for otherwise valid installations that use the extension mechanism.

**Reproduction:** `safe-start-catalog.mjs` installs an inert external page and explicitly selects it for Costs. An isolated safe-start HTTP server correctly lists the installed plugin. The probe then uses the production selection function to persist the valid shipped `helmsman/helm-page -> helmsman.helm/page` binding. A fresh safe-start server returns `plugins: []`, the metadata error and an empty binding object. A normal catalog read confirms the original records are intact. The fixture main database and frontend directory are deliberately absent, so those unrelated conditions are identical for both control and failing requests.

**Expected:** validate supported slots using the current slot registry, while preserving the safe-start read-only/no-provider-execution guarantees. Valid selection metadata must not suppress the entire installed-plugin diagnostic list.

**Evidence:** `safe-start-catalog.log`; script exits 0 and closes its owned ephemeral server. No stored data was deleted. The hard-coded validation dates to Phase A (`2e8d8ffb`) and was not expanded with the subsequent slot migrations.

### ARCH-4 — P2: retained external-provider loading omits the declared Node compatibility check

**Location:** `server/helmsman/native-terminal-retained-loader.ts:41` and `:80`; duplicated external closure/import logic in `agent-retained-loader.ts`, `execution-host-retained-loader.ts` and `workflow-retained-loader.ts`. Contrast ordinary checks in `plugins/store.ts:68` and `plugins/backend.ts:274`.

Retained loading verifies archive integrity, package identity, imports, settings and metadata, then evaluates external code without comparing `pkg.node` to the current Node major. Parsing the descriptor only validates that its bounds are well formed. A retained native/browser artifact from a previously supported runtime can therefore execute after a Node upgrade even though ordinary activation rejects it. Communication reconciliation reaches this loader through `communication-runtime.ts:77`; its external-artifact verification at `application.ts:571` checks identity and hashes but also does not enforce the Node range.

**Reproduction:** on Node 24.17.0, `retained-loader.mjs` stages a valid external browser artifact declaring `minMajor: 23, maxMajorExclusive: 24`, representing a retained artifact copied forward from the earlier supported runtime. Ordinary backend activation rejects it with `Backend Node version is incompatible` before module evaluation. The retained loader then evaluates exactly the same bytes, activates the provider and successfully calls `sessionIdentity`. Both paths and the top-level evaluation counter are asserted.

**Expected:** apply runtime compatibility checks before evaluating retained external code and report a blocked recovery reason for unsupported runtimes. Retention is not permission to disregard the author's runtime range.

**Limits:** the probe deliberately stages an archive as pre-existing retained storage; it does not claim normal installation on Node 24 accepts the Node-23-only artifact. Built-in retained runtimes independently enforce Node major/ABI in `verifyLegacyRuntime`; execution flows whose entire artifact closure includes an incompatible built-in runtime can consequently block earlier. The relevant unguarded case is an external-only retained closure, including independently replaceable communication/browser providers. No multi-Node process migration was performed.

**Evidence:** `retained-loader.log`; same passing script as ARCH-2. External retained loader logic was introduced across F, including `7a5450c7` for native/browser providers.

## Reproducible commands and verification

Run from any directory; every script derives its own fixture paths and uses explicit temporary state:

```sh
node /private/tmp/helmsman-adversarial-20260921-ec3dd6b/probes/codex_architecture/lifecycle-gc-cli.mjs
node /private/tmp/helmsman-adversarial-20260921-ec3dd6b/probes/codex_architecture/lifecycle-gc.mjs
node --expose-gc /private/tmp/helmsman-adversarial-20260921-ec3dd6b/probes/codex_architecture/retained-loader.mjs
node /private/tmp/helmsman-adversarial-20260921-ec3dd6b/probes/codex_architecture/safe-start-catalog.mjs
node /private/tmp/helmsman-adversarial-20260921-ec3dd6b/probes/codex_architecture/validation-negatives.mjs
node /private/tmp/helmsman-adversarial-20260921-ec3dd6b/probes/codex_architecture/sdk-author.mjs
```

All final commands exited 0. Matching `.log` files retain the observed output. An initial safe-start fixture attempted to bind a manifest-1 page to Helm and was correctly rejected because Helm requires its composition contract; the final probe uses the valid built-in Helm contribution.

The 13 archive/import controls independently confirmed rejection of traversal, encoded traversal, duplicate files, missing entries, reserved namespaces, unsupported SDK versions, unsupported dependency fields, bare imports, escaping imports, computed dynamic imports, browser Node built-ins and missing relative modules. A valid bundled local helper was accepted.

`sdk-author.mjs` copies the release's manifest-2 scope-panel author project into a fresh external directory, supplies only the distributed SDK and the existing read-only TypeScript compiler, compiles it, then uses the compiled CLI to pack/install/enable it. Catalog validation confirms one page and one panel. The compiler file inventory contains no host `src/` imports and is retained in the fixture's `compiler-files.log`. No dependency installation occurred. This is a build/installation proof; this reviewer did not claim a new browser rendering or visual proof.

## Review coverage, disproof and limitations

Read the repository instructions, architecture plan, complete phase inventory/status and final acceptance limitations in the delivery ledger/remaining plan; package, backend, quickstart, SDK compatibility, distribution and relevant provider author contracts. Reviewed the all-phase history/log and aggregate file additions, then traced the current implementations instead of relying on prior acceptance. Relevant historical checkpoints include A (`768c21b`, `2e8d8ff`), B (`8f3d11b`), C (`200c57b`, `2e9bd57`), composition (`a1fb976`), F (`a8baf84`, `615a077`, `7a5450c`, `568cd82`, `2b10ce0`) and G (`59f8b76`). `git blame` located the findings' introduction; the inspected code remains present at exact `ec3dd6b`.

Reviewed `src/plugins/{manifest,package,registry,runtime,modules,panels,page-host,panel-host,sdk,backend,frontend-manifests}.ts`; archive/import validation, installation/catalog/data/coordinator/lifecycle/activation/materialization/HTTP/CLI code under `server/helmsman/plugins`; safe-start selection and read-only recovery; retained agent/host/native/workflow loaders and their provider registries; application artifact/activation wiring; communication retained-session call sites; distribution/SDK build and compatibility scripts; related tests and examples. Deep domain execution/publication semantics are assigned to other reviewers and were followed only where needed to establish lifecycle reachability.

An initial concern that disabling a provider aborts every in-memory obligation method was not promoted: actual run execution and browser recovery use separate retained loaders with their own lifetimes. Explicit missing selections and manifest/import rejection of unsupported dependencies are documented fail-closed v1 behavior, not installation-order fallback. The current ledger explicitly documents self-contained packages and lack of general dependency/semver negotiation; those limitations were not presented as undisclosed implementation bugs. Trusted plugin execution itself was not treated as a sandbox vulnerability.

No aggregate test suite or host build was rerun by this reviewer; the root reviewer owns the fresh build and aggregate checks. No real providers, native terminals, credentials, `.env`, remote publication or live data were accessed. The focused probes do not exhaust filesystem power-loss behavior, every frontend mount race, OS/Node variants or malicious same-context plugin behavior. No further unconfirmed risk is promoted to a finding.

_Helmsman · gpt-6-astra - high_
