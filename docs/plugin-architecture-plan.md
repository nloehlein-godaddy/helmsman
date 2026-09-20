# Helmsman plugin architecture plan

Date: 2026-09-20  
Status: Proposed; implementation has not started.

## Objective and recommendation

Make nearly every feature independently installable, replaceable, and removable without modifying Helmsman source. This includes Jira, Slack, Todos, Helm and its individual panels, Costs, and other pages and integrations.

Migrate incrementally to a small core plus replaceable plugins. A ground-up rewrite would put working run recovery, review gates, and integrations at risk without making the plugin architecture better. Preserve existing implementations behind new contracts, then extract them one feature at a time.

The main obstacles are concentrated:

- [`src/main.ts`](../src/main.ts) owns most frontend behavior, state, requests, and lifecycle management.
- [`server/helmsman/main.ts`](../server/helmsman/main.ts) wires integrations, stores, providers, background work, and launch dispatch.
- [`src/logic/routes.ts`](../src/logic/routes.ts) and [`src/logic/rack.ts`](../src/logic/rack.ts) define closed lists of pages and panels.
- [`server/helmsman/router.ts`](../server/helmsman/router.ts) knows individual features and their dependencies.
- [`server/helmsman/agents/adapter.ts`](../server/helmsman/agents/adapter.ts) includes Jira-specific task fields; runner and recovery paths know specific providers.

Existing agent adapters, run hosts, data clients, store factories, and mounted page lifecycles provide useful starting boundaries. Jira and Todos currently cannot launch work simultaneously. Making features replaceable requires changing those domain assumptions, beyond adding a plugin loader.

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

The plugin manager and recovery controls remain available even when every optional feature is disabled.

Disabling Costs must not stop usage recording or budget enforcement. Hiding the Runs page must not stop active runs. Presentation plugins may be replaced independently of the services that record or execute work.

## 2. Establish a public plugin contract

A plugin is an independently built package containing a manifest, optional frontend/backend entry points, and its own assets. Installing one must not require editing or rebuilding Helmsman source.

The manifest declares:

- Stable plugin ID, version, and supported SDK versions.
- Required and optional capabilities.
- Pages, panels, commands, settings, and backend services.
- Requested access, storage schema version, and activation conditions.

Use separate contracts for presentation and providers:

| Contract | Responsibility |
|---|---|
| Page / panel | Mount, receive scope changes, refresh, dispose |
| Task source | Find work, load details, claim it, update lifecycle |
| Code host | Read changes, publish PRs, submit reviews |
| Messaging | Receive events and send explicitly authorized messages |
| Agent provider / execution host | Build commands, interpret output, launch, monitor, stop |
| Workflow / pricing provider | Define execution stages or supply cost estimates |

Avoid designing every contract upfront. Stabilize each against actual extractions and at least two implementations. Plugins communicate through versioned services, commands, and events, rather than imports from another plugin's implementation. Validate data at plugin boundaries; TypeScript types alone do not validate external values.

## 3. Make replacement an explicit feature

Installing two providers is different from selecting which one a workflow uses.

Add explicit bindings for task sources, agents, messaging, and execution hosts, configurable globally and where appropriate per galleon or workflow. Allow Jira and Todos to coexist.

Use source-neutral work identities, for example:

```ts
type WorkRef = {
  providerId: string;
  connectionId: string;
  externalId: string;
};
```

Jira-specific URLs, IDs, and transitions belong to the Jira plugin.

Separate these user actions:

- **Hide a panel:** change presentation.
- **Disable a plugin:** stop its registrations and background work.
- **Replace a provider:** change an explicit binding.
- **Uninstall:** remove its package, retaining data unless deletion is requested.

Replacing a Todos UI should preserve its task provider. Replacing the task provider may require a data migration; the architecture should make that distinction visible.

## 4. Build the host and SDK

Introduce packages along these lines:

```text
apps/helmsman/
packages/plugin-sdk/
packages/plugin-testkit/
packages/core/
plugins/helm/
plugins/todos/
plugins/jira/
plugins/slack/
plugins/costs/
```

First-party plugins may remain in this galleon for development, but must build against the same public SDK available to external authors.

The host supplies:

- Registration for navigation, pages, panels, settings, and namespaced backend endpoints.
- Read-only header scope, with explicit panel-local overrides that never change the header scope.
- Theme tokens, terminology, accessible UI primitives, and notifications.
- Namespaced storage, validated settings, and credential access.
- Managed subscriptions, timers, cancellation, and cleanup.
- Compatibility checks, dependency resolution, health reporting, and activation failures.

