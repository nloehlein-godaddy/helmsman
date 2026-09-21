# Phase E implementation proposal: Helm and feature extraction

Status: E0 design review complete; E1 infrastructure and the first Helm/backlog extraction passed the isolated production gate. E2 run services, all eight Helm panels and the legacy Helm cutover have passed aggregate and isolated production validation. E3 task presentation packages and services passed isolated production validation and are pushed as `bc51ae6`; default task-page cutover passed acceptance validation locally and awaits exact-commit review and push. See [E3 implementation detail](plugin-phase-e3-implementation.md) and the proposed [E4 run-presentation batch](plugin-phase-e4-implementation.md). Phase D is reviewed and pushed as `abae201`. The remainder of E and phases F/G are still pending.

## Outcome and boundaries

Make Helm replaceable as a page, and each Helm panel independently installable, replaceable, and hideable. Then move the remaining shipped presentation and integration policy into packages using established host ports. Keep admission, durable execution, usage recording, recovery, credentials, and publication safeguards in core. Disabling a presentation never stops a voyage or deletes its recorded state.

The existing SDK already supports framework-neutral page mounting, updates, disposal, scoped services, canonical contribution routes, and selected page aliases. Phase D supplies stable source identity, task snapshots, source commands, configuration, and adoption. Extend those contracts where extraction proves a missing boundary; avoid a generic framework rewrite.

## Current coupling to retire

| Surface | Current coupling | Proposed seam |
|---|---|---|
| Helm | `src/main.ts` controls refresh, launch, pane events and drafts; `src/render.ts` builds every panel. | Packaged Helm page composes registered panel contributions through host lifecycle services. |
| Rack | `src/logic/rack.ts` has a closed `PanelId` union and filters unknown IDs. | Versioned layout stores namespaced contribution IDs and opaque state, preserving missing entries. |
| Task views | Todo, triage and bug presentation calls legacy endpoints; source management now has a separate controller. | Public task-source read/command/launch/configuration DTOs, with source-owned links and canonical WorkRef. |
| Run views and launch | UI directly imports legacy run clients/controllers. | Narrow read/subscribe/launch/stop/retry host services; execution implementation remains behind C/D adapters until F. |
| PR, Slack and terminal | Page controllers and feature endpoints are built into the shell. | Capability-specific validated services, then independently packaged presentation and integration policies. |
| Config | Core settings and feature-specific forms share a renderer. | Core recovery/plugin administration stays available; packages contribute namespaced settings views. |

## E0: reviewed public contract checkpoint

Agree on a `PanelContributionV1` with namespaced ID, title, mount entry, declared compatible slot/version and optional route-state schema. The containing page declares slots and their cardinality; installation only makes contributions available. Operators explicitly choose replacements. A page can provide default selections for a new layout but cannot overwrite existing selections.

The panel lifecycle reuses page semantics: mount into an owned container, update immutable effective scope/theme/terminology/visibility, refresh, and dispose. Each instance owns an abort scope; hiding/unmounting prevents late state writes and removes subscriptions. The page owns composition; panels cannot reach into sibling DOM, change header scope, or register unmanaged global listeners. Bundled frameworks and scoped CSS remain supported. Host theme tokens and terminology access are public; legacy application CSS classes are not an API.

Publish typed domain services, not raw internal clients or broad fetch/database access. Separate read/subscribe permissions from mutations. Task actions carry exact source identity and configuration revision. Run actions identify a retained run and pass through existing host gates. Preserve mutation request IDs across response loss and reload; validate success receipts before discarding drafts. Unknown cost and availability remain explicit states.

## E1: rack and mount infrastructure

Add panel manifests, validation, immutable module loading, selected bindings, lifecycle failure containment and distribution SDK declarations. Keep missing selections as unavailable placeholders with their original positions, stack membership, active tab, collapsed state and opaque data. Disabling a provider must not silently select a different panel.

Migrate the current rack in an additive versioned envelope. Map known legacy IDs once to shipped contributions; retain the original layout and unknown IDs. Validate bounded collections, duplicate instance IDs and opaque-state size without deleting unavailable entries. Distinguish a contribution ID from a mounted instance ID so the same panel can appear twice with different local scope. Scope overrides are per instance and never write the header selection.

## E2: Helm and independent panel proof

