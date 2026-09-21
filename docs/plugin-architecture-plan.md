# Helmsman plugin architecture plan

Date: 2026-09-20  
Revision: 3 — incorporates both independent reviews and the final readiness review.  
Status: Phases A–D are complete and pushed. Phase E Helm and feature extraction is in implementation and acceptance review; phases F–G remain pending. The [completion ledger](plugin-implementation-progress.md) tracks the full objective.

The review findings are addressed in the proposal below and tracked in the review disposition table. Original review text is retained at the end and refers to revision 1 (`8259c2c`). Architectural choices here are proposed defaults, not claims about existing functionality.

## Objective and recommendation

Make nearly every feature independently installable, replaceable, and removable without modifying Helmsman source. This includes Jira, Slack, Todos, Helm and its individual panels, Costs, and other pages and integrations.

Migrate incrementally to a small core plus replaceable plugins. A ground-up rewrite would put working run recovery, review gates, and integrations at risk without making the plugin architecture better. Preserve existing implementations behind new contracts, then extract them one feature at a time.

The main obstacles are concentrated:

- [`src/main.ts`](../src/main.ts) owns most frontend behavior, state, requests, and lifecycle management.
- [`server/helmsman/application.ts`](../server/helmsman/application.ts) wires integrations, stores, providers, background work, and launch dispatch. [`main.ts`](../server/helmsman/main.ts) selects normal or safe startup.
- [`src/logic/routes.ts`](../src/logic/routes.ts) and [`src/logic/rack.ts`](../src/logic/rack.ts) define closed lists of pages and panels.
- [`server/helmsman/router.ts`](../server/helmsman/router.ts) knows individual features and their dependencies.
- [`server/helmsman/agents/adapter.ts`](../server/helmsman/agents/adapter.ts) includes Jira-specific task fields; runner and recovery paths know specific providers.

Existing agent adapters, run hosts, data clients, store factories, and mounted page lifecycles provided the initial boundaries. Phase D removed the former Jira-versus-Todos mode split. E3 provides task presentations through public editor, command, task-view and source-admin services; default task-page cutover passed acceptance validation and awaits exact-commit review and push. See [E3 evidence](plugin-phase-e3-implementation.md) and the [E4 proposal](plugin-phase-e4-implementation.md). The remaining plan describes the target architecture, including unfinished F/G work.

## 1. Define what stays in the core

The core provides infrastructure and enforces application invariants. Features consume its public APIs.

| Small, stable core | Shipped as plugins |
|---|---|
| Application shell, navigation registry, layout infrastructure | Helm page and its individual panels |
| Galleon identity and scope | Jira, local Todos, future task sources |
| Plugin installation, settings, lifecycle, dependency resolution | Slack and other messaging integrations |
| Durable run lifecycle, resource limits, usage recording | Agent adapters, execution hosts, workflow definitions |
| Credential broker and publication safeguards | GitHub integration, PR pages and review workflows |
| Storage, events, commands, logging | Costs, outcomes, campaigns, terminal, triage, bugs |

The plugin manager, minimal recovery controls, and a safe startup mode remain in the core even when every optional feature is disabled. Core APIs enforce galleon scope, concurrency and publication checks for compliant plugins; arbitrary trusted code running with host privileges can bypass these boundaries. Strong isolation is outside v1.

Disabling Costs must not stop usage recording or budget enforcement. Hiding the Runs page must not stop active runs. Presentation plugins may be replaced independently of the services that record or execute work.

## 2. Define contribution and capability contracts

A plugin is an independently built package containing a manifest, optional frontend/backend entry points, and assets. Installation must work against a production distribution without Helmsman source or a host rebuild.

Keep these identities and versions separate:

| Item | Meaning |
|---|---|
| Plugin ID and package version | Publisher-owned implementation identity and release |
| Manifest schema version | Package metadata format understood by the loader |
| SDK compatibility range | Public host API versions supported by the package |
| Capability ID and contract version | Interoperable service protocol, independent of implementing package |
| Contribution ID | Namespaced page, panel, command, or settings contribution, such as `acme.costs/summary` |
| Storage schema version | Persisted-data format and migration compatibility |

The manifest also declares entry points, assets, runtime requirements, contributions, package dependencies, provided/required/optional capabilities, requested access, settings schemas, and activation requirements. Validate manifests and runtime payloads; TypeScript types are insufficient at external boundaries.

### Presentation slots and routes

- Distinguish a contribution from the slot it can fill. A stable slot such as `helmsman/costs-page` identifies a replaceable presentation role; the selected contribution identifies its implementation.
- A slot owner declares its contract version and cardinality: one selected contribution or an ordered collection. Core owns shell slots; page plugins own their internal slots. Slot declarations must not import the selected implementation.
- Persist explicit bindings. Shipped defaults apply only to unconfigured installations. A missing selected contribution produces a placeholder or recovery link rather than silently choosing a different plugin.
- Each page owns a namespaced canonical route, for example `/plugins/acme.costs/summary`. Stable aliases such as `/outcomes` bind to slots, so replacement preserves existing links. Reserve core and legacy paths; reject collisions during activation.
- The host validates common scope parameters. Contributions validate their own versioned query state, including source-specific IDs. Invalid state produces a bounded error or documented default, never unchecked input passed to providers.
- Preserve unknown contribution IDs, layout positions, and route state when a plugin is absent. Disabling an open page navigates to an available host page without deleting its saved state.

### Capability resolution

Package dependencies require an implementation package; capability requirements require a compatible service contract. Prefer capabilities for interchangeable providers. Reject required dependency cycles and incompatible versions before activation; publish registrations only after successful activation.

Each capability declares whether consumers select one provider or enumerate many. For single-provider requests, resolve an authorized explicit launch selection, then workflow binding, galleon binding, and global binding, in that order. An explicit invalid binding is an error, not permission to fall through. Only an unconfigured binding with exactly one compatible provider may use that provider automatically. Zero or multiple candidates produce an actionable diagnostic.

For multi-provider discovery, return compatible configured providers in stable ID order; consumers select or enumerate them explicitly. Missing optional services are represented as unavailable capabilities and must be guarded by consumers. No selection depends on package installation order.

### Contracts introduced as features migrate

