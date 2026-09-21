# Plugin implementation completion ledger

The active objective is to complete every phase in [the architecture plan](plugin-architecture-plan.md), including independent review, fixes, and behavioral verification. A completed increment is not completion of the full objective.

| Phase | State | Required evidence |
|---|---|---|
| A — Host foundation | Complete (`2e8d8ff`, `7c8c27e`) | Standalone SDK/distribution, isolated source-denied installation and route reload, archive/registry rejection, full safe start, existing browser flows. Build, unit, browser/visual, distribution gates passed. |
| B — External frontend and backend | Complete (`8f3d11b`, `8652f9e`, pushed) | Independent Costs and pricing packages use public SDK only; explicit reversible replacements; settings/storage survive restart; missing providers remain unavailable; measured usage and budgets survive disabling presentation/pricing; isolated production-server proof. Verified by 2,968 unit/integration tests, 10 browser/visual tests, six distribution checks, three isolated server tests, and build/TypeScript. |
| C — Persistence and recovery | Complete (`200c57b`, `2e9bd57`, pushed) | Shared transactions/migrations, exclusive startup, pinned executions/checkpoints, host ownership recovery, durable publication/Slack/Jira/manual review effects, legacy preservation, lifecycle draining/rollback, core recovery and offline backup. Verified by 3,184 tests / 207 files, final focused runner/runtime fixes, 11 browser/visual tests, six distribution checks, four isolated-server tests, TypeScript and production build. |
| D — Task sources | Complete (`85e1564`, `abae201`, pushed) | Todos and Jira coexist; neutral logical identity and immutable admission bindings; explicit compatible source adoption; pinned operations survive replacement; two providers pass one contract suite. |
| E — Pages and integrations | In progress: E1/E2 Helm cutover verified; E3 feature extraction next | Helm and every optional page/panel/integration use replaceable public contributions; layout/route state survives absence; scope, settings, polling and disposal behave correctly; execution exceptions explicitly await F. |
| F — Execution extensions | Pending | Agent/host/workflow/scheduling implementations launch, monitor, stop, recover and finalize through public APIs; alternate implementations pass contract tests; recorded bindings, publication/clarification gates, budgets and concurrency remain enforced. |
| G — Stabilization and removal | Pending | Independent author builds frontend/backend from public docs; proven versioned contracts; no optional feature/private host import exceptions; legacy switches removed; complete unit/integration/visual/distribution verification. |

Each phase must also satisfy the cross-cutting gates in architecture plan section 8. Pending or indirect evidence is not a passing gate. After implementation, review and fix findings before moving to dependent extraction; review each completed commit before pushing.


## Phase C completion evidence

The following work passed independent implementation/review/fix rounds and acceptance verification. Post-commit review found and fixed a Git URL-rewrite bypass in controlled publication and concurrent package installation/reconciliation races. Independent review of the fixes is clean.

- Shared main-database connections and coordinated legacy store migrations cover run history, Todos, telemetry/usage, Outcomes, workflows, campaigns, webhooks, clarifications, notifications, Slack, and capabilities. Source claim and admission rollback together.
- Immutable admission intents reserve capacity before asynchronous preparation. Execution snapshots pin retained executable runtime bytes and dependency closure. Lease fencing, per-attempt host identities/receipts, separate attachment/completion, protected cleanup, checkpoint retention, and guarded continuation are wired into normal application launches.
- Runtime artifacts retain source/compiled executable and dependency bytes outside runtime data. Recovery verifies retained identity, task content, settings, connection identity, and paths. Unknown legacy bindings remain blocked and retain capacity/workspaces rather than adopting current defaults.
- Jira claims, GitHub review publication, Copilot requests, and the existing created-PR review queue use durable operations. Final completion and its obligations share a transaction. Pre-PR push/PR create/edit, manual PR reviews, scoped push, and outgoing Slack requests are also mounted through the ledger. Browser uncertainty only reconciles stored receipts; automatic delivery never replays a nonretryable rejection.
- Plugin catalog/data projection intents, desired disablement, draining, provider query gates, pin-aware install/uninstall/collection, and frontend catalog refresh are integrated. Independent reviews fixed live-disable and installation/collection races, default CLI coordination, and frontend-only inactive health.
- Core recovery endpoints and a separate core page expose scoped diagnostics and evidence-backed actions. Safe start stays provider-free, script-free, and read-only; SQLite inspection uses private WAL-aware copies.
- A consistent three-database backup primitive rejects live writers and retains acknowledged WAL writes. The offline backup CLI checks writers across all three databases. Compatible rollback after forward migration, incompatible rollback rejection, and retained schema ranges now have regression coverage. Legacy preservation fixtures cover source/host/status combinations, malformed metadata, retained checkpoints, and restart without invented runtime bindings.

