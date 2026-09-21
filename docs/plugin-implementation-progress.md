# Plugin implementation completion ledger

The active objective is to complete every phase in [the architecture plan](plugin-architecture-plan.md), including independent review, fixes, and behavioral verification. A completed increment is not completion of the full objective.

Implementation has resumed at the user's request. The [revised remaining delivery plan](plugin-remaining-delivery-plan.md) replaces repeated intermediate review/build cycles with feature checkpoints, affected checks and phase-level aggregate validation. The preserved checkpoint and public clarification recovery package are reviewed and pushed as `3806090` and `ab0757d`; Runs cutover is the active feature.

| Phase | State | Required evidence |
|---|---|---|
| A — Host foundation | Complete (`2e8d8ff`, `7c8c27e`) | Standalone SDK/distribution, isolated source-denied installation and route reload, archive/registry rejection, full safe start, existing browser flows. Build, unit, browser/visual, distribution gates passed. |
| B — External frontend and backend | Complete (`8f3d11b`, `8652f9e`, pushed) | Independent Costs and pricing packages use public SDK only; explicit reversible replacements; settings/storage survive restart; missing providers remain unavailable; measured usage and budgets survive disabling presentation/pricing; isolated production-server proof. Verified by 2,968 unit/integration tests, 10 browser/visual tests, six distribution checks, three isolated server tests, and build/TypeScript. |
| C — Persistence and recovery | Complete (`200c57b`, `2e9bd57`, pushed) | Shared transactions/migrations, exclusive startup, pinned executions/checkpoints, host ownership recovery, durable publication/Slack/Jira/manual review effects, legacy preservation, lifecycle draining/rollback, core recovery and offline backup. Verified by 3,184 tests / 207 files, final focused runner/runtime fixes, 11 browser/visual tests, six distribution checks, four isolated-server tests, TypeScript and production build. |
| D — Task sources | Complete (`85e1564`, `abae201`, pushed) | Todos and Jira coexist; neutral logical identity and immutable admission bindings; explicit compatible source adoption; pinned operations survive replacement; two providers pass one contract suite. |
| E — Pages and integrations | In progress: E1/E2 Helm and E3 task-page cutovers delivered; E4 foundations reviewed and pushed; presentation extraction remains | Helm and every optional page/panel/integration use replaceable public contributions; layout/route state survives absence; scope, settings, polling and disposal behave correctly; execution exceptions explicitly await F. |
| F — Execution extensions | Pending | Agent/host/workflow/scheduling implementations launch, monitor, stop, recover and finalize through public APIs; alternate implementations pass contract tests; recorded bindings, publication/clarification gates, budgets and concurrency remain enforced. |
| G — Stabilization and removal | Pending | Independent author builds frontend/backend from public docs; proven versioned contracts; no optional feature/private host import exceptions; legacy switches removed; complete unit/integration/visual/distribution verification; repository-wide README, documentation and flowchart audit, including HTML/Markdown parity and working links/examples. |

Each phase must also satisfy the cross-cutting gates in architecture plan section 8. Pending or indirect evidence is not a passing gate. After implementation, review and fix findings before moving to dependent extraction; review each completed commit before pushing.

Documentation is part of every extraction: update affected READMEs, operator and author guides, architecture/process diagrams and HTML counterparts with the implemented behavior and its limits. Keep proposed work and historical plans clearly identified. Before Phase G completion, inventory all repository documentation and flowcharts, verify current-state claims against code and runtime evidence, and validate links, examples and diagram rendering.


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

Independent review found no material findings. Verification passed 114 focused composition/metadata tests, TypeScript and production/distribution build, two existing browser/visual scenarios and seven Node distribution checks. A new isolated production test builds and installs independently authored packages with source unavailable: package defaults retain a missing panel, activate it after installation, survive switching page implementation, and preserve deliberate removal through reload and another replacement. Exact-commit Senior Software Architect review was clean; `edfe0eb2204470482df54f54cf4a63e553b81ac0` is pushed and its remote SHA was verified. Todos, durable source edits and provider-owned Triage/Bugs views are in implementation; no legacy feature cutover is claimed.

_Helmsman · not reported - not reported_

## Phase E3 task presentation integration

Provider-declared task editors, durable source commands, audited source-command Recovery and bounded provider-owned Triage/Bugs views are implemented locally. Independently installed Todos passed creation with response loss, receipt recovery after reload, retention of a newer draft, exact-identity move and confirmed deletion. The source-denied task-view service gate passed independently installed Jira and authored providers across galleon changes, source/plugin disablement and restart. These gates precede the latest legacy-recovery and authored Triage/Bugs presentation changes; the release will be rebuilt for those checks.