| Contract | Responsibility |
|---|---|
| Page / panel | Mount, receive context updates, refresh, dispose |
| Usage query / pricing | Read durable measured usage; compute separately identified estimates |
| Task source | Find work, load details, claim it, update lifecycle |
| Code host | Read changes, publish PRs, submit reviews |
| Messaging | Receive events and send explicitly authorized messages |
| Agent provider / execution host | Build commands, interpret output, launch, monitor, stop |
| Workflow | Define stages and request core-supervised execution |

Stabilize each contract against actual extractions and at least two implementations before declaring it public and stable. Plugins communicate through versioned services, commands, and events, never private implementation imports. Do not design the entire execution SDK in Phase A.

## 3. Separate work identity from implementation selection

Jira and Todos must coexist. A work item identifies a stable logical source, not a plugin package:

```ts
type WorkRef = {
  sourceId: string;
  externalId: string;
};

type ProviderBinding = {
  pluginId: string;
  version: string;
  artifactHash: string;
  capabilityVersion: string;
  connectionId: string;
};
```

`sourceId` is a host-managed namespace for a logical collection of work, such as a Jira tenant or local Todo collection. It survives package replacement and credential rotation. `externalId` is the source's canonical immutable item ID; human-readable ticket keys are display fields. Claims and deduplication use logical identity, not implementation IDs.

Connections reference that logical source and carry credential handles and provider settings. Registering a second connection to the same verified source reuses its namespace; ambiguous source identity requires explicit adoption instead of creating duplicate identities silently.

A source's configured binding determines how an existing `WorkRef` resolves. Generic default precedence from section 2 selects providers for unbound/new work; it cannot reinterpret an existing source. Replacements must explicitly adopt a compatible source, validate identifier and data semantics, and map settings or migrate owned data. Existing runs and pending operations retain their recorded implementation binding until deliberately migrated.

Admission freezes the neutral task snapshot, work reference, provider bindings, and provider-owned versioned context. Jira URLs, transitions, and API payloads remain in its plugin. Replacing a UI does not migrate task data; changing a provider may require migration.

| User action | Defined effect |
|---|---|
| Hide a panel | Change presentation only |
| Disable a plugin | Remove UI and new-work admission; drain existing obligations under section 6 |
| Replace a provider | Validate and change bindings for new work, preserving logical identity |
| Uninstall | Remove activation registration after obligations drain; retain data and referenced artifacts |

Data deletion and artifact retirement are explicit operations with dependency and retention checks.

## 4. Build a usable loading and authoring boundary early

Create the smallest SDK, loader, packager, sample, and test harness needed for the first external slice. Keep existing source locations initially. Extract packages when the working boundary justifies them; a monorepo directory reorganization is not a prerequisite.

First-party plugins must use the same SDK as external authors. Add import-boundary checks that reject private host and cross-plugin imports. Temporary legacy adapters live inside the host and have an explicit retirement phase; they are not published plugin APIs.

### Package and runtime format

- Browser and backend entry points are prebuilt ESM. Plugins bundle runtime dependencies, including any frontend framework. V1 excludes plugin-specific native addons, host dependency installation, and package install scripts.
- The SDK publishes type declarations and bundleable helpers. Live services arrive through an injected versioned context; plugins do not rely on host module paths or host-owned React instances. Backend Node built-ins remain available under the trusted-code model.
- Packages declare their supported Node range, checked against Helmsman's runtime. The production server serves immutable plugin assets under plugin ID and artifact hash and supports contributed route reloads. Asset requests never fall through to the SPA HTML response.
- Produce a runnable host distribution containing built server entry points, frontend assets, required runtime helper files, and runtime dependencies. Resolve packaged assets independently of the source checkout. Test startup and plugin installation from an isolated distribution with application source unavailable; the current frontend-only `npm run build` does not meet this gate.
- Store validated artifacts by content hash, with pinned transitive plugin dependencies. Verify entry points, asset paths, SDK/capability compatibility, and storage compatibility before activation.
- Installation stages and validates an archive before atomically publishing its installed record. Installing does not execute plugin code. Reject archive traversal, symlinks, duplicate/escaping paths, and configured size limits. Partial installation remains recoverable after a crash.
- V1 supports explicit activation and a controlled restart for backend install/upgrade; hot code replacement is not required. Restart proceeds only when active work can safely reattach or has drained. UI bindings may change without rebuilding the host.
- Support one loaded backend version and one UI version per plugin in v1. Queue upgrades until current obligations drain and the execution-binding checks in section 6 pass. Retained old artifacts support pinned recovery or compatible rollback, not simultaneous runtimes for different versions of one plugin.

### Frontend and host services

Use a framework-neutral `mount → update → dispose` contract. Each instance owns its container and scoped CSS, with documented theme tokens rather than dependencies on application CSS classes. React can be bundled inside a plugin without migrating Helmsman to React.

The injected context provides read-only effective galleon scope, theme and terminology updates, navigation, commands, notifications, and an abort signal. Explicit panel overrides stay local and never change header scope. Plugins translate application copy through namespaced terminology keys, never user content or technical identifiers.

The host owns global navigation and event dispatch. Plugins register shortcuts and subscriptions through disposable APIs instead of attaching unmanaged document handlers. Unmount cancels pending requests, removes owned listeners, and invalidates stale updates. Mount/activation failure rolls back partial registrations and owned resources.

Backend context supplies namespaced endpoints, validated settings, credential handles, managed tasks, and owned storage APIs. No public SDK exposes shared database handles or the host environment. These are API discipline boundaries, not a sandbox against trusted malicious code. Start with focused storage transactions and the existing domain stores behind host adapters rather than inventing a general database framework.

### Costs as a real frontend and backend proof

Move durable usage types, recording, and a versioned read/query contract into the core boundary. Remove the dependency from core telemetry to optional Outcomes implementation/types. Costs presents this data; pricing plugins supply estimation policy.

Build an external alternative Costs view and a small external pricing provider with namespaced settings and storage. Estimates carry rate provenance, currency, coverage, and as-of time; missing prices remain unknown. Estimates remain distinct from recorded spend and do not silently become budget-cap inputs. Disabling either plugin must leave recording, historical usage, and existing budget policy intact.

## 5. Migrate in phases with concrete exit criteria