Final full suite after post-commit fixes: 3,184 tests across 207 files passed. Focused checks also passed 91 runner tests, 23 runtime-path tests, 22 transport/service tests, and 47 coordinator/store/CLI tests. These include actual detached workers, persistent SQLite restart, lost launch response without duplicate launch, terminal-before-finalization replay, stop-before-recovery-exit, stop-during-recovery-launch, and continuation faults. TypeScript and production build passed.

Independent review fixes include finalization lease fencing, retry pin transfer, terminal attempt recovery, retired-checkpoint rejection, pinned host/task validation, capability redaction, and obligation-only credential resolution when Jira is disabled. Further fixes cover nonretryable delivery replay, authenticated Copilot actor pinning, publication reconciliation after an attempt changes, final PR re-observation, package installation/collection races, coordinator bypass, provider-validated checkpoint migration, retained schema compatibility, and terminal/legacy worktree protection.

Browser/distribution verification: all 11 browser/visual tests passed; six distribution checks and all four source-denied isolated production-server tests passed, including normal legacy recovery, exclusive startup, gateway port retention, and offline backup. All 28 pre-PR CLI cases drive the real authenticated durable publication endpoint with real Git fixtures and passed.

Publication Git transport now uses a fresh bare repository, empty system/global configuration, no inherited Git overrides, HTTPS-only canonical targets, no redirects/hooks, and repository-scoped credentials. It rechecks authorization immediately before push after asynchronous setup. Package capacity is enforced inside the shared lifecycle transaction, and reconciliation drains intents added by concurrent callers.

Local publication gateways choose an isolated loopback port on first start and retain it in the runs directory for surviving coordinators. Docker retains its configured network listener. Run capabilities and coordinator publication capabilities are separate, and neither enters immutable task snapshots. Stop intents persist per attempt, and attempt advancement is blocked while any prior external operation remains unsettled. Application startup claims exclusive ownership before mutating recovery state.

_Helmsman · not reported - not reported_


## Phase D acceptance evidence

The task-source packages, host APIs and application cutover are implemented. Todos and Jira have independent enablement and scheduling, canonical WorkRefs, immutable source/connection bindings, guarded commands, retained claims and explicit replacement validation. Dashboard actions use canonical identity; source settings preserve drafts and the header galleon scope. Compatible local provider adoption preserves the original collection and task IDs.

Final acceptance evidence: 3,439 unit/integration tests across 230 files, with no unhandled errors; TypeScript and production build; 12 browser/visual tests; seven distribution checks; six isolated production-server tests. Focused tests also verify the final source-launch ordering and Recovery action fixes. Test fixtures now dispose every created dashboard view before jsdom teardown.

The distribution checks build an independent public-SDK provider, adopt existing local work, restart and complete a real durable detached worker with application source denied. Production-server tests prove source API adoption, desired disablement across restart, source-backed launch and preflight-abort cleanup, and an explicit same-provider Jira update after the application runtime changes. The Jira update preserves operator-seeded identity, connection and namespace; changing the legacy environment switch after conversion does not overwrite source enablement.

Independent review fixed malformed source requests, concurrent scheduler cursor updates, source launch routing, request cancellation, settings credential rejection, source-specific task links, retry identity across lost responses/reload, immutable settlement replay, abort draining after failed admissions, and source claim retention for resumable checkpoints. Adoption preserves desired disablement and rejects changes to either the previous or proposed configuration after validation. Worker outcomes remain truthful when source finalization fails; source ownership stays protected separately.

Source-claim diagnostics and guarded retry actions are available in scoped Recovery, including read-only safe start. Explicit operator-seeded Jira artifact refresh is verified without promoting or merging source identity. Source launch performs synchronous scope validation, then reserves admission/capacity before provider reads. Exact-commit review of `85e1564` found and fixed stale Todo request identities after definite rejection, misleading shared-source scheduler wording, and failed source retries after configuration revision changes. Durable rejection receipts fence concurrent late preparations; fresh retries retain canonical owner/provider binding while validating current enablement and scope. Both fixes passed independent cross-review, 151 focused tests, TypeScript and production build. Exact-fix-commit reviews are clean; `abae201f87ff23bfbae0fbb9bb31972540935ca3` is pushed and matches the remote. Phase E contract and infrastructure implementation has begun.