Todos now supports bounded All-galleons aggregation with actual provider timestamps, full filtered totals, source-qualified editing and independent pagination failures. The legacy request recovery port preserves old identities and refuses to clear uncertain requests. Independent review caught receipt destination validation and coercive reason validation; both were fixed with regression coverage and re-reviewed. The focused host/router/accessor batch passed 153 tests; the subsequent legacy recovery, package and registry review-fix batch passed 103 tests. Source-admin contracts and provider-declared editable settings are in development, preserving process-local automatic starts separately from persistent source selection.

Source administration is now implemented with provider-declared editable settings, exact source/instance revisions, persistent schedule selection and separately controlled process-local automatic starts. Durable runtime intents preserve caller/request identity before toggling memory; historical outcomes survive restart and unresolved prior-process intents expire without reenablement. Independent review fixed last-galleon receipt recovery, command identity across restart, missing-provider disablement, settings-reset semantics, stale replacement drafts, bounded receipt history and recovery of unavailable scheduled selections.

Final aggregate verification passed 4,127 tests across 281 files, TypeScript and production/distribution build, 23 browser/visual tests and seven Node distribution checks. Later source-settings UI fixes passed 13 focused tests and all three final isolated production scenarios without snapshot updates. Todos passed four isolated scenarios. The expanded Triage/Bugs service/UI gate passed on the rebuilt release, including independent compilation, filtered pagination, exact-ref related runs, independent metrics, disable/re-enable and restart; its final screenshot baseline rerun passed. Screenshots were inspected. The three source-settings scenarios cover configuration response loss after removing the last allowed galleon, persisted schedule selection with automatic starts disabled on restart, and stale pinned replacement rejection.

Documentation is synchronized across README, PRODUCT/DESIGN, package/distribution/backend/task-source/recovery guides and the affected package READMEs. Markdown and offline HTML process diagrams distinguish source/run Recovery from source-admin pending receipts and preserved legacy Todo journals. Review corrected reserved-namespace installation recipes and a diagram that treated rejection as successful mutation. Exact external-package recipes were checked against descriptor rewriting, standalone compilation and CLI packaging/installation; local links and desktop/mobile HTML rendering passed. Historical Bugs plans and Moonunit adoption link to the current migration state. The E4 proposal includes proposed viewer/answer diagrams and carries the documentation gates forward.

This increment awaits exact-commit review and push. Legacy Todos, Triage and Bugs remain active; default task-page slot cutover and legacy presentation retirement are next. The [E4 proposal](plugin-phase-e4-implementation.md) covers following run/clarification work. Later E batches and phases F/G remain open.

_Helmsman · not reported - not reported_

## Phase E3 exact-commit task-editor corrections

Review of `77c856d280a5e12d7dcad82757c7bac92334410d` found two P2 issues: a moved Todo could link to a retained run in its former galleon, and source configuration changes could prevent explicit reconciliation of preserved drafts. Both are fixed locally. Run links require a real retained run in the selected galleon; explicit reconciliation preserves dirty fields while advancing only the original source/instance/editor identity, with pending command identities kept immutable. A subsequent review also caught and fixed overlapping refresh/reconciliation ownership.

The focused regression batch passed 58 tests across five files, and TypeScript plus the production/distribution build passed. All four isolated Todo production scenarios passed without snapshot updates, including live source configuration followed by explicit reconciliation and successful saving of preserved edits. Exact-fix-commit review remains pending. The implementation and correction commits have not yet been pushed. Default task-page cutover and the remaining E/F/G work remain open.

_Helmsman · not reported - not reported_

## Phase E3 default task-page cutover

The task-package checkpoint and its two exact-commit corrections are pushed to `godaddy/master`; remote SHA was verified at `bc51ae6a0600ef705c1a90d5150699f07353be70`. Both Senior Software Architect fix-commit reviews were clean.

Default task-page cutover is implemented locally and under validation. Todos, Triage, Bugs and Source settings now participate in the shared page-slot/catalog lifecycle. Core Config retains its controls and links to Source settings. Legacy Triage preferences initialize only an absent composition, with an atomic raw archive; existing layouts, opaque state and Todo mutation journals are preserved. Legacy task renderers and shell polling owners are being retired. READMEs, author/operator guides and matching Markdown/HTML flows are being updated with the actual boundaries. These cutover changes are not yet committed or pushed; aggregate tests, isolated alias acceptance and architectural review remain pending. E4 and later E batches, F and G remain open.

_Helmsman · not reported - not reported_

## Phase E3 default task-page acceptance evidence

The cutover passed 4,120 tests across 279 files, TypeScript and production/distribution build, 23 browser tests, seven Node distribution checks and seven isolated Todo/default-task-page scenarios without snapshot updates. Production proof covers alias selection, external replacement, disable/re-enable without fallback, legacy preferences and pane links, persisted empty layouts across restart, preserved draft/journal identities, and zero legacy task-list reads from the new pages. Screenshots were inspected. The separate Triage/Bugs production gate also passed on the final documentation/CSS build, verifying that removal of legacy global styles leaves authored panels intact.