| Phase | Deliverables | Completion gate |
|---|---|---|
| **A. Narrow host foundation** | Record the v1 contract decisions in sections 2–4. Add SDK declarations/helpers, manifest validator, minimal dynamic slots/routes, lifecycle registration, safe startup, archive loader, packager, external sample harness, and runnable host distribution including backend/helper assets. Wrap only shell/Costs surfaces; retain other legacy paths. | An isolated distribution with application source unavailable starts, loads a separately built sample, and reloads its deep link. Invalid packages and route collisions fail without partial registration. Existing pages still work. |
| **B. External frontend and backend slice** | Extract durable usage query boundary, Costs UI, and a small pricing capability. Package alternative Costs and pricing implementations outside this galleon, including settings/storage and basic author docs. | Install against a production distribution with source unavailable. Explicitly swap implementations without rebuilding. Verify settings persistence, missing-provider behavior, preserved usage, and no private imports. |
| **C. Persistence and recovery prerequisites** | Implement section 6 lifecycle states, artifact pinning, migration ledger, legacy decoding, recovery diagnostics, and durable operation protocol behind existing providers. Add fixture and crash tests before extracting task sources. | Drain/restart, blocked recovery, remote-success/local-crash reconciliation, and compatible rollback tests pass. Recovery distinguishes attachment failure from run completion. No destructive migration is needed. |
| **D. Coexisting task sources** | Extract Todos, then Jira. Introduce stable source identity, neutral task snapshots, explicit bindings, and connection adoption. Remove Jira/Todo mutual exclusion. | Both launch independently; replacing an implementation preserves task identity and existing operation targets. Two compatible implementations pass the task-source contract suite. |
| **E. Helm and feature extraction** | Extract Helm and each panel; progressively migrate remaining page, setting, and integration registrations. Extract Slack, PR views, terminal UI, campaigns, clarifications, bugs, and triage behind established ports. | Replace Helm or a panel independently. Each extracted feature owns cleanup/settings; missing contributions preserve layout. Any feature requiring an unfinished execution contract stays behind a legacy adapter until F. |
| **F. Execution extension completion** | Generalize remaining agent, execution-host, workflow, and scheduling contracts using the C recovery foundation. Extract execution portions deferred from E and retire their adapters. | Alternative implementations launch, stop, recover, and finalize through public APIs. Recorded bindings are honored across restart; human gates and concurrency limits pass regression tests. |
| **G. SDK stabilization and legacy removal** | Expand templates and author docs, stabilize proven contract versions, enforce deprecation policy, remove remaining legacy switches/import exceptions, and reorganize packages where useful. | An independent author builds frontend and backend plugins from public docs. Every optional shipped feature uses public contracts and has no private host imports. |

A and B form one narrow architectural milestone. Do not wrap every page before delivering it. C is a mandatory gate before task-provider extraction; F extends execution choices rather than introducing recovery safety for the first time.

For each extraction, preserve behavior through one active implementation path. Validate read equivalence with fixtures or shadow reads when useful; never run old and new write paths simultaneously. Cut over admission explicitly. Rollback requires compatible data and retained bindings, not merely changing a feature flag.

## 6. Define lifecycle, persistence, and recovery protocols

### Plugin lifecycle and artifact retention

| State | Behavior |
|---|---|
| Installed | Validated artifact available; no code activated |
| Active | Contributions and compatible services available; new work permitted |
| Draining | UI removed and new work denied; only existing execution, finalization, and operation obligations continue |
| Disabled | No active obligations or managed background work; settings/data/layout retained |
| Failed | Activation or execution service unavailable, with diagnostic and explicit retry/recovery path; existing obligations retained |

Disable cancels ordinary polling and removes presentation immediately, then enters draining if obligations remain. Persist desired enablement separately from runtime health, so a failed draining plugin can recover only to service its existing obligations. A provider cannot disappear beneath a required dependent: block the change with an affected-consumer list or explicitly drain those consumers too.

Reference counts include active runs, recoverable runs, pending side effects, and pinned dependency closures. Hold artifact/schema pins for all resumable checkpoints until explicitly retired; retain provenance for historical runs even after their executable artifacts can be deleted. Completion alone does not release a pin when finalization or resumable checkpoints remain.

Uninstall and garbage collection reject referenced artifacts. Upgrades wait for runtime obligations to drain, then inspect every retained execution/checkpoint binding in the affected dependency closure. Any binding requiring a different loaded version blocks activation until it is explicitly retired or migrated, even when the new package is schema-compatible. Apply this rule to provider dependencies as well as the upgraded package.

Checkpoint migration requires a provider-supported validation of execution state, artifacts, and contract compatibility. Record the new binding in an append-only migration record while preserving the original snapshot and provenance. Without that migration support, the upgrade remains blocked. Storage compatibility alone never authorizes rebinding execution. V1 does not load two versions of one plugin. Stop/abandon actions are separate operator decisions, never inferred from a disable timeout.

### Admission snapshots and restart recovery

Persist an execution dependency record before launch: logical work identity, normalized task, exact artifact hashes and dependency closure, resolved capability versions/bindings, intended execution host, durable launch ID, workflow revision, compatible non-secret settings, and owned-data schema requirements. Persist the concrete host reference as soon as launch returns it. Hosts must support deduplicated launch or discovery by durable launch ID; if a crash leaves launch success uncertain and discovery is unavailable, block for reconciliation rather than launching again. Include prepared-but-not-launched records in recovery.

Snapshot credential handles and connection identity, never secrets. Resolve live credentials at use time; rotation must preserve the authorized connection identity. Revoked/missing credentials block the affected operation with a reason. Provider replacement must not retarget an admitted run or pending operation.

Separate execution status from attachment health (`pending`, `attached`, `blocked`, `failed`). [`server/helmsman/recovery.ts`](../server/helmsman/recovery.ts) currently dispatches asynchronous reattachment without surfacing rejection. Replace that contract with an explicit attachment handshake and separately tracked completion; persist diagnostics and expose retry in core recovery controls.

If a pinned plugin, compatible schema, or credential is unavailable, preserve processes, logs, worktrees, and concurrency reservations. Never silently substitute a default provider, mark an unknown process completed, or let orphan cleanup remove its workspace. Keep core recovery controls available; attempt stop through available host controls and report when missing host support prevents it. Do not admit conflicting work until liveness/ownership is resolved.