_Helmsman · not reported - not reported_

## Phase E first composition gate

The first composition slice is implemented. Manifest version 2 adds explicit panel contracts and separate entries; version 1 remains supported. Host-managed composition owns module loading, instance scopes, cancellation, bounded state and unavailable contributions. IndexedDB layout writes use revision-checked transactions across tabs and preserve raw legacy storage during migration.

The shipped Helm and backlog packages and independently authored alternatives compose through the public SDK. The isolated production test passes all four combinations with application source denied during compilation, packaging, installation and runtime. It also verifies live page selection/reset, panel replacement and reload, panel disable/re-enable, unavailable selected Helm without fallback, core Config/Recovery access and restart with a retained disabled Helm binding.

A clean intermediate full suite passed 3,575 tests across 240 files. Browser verification passed the 12 existing tests and the new composition/visual test, including duplicate panels with different galleon scopes and retained layout through disablement/reload. Later review fixes have focused regression coverage; final aggregate checks remain pending. This evidence does not mark Phase E complete.

Reviews fixed disposed-panel state writes, overlapping/detached mount containers, unscoped panel service exposure, hidden stack selection, stale asynchronous layout reads, dirty selection races, unread response cleanup, live catalog binding propagation, server Helm slot registration, retained incompatible composition selections and truthful frontend inactive health. Panel authoring and lifecycle documentation now describe the implemented contracts.

Remaining Phase E work includes the other Helm panels, task/run/PR/communication/workspace/settings presentation packages and their narrow services. Running/Recent need scoped run reads and preserved Stop/Retry commands; Underway is a source-task view, not a worker-status view. The initial run-read implementation has begun after the first production composition gate. Phases F and G remain pending. These E edits are not committed or pushed yet.

_Helmsman · not reported - not reported_


## Phase E run services and panel extraction

The bounded run-read service is implemented and independently reviewed. It filters galleons and worker states before the SQL page limit, uses signed scope-bound keyset cursors, bounds log text and response bodies, and supplies initial cancellable polling without overlap. Read DTOs omit execution internals; worker outcome and source settlement remain separate.

The fixed run-command service now has a durable server ledger and host browser journal. Exact-attempt stop intent shares the receipt transaction; retry reserves the original attempt across callers and request IDs. Admission stores the command content binding so restart reconciliation cannot adopt unrelated work. Caller attribution comes from the mounted contribution under the trusted same-origin model. Accepted/rejected browser receipts remain until explicit acknowledgment after result/draft consumption. Unknown delivery retains the UUID and supports explicit delivery retry, with no automatic replacement worker.

Independent reviews found and fixed cancellation during browser storage, wrong-target stop receipt retirement, lost acceptance during scope changes, duplicate retry after reload, and stop evidence from another galleon. The focused run-read/run-command/router regression batch passed 222 tests. Running and Recent packages and their production/visual proof are underway; Underway is implementing an explicit assigned-work provider view, preserving Jira assignee semantics independently of queue JQL. New Run is implementing persisted per-galleon drafts and source-qualified launch through the same public service.

E2 production acceptance is pending. These changes remain uncommitted and unpushed; phases E remainder, F and G remain open.

_Helmsman · not reported - not reported_


## Phase E Helm cutover checkpoint

All eight Helm panels now have standalone author packages: Underway, New Run, Backlog, Running, Pull requests, Recent, Activity and Shipped. New layouts use the original two-column arrangement; persisted layouts retain deliberate removals, missing contributions, stacks and scope overrides. The Helm slot is registered before catalog loading, so missing or failed activation displays an unavailable page. The legacy dashboard renderer, rack event owner and dashboard polling path are removed. Core header/drawer controls and remaining pages retain their owners.

Public services now cover scoped source reads, assigned-work views, display-key lookup, source history, run reads, durable launch/stop/retry and bounded PR reads. New Run saves per-galleon drafts before dispatch, resolves display keys to canonical source identity, and checks readiness again before launch. Underway and Backlog expose new-launch controls only for ready tasks. Accepted command receipts describe admission, not successful execution.