Review fixed Node JSON descriptor closure, malformed explicit task locators, pane focus, transient reveal-write retry and Pirate mode updates without losing Todo edits. Aggregate testing exposed and fixed an existing exit-receipt/process-probe race, with a deterministic regression and 48 repeated real-worker executions. Independent reviews are clean. Relevant READMEs, current and historical documentation pointers, author/operator guides and Markdown/offline HTML flows are synchronized; 72 tracked documentation files passed local-link checks, and the offline flow rendered at desktop/mobile sizes. Exact-commit architectural review and push remain pending; E4 and the remaining E/F/G work are open.

_Helmsman · not reported - not reported_

## Phase E3 pushed; E4 foundations underway

All three exact-commit Senior Software Architect reviews of `d21d9cb2bc642b6491962458c5553ca040d8f798` were clean, including an independent 95-test rerun. The commit is pushed to `godaddy/master` and the remote SHA was verified. E3 default task-page cutover and its documentation/flowchart updates are delivered.

E4 implementation has begun with a separate run-inspect service, durable clarification attempt-channel provenance, and the shared viewer/download architecture. Existing run-read contracts remain unchanged. E4 runtime work is unaccepted and uncommitted; remaining E batches, F and G stay open.

_Helmsman · not reported - not reported_

## Phase E4 foundation validation evidence

The working tree now includes the separate `helmsman/run-inspect@1` and `helmsman/download@1` facets, bounded history/log/export services, the browser download sink and scoped static worker, and durable clarification attempt channels with companion revision metadata. Legacy questions with unknown attempt provenance remain visible and read-only; required unanswered obligations continue to block publication. Versioned local and Docker publication gates require the exact retained attempt/channel pair. Existing viewer/history and known-channel answer/contact compatibility paths remain until their later extraction; durable answer/contact receipts and public clarification reads are not delivered by this foundation.

Cross-review fixed oversized network chunks crossing the export/download boundary, maximum-length run filenames, the pre-PR validator rejecting new channel queries, unknown-question answers through the old route, and standalone SDK declaration generation. TypeScript and the production/distribution build pass. The aggregate gate passed 4,214 tests across 288 files; the existing browser suite passed 23 tests, Node distribution checks passed seven tests, and nine actual download scenarios passed across Chromium/WebKit/Firefox. A separately compiled SDK-only page passed the copied-production inspection/export/download gate with checkout access denied. Final focused transport regressions also pass. Exact-commit architectural review and push are the remaining checkpoint steps; no E4 push is claimed here.

README, authoring/distribution and operational guidance now describe the foundations and remaining boundaries. Matching Markdown/offline HTML flows show inspection, watermark export and browser completion limits; the HTML was rendered and visually inspected at desktop/mobile sizes. Local targets in 74 documentation files were checked. Documentation remains an acceptance gate for this and every later extraction.

_Helmsman · not reported - not reported_

## Phase E4 foundation review corrections

Exact review of `039f516` found two lifecycle errors: the final question-file write could arrive between polling and exit observation, and replaying an answered question after run completion could block durable finalization effects. Both are corrected. A verified exit now triggers an attempt-fenced final drain before completion or retry. Complete records are retained; unfinished non-whitespace JSONL suffixes block progress. Active polling still tolerates partial writes. Existing terminal records replay only after identity/channel/content validation, without changing answers or revisions; new or altered terminal records remain rejected.

Regressions cover one- and two-attempt exit races, incomplete and whitespace-only suffixes, preserved attempt/channel state and dispatch of all three successful finalization effects through the real clarification gate. Independent review is clean. The corrected tree passed 4,224 tests across 288 files, TypeScript and the production/distribution build, and the source-denied Unicode inspection/download production test. Prior unchanged frontend evidence remains 23 browser tests, nine real cross-browser download scenarios and seven Node distribution checks. Documentation now correctly identifies the implemented download facet and shows destination readiness before lazy export capture in both process diagram formats. All 74 documentation files passed local-target checks. Correction-commit review and push remain the checkpoint's final steps.

_Helmsman · not reported - not reported_

## Phase E4 foundations pushed; presentation and public clarification services underway

The foundation and review corrections are pushed to `godaddy/master` as `e788774dcf394545481cfce1e3b654d695ab73b5`; the remote SHA was verified. Three exact-commit architectural reviews were clean. The correction gate passed 4,224 tests across 288 files, TypeScript and the production/distribution build, and the source-denied inspection/download scenario. Existing browser checks passed 23 tests; Node distribution checks passed seven, and real download scenarios passed nine across Chromium, WebKit and Firefox. All 74 documentation files passed local-target checks; the offline process flow was inspected at desktop and mobile sizes.