First extract a read-only backlog panel through Phase D task discovery, then a run-status panel through a versioned host query/subscription. Extract the Helm composition page and migrate remaining panels incrementally: underway tasks, running voyages, recent voyages, repository PRs, shipped work, activity and launch.

For each panel use one active implementation path. Remove corresponding branches/events/state from `src/main.ts` only when its package owns them. Keep launch/stop/retry semantics in core services; extraction must not weaken human gates, concurrency, durable claims or publication checks.

Build a separately authored alternative Helm page and an independent alternative backlog panel using only the released SDK. Prove replacing either independently against an isolated production distribution with application source denied. This is the first E release gate; do not parallelize all feature migrations before it passes.

## E3: remaining features in bounded batches

| Batch | Packages | Required public boundary before cutover |
|---|---|---|
| Task presentation | Todos, triage, bugs and task-source settings | D task-source queries/commands/configuration; source-qualified routes and draft storage. |
| Voyage presentation | Run history, details, logs, clarifications | Scoped history/detail/events and existing mutation gates; recorded execution stays in core. |
| Collaboration | PR views, review requests, Slack views/integration policy | Pinned credential/effect ports and truthful durable operation receipts. |
| Workspace features | Terminal UI and campaigns | Scoped terminal session APIs and existing campaign coordination gates. |
| Configuration | Feature settings contributions | Namespaced schemas, redacted read models, revision-checked writes and independent availability. |

A feature requiring a new execution-host, agent, workflow or scheduler replacement protocol remains behind a documented temporary adapter until Phase F. Do not invent those contracts inside a UI extraction. Slack side effects and PR publication continue through the durable operation system; hiding their panels never cancels retained obligations.

## Acceptance and ownership

| Gate | Required evidence |
|---|---|
| Layout compatibility | Legacy migration, unknown contribution retention, duplicate instances, hide/re-enable, active stack recovery and rollback. |
| Lifecycle | Failed and slow mount isolation, scope changes during reads/writes, disposal, subscription cleanup and stale result fencing. |
| Behavior | Existing task/run/PR workflows retain authorization, canonical identity, drafts and idempotent requests. Source-specific display links never use a global Jira fallback. |
| Visual/accessibility | Current designs, keyboard panel navigation, focus preservation, responsive layout, missing/unavailable states and both terminology modes. |
| Execution independence | Disable every presentation package while admitted voyages continue and Recovery remains available. |
| External authorship | Replace Helm and one panel independently; build/install/reload without source access or host rebuild; no private imports. |

After D passes, assign one owner to SDK/registry/layout migration, one to Helm/backlog extraction, and one to independently authored replacement/contract review. Root owns application cutover and integration. Keep each feature batch reviewable and complete its focused tests, TypeScript/build, visual checks and source-denied distribution proof before moving to the next batch. Preserve existing runtime artifacts and databases throughout.

## Decisions requiring E0 review

- Use contribution instances in persisted layouts rather than overloading contribution IDs.
- Reuse page lifecycle semantics while keeping page-owned composition separate from core navigation.
- Preserve missing routes/layout/drafts instead of redirecting or silently replacing selected features.
- Introduce only the domain service ports needed by the next extraction; explicitly list temporary F adapters.


## E0 review decisions

Two independent reviews inspected current manifest/package validation, page mounting, static slot handling, layout normalization, and routes. They found that the current public SDK cannot compose independently installed panels, the manifest accepts pages only, root routing is still private, and current layout/route parsing destroys unavailable state. Implementation must close these gaps before extracting Helm.

