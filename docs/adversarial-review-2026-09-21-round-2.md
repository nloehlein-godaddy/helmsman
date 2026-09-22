# Adversarial review — second pass, 2026-09-21

Subsequent implementation and verification are recorded in the [second fix ledger](adversarial-fixes-2026-09-21-round-2.md). This report retains the audited snapshot and original findings.

**Seven confirmed findings: two P1, four P2, one P3. No P0.** The application builds and its baseline tests pass, but startup can delete unrelated developer work, and an accepted historical execution-host package can produce false staged-completion evidence. Address those two findings before treating the current snapshot as ready for unrestricted use.

Reviewed `e3ccca4d6b31db70974f4c8e70784e491768d9c8` on `fix/adversarial-review-2026-09-21`: the fixes since the [first review](adversarial-review-2026-09-21.md) at `ec3dd6b544cba1f796c353134dc4af0437cf40a8`, A–G history since `e471d86630d78f2285611e81256ff912e5f57d0e`, and inherited current code. The rewrite range comprises **85 commits, 1,401 changed files, 103,230 insertions and 18,645 deletions**. Reviewers investigated risk-selected histories and current implementations; this is not a claim that every changed line or possible interleaving was exhaustively checked.

All six primary reviewers finished before this report was assembled. This pass changes documentation and preserves evidence; **none of the findings below has been fixed by this review**. The [previous fix ledger](adversarial-fixes-2026-09-21.md) remains a historical record of its tested paths.

## Independent reviewers and method

| Reviewer | Actual model / configured effort | Distinct focus | Report |
|---|---|---|---|
| Codex architecture | `gpt-6-astra` / high | Package/SDK contracts, author projects, lifecycle/concurrency, projections, GC, retained loaders, safe start | [Architecture](adversarial-review-2026-09-21-round-2/reviewers/codex-architecture.md) |
| Codex execution | `gpt-6-astra` / high | Admission, leases, claims, recovery, Git ownership, process supervision, hosts, staged workflows, retry cost | [Execution](adversarial-review-2026-09-21-round-2/reviewers/codex-execution.md) |
| Codex UI | `gpt-5.6-sol` / high | Installed Chromium, scope, canonical identities, keyboard/mobile, replacement, lost responses and drafts | [UI](adversarial-review-2026-09-21-round-2/reviewers/codex-ui.md) |
| Claude security | `claude-opus-4-8` / high | HTTP authority, request origin, webhook exemption, gateways, credentials, file/command boundaries | [Security](adversarial-review-2026-09-21-round-2/reviewers/claude-security.md) |
| Claude domain/data | `claude-sonnet-5` / high | Jira/Todos claims, journals, never-launched settlement, restart, source/operation ownership | [Domain/data](adversarial-review-2026-09-21-round-2/reviewers/claude-sources.md) |
| Claude integrations | `claude-opus-4-8` / high | GitHub/Slack, remote effects, pagination/reconciliation, actor/head identity, webhook and clarification gates | [Integrations](adversarial-review-2026-09-21-round-2/reviewers/claude-integrations.md) |

An additional [current-code domain follow-up](adversarial-review-2026-09-21-round-2/reviewers/domain-followup.md) re-read unchanged campaign/scheduling, contacts, task-view and pricing/accounting code that the primary domain reviewer had carried forward from round one. Focused real-store and injected-boundary probes passed; no additional defect was confirmed.

The Claude lanes ran actual Claude CLI processes with distinct prompts, not Codex agents impersonating Claude. Each lane used its own detached worktree at the same SHA. The root built one fresh distribution and ran one full unit gate. Reviewers used temporary databases, real local Git/process fixtures, mocked remote services and copied installed releases. No user demo, credentials, live integrations, application-managed model jobs, native terminal or Docker engine was exercised. Root independently replayed the six P1/P2 findings; the startup deletion was additionally reproduced through the compiled application's actual startup.

[Evidence index and reproduction notes](adversarial-review-2026-09-21-round-2/README.md) · [Metadata](adversarial-review-2026-09-21-round-2/metadata.json)

## Confirmed findings