The next slice is in progress: public clarification reads, durable answer/contact services, authored run viewer/history packages, and typed auxiliary presentation selection. Its working changes have not passed the foundation checkpoint gates and are not delivered. Relevant READMEs, author/operator guides and Markdown/HTML flows remain required for every checkpoint, followed by a repository-wide documentation audit in Phase G. Remaining E extractions and phases F/G stay open.

## Phase E4 presentation and clarification service checkpoint

Public bounded clarification reads, revision-checked durable answers and explicitly global suggested-contact administration are implemented. The compatibility question/contact renderer uses these services and stores drafts, immutable displayed results and pending commands separately. Explicit cleanup requires a fresh successful journal read, protects unresolved commands and keeps global contact cleanup separate. Legacy HTTP ingestion, ID-only answers and unversioned contact writes return 410 when the public services are active; trusted worker ingestion retains its attempt-channel path.

Independently authored run-viewer/history packages use the copied SDK. Typed presentation locators preserve canonical run identity and invoking-panel scope without changing the header; reload retains the canonical target separately from header scope. The auxiliary host rehomes its mounted session, preserves focus and pauses detached work. The provisional `/run-viewer` and `/run-history` slots are integrated. Standalone and auxiliary viewer sessions still require convergence; the existing `/runs` drawer, private PR presentation and fully authored clarification/contact packages remain pending. This checkpoint does not complete E4 or Phase E.

Validation passed 4,334 tests across 302 files, TypeScript and the production frontend build, plus 23 existing browser/visual tests. Final cleanup and shell regressions passed 122 tests across five files; clarification-specific validation passed 45 tests across six files. Independently compiled presentation packages passed 47 tests and two copied-SDK desktop/mobile browser scenarios. The final source-denied viewer/history shell scenario passed, including pagination, focus, hidden/resumed logs, scope-preserving canonical reload and disabled-selection behavior. Two final production clarification scenarios passed, including response loss, restart persistence, independent contacts, durable result-before-ack ordering, storage failure and protected cleanup. Desktop/mobile screenshots were inspected.

README, PRODUCT/DESIGN, package READMEs, SDK and operational guides, and both Markdown/offline HTML process flows are synchronized. Distribution builds now copy linked offline documentation and assets, rewrite relocated author links and direct source-only references to the canonical GitHub repository; browser test sources are excluded from copied author projects. The repository link audit covers 80 documentation files with no missing targets. The final production/distribution build and all nine Node distribution checks passed. The offline HTML flow rendered without overflow and was visually inspected at desktop/mobile sizes; guide examples compile against the copied SDK. Independent precommit architectural and documentation reviews are clean. Exact-commit review and push remain pending. Remaining E extractions and phases F/G stay open; Phase G retains the repository-wide documentation acceptance gate.

_Helmsman · not reported - not reported_

## Phase E4 postcommit state-preservation corrections

Architectural review of `47bd469` found two state-loss paths. Passive shell refresh invoked the standalone viewer/history reset operation, discarding paused log windows or the selected history page. The shell now leaves passive refresh ownership with those compositions, for both aliases and canonical replacement routes, while retaining explicit Refresh. Costs retains its existing passive refresh behavior.

Clarification cleanup could discard newer answer or contact text entered while fresh journal reads were pending. It now captures the selected displayed and saved draft, rejects changed local or persisted content after those reads and compares the expected stored content immediately before removal. Regressions cover same-tab, other-tab and unsaved/quota-failed edits for answers and global contacts. Discarding a preexisting unsaved edit preserves and reloads stored text; deleting it requires a separate explicit action. Compatibility local storage still lacks atomic cross-document compare-and-delete; the author guide and both process-flow formats state this limit.

Correction validation passed 66 presentation/shell tests and 43 clarification tests, TypeScript and production/distribution builds, and all nine Node distribution checks. The source-denied viewer scenario verifies history page 2 and paused standalone logs across a real shell polling interval; the final renderer scenario passed after the dirty-local cleanup fix. Independent re-review is clean. Desktop/mobile flows were rendered and inspected again, and all 80 documentation files pass local-target checks. Exact-fix-commit review and push remain pending; the implementation checkpoint remains local. Standalone/auxiliary viewer convergence, legacy Runs/PR cutover and fully authored clarification/contact presentation remain open, along with later E extractions and phases F/G.

_Helmsman · not reported - not reported_

## Phase E4 presentation checkpoint pushed; shared-session and authored forms underway

`47bd469` and correction `b49c6ca5cd80e45066b24da3965dbe3153b8e240` are pushed to `godaddy/master`; the remote SHA was verified. All three exact-fix-commit Senior Software Architect reviews were clean. The final gate included the production/distribution build, nine Node distribution checks, focused state-preservation regressions and source-denied viewer/clarification browser scenarios. The documentation and desktop/mobile flow checks recorded above are delivered with this checkpoint.