- Introduce manifest version 2 for panel declarations and page composition declarations, while retaining unchanged manifest version 1 packages. Keep page entry and panel entry maps distinct. Panel contracts carry an explicit version; duplicate local IDs across contribution kinds are rejected. Required domain service versions are declared and checked before mount.
- Add `helmsman/helm-page` as the stable composition identity with `/` and `/helm` aliases. The canonical contribution route remains independently addressable. An explicitly disabled/missing Helm yields an unavailable view; shell navigation, plugin administration, and Recovery remain usable. Shipped presentation contributions participate in the same operator-controlled lifecycle as installed packages.
- Expose host-managed composition through the public page context: discover compatible panel contributions, read/update the selected layout, and mount an instance into a page-owned container. The host resolves modules, derives child context, owns cancellation and failure containment, and returns a managed handle. A page never imports private module loaders or mounts another package directly.
- Keep the initial layout browser-local, keyed by stable composition identity and version, independent of which Helm implementation is selected. Use a shared IndexedDB transaction for revision-checked multi-tab updates and a change notification; preserve original localStorage bytes during additive migration. Read raw legacy layout before legacy normalization can discard unknown IDs. Separate instance IDs, selected contribution IDs, hidden state, stack membership/active instance, collapse state, scope override, and bounded versioned opaque state. Never automatically reinsert explicitly removed panels.
- Scope overrides are a tagged union: inherit header, explicit all galleons, or one galleon. Each instance has independent scope. Its lifetime signal lasts until removal/disable/replacement; each effective scope has a separate epoch and abort signal. Hide/collapse/inactive-stack changes suspend reads/subscriptions immediately while retaining mounted drafts; reappearance refreshes current scope. A hung update must not delay invalidation of prior requests. Durable mutation identities survive suspension/disposal separately.
- Preserve bounded panel-instance route locators and namespaced versioned opaque state while unavailable. Validate provider-owned state when a contribution becomes available, without deleting unrelated state or feeding one implementation another's state. The first slice uses instance-qualified panel focus and source-qualified task links; it does not generalize arbitrary routing.
- Add a versioned browser task-read facade: instance discovery plus bounded list/load with source ID, instance revision, effective galleon, cancellation, and explicit unavailable state. All-galleon discovery enumerates each permitted galleon rather than inventing a provider-wide scope. Manual source selection is independent of automatic scheduling. Add run reads later with separate worker outcome and pending source settlement; the initial subscription implementation is host-managed polling with an initial snapshot, cancellation and explicit errors.
- The first extraction proves all four pairings of shipped/independent Helm and shipped/independent backlog panel. Also mount the same panel twice with different scopes, disable/re-enable, reload a deep link, and retain missing layout/state. Remove each corresponding legacy owner when its package cuts over; do not keep dual polling/event paths.

Slack integration requires a separate public communication-provider and durable invocation contract before its extraction batch. PR publication remains under core authority. Terminal and settings contributions get narrow domain contracts; a generic arbitrary-endpoint dispatcher is not the replacement protocol. Header status and run drawers receive explicit ownership so optional Helm disablement cannot remove core controls.

Root owns the contract decisions and integration. One agent owns panel registry/package/catalog/layout infrastructure, one owns scoped domain services and their server adapters, and one owns authored Helm/backlog packages and independent replacements after the types are agreed. File ownership will be split further at the actual E1 handoff to avoid concurrent edits.

_Helmsman · not reported - not reported_

## E2 run-service review decisions

Running/Recent now use scoped, bounded run-read queries and host-managed polling. Commands are a fixed domain protocol: source/freeform/review/rerun launch, exact-attempt Stop and exact-attempt Retry. Browser storage reserves a request UUID before transport; a server ledger binds caller, canonical content, assigned run, original retry lineage and receipt. Core launch still owns capacity, source claims, snapshots and execution. Admission retains a hash binding to the command so restart recovery cannot confuse unrelated evidence with acceptance.

A terminal receipt remains in the browser journal until explicit acknowledgment after result/draft consumption. Cancellation during response or storage processing cannot retire an unobserved success. Definite rejected requests can be dismissed; unknown delivery can be checked or explicitly delivered again with the same UUID. Recovery-required delivery remains an operator action. Exact-original-attempt retry uniqueness spans callers and request IDs. A worker result never follows from command acceptance or log text.

Underway has an optional declared task-source read view. Jira's view preserves assigned, non-Done work independently of queue JQL, including assigned Ready/Blocked tasks. Local Todos expose in-progress/review work. Unsupported providers remain unavailable without normal-list substitution. New Run keeps per-galleon drafts and selects canonical work references through public reads. Display-key lookup and backlog launch parity remain follow-up work before Phase E completion.

The next remaining Helm batch covers repository PRs, Shipped and Activity. PR presentation needs a bounded scoped PR-read contract with explicit partial/unavailable evidence, preserving authored-work and review-request semantics independently of run status. Activity needs scoped source/PR activity and completed-throughput evidence; unknown integrations must not become fabricated zeroes or sample events. These ports must project allowlisted public DTOs from existing adapters, then move provider policy behind replaceable capabilities during integration extraction. They must not expose arbitrary endpoint dispatch or private clients. Keep the legacy rack paths until all corresponding package owners are ready for one coordinated cutover; do not claim complete feature parity while placeholders remain.

_Helmsman · not reported - not reported_