| ID | Severity | Finding | Relationship to previous work |
|---|---|---|---|
| RR01 | P1 | Startup force-deletes unrelated dirty `.worktrees` checkouts | Inherited cleanup path outside the corrected R01 rerun helper |
| RR02 | P1 | Accepted historical host package drops staged-supervision metadata | Compatibility gap in R04's new acknowledgement protocol |
| RR03 | P2 | Final-output cost does not stop additional retries | Phase C durable-runner defect |
| RR04 | P2 | Disable/shutdown overlap terminates asynchronous plugin cleanup | Existing lifecycle concurrency defect |
| RR05 | P2 | Package replacement overwrites a concurrent successful enable | Existing coordinated-install race |
| RR06 | P2 | Landed GitHub review cannot reconcile after head/state changes | Existing precheck plus R10 postcheck conflate send and reconciliation preconditions |
| RR07 | P3 | Malformed JSON silently disables legacy automatic starts | Authorized malformed-client correctness defect; no CSRF bypass |

### RR01 — P1: startup deletes unrelated dirty developer checkouts

**Locations:** [worktree.ts](../server/helmsman/worktree.ts):60, 76, 111–114; [application.ts](../server/helmsman/application.ts):1080–1086; [execution-store.ts](../server/helmsman/execution-store.ts):561–576.

`listAgentWorktrees` assumes any registered path containing `/.worktrees/` belongs to Helmsman. Startup takes the basename as a run ID; missing execution/run records allow cleanup. `removeWorktreeAt` then invokes `git worktree remove --force`.

**Reproduction and impact:** an inspected galleon has a linked checkout at `developer/.worktrees/personal-feature`, outside `AGENTS_ROOT`, with unsaved tracked edits and a unique untracked file. Starting the compiled application deletes that checkout and both files. A dirty sibling checkout without the marker survives. No run record exists for the deleted checkout. This is loss of developer work during ordinary startup; the corrected rerun path does not protect this separate caller.

**Fix direction:** require a retained ownership record binding the exact canonical workspace and galleon, plus settled cleanup eligibility. Preserve unknown and dirty work. Reuse the guarded Local Git cleanup policy; restricting the pathname or checking only for an absent reservation is insufficient.

[Compiled-startup evidence](adversarial-review-2026-09-21-round-2/evidence/root/startup-sweep.json) · [Root probe](adversarial-review-2026-09-21-round-2/evidence/root/review-startup-sweep.ts.txt) · [Agent probe](adversarial-review-2026-09-21-round-2/evidence/codex_execution/adversarial2-execution.audit.test.ts.txt)

### RR02 — P1: a supported older host can fabricate staged completion

**Locations:** [run-wrapper.mjs](../server/helmsman/run-wrapper.mjs):21, 37–41, 88, 112–117; [execution-host-execution.ts](../server/helmsman/execution-host-execution.ts):62–63; [execution-host.ts](../src/plugins/execution-host.ts):78–84.

Core passes `coordinator: true` for staged workflows; the current wrapper newly relies on its serialization. The historical local-host author package at `ec3dd6b` omits that field when serializing the wrapper specification. It remains accepted under `helmsman/execution-host@1`; the current wrapper interprets the omission as ordinary direct execution and accepts numeric coordinator exit without stage-cleanup acknowledgement.

**Reproduction:** build the historical descriptor/backend/provider with its normal SDK bundling, changing only the reserved namespace for external installation. Current compiled CLI pack/install/enable/select operations and normal activation/admission-selection checks accept it. The current adapter and retained provider launch a fixture coordinator that starts a separate bounded stage group and then crashes. The wrapper writes a matching exit-1 receipt while the stage is still writing. The current-provider control withholds the receipt and reports unknown; an ordinary direct-worker control exits successfully.

**Impact:** completion evidence can authorize capacity release or workspace/finalization effects while staged work remains active. This concerns new runs with an accepted older external package. Normal recovery of a mismatched historical core runtime already fails closed and is not this finding. Public package acceptance and real adapter/provider/wrapper execution were proven separately; a complete HTTP new-run flow was not staged.

**Fix direction:** version or negotiate supervision compatibility, or keep coordinator classification in a core-owned protocol the provider cannot accidentally omit. Reject incompatible new staged admissions before launch; preserve existing retained-run identities. Add a historical installed-package regression.

[Historical public selection](adversarial-review-2026-09-21-round-2/evidence/codex_execution/historical-host-public-selection.json) · [Failing historical provider](adversarial-review-2026-09-21-round-2/evidence/codex_execution/coordinator-provider-old.json) · [Current-provider control](adversarial-review-2026-09-21-round-2/evidence/codex_execution/coordinator-provider-new.json)

### RR03 — P2: retries continue after final reported cost exceeds the cap

**Locations:** [runner.ts](../server/helmsman/runner.ts):648–654, 758.