The next increment is local and unaccepted: converge standalone and auxiliary viewer lifetimes, add canonical-only authored clarification/question and global-contact panels, and add an optional public compare-and-set operation for panel state. Existing compatibility caller identities, drafts, results and journals remain intact; the new packages cannot adopt or replay another contribution's requests. Alias cutover and compatibility retirement require their own migration proof. Current work does not complete E4, Phase E, F or G.

_Helmsman · not reported - not reported_

## Phase E4 shared viewer and authored forms acceptance

The current increment converges standalone viewer aliases, exact canonical viewer routes and auxiliary presentation onto one retained composition session. Synchronous DOM transfers preserve tabs, focused paused logs, active reads and unresolved requests; real hiding still cancels scoped activity. Exact canonical routes retain their own contribution identity independently of the selected alias. Legacy Runs and private PR presentation remain pending cutover.

Independent clarification and suggested-contact packages now mount through public SDK contracts, with separate services and error boundaries. The clarification page is canonical-only: its alias and the compatibility caller remain unchanged. Original compatibility journals, results and drafts remain recoverable under their original identity; the new packages cannot adopt them. Optional conditional panel-state saves compare the exact namespace baseline inside revision-checked layout persistence. Conflicts preserve stored data, local drafts and original requests, including when BroadcastChannel is unavailable. Explicit result dismissal requires a successful conditional save before acknowledgment. Unknown or oversized saved state stays preserved with writes disabled.

Independent review fixed clean-state saves bypassing comparison and failed pagination mislabeling retained rows. All explicit saves now perform comparison, and page identity, cursor history and rows commit together only after successful reads. Review and re-review are clean. Broad validation before the final pagination correction passed 4,397 tests across 307 files, 23 existing browser/visual tests and nine Node distribution checks. After that correction, all 39 authored-package tests and TypeScript/production/distribution builds passed. The final two source-denied production scenarios passed in 40.4 seconds, covering independent copied-SDK installations, missing/disabled contacts, response loss and restart, compatibility recovery, dirty and clean stale-tab conflicts, durable result-before-acknowledgment, global contact identity and revision preservation. Four desktop/mobile screenshots were inspected. The unchanged viewer convergence production scenario also passed, proving retained DOM, focus, paused browsing, one polling loop and unresolved request identity across surfaces and canonical routes.

READMEs, package/SDK/operator guides and Markdown/offline HTML flows reflect these boundaries. All 83 documentation files passed local-target checks. Updated HTML flows rendered without horizontal overflow at desktop and mobile sizes and were visually inspected. Exact-commit architecture review and push remain pending. This increment does not complete E4 or Phase E; Runs/PR and clarification alias migration, remaining integrations, F and G stay open.

_Helmsman · not reported - not reported_

## Phase E4 exact-commit retry correction acceptance

Review of `612057b` found that an explicit Retry original action used `submit` with the retained input. If another tab had already acknowledged the original reservation, that path could reserve a new request and, for contact creation, a new contact ID. Instance-specific saved-state comparison cannot prevent this across distinct instances. The correction adds optional exact-request retry operations that read the original caller-owned journal without reserving identities. Missing requests fail closed; older hosts keep receipt lookup available and disable retry. Authored panels and the compatibility controller use this operation exclusively for redelivery.

Correction validation passed 32 host-service/contract tests and 52 consumer tests, final TypeScript and production/distribution builds, and all nine Node distribution checks. The corrected source-denied questions scenario passed in 27.3 seconds and contacts in 9.9 seconds. Both prove that a stale peer retry after acknowledgment sends zero commands and recreates no journal; contact creation retains exactly one original contact. Desktop/mobile screenshots were inspected for both scenarios. Independent host and consumer reviews are clean. All 83 documentation files pass local-target checks, and matching Markdown/offline HTML flows describe exact retained-request retry; desktop/mobile HTML inspection is clean. Exact-fix-commit review and push remain pending.

A sibling scan found the same submit-as-retry pattern in run, task-source and source-administration consumers; the next verification/fix batch must cover those public services and every retry consumer before continuing page cutovers. This finding does not reopen unrelated completed extraction work, but its command-identity guarantee requires explicit correction evidence. No completion or push of this correction is claimed here.

_Helmsman · not reported - not reported_


## Phase E4 authored forms pushed; sibling retry corrections underway

`612057b` and correction `773cce4f3888c10f5cabd6199b56c8ba3205398b` are pushed to `godaddy/master`; the remote SHA was verified. All three exact-fix-commit Senior Software Architect reviews were clean, including an independent 84-test rerun. The preceding production, build, documentation and visual evidence is delivered with this checkpoint.

The next local increment corrects exact-request redelivery across run commands, task-source commands and source administration. Three agents own the service/journal contracts, run presentation consumers and task/source consumers respectively. The inventory covers 11 retry entry paths across nine packages, including submitted Todo drafts that lack a request ID. No accepted completion is claimed for this new increment. Runs/PR extraction, clarification alias migration, remaining Phase E integrations and phases F/G remain open.