Legacy adapters decode existing Jira/Todo launch payloads, host references, and workflow snapshots. Migration fixtures must cover active, completed, failed, and resumable legacy runs, preserving IDs and relationships.

### Storage ownership and rollback

Keep the current shared SQLite database initially. Inventory tables, assign an owner and migration authority, and add a host-coordinated migration ledger with exclusive migration locking. Plugins access owned storage through namespaced SDK operations; compatibility adapters preserve existing store behavior while ownership moves.

Use additive transactional migrations and declared schema compatibility ranges. For non-transactional preparation, stage artifacts separately and record resumable migration steps; do not activate against partially migrated state. Validate plugin storage declarations before execution and coordinate schema changes across all loaded consumers.

Use a SQLite-consistent backup mechanism that includes WAL state. Restoring the entire database is application-wide recovery with writes stopped, never an automatic rollback for one plugin. Prefer a forward fix or compatible package rollback; reject downgrade when current data is unsupported. Reverting activation does not imply reverting a committed data migration.

### Durable side-effect protocol

Before a task-provider extraction, replace informal lifecycle callbacks with a minimal operation ledger/outbox:

1. Persist an operation ID, originating run/state revision, immutable provider binding and target, versioned payload, and pending state in the same transaction as its originating core state change where possible.
2. A host-owned dispatcher leases the operation, invokes the pinned provider with the same idempotency key on every attempt, and records acknowledgment or retry state. An expired lease permits recovery, not a new logical operation.
3. After ambiguous remote success, query/reconcile external evidence before retrying. Providers declare their idempotency/reconciliation support. Where the result cannot be determined safely, mark the operation uncertain and request an explicit resolution instead of blindly repeating a publication.
4. Retain operations through plugin disable/restart. Missing providers or credentials mark them blocked. Retries never select a newer default binding.
5. Show pending, retrying, blocked, uncertain, and completed obligations in recovery controls. Run process success is distinct from fully settled external effects.

When a state update spans stores that cannot share a transaction, persist a recoverable intent first and reconcile both sides by operation ID. Do not claim exactly-once external delivery: require one durable logical obligation and provider-specific duplicate suppression or visible uncertainty.

## 7. State the v1 trust and failure boundaries

The proposed v1 supports explicitly trusted installed plugins in the existing browser and Node contexts. Operators review requested access and activate installed packages deliberately. Integrity hashes verify bytes, not publisher trust or behavior. A manifest or ordinary child process is not a sandbox.

Containment guarantees cover handled validation, activation, registration, request, and subscription failures. Same-context code can still block the browser or terminate the server. Do not promise arbitrary plugin crash isolation. Catch individual event-listener failures and dispose owned resources, while documenting these limits.

Provide a CLI/config safe-start option that skips all optional plugin activation, including first-party plugins. Core diagnostics can disable the failing package, inspect blocked work, and restore a compatible version. Safe start must not resume provider-dependent work or delete its artifacts; it is a recovery mode, not normal operation.

Keep broker interfaces and payloads versioned to permit later isolation. Sandboxed untrusted plugins require isolated frontend execution and OS/container restrictions on backend filesystem, process, credential, and network access; that is a separate milestone. Also defer marketplace discovery, automatic updates, universal concurrent plugin versions, and a frontend framework rewrite.

## 8. Validate the architecture through behavior

Each extraction passes TypeScript, production build, relevant unit/integration tests, and browser visual tests. Add the browser harness and external package fixture in A/B, not at the end. Use published SDK contract suites for both first-party and external implementations.

| Gate | Required evidence |
|---|---|
| External installation | Build outside this galleon and install into an isolated runnable host distribution with application source unavailable; backend/helper assets work without checkout paths; no host rebuild/private imports; direct route reload and asset loading work. |
| Replacement | Two implementations target the same slot/capability; selection and aliases are explicit and reversible; layouts and route state survive removal/reinstall. |
| Resolution | Ambiguous/missing bindings, version conflicts, cycles, collisions, and optional absence produce deterministic results; no hidden installation-order fallback. |
| Scope and presentation | Header scope propagates, panel overrides stay local, theme/terminology updates work, CSS stays scoped, keyboard/responsive layouts match existing designs. |
| Cleanup | Hide does not stop providers; disable removes ordinary polling/UI and rejects new work; only draining obligations continue; stale responses cannot remount views. |
| Backend proof | External pricing uses published usage queries plus namespaced settings/storage; disabling Costs/pricing preserves usage and budget policy. |
| Atomic activation | Inject crashes during extraction, migration, registration, and activation rollback; restart yields a usable safe-start path with no partial registrations. |
| Live disable | Disable a task source during execution, finish/restart, and reconcile one logical completion obligation without losing its binding. |
| Blocked recovery | Remove a pinned provider or revoke credentials; preserve process/workspace/leases, report blocked attachment, and recover without duplicate admission. |
| Storage and upgrade | Upgrade while another feature records usage; coordinate migration, preserve unrelated writes, and reject incompatible downgrade/unsafe restore. |
| Checkpoint version pin | Complete a resumable run under v1, then attempt a schema-compatible v2 upgrade, including a provider-dependency upgrade. Block activation or explicitly migrate the checkpoint; restart/resume without concurrent versions or silent artifact substitution. |
| Remote uncertainty | Crash after remote success before local acknowledgment; deduplicate/reconcile, or expose uncertainty without blind replay or target changes. |
| Legacy compatibility | Replay Jira/Todo/host/checkpoint fixtures; preserve identifiers, task history, navigation links, and resumability or explicit blocked reasons. |
| Execution invariants | Human-only merges, publication gates, required clarification gates, concurrency limits, and budget accounting survive every extraction. |

Plugin failures in these gates mean handled failures unless explicitly testing process crash and safe-start recovery; sandbox-level containment is not implied.

## First implementation milestone

Complete A/B: a narrow host boundary with an externally packaged Costs replacement and a small external pricing provider, installed against production without source edits or rebuilds. Include usable packaging/docs, route reloads, explicit replacement, settings/storage, and unchanged usage recording.