Keep the frontend framework-neutral with a `mount → update → dispose` boundary. Helmsman currently uses vanilla TypeScript; adopting React is a separate decision. Plugin authors could bundle React internally.

## 5. Migrate in phases with concrete exit criteria

| Phase | Work | Completion gate |
|---|---|---|
| **A. Foundation** | Introduce SDK, manifest validation, contribution registries, lifecycle management, and adapters around existing features. | Existing pages retain their URLs and behavior through the new host. |
| **B. First external plugin** | Extract Costs presentation; decouple durable telemetry from optional outcomes processing. Create a separately packaged alternative Costs panel. | Install and select the alternative without modifying Helmsman source. Disable it without losing usage history. |
| **C. Task sources** | Extract Todos end to end, introduce source-neutral work references, then extract Jira. | Both sources operate simultaneously; switching providers requires configuration only. |
| **D. Shell and Helm** | Replace fixed navigation, route, and panel lists. Extract Helm and register each panel independently. | Users can replace Helm or individual panels; saved layouts survive missing plugins. |
| **E. Remaining features** | Extract Slack, PR views, terminal UI, campaigns, clarifications, bugs, and triage using established contracts. | Each feature owns its settings, requests, subscriptions, and cleanup. |
| **F. Execution extensions** | Generalize agent providers, execution hosts, workflows, scheduling, and recovery. | Runs survive restart using their recorded provider and workflow versions. |
| **G. Author experience** | Publish SDK, templates, development loader, test harness, packaging tools, and compatibility documentation. | An external author builds a useful plugin using published documentation alone. |

Phase B is the architectural checkpoint. If the external plugin still needs private imports or core edits, fix the boundary before extracting more features.

## 6. Specify lifecycle and persistence before enabling removal

These rules prevent disabling a feature from corrupting ongoing work:

- Disable blocks new work, cancels background polling, and removes contributions.
- Active runs retain their required plugin versions until they finish; immediate termination is a separate action.
- Required dependencies cannot disappear silently. Show affected consumers and block incompatible changes.
- Run snapshots record plugin versions, provider bindings, workflow configuration, and artifact identities.
- Recovery never substitutes a different provider when the recorded one is missing.
- Storage migrations are versioned and backed up. Package rollback is permitted only when its data remains compatible.
- Disabled plugins retain their data, settings, and layout positions.
- Reliable workflow side effects use durable delivery and idempotency; an in-memory UI event bus is insufficient.

Preserve existing URLs through compatibility aliases and migrate persisted tasks and runs incrementally.

## 7. Choose the trust model deliberately

There are two viable scopes:

| Option | Tradeoff |
|---|---|
| **Trusted installed plugins — recommended for v1** | Smaller implementation; operators explicitly trust installed code with application privileges. |
| **Sandboxed third-party plugins** | Requires isolated browser execution, restricted backend runtimes, and brokered filesystem/network access. More work and a narrower API. |

A permission manifest, iframe-free mount API, or ordinary child process does not make arbitrary code safe. Design SDK messages to support later isolation, but describe v1's trust boundary accurately.

For initial distribution, support local development packages and version-pinned plugin archives with integrity checks. Defer a marketplace and automatic updates.

## 8. Validate the architecture through behavior

Each extraction should pass TypeScript, production build, relevant unit/integration tests, and browser visual tests. Add a browser test harness early; the current setup is primarily Vitest/jsdom.

The important acceptance cases are:

- Third-party plugin installation requires no core changes.
- Jira and Todos coexist.
- Header galleon scope propagates correctly; panel overrides remain local.
- Disabled plugins stop requests, timers, and subscriptions.
- Late responses cannot revive disabled views.
- Missing or failed plugins leave the shell usable.
- Plugin upgrades preserve data and active-run recovery.
- Human merge gates, publication checks, and budget limits remain enforced.
- Existing layouts, terminology modes, navigation, and keyboard behavior remain intact.

## First implementation milestone

Deliver the plugin host plus an externally packaged Costs replacement. That proves extensibility before committing to a broad migration.

## Independent reviews

Two separate agents reviewed the proposal independently on 2026-09-20. Neither edited the plan or coordinated with the other reviewer. The reviews below are preserved as returned; their recommendations are not automatically accepted amendments to the proposal.

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