_Helmsman · not reported - not reported_

## Phase E4 sibling exact-request retry acceptance

Run, task-source and source-administration services now expose optional exact-request retry. Caller/request-indexed journal reads validate immutable commands and stored receipts without allocating identities. Missing or acknowledged entries send nothing; acknowledgment after lookup can only replay original IDs and cannot recreate the journal. Source-command transport validates all receipt identity fields against the retained source command while preserving its original input, even when acknowledgment removes the journal before response recording. Receipts do not echo the input payload.

All 11 identified retry entry paths across New run, Run viewer, Running, Recent, Backlog, Underway, Triage, Todos and Source settings use these operations. Initial intentional commands still submit normally. Older hosts disable redelivery while preserving receipt checks. ID-less submitted Todo drafts reconcile a unique exact-input journal match and check its receipt; absent or ambiguous identity retains the draft and submission evidence without dispatch or rebinding.

Independent cross-reviews are clean. Validation passed 4,480 tests across 307 files, TypeScript and the production/distribution build, 23 existing browser/visual tests and all nine Node distribution checks. Ten source-denied production scenarios passed: New Run/Underway, six Todo and three source-settings scenarios, including existing visual baselines. Real stale-peer retries after acknowledgment send zero POSTs and recreate no journal in all three service families; the Todo remains a single record. The New Run peer explicitly disables cross-tab notifications so automatic refresh cannot hide the stale-row race. Focused tests also cover freeform launch identity, newer reservations, acknowledgment during lookup, cancellation, corrupted storage, original authority, missing optional methods and ID-less draft preservation.

Root/package READMEs, SDK/source/recovery guides and matching Markdown/offline HTML flows describe the corrected APIs and remaining work. All 83 documentation files pass local-target checks. Desktop/mobile HTML flows render without overflow and were visually inspected. Exact-commit review and push remain pending. The next work is PR compatibility extraction and Runs cutover, followed by clarification alias/recovery migration and the remaining E/F/G scope.

_Helmsman · not reported - not reported_

## Phase E4 sibling retry corrections pushed; page cutovers continue

`91429669d5727776f84a84d8d90438e9c9d39a1c` is pushed to `godaddy/master`; the remote SHA was verified. All three exact-commit Senior Software Architect reviews were clean after correcting a documentation distinction between preserving command input and validating receipt identity. The preceding 4,480-test, 23-browser-test, ten-production-scenario and nine-distribution-check evidence applies to the pushed code. The final distribution copy includes the reviewed documentation.

The next increment is underway with separate ownership: extract existing PR state into an explicit private compatibility controller/panel before Runs cutover; bind the clarification alias to the independently authored composition while retaining original compatibility recovery; and define a separately declared public PR inspection facet for revision-bound detail and bounded diff reads. Public manual-review and optional Slack publication contracts remain subsequent work. No new cutover or PR inspection acceptance is claimed here; remaining E integrations, F and G stay open.

_Helmsman · not reported - not reported_

## Delivery cadence revised at user request

Stopped implementation and all three agents before further builds or commits. The remaining A–G objective is unchanged. The new delivery plan finishes one feature at a time, uses one independent exact-commit review with correction-only follow-up, reuses validation evidence and runs aggregate suites at phase exits. Targeted checks still cover durable effects, identity, scope, migration and recovery changes. Current uncommitted E work and its outstanding catalog/PR/clarification acceptance are recorded in that plan. The user subsequently resumed implementation under this revised plan.

## E4 clarification alias and PR inspection checkpoint

The clarification alias now selects the authored composition and always exposes compatibility recovery for empty or missing-panel layouts. Original caller identities, raw drafts and pending requests remain untouched. Catalog reads reconcile committed CLI selections and serialize fresh snapshot application before serving, preventing a stale default page from persisting the wrong initial layout.

A private PR session shares status/diff reads, drafts and unresolved manual-review/Slack identities across legacy surfaces and a canonical compatibility panel. It cancels reads after the last interested surface leaves and preserves explicit galleon scope. This is memory-only compatibility, not restart durability; legacy Runs/PR cutovers and public action extraction remain open. The new public PR inspection facet supplies scoped detail and immutable comparison previews with independent completeness, bounded transport and nullable incomplete counts, including classic GitHub statuses.

Final validation under the revised delivery plan: TypeScript/app/distribution build passed; 88 focused PR tests across eight files passed; all six affected source-denied production scenarios passed (four clarification, one private PR preservation, one independent public-SDK PR inspection). Desktop/mobile changed-layout screenshots were inspected. Earlier unchanged evidence remains applicable: 55 inspection tests, 135 alias/page tests, 23 browser tests and nine distribution checks. The earlier aggregate unit run had 4,545 passing tests and one descriptor-parity failure; that failure was corrected and its 14-test file passed. The full suite was not repeated for this feature checkpoint. Latest catalog/PR behavior is covered by the final focused and production checks.