Do not begin broad extraction until this passes. Complete C's lifecycle, storage, delivery, and recovery gates before extracting task providers. This proves both frontend and backend extensibility while keeping migration safety ahead of the features that depend on it.

### Implementation progress

The first Phase A increment introduces validated, immutable page manifests and a shared route/slot registry. Costs uses this registry for navigation and its canonical URL. Its renderer and controller now live under `src/plugins/costs`, with injected read/save/link services, and mount through the same generic lifecycle as other in-process page modules. Browser and server page recognition share the same route definitions. Missing selections remain unavailable rather than selecting a fallback, and scope changes or disposal cancel pending Costs reads and writes. Failed saves preserve drafts, and edits no longer suppress refreshes or period changes.

See [the experimental page-registry documentation](plugin-page-registry.md) for the current API and limitations. Frontend archive packaging/installation, persistent activation/bindings, immutable asset serving, lazy external module loading, and a separately packaged browser sample now work. UI safe mode skips optional page activation. See [package authoring and operations](plugin-packages.md). The runnable distribution includes compiled server/helper assets, native dependencies, and a standalone SDK. Full safe start bypasses normal provider composition and opens existing state read-only. The isolated full-server harness compiles external SDK packages, denies source access, installs through the compiled CLI, and exercises deep-link reload and recovery. See [distribution operations and acceptance evidence](distribution.md). Phase B adds independent Costs/pricing author projects, versioned usage queries, and namespaced backend settings/storage; see [backend authoring](plugin-backend.md). The SDK remains experimental.

Validation includes manifest/registry/module/lifecycle unit tests, Costs draft and stale-request regressions, route and application integration tests, and a Playwright production-preview harness with mocked APIs and a reviewed Costs screenshot. The separate distribution harness now supplies the isolated full-server gate. Archive recovery tests also terminate an installer after publication and inject catalog transaction failures, proving no partial activation.

## Review disposition

All twelve prioritized findings are incorporated as design requirements. This records plan changes, not implementation completion or renewed reviewer approval.

| Finding | Disposition in revision 2 |
|---|---|
| R1.1 — Composition contract | Section 2 defines slots, contribution IDs, bindings, aliases, collisions, and missing-layout preservation; minimum registries move to A. |
| R1.2 — Capability resolution | Section 2 separates dependencies/capabilities, defines cardinality, precedence, ambiguity, optional absence, and cycle handling; section 6 pins admission. |
| R1.3 — Work identity | Section 3 separates logical source/item identity from implementation and connection bindings and requires explicit adoption. |
| R1.4 — Backend proof | Section 4 and B require public usage queries and a separately packaged pricing provider with settings/storage. |
| R1.5 — Package compatibility | Sections 2/4 distinguish version domains and specify ESM, bundling, asset paths, runtime checks, restart policy, and single-version loading. |
| R1.6 — Frontend ownership | Section 4 defines container/CSS ownership, context updates, terminology, managed events, cancellation, and cleanup. |
| R2.1 — Phase prerequisites | A/B contain the minimal loader, registries, packager, harness, and author docs; remaining pages stay on legacy paths until extraction. |
| R2.2 — Recovery representation | Section 6 and C add dependency records, attachment handshake, blocked diagnostics, and preservation of uncertain running work. |
| R2.3 — Disable/upgrade lifecycle | Section 6 defines draining, desired enablement, obligation/artifact pins, resumable checkpoint retention, and upgrade restrictions. |
| R2.4 — Storage rollback | Section 6 establishes table ownership, migration coordination, additive schemas, WAL-consistent backups, and application-wide restore policy. |
| R2.5 — Durable effects | Section 6 and C require an outbox, immutable operation targets, leases, idempotency/reconciliation, and explicit uncertainty. |
| R2.6 — Trust/failure limits | Section 7 narrows containment guarantees and adds safe startup; section 4 specifies atomic archive installation and validation. |

### Final implementation-readiness review

A further independent review on 2026-09-20 found one additional prerequisite, accepted in revision 3:

- **R3.1 — Runnable host distribution:** The current build emits frontend assets only, while server startup and helper resolution use source files. Section 4, Phase A, and the external-installation gate now require a built server distribution with runtime helpers/dependencies and an isolated smoke test. No other material architecture blockers were reported.

_Helmsman · not reported - not reported_

## Independent reviews

Two separate agents reviewed revision 1 independently on 2026-09-20. Neither edited the plan or coordinated with the other reviewer. The reviews below are preserved as returned and refer to revision 1's section/phase numbering. Revision 2 incorporates their findings as mapped above; the reviews are historical assessments, not endorsements of this revision.

The agents received different review assignments:

- **Review 1 prompt:** Independently review this plan as a Senior Software Architect focused on extensibility and public API design. Inspect relevant current source. Challenge core/plugin boundaries, replacement semantics, capability resolution, version compatibility, framework neutrality, and whether outside authors truly avoid core edits. Identify concrete contradictions, missing decisions, and overengineering. Provide prioritized findings, actionable amendments, and acceptance gates, distinguishing observed facts from recommendations.
- **Review 2 prompt:** Independently review this plan as an implementation and reliability reviewer. Inspect relevant source and stress-test incremental rollout, dependency ordering, retained legacy data, active runs, restart/crash recovery, plugin disable/uninstall/upgrade, storage rollback, trust boundary, and packaging. Focus on how the plan could fail in production or stall before delivering external plugins. Provide prioritized findings, phase corrections, and adversarial validation gates, distinguishing evidence from proposed policy.

### Review 1 — Architecture and extension contracts

**Scope:** Independent architecture review of the proposal against current routing, layout persistence, agent contracts, telemetry, server delivery, and page lifecycle implementations. This review focuses on replacement by outside authors and the public API needed to support it.

**Verdict:** Proceed with the incremental approach, but amend the first milestone before implementation. The direction is sound; several required extension contracts remain implicit, and the Costs checkpoint currently proves less than the broader objective requires.

#### Prioritized findings

**1. High — Page replacement needs an explicit composition contract.**

**Observed:** Sections 2–4 describe page/panel registrations and provider bindings, but do not define how users select a replacement page, how plugins target panel slots, or who owns route aliases. [`src/logic/routes.ts`](../src/logic/routes.ts) contains feature-specific route fields and validators, including Jira ticket syntax and terminal surface formats. [`src/logic/rack.ts`](../src/logic/rack.ts) discards unknown panel IDs during deserialization.