Legacy pane links resolve through a generic contribution locator when old migrated instance IDs differ. Canonical instance links never silently switch targets. Namespaced ephemeral route state reaches only its selected panel; legacy task keys stay unresolved until an explicit source choice. Route-only changes propagate without saving into layout state or giving replacement implementations another contribution's payload.

Activity separates event-history quality from current Done-task snapshot counts grouped by retained completion date. Reopened/deleted tasks are excluded from those snapshot counts. Missing providers and incomplete scans produce unknown counts; source events and authored PR timestamps remain attributable rather than fabricated.

The source-denied production gates passed independent New Run/Underway installation with committed-admission response loss and same-UUID retry, and Activity/PR installation with real source records, scope exclusion, disabled sources, plugin enablement and restart. Desktop/mobile screenshots were inspected, including lower panels within the scrolling shell. TypeScript, production build and seven Node distribution checks passed. Final verification passed 3,915 tests across 264 files, 18 browser/visual tests, seven Node distribution checks and ten isolated production-server tests. Legacy renderer-specific tests now exercise public page entry points and package lifecycle behavior. Final architectural review also fixed contradictory browser receipt evidence, including nullable identity erasure, and rechecks durable admission identity after asynchronous launch preparation; the 47-test regression batch passed independent re-review. Unrelated composition contracts start empty. The verified increment awaits exact-commit review and push. E3 feature extraction and phases F/G remain open.

_Helmsman · not reported - not reported_


## Phase E2 exact-commit Recovery correction

Exact-commit architectural review of `a1fb97615222bafc5a88f4db4f271930ca457d7c` found that uncertain run commands linked to Recovery without a matching inventory or operator action. Core Recovery now lists scoped uncertain commands, reconciles matching admission evidence, and offers an audited not-admitted resolution only when all retained execution, admission, control, reservation, checkpoint, source-claim and operation evidence proves absence. Safe start exposes read-only inventory without applying migrations.

Resolution compares the displayed immutable receipt proof and writes the audit and terminal receipt atomically. Exact lost-response replay returns the same audit identity across restart; stale proof, changed operator input and unrelated retained evidence conflict. Public receipts carry the original execution assignment in a validated resolution marker; the browser journal permits uncertain-to-rejected transition only through that marker and retains the result until explicit panel acknowledgment. Delayed dispatch remains fenced and resolution does not start or stop a worker.

Independent architectural re-review found no remaining material findings. Verification passed 3,953 tests across 264 files, 109 focused backend tests including the final audit-integrity hardening, five Recovery browser/visual tests with inspected screenshots, TypeScript and the production/distribution build. The rebuilt isolated production Recovery gate passed with lost-response replay, restart, safe-start mutation denial, missing caller plugin, stale proof and conflicting evidence. It verifies one durable audit and no new executions. The earlier E2 full browser and distribution gates remain recorded above. Exact-fix-commit Senior Software Architect review is clean. Both E2 commits are pushed; remote `godaddy/master` was verified at `57b77f2272f55a1d07d8c93ab43f6f5d9ecc98d9`. E3 implementation is underway; F and G remain open.

_Helmsman · not reported - not reported_


## Phase E3 shared composition foundation

Composition pages now declare their own initial instances and stacks through the public manifest. The host no longer seeds Helm panels by feature identity; the shipped Helm and independent alternative supply different defaults. Existing layouts, including intentional emptiness and unavailable contributions, remain authoritative across page replacement and reload.

Generic saved state now permits 1 MiB of UTF-8 JSON per instance and 4 MiB per composition. Regression coverage preserves multiple full-size Unicode editor drafts and rejects oversized per-instance and aggregate payloads without truncation. An additive panel `setScope` capability persists explicit local scope changes, retains drafts, cancels old scoped reads and rejects pending changes after activity cancellation. Header scope is unchanged.

Independent review found no material findings. Verification passed 114 focused composition/metadata tests, TypeScript and production/distribution build, two existing browser/visual scenarios and seven Node distribution checks. A new isolated production test builds and installs independently authored packages with source unavailable: package defaults retain a missing panel, activate it after installation, survive switching page implementation, and preserve deliberate removal through reload and another replacement. The increment awaits exact-commit review. Todos, durable source edits and provider-owned Triage/Bugs views are in implementation; no legacy feature cutover is claimed.

_Helmsman · not reported - not reported_