Affected READMEs, author/operator guides and matching Markdown/HTML flows are updated. Local documentation links pass, and the offline flow renders without horizontal overflow. Exact-commit architectural review and push are next. The next feature milestone is Runs presentation and public-contract clarification recovery; the full E/F/G scope stays open.

_Helmsman · not reported - not reported_

## Public clarification recovery package

The preceding checkpoint `380609010bf7f5399532ddc39c5e4505a7f3d7f0` passed one independent exact-commit architectural review and is pushed to `godaddy/master`; the remote SHA was verified.

Clarification recovery now owns its renderer, controller, draft storage and scoped styles inside an independently buildable public-SDK package. Root legacy implementations are removed. The original contribution ID, caller journals and raw storage formats remain unchanged. The host supplies immutable optional page contribution identity; missing identity/services fails closed before storage reads, and renamed packages use a separate namespace outside the legacy prefix so another caller cannot clean up original evidence.

TypeScript/app/distribution build passed. Focused host, package and descriptor checks covered 95 cases: the initial run passed 94 with one missing descriptor entry-map failure; the descriptor and a test-only typing error were corrected, then all 21 directly affected descriptor/page tests passed. Both source-denied production scenarios passed (31.9s), covering independent copied-SDK compile/install/reload, original versus copied namespace isolation, original answer/contact request identities, exact retry, newer drafts, storage failure and result-before-acknowledgment. Six changed desktop/mobile screenshots were inspected. No aggregate suite was repeated. READMEs/guides and matching process flows describe the package boundary and preserved recovery data. Exact-commit review and push are next; Runs cutover is the next feature.

_Helmsman · not reported - not reported_


## Runs composition cutover

Clarification recovery commit `ab0757dd2328d19eca49c6dcfcec977945d7e0d8` passed one independent exact-commit architectural review and is pushed to `godaddy/master`; the remote SHA was verified.

The active Runs feature replaces shell-owned history and rendering with `helmsman.runs/page`, an independently buildable composition package. It composes authored history and the temporary private PR panel, using the existing shared auxiliary viewer for run selection. Legacy review/relaunch links retain their mode, target and focus; explicit PR/run targets stay separate from header scope. Empty layouts, missing contributions and disabled selected pages do not restore the old page. The retained `/prs` drawer suspends its streams off that surface.

Validation passed: 101 route tests, 47 builtin registration/registry tests, 15 Runs package tests, 169 affected integration tests and 19 directly affected checks after the final stream correction. TypeScript/app/distribution build passed. Four source-denied production scenarios passed (26.6s), including copied Runs installation, legacy draft/request preservation, exact shared viewer/log DOM, paused logs, layout preservation, restart and disabled selections. Eight affected browser tests passed (7.8s), using the same built application without another build. Six changed desktop/mobile screenshots were inspected. All 87 documentation files pass local-target checks; offline Markdown/HTML flow parity and desktop/mobile rendering passed. No aggregate suite was repeated. The independent exact-commit review found weaker PR target validation through opaque panel state. The corrective diff shares the canonical route validator across URL, saved, opaque and presentation targets; malformed values issue no provider reads. Its 112 directly affected tests, rebuilt TypeScript/distribution artifact and two Runs production scenarios passed (17.1s). Correction-only review is clean. Runs commits `d61552f` and `56e6d60da197c6457e2259fd50812c6d88413943` are pushed to `godaddy/master`; the remote SHA was verified. Public PR/GitHub extraction is active, split between provider, durable command and presentation ownership. E/F/G remain open.

_Helmsman · not reported - not reported_


## Public PR presentation and GitHub provider

The PR candidate replaces the private session and shell drawer with an independently buildable SDK page/panel. `/prs` and `/pr` select the existing `helmsman/pr-compatibility-page` slot; stable contribution IDs preserve saved layouts. Runs uses the same public PR panel and shared viewer. Header, explicit PR and run scopes remain separate, including renamed plugins and setup links. Optional Slack requests are temporarily isolated in Config with their original in-memory request identities and no navigation replay.

GitHub is an independently buildable `helmsman/pull-request@1` backend with persistent CLI selection and exact retained artifact bindings. Public manual-review commands reserve browser identities before transport and commit durable operations before remote mutation. Authenticated actor/head proof, response uncertainty, exact retries and result-before-acknowledgment remain explicit. The old review admission endpoint returns 410 while public commands are active; retained legacy operations still reconcile through their original resolver. Provider reads recheck selection/credentials, and each POST rechecks the operation lease. Copied providers package their public SDK runtime locally.