The terminal-receipt branch drains and records final output, then returns the previously calculated `capped` flag. The budget calculation sits below that return. The retry loop trusts the stale flag.

**Reproduction:** with actual SQLite execution stores and production usage/telemetry, matching fake-host receipts simulate failed direct-workflow attempts. The run has `maxCostUsd=0.5`, three allowed attempts, and each failed worker reports `$0.75` in its final output. Attempts two and three launch with already-recorded costs of `$0.75` and `$1.50`; final cost is `$2.25`. The no-cap control correctly uses three attempts.

**Impact:** new model work is launched after the application knows the cap has been exceeded. This is separate from unavoidable overshoot before delayed usage arrives. Accounting is correct; retry enforcement is not.

**Fix direction:** recompute the cap after draining terminal output and check current persisted cost before another attempt launches. Preserve uncapped behavior and existing execution outcomes.

[Capped evidence](adversarial-review-2026-09-21-round-2/evidence/codex_execution/terminal-cost-capped.json) · [Uncapped control](adversarial-review-2026-09-21-round-2/evidence/codex_execution/terminal-cost-uncapped.json) · [Independent confirmation](adversarial-review-2026-09-21-round-2/evidence/root/root-terminal-cost.log)

### RR04 — P2: overlapping disposal truncates plugin cleanup

**Locations:** [plugins/backend.ts](../server/helmsman/plugins/backend.ts):231–249, 490–493; [application.ts](../server/helmsman/application.ts):1661.

Cleanup marks the activation disposed before awaiting its asynchronous callbacks. A simultaneous runtime shutdown calls cleanup again, sees disposed, and returns immediately. Application shutdown then exits while the original callback is still running. The runtime's own concurrent-dispose guard has the same early-resolution pattern.

**Reproduction:** an installed external pricing plugin registers a callback that writes a start marker, waits 1,200 ms, then writes a finish marker. Ordinary compiled-app shutdown waits about 1.24 seconds and completes the callback. Disable through the compiled CLI, wait for the callback to begin, then send SIGTERM: root reproduction exits in 21 ms and the finish marker never appears.

**Impact:** supported asynchronous teardown is cut short on a normal disable/restart overlap. Callback truncation is proven; loss of particular production integration data is not.

**Fix direction:** share an in-progress cleanup promise per activation and shutdown promise per runtime. Immediate invalidation must not be mistaken for completed asynchronous cleanup.

[Probe](adversarial-review-2026-09-21-round-2/evidence/codex_architecture/installed-cleanup-race.mts.txt) · [Independent confirmation](adversarial-review-2026-09-21-round-2/evidence/root/root-cleanup-race.log)

### RR05 — P2: replacement loses a concurrent enable

**Locations:** [plugins/store.ts](../server/helmsman/plugins/store.ts):73–81, 321–323; [plugins/lifecycle.ts](../server/helmsman/plugins/lifecycle.ts):145–147.

Replacement checks that the old package is disabled before asynchronous archive publication. Its coordinated commit reads the latest lifecycle revision but never rechecks `desiredEnabled`, then selects the replacement disabled.

**Reproduction:** two real SQLite coordinator connections share a store with inactive, disabled V1. Start V2 replacement; observe archive staging through a filesystem watcher; enable V1 through the other connection before replacement commits. Both operations report success, but final state is V2 disabled. An already-enabled, non-racing replacement correctly rejects.

**Impact:** an acknowledged enable transition is silently overwritten. No active worker interruption or data loss was demonstrated.

**Fix direction:** recheck authoritative desired state and the intended revision within the installation transaction. A conflicting enable must produce a retryable conflict rather than silently changing its result.

[Probe](adversarial-review-2026-09-21-round-2/evidence/codex_architecture/install-enable-race.mjs.txt) · [Independent confirmation](adversarial-review-2026-09-21-round-2/evidence/root/root-install-enable-race.log)

### RR06 — P2: a proven delivered review stays in recovery after PR changes

**Locations:** [github/provider.ts](../src/plugins/github/provider.ts):177–183, 282–300.

`reconcileReview` applies `prepared()` before and after reading receipts. That requires the PR to remain open, unmerged and at the original head. Those conditions govern whether to send a new review; they do not establish whether an earlier send succeeded.