**Impact:** Registering a component does not make it replaceable. A new task source could still require core edits for deep links, and a temporarily absent plugin could lose saved layout positions.

**Action:** Define namespaced contribution IDs separately from stable presentation slots, such as the default Costs page. Specify explicit slot bindings, route ownership and collision rejection, plugin-owned route-state validation, and preserved placeholders for missing contributions. Move the minimum registry work from Phase D into Phase A; Phase B depends on it.

**2. High — Capability discovery and provider selection are underspecified.**

**Observed:** Sections 2–3 promise required/optional capabilities and bindings at multiple scopes, but provide no resolution rules. The coexistence problem is real: [`server/helmsman/main.ts`](../server/helmsman/main.ts) rejects Todo launches when Jira is enabled, and [`src/main.ts`](../src/main.ts) redirects away from Todos in that configuration.

**Impact:** Without cardinality and precedence rules, two valid plugins can yield ambiguous services or inconsistent execution across UI, scheduler, and recovery.

**Action:** Distinguish package dependencies from capability requirements. Each capability contract should declare its version and whether consumers select one provider or enumerate many. Specify binding precedence, connection selection, cycle rejection, and behavior for absent optional providers. Fail an ambiguous required binding with a diagnostic; do not select by installation order. Persist the resolved binding when work is admitted.

**3. High — Logical work identity should survive implementation replacement.**

**Observed:** Section 3 proposes `WorkRef.providerId`, `connectionId`, and `externalId`, without defining whether `providerId` identifies a plugin package, a provider instance, or a stable source namespace. Section 6 separately requires exact plugin versions for recovery. [`server/helmsman/agents/adapter.ts`](../server/helmsman/agents/adapter.ts) currently mixes task identity with Jira context and execution parameters.

**Impact:** Two Jira implementations could address the same issue under different identities, producing duplicate claims or disconnected history. Changing a default provider could accidentally redirect existing work.

**Action:** Define durable source/connection identity separately from the selected plugin implementation and version. Specify how a replacement explicitly adopts an existing connection, including compatibility validation. Existing work keeps its recorded binding unless deliberately migrated. Replace Jira-specific task fields with a neutral task snapshot plus provider-owned context.

**4. High — An external Costs view alone cannot validate backend extensibility.**

**Observed:** Phase B proves presentation replacement, while backend/provider extraction starts later. Current [`server/helmsman/run-telemetry.ts`](../server/helmsman/run-telemetry.ts) requires `OutcomeStore` to record and aggregate usage. [`server/helmsman/cost-estimates.ts`](../server/helmsman/cost-estimates.ts) imports types from frontend outcomes data.

**Impact:** A successful external view might merely wrap a feature-specific HTTP endpoint while core services still depend on the bundled feature. It would not establish that an independent backend provider can be installed without source edits.

**Action:** Give Phase B a public usage query contract owned by the durable telemetry boundary. Before calling the architecture validated, add a small separately packaged backend contribution—such as an alternative pricing provider—with settings and storage. Keep this bounded; do not design all execution contracts at this stage.

**5. Medium — Package compatibility needs more than an SDK version range.**

**Observed:** Sections 2, 6, and 7 mention SDK compatibility, archives, and retained plugin versions, but leave the runtime format and resolution policy unspecified. [`package.json`](../package.json) currently builds a single Vite application; [`server/helmsman/main.ts`](../server/helmsman/main.ts) serves a fixed set of page paths and files from `DIST`.

**Impact:** Independently compiled plugins need a loader and asset-serving contract. Retaining old execution plugins also raises questions about simultaneous versions and their transitive dependencies.

**Action:** Before Phase B, document browser module format, backend runtime requirements, SDK import resolution, asset URLs, dependency bundling, and activation/restart behavior. Distinguish manifest, SDK, capability, and persistence versions. Permit only one UI version per plugin initially; explicitly specify how retained execution versions are loaded or isolated.

**6. Medium — Framework neutrality needs styling and interaction boundaries.**

**Observed:** Section 4 specifies `mount → update → dispose`, but no CSS or event-ownership contract. [`src/renderCampaigns.ts`](../src/renderCampaigns.ts) directly imports application terminology and CSS and renders shared classes such as `panel`.

**Impact:** A React plugin could mount successfully yet depend on undocumented styles, collide with document-level handlers, or miss theme and terminology changes.

**Action:** Publish the container ownership rule, CSS scoping convention, theme tokens, terminology extension mechanism, scope updates, and disposal expectations. Start with scoped DOM/CSS conventions; introduce a broader component library only when extractions demonstrate the need.

#### Recommended plan amendments and acceptance gates

Add a short “v1 contract decisions” deliverable to Phase A covering findings 1–3 and 5–6. Defer the proposed directory reorganization until a working extraction demonstrates necessary package boundaries.

Require these gates before broad migration:

- A plugin built outside this galleon installs into a production build, serves its assets, and survives a direct deep-link reload.
- Two implementations can target the same presentation slot; selection is explicit and reversible.
- Disabling and restoring a plugin preserves layout positions and route state.
- Two task providers coexist, and ambiguous bindings produce actionable errors.
- Replacing a provider preserves logical work identity while existing runs retain their implementation binding.
- An external backend contribution uses only published contracts.
- Dependency checks reject private cross-package imports from first-party plugins.

_Helmsman · not reported - not reported_

### Review 2 — Migration, reliability, and delivery

**Scope:** Independent review of migration sequencing, durable state, recovery, plugin lifecycle, packaging, and operational failure modes. Checked the proposal against startup, recovery, run storage, task storage, telemetry, workflow snapshots, and build configuration. References describe inspected code; lifecycle corrections below are proposed policy.

**Verdict:** Proceed with incremental extraction, but tighten the first milestone and move minimum persistence and recovery contracts ahead of task-provider extraction. The plan identifies the right risks, yet several completion gates depend on infrastructure scheduled later.

#### Prioritized findings