Validation: focused routing, host, package, command, provider, lifecycle and affected main/render checks passed; the PR package has 50 passing tests. TypeScript/app/distribution build passed. Four affected source-denied production scenarios passed across the final correction runs, covering independent frontend/backend build/install, lost-response recovery without duplicate review, disable/restart, inspection quality/cancellation, PR→Runs draft/request preservation, shared viewer identity and saved layouts. Four affected browser tests passed using the same app artifact. Production found and corrected SDK runtime packaging and a synchronous storage-notification redraw that detached the feedback field during focus transfer. The new regression verifies both drafts survive blur and remount. No aggregate suite was repeated.

README, author guides and matching Markdown/HTML flows describe the public boundaries; the local-target audit covers 89 documentation files. PR, Runs/viewer and offline flow desktop/mobile screenshots were inspected; a leftover row-layout flex basis was corrected for the new metadata column and the affected production visual passed. Independent review of `6ef2218` found that lease authorization did not bind provider-controlled POST fields to the retained review. The correction validates exact target, head, event, canonical body and empty query, then forwards a reconstructed immutable request after authorization. Ten focused effects regressions pass, including independent hostile-field changes and mutation while authorization waits; provider tests also pass. The corrected TypeScript/app/distribution build and independent PR/GitHub production scenario passed (12.1s). Correction-only review of `a230369` is clean. The PR/GitHub feature is reviewed and pushed through `e6c3be32ee562e10fbfaba1e5898067a89913ac2`; remote SHA verified. Slack extraction follows; E, F and G remain open.

_Helmsman · not reported - not reported_

## Public communication presentation and Slack provider

The Communication package owns the notification header, composition page and independent notifications, review-request and settings panels. `/communication` selects the authored page; PR links and old Config review hints open it without sending or changing header scope. Shell-owned Slack polling, rendering and handlers are removed. Copied contributions retain their own journals and drafts. Settings use revision checks covering both values and the displayed destination; saving never sends.

The independently buildable Slack backend owns channel navigation, group mention resolution, draft checks, message scanning and delivery policy. Core supplies bounded browser primitives under the existing shared lock. Public commands retain the original caller, request ID, provider artifact, destination and connection in durable operations. Admission and final-send checks preserve PR eligibility, cooldown and lease ownership. Unknown delivery remains uncertain without automatic resend; matching a PR URL cannot prove an exact request. Legacy operation resolvers remain available for obligations, while replaced legacy write routes return 410. Execution and scheduling adapters remain assigned to F.

Acceptance has exercised scoped services, cross-caller cooldown and same-request races, durable receipts, settings conflicts, browser argument validation, plugin lifecycle and notification node identity. TypeScript/app/distribution build passed. The source-denied production scenario builds copied frontend and Slack packages plus a replacement provider using the public SDK; it proves lost-response recovery with one mock send, retained receipts after disable/restart, settings conflicts and header/panel scope separation. No real Slack messages were sent. Desktop/mobile inspection identified a notification loading failure caused by an undefined optional browser surface in the scanner identity. Canonicalizing it to null fixes notification projection and scan comparisons; seven focused runtime/read tests pass, including a connection change during scanning. Production acceptance now explicitly requires successful scoped notification loading. READMEs, public authoring guidance and matching Markdown/offline HTML flows are updated; the offline flows render without mobile overflow. The corrected TypeScript/app/distribution build and strengthened source-denied production scenario pass (13.5s); notification, composition, review and offline-flow desktop/mobile layouts were inspected. All 92 documentation files pass local-target checks. Independent exact-commit review of `c5eee08` found five material issues: pre-send failures lost retryability, sends unnecessarily required watcher fields, historical success blocked later reminders, public/server notification bounds differed, and the UI hid notifications past its fixed limit. The corrective increment restores proven pre-send retryability while preserving post-send uncertainty, separates watcher validation, supports explicitly preparing another request without sending, and uses the shared 256-notification bound. The correction passes 36 frontend regressions, 22 backend/provider checks, TypeScript/app/distribution build, and the strengthened source-denied production scenario with empty watcher settings (13.3s). Updated request/header visuals were inspected. Correction-only review caught unattended retries after a proven pre-send failure. Host command policy now blocks automatic replay for both invocation and reconciliation results from any provider; only explicit retry reopens the same recorded operation. Focused service tests cover service restart, resubmission, drains, reconciliation and original identity; the corrected TypeScript/app/distribution build passes. Correction-only review of `56e5d15` is clean. A final integration check also connected browser exact retry to the explicit backend retry route, with full retained-command comparison before reopening and same-ID redelivery only when no server operation exists. Fourteen focused transport/service tests and the corrected TypeScript/app/distribution build pass; strengthened production acceptance exercises a pre-send failure, explicit retry, successful-send response loss and recovery with one mock send (13.5s). The transport corrective diff awaits review before push. E/F/G remain open.

_Helmsman · not reported - not reported_