**Reproduction:** a published review with the exact operation marker, expected body, original actor and original commit exists in complete history, but its acknowledgement was lost. With the current PR head unchanged, reconciliation acknowledges. Move the current head or merge/close the PR, leaving the same receipt available: reconciliation returns unknown, including on repetition. The provider-level three-case probe and independent replay pass. Durable downstream recovery behavior was traced, not crash-tested end to end.

**Impact:** a confirmable delivery remains `uncertain` / `recovery-required` and does not automatically recover. Manual `resolve-operation` can acknowledge it. No false acknowledgement or duplicate send was reproduced.

**Fix direction:** separate invocation preconditions from historical receipt verification. Preserve authorization and complete, unique actor/commit/body/operation evidence; do not reject that evidence solely because the current PR head/state changed. Keep head fencing for publication.

[Probe](adversarial-review-2026-09-21-round-2/evidence/claude_integrations/reconcile-head-recheck.test.ts.txt) · [Independent confirmation](adversarial-review-2026-09-21-round-2/evidence/root/root-github-reconcile.log)

### RR07 — P3: malformed JSON is interpreted as disable

**Locations:** [application.ts](../server/helmsman/application.ts):1457–1464; [router.ts](../server/helmsman/router.ts):426–431.

Enable legacy auto-claim for `org/a`, then submit raw `{` to `POST /api/repos/org%2Fa/auto-claim` with legitimate same-origin JSON headers. Parsing converts the error to null, and `body?.enabled === true` becomes false. The installed browser receives 200 and subsequent state shows auto-claim disabled. A malformed config request returns 400; cross-origin and text/plain mutations return 403.

**Impact and severity:** reversible, process-local scheduler disablement by a faulty/manual authorized client. No shipped malformed caller was found; the current automatic-start UI uses validated source-admin commands. This does not bypass R02 and does not prove persisted data loss or worker termination.

**Fix direction:** reject malformed JSON and require a boolean `enabled` without mutation. Preserve deliberately bodyless endpoints such as Stop. Update the README's legacy automatic-start routing description separately.

[Browser evidence](adversarial-review-2026-09-21-round-2/evidence/codex_ui/request-guard-browser-clients.json) · [Browser probe](adversarial-review-2026-09-21-round-2/evidence/codex_ui/codex-ui-second.pw.ts.txt)

## Previous findings rechecked

| Original finding | Second-pass disposition |
|---|---|
| R01 — destructive PR rerun | Corrected rerun helper preserves dirty/occupied checkouts. RR01 exposes a separate startup deletion path. |
| R02 — cross-origin mutation | Guard matrix (29), raw HTTP cases (8), installed Chromium rejection and valid-client checks pass. No new exploitable bypass confirmed. |
| R03 — never-launched capacity | Failure/restart/lease/immutable-outcome tests pass; uncertain claims remain protected. Two additional real-store domain probes pass. |
| R04 — premature process settlement | Current same-version wrapper/provider checks pass, including coordinator crash/acknowledgement. RR02 finds an older accepted-package compatibility gap. |
| R05 — cancelled retained parser | Final output drains after Stop using the retained lifetime; reservation/pin release and disposal checks pass. |
| R06 — pending projection GC | Three fresh CLI lifetimes refuse collection during injected projection failure; after reconciliation, old bytes collect normally. |
| R07 — ESM identity growth | 116 retained sessions plus ordinary activation, concurrent waves and 32 materialization races: one evaluation, 117 cleanups, isolated settings and bounded measured memory. |
| R08 — safe-start page slots | All 19 slots survive read-only safe-start; unknown binding rejected without mutation. |
| R09 — retained Node compatibility | Four loader types reject 24 incompatible direct/dependency cases before evaluation; four compatible controls reach evaluation. |
| R10 — GitHub pagination | Second-page matching, duplicate/malformed/failed/foreign pages, 20-page limit and cancellation pass. RR06 finds overly restrictive receipt preconditions. |
| R11 — duplicate panels | Full accessible identity, exact scoped action/removal and complete stack options pass. Visible duplicate titles remain a usability improvement. |
| R12 — same-key run selection | Canonical identities across galleons/shared-prefix IDs, keyboard selection/close, correct logs, navigation/reload and mobile wrapping pass. |

## Validation and coverage limits