1. **High — The phase order postpones prerequisites for its own acceptance gates.**  
   **References:** Sections 4–5; [`package.json`](../package.json); [`server/helmsman/main.ts`](../server/helmsman/main.ts).  
   **Evidence:** Phase B requires installation of an external Costs panel, while dynamic shell lists arrive in D and the development loader, packaging tools, and author harness arrive in G. The current application builds through `tsc && vite build`; server page routing also contains a fixed route expression.  
   **Impact:** B could produce a demonstration that secretly depends on source-tree imports, build-time discovery, or special routing. Conversely, A’s requirement to put every existing page through the new host could become a broad rewrite before extensibility is demonstrated.  
   **Correction:** Move minimum dynamic panel registration, artifact loading, SDK declarations, packaging, and a standalone sample into A/B. Limit A’s compatibility wrapper to the shell and Costs surface. Keep existing pages operational and migrate their registrations progressively. Require installation into a production build from an author directory outside the application checkout.

2. **High — Recovery currently cannot represent the proposed missing-plugin condition reliably.**  
   **References:** Sections 5–6; [`server/helmsman/recovery.ts`](../server/helmsman/recovery.ts); [`server/helmsman/main.ts`](../server/helmsman/main.ts); [`server/helmsman/db.ts`](../server/helmsman/db.ts).  
   **Evidence:** `recoverRuns` reports a run as reattached immediately after dispatch and suppresses asynchronous rejection; its returned `failed` array remains empty. `dispatchReattach` resolves current configuration. `RunStatus` has no recovery-blocked state.  
   **Impact:** A missing provider could leave a run apparently running without usable monitoring, termination, or an actionable explanation. Retaining a package version alone does not preserve its dependency resolution, connection identity, or configuration.  
   **Correction:** Before C, persist an execution dependency record containing artifact hashes, provider bindings, connection identifiers, and compatible configuration snapshots. Define a separate recovery condition for blocked reattachment, with diagnostic reason and retry. Distinguish successful attachment from eventual run completion. Preserve external processes and worktrees while dependency recovery is blocked.

3. **High — Disable, uninstall, and upgrade need one coherent transition model.**  
   **References:** Sections 3 and 6; [`server/helmsman/main.ts`](../server/helmsman/main.ts).  
   **Evidence:** The proposal says disable removes registrations and background work while active runs retain required plugins. Existing run finalization directly calls `todos.finishRun` and schedules created-PR review polling.  
   **Impact:** An active run may finish after its task provider or dependent service has been disabled, losing the task update or subsequent review obligation. Removing a retained artifact may break recovery after restart.  
   **Correction:** Define installed, active, draining, disabled, and failed states. Disable should immediately reject new launches and remove presentation while retaining execution-scoped services required by existing obligations. Track references from runs, pending side effects, and dependencies; garbage-collect artifacts only after those references expire. For v1, allow upgrades requiring incompatible shared storage to wait until draining completes instead of promising universal concurrent versions.

4. **High — Storage rollback could damage unrelated features.**  
   **References:** Section 6; [`server/helmsman/main.ts`](../server/helmsman/main.ts); [`server/helmsman/db.ts`](../server/helmsman/db.ts); [`server/helmsman/todos.ts`](../server/helmsman/todos.ts); [`server/helmsman/run-telemetry.ts`](../server/helmsman/run-telemetry.ts).  
   **Evidence:** Multiple stores open the same database path and perform schema initialization themselves. Telemetry writes lifecycle records through one connection and usage through the outcomes store.  
   **Impact:** Restoring a whole database backup to undo one plugin upgrade could discard newer runs or another plugin’s writes. Separating databases immediately would introduce additional cross-store consistency problems.  
   **Correction:** Assign table ownership and migration authority before extraction. Prefer additive migrations and compatibility views/adapters initially; introduce a migration ledger and exclusive migration coordination. Define backup restoration as an application-wide recovery procedure unless narrowly scoped restore is proven. Preserve legacy task identifiers and launch payload decoding explicitly, with fixture-based migration tests.

5. **High — “Durable delivery and idempotency” needs an executable protocol.**  
   **References:** Section 6; [`server/helmsman/runner.ts`](../server/helmsman/runner.ts); [`server/helmsman/main.ts`](../server/helmsman/main.ts).  
   **Evidence:** Jira transitions occur as runner side effects, and Todo completion runs during finalization. These responsibilities cross the proposed provider boundary.  
   **Impact:** Crashing after an external operation but before acknowledgment can duplicate publication or leave work permanently claimed. Provider replacement can accidentally redirect an outstanding operation.  
   **Correction:** Before C, define durable operation IDs, immutable target bindings, retry ownership, and reconciliation for APIs without idempotency support. Persist the operation intent alongside the originating state transition where possible. Retain pending operations across disable and expose unresolved reconciliation in recovery controls.

6. **Medium — Trusted plugins limit the failure-containment guarantee.**  
   **References:** Sections 7–8.  
   **Evidence:** The proposal correctly acknowledges full application privileges, but also says failed plugins leave the shell usable.  
   **Impact:** An in-process backend plugin can crash the server; same-context browser code can block rendering. Integrity checks verify bytes, not trustworthiness.  
   **Correction:** Scope v1 containment guarantees to handled activation, registration, and asynchronous failures. Provide startup with third-party activation disabled through a CLI/config switch. Specify atomic installation, archive traversal/symlink rejection, dependency pinning, and explicit activation after validation. Stronger crash containment requires a separate runtime decision.

#### Recommended phase changes

Make A/B one narrow, externally installable vertical slice. Move the lifecycle state machine, legacy execution decoding, operation delivery contract, and recovery diagnostics before C. Let F generalize execution capabilities after those invariants already exist. Treat G as SDK polish and broader documentation, not the first usable author workflow.

#### Adversarial validation gates

- Install a packaged Costs alternative against a production application with application source unavailable.
- Crash during archive extraction, migration, activation, and activation rollback; restart into a usable plugin manager.
- Disable a task provider during execution, finish the run, restart, and verify exactly one durable task-completion obligation.
- Restart with the recorded provider missing; preserve the process and worktree and expose a recoverable blocked condition.
- Upgrade one plugin while another records usage; reject unsafe rollback without losing either feature’s writes.
- Replay legacy Jira/Todo records and crash after remote success but before local acknowledgment; reconcile without changing the target provider or duplicating publication.

_Helmsman · not reported - not reported_

### Page lifecycle implementation review