- Fresh TypeScript, Vite and distribution build passed: [build log](adversarial-review-2026-09-21-round-2/evidence/root/current-build.log).
- Full baseline: **4,922 tests / 370 files passed**, 143.80 seconds: [unit log](adversarial-review-2026-09-21-round-2/evidence/root/baseline-unit.log). The canonical checkout avoids known symlinked-dependency fixture artifacts.
- **9/9 distribution checks passed**, including source-denied CLI, compiled workers, SDK authoring, guide links, durable source adoption and safe release replacement: [log](adversarial-review-2026-09-21-round-2/evidence/root/distribution-check.log).
- Execution lane: seven adversarial observations and 235 focused existing tests passed. Root replayed its five initial observations and two cost cases. These custom probes pass when the documented defect or negative control occurs; passing probes do not mean the product is defect-free.
- Architecture lane: two confirmed race probes, projection/restart/safe-start, retained-session/load compatibility, 13 archive/import controls, and two independent distributed-SDK author projects passed. Root replayed both lifecycle races.
- Domain lane: two new real-store probes and its two listed focused test batches passed. Captured batches contain 85 and 444 executions; counts overlap other gates and are not added to the baseline total. The follow-up independently exercised campaign dispatch/replay, scheduling races, task scope, contact commands and pricing numeric boundaries.
- Integrations: 21 existing GitHub tests and three new receipt cases passed; root replayed all three. Security: 29 guard and eight raw HTTP cases passed; deeper gateway/file/publication review was mostly static.
- **Five installed Chromium scenarios passed** in 2.1 minutes. Coverage includes all listed product routes, keyboard/mobile, duplicate identities, explicit scope, cross-tab layout convergence, external Costs replacement disable/re-enable/reset, malformed responses and lost Todo acknowledgement with a newer unsent draft. Screenshots: [mobile run labels](adversarial-review-2026-09-21-round-2/evidence/codex_ui/same-key-long-prefix-runs-mobile.png), [desktop run labels](adversarial-review-2026-09-21-round-2/evidence/codex_ui/same-key-long-prefix-runs-desktop.png), [Todo recovery](adversarial-review-2026-09-21-round-2/evidence/codex_ui/todo-lost-response-reconciled.png), [Recovery mobile](adversarial-review-2026-09-21-round-2/evidence/codex_ui/recovery-mobile.png). Root visually inspected representative screenshots.

Testing used macOS arm64, Node 24.17.0 and Chromium. No live GitHub/Jira/Slack, model usage, Docker, cmux/WezTerm, Windows/Linux process teardown, Firefox/WebKit or actual assistive-technology device was exercised. Real process probes used bounded owned fixture children. No power-loss simulation or exhaustive crash/lease/migration matrix was performed. Campaign, terminal, Local Git cleanup, PR publication and Recovery mutations were not driven through the UI; component/static/store coverage does not substitute for those live flows. Trusted plugin execution is deliberately not sandboxed.

Individual reviewer reports are preserved verbatim. This consolidated report controls severity and evidence interpretation: the security report's categorical assurances exceed its tested scope; absence of cookies does not itself eliminate loopback CSRF risk. The UI report's “durable mutation” wording for RR07 is too broad. Domain “cross-process” probing uses separate database connections in one process. Reviewer bylines can differ from launch metadata; actual Claude CLI configuration was high effort. See the evidence index for these adjudications and reproduction limits.

## Secondary improvements and future work

1. Add lifecycle/state-machine fault tests at public boundaries: older installed provider compatibility, concurrent disable/shutdown, replacement/enable conflict, final cost before retry and startup ownership. Keep broad builds centralized and rerun focused regressions during fixes.
2. Display a compact visible instance identity beside duplicate Helm titles. Existing accessible identity and canonical targeting already pass.
3. Recognize GitHub secondary-rate-limit 403 responses and `Retry-After`. Verify actual body-normalization behavior before changing receipt matching; do not weaken operation/content identity speculatively. Document the legacy Copilot reconciliation idempotency boundary.
4. Align ordinary static-serving realpath checks with safe-start; consider moving maintenance out of GET handlers and authenticating webhooks before avoidable configuration reads. These are hardening ideas, not confirmed remote exploits.
5. Improve diagnostics for coordinated enablement that will later fail Node/import validation. Before exposing checkpoint migration operationally, prove target artifact availability and pin it against collection.
6. Add platform/browser acceptance for Linux, Windows Job Objects, real terminal providers, Firefox/WebKit and assistive technology. Preserve fail-closed behavior for unsupported local hosts and uncertain staged cleanup.
7. Extend fault coverage for source-admission crash windows, recovery retry policy and galleons sharing a basename. Pricing/outcome duplicate-input normalization and Todo history-eviction performance remain lower-priority investigations, not established product failures.

_Helmsman · not reported - not reported_