Two independent reviews covered registry/routing and Costs lifecycle/state behavior. The registry review found no material issues. The Costs review found draft loss after failed saves, late save failures affecting disposed or differently scoped pages, and refresh/period changes suppressed by an editing flag. The extracted controller now owns scoped, revisioned drafts and cancellable reads/writes; regression tests cover those cases. Generic host tests cover async mount retirement, serialized updates, module removal, hidden-page refresh, cleanup, and lifecycle failure containment. Follow-up review also fixed refresh waiters remaining blocked after a never-resolving lifecycle was retired, and contained asynchronous cleanup rejections. Post-commit review found that malformed successful assessment responses could clear drafts before rendering failed; response validation now rejects invalid or mismatched assessments before treating a save as successful.

_Helmsman · not reported - not reported_

### External page package implementation review

Two independent reviews covered host lifecycle/routing and Costs API/controller boundaries. The host review found no material defects. The Costs review found incomplete summary validation admitting missing fields, malformed nested assessments, and nonnumeric counters into rendering. Validation now covers the consumed summary schema; regressions prove initial read errors remain recoverable and failed refreshes preserve drafts.

The Phase A continuation adds bounded archives, an installation CLI, transactional activation/binding records, immutable assets, lazy browser imports, and a standalone sample. Follow-up review caught raw asset traversal being normalized into a page route before rejection; the HTTP handler now rejects those requests before SPA routing. Browser tests exercise copied external packages against the built frontend and real catalog/asset handlers. The isolated runnable-server gate remained outstanding at that increment and is covered by the completion entry below.

_Helmsman · not reported - not reported_

### Phase A completion review loop

Independent agents implemented the runnable distribution/SDK and full safe start, reviewed each other's changes, and added acceptance coverage for installation crashes and recovery without frontend assets. Review found that replacing a generated release could delete runtime state written inside it; the builder now verifies its generated inventory around replacement and retains prior distributions as backups. Native runtime metadata records matching OS, architecture, Node major, and ABI.

The completion harness compiles a separately authored TypeScript page against the standalone SDK, packages/installs it using the compiled CLI, denies access to application source, and tests the real server in Chromium. Safe mode preserves active rows and artifacts, exposes core recovery independently of frontend code, and invokes no provider commands. Runtime helper checks exercise native storage, workflow preparation, coordinators, and the run wrapper from unrelated working directories.

At Phase A completion, Costs was an explicit temporary host adapter: it shared the page lifecycle but still used private legacy domain/renderer services. Phase B retires that exception through the versioned usage-query boundary and independently packaged Costs/pricing implementations. No broader task-provider or execution SDK is claimed complete in Phase A.

Completion validation passed: TypeScript and production build, 2,859 unit tests across 174 files, 10 browser/visual tests, six distribution checks, and two isolated production-server browser tests. Independent follow-up review confirmed that inventory validation and retained backups resolve the release replacement finding without remaining material issues.

Post-commit review found Unix-only path checks in Docker coordinator routing and workspace cleanup. The follow-up uses shared coordinator recognition for both path separators, platform-aware workspace dispatch, and portable distribution assertions, with Windows-path regressions. All 48 focused runtime/Docker/adapter tests passed, followed by TypeScript/build and another full distribution validation run.

_Helmsman · not reported - not reported_

### Phase B implementation review loop

Independent agents extracted durable usage recording/querying, the public Costs implementation, and backend pricing/settings/storage. Costs now owns its renderer, terminology and scoped styles and builds independently against the same SDK used by external authors. The distribution includes full/alternative Costs and standard/flat pricing author projects. Public report APIs omit legacy fixed-policy estimates; selected pricing is separate from measured spend and budget values.

Cross-review corrected UTC normalization, invalid/duplicate pricing details, mismatched usage snapshots, optional backend startup containment, activation storage rollback, Unicode quota accounting, removed-setting recovery, and large pricing-result handling. Final audit also delayed combined frontend/backend package publication until successful backend activation. The isolated server test exercises explicit independent replacements, retained settings/storage, missing selected providers without fallback, and continued telemetry recording with selected Costs/pricing disabled. A reviewed screenshot reflects generic selected-provider pricing and unavailable-provider copy while preserving the Costs layout.

Backend plugin data remains in the plugin directory's namespaced database, separate from core run/usage data. Phase C must use durable core intents and idempotent projections for cross-store obligations; no cross-database atomicity is claimed. General dependency closure, durable draining, execution bindings, migration coordination, and provider extraction remain Phase C and later work.

_Helmsman · not reported - not reported_

Phase B completion validation: 2,968 unit/integration tests across 182 files; TypeScript and production build; 10 browser/visual tests; six distribution checks; three isolated compiled-server browser tests.

Post-commit review found that shared client validation incorrectly assumed cached input tokens are included in newly read input tokens for every provider. Claude records those separately. The shared relationship check was removed while provider-specific pricing validation remains; 39 focused tests, TypeScript/build, and the isolated full-server flow with a Claude usage event passed.

_Helmsman · not reported - not reported_

### Phase C implementation review loop

Independent persistence/lifecycle and host/effects reviews found and fixed ownership races, stale lease finalization, retry/checkpoint pin transfer, mutable connection substitution, nonretryable redelivery, remote-write authorization after stop, old-attempt publication reconciliation, and cleanup of terminal retained workspaces. A further review caught startup mutations before exclusive ownership and loss of stop intent across restart. Startup now claims ownership before initialization; stop requests are persisted per attempt and observed at launch, publication, and recovery boundaries.

The core recovery page, additive legacy audit, retained runtime artifacts, shared transactions, durable effect adapters, and offline three-database backup are implemented behind existing providers. Legacy executable bindings are not invented: records without historical runtime or ownership evidence stay protected and blocked. Checkpoint migration requires an exact-provider validator; storage compatibility alone cannot authorize rebinding. The operator flow is documented in [recovery.md](recovery.md).

Publication tests exercise a real coordinator process, authenticated local gateway, durable operations, and real Git against isolated fixtures. Distribution tests deny access to the application source and verify protected recovery across restart, second-instance rejection, retained gateway addressing, and live-writer backup rejection. The [completion ledger](plugin-implementation-progress.md) records final validation and commit status; Phase D extraction remains gated on that evidence.

_Helmsman · not reported - not reported_
