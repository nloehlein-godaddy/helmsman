# Phase C implementation design

Status: proposed implementation, dependent on passing Phase B gates. This document implements all of [architecture plan section 6](plugin-architecture-plan.md#6-define-lifecycle-persistence-and-recovery-protocols) behind existing providers. It does not extract task sources or generalize execution plugins early. Phase C is complete only when the acceptance matrix below passes.

## Current seams and gaps

- `recovery.ts` reports reattachment before its promise resolves and suppresses rejection. `runner.ts`, `resume.ts`, and application finalizers can classify attachment failure as execution failure, remove worktrees, and release reservations.
- `startRun` and continuation launch persist a concrete host reference after launch. There is no durable attempt launch identity or discovery handshake. Docker recognizes a run label, but currently reclaims stopped containers by run ID; retries require distinct attempt identities.
- `application.ts` restores adapters and Jira actions from current configuration. Historical bindings, connection identity, and dependency closure are not retained.
- `plugins/store.ts` retains an enabled flag and one selected artifact. Runtime pins, checkpoint pins, draining, and migration coordination do not exist.
- Existing stores open independent SQLite connections. Most share `HELMSMAN_DB`; `catalog.sqlite` and `plugin-data.sqlite` are separate databases. A transaction on one store does not include calls on another connection.
- Runner callbacks publish reviews, transition Jira, and schedule follow-up reviews directly. Pre-PR publication also occurs in `pre-pr-runtime.ts`; wrapping runner completion alone would miss it. Slack already distinguishes uncertain delivery and must retain that behavior.

## Core persistence and transaction boundary

Introduce `persistence.ts` for a host-owned shared database connection, migrations, and synchronous transactions. Adapt existing stores to borrow this connection where core state and obligations must commit together; borrowers never close it. Keep current tables and their IDs. Constructors used independently by tests may create an owned connection through the same migration coordinator.

Add the following additive records in the main database. Version and validate every serialized payload on read, and verify hashes against canonical content and row identity.

| Record | Required contents and invariant |
|---|---|
| `execution_snapshots` | Immutable snapshot ID/hash; run and attempt; logical source identity; normalized task; workflow snapshot/revision; selected agent/host/provider IDs; exact artifact hashes and transitive dependency edges; capability contract versions; non-secret settings allowlist; schema compatibility requirements; connection IDs and credential handles. No secret values. |
| `execution_attempts` | Unique run/attempt and durable launch ID; snapshot ID; preparation state; host reference; attachment health; diagnostic code/details; owner/lease generation; process outcome evidence. Preserve existing `runs.status` as execution status. |
| `execution_reservations` | Durable run/galleon ownership and reason; required while prepared, alive, uncertain, or blocked with unresolved ownership. Global and per-galleon concurrency consult these records before admission. |
| `execution_checkpoints` | Snapshot/attempt and immutable artifact references; resumable/retired state; validated checkpoint format. A terminal run may still own a resumable checkpoint. |
| `artifact_pins` | Exact artifact plus obligation owner/type: execution, checkpoint, operation, or dependency. Unique ownership edges make replay idempotent; compute retention from edges rather than an unverified counter. |
| `plugin_lifecycle` | Desired enablement, selected artifact, runtime health, diagnostic, and lifecycle revision. Derived public state is installed/active/draining/disabled/failed. |
| `binding_migrations` | Append-only old/new snapshot linkage, provider validation receipt, checkpoint evidence, actor/reason/time. Preserve original snapshots and historical provenance. |
| `operations` and `operation_attempts` | Unique logical operation key, origin/revision, immutable provider/artifact/connection/target, payload version/hash, dependency operations, status, retry policy, lease generation/expiry, remote receipt and reconciliation evidence. |
| `migration_ledger` and `migration_steps` | Database identity, owner, migration ID/checksum, from/to schema versions, resumable preparation state, transaction result, compatibility declarations. |
| `persistence_intents` | Cross-database catalog/data projection intent, stable operation ID, desired revision and applied acknowledgments. Admission stays blocked until projections agree. |

Expose narrow core transactions: `prepareExecution`, `recordLaunch`, `recordAttachment`, `recordProcessOutcomeAndOperations`, `retireCheckpoint`, and lifecycle transitions. Do not expose arbitrary SQL to plugins. The `prepareExecution` transaction checks lifecycle/schema/closure eligibility, allocates the reservation, stores the snapshot/attempt, and acquires every required pin together. Origin state changes and outbox insertion use one shared connection and transaction.

Keep plugin catalog/data files in place for this phase. Core lifecycle intent is authoritative for admission and retention; apply catalog/data projections idempotently by revision and reconcile before activation. CLI mutations use the same coordinator and lock protocol. Never overwrite the only retained artifact when selecting a new one. If the main database is inaccessible, recovery commands may inspect diagnostics but must reject destructive package changes.

Legacy agent/host/workflow/provider implementations receive explicit compatibility adapter identities backed by a retained host distribution artifact or verified installed build digest. A synthetic name alone is not executable retention. Missing historical implementation bytes cause blocked recovery; the current default is never silently substituted.

## Launch, attachment, and recovery

1. At startup, open and validate persistence, reconcile migrations/intents, decode legacy records, reconstruct reservations and pins, then activate obligation-scoped services. Only afterward run Todo reconciliation, orphan worktree cleanup, optional polling, or new admission. Safe start reconstructs blockers and exposes controls without executing optional providers.
2. Before worktree or host side effects, persist a prepared attempt and intended paths. Preparation steps are resumable and recorded. A prepared record that never entered host launch can safely continue preparation once dependencies are available.
3. Persist `launching` before calling the host with a unique `launchId` for that run attempt. Host discovery returns `found(ref, ownershipEvidence)`, `definitelyAbsent`, or `unknown`. Only definitive absence allows starting the same launch identity. A timeout or unavailable host is unknown, never proof of absence.
4. Record the returned host reference before attachment. Recovery includes prepared/launching attempts, not only `runs.status = running`. Deduplicate concurrent recovery by lease generation and compare-and-set writes.
5. Change reattachment to return a handshake result and a separately observed completion promise. Health is `pending`, `attached`, `blocked`, or `failed`; failures identify the attachment stage. Do not await the whole voyage to mark attachment successful, and do not mark execution terminal because attachment failed.
6. Resolve services from the snapshot, validate actual loaded artifact/schema closure, rehash the workflow snapshot, and resolve credentials for the pinned connection identity. Live credential rotation is allowed only for that connection. Missing/revoked credentials or unavailable dependencies block the affected work with a retryable diagnostic.
7. Preserve processes, logs, worktrees, checkpoints, pins, and reservations while ownership/liveness is unknown. Replace unconditional cleanup in `reattachRun`, `completeRun`, `resumeFailedPrePrRun`, and application `.finally` handlers with an eligibility decision. Cleanup requires proven process termination and no checkpoint/operation that still needs the resources.

Host adapters remain legacy implementations in C. Extend their internal contract with discovery/ownership evidence now; publish generalized host contracts in F. Detached wrappers write an atomic ownership receipt containing launch ID, wrapper PID, and process-start identity before spawning the worker; a PID alone is insufficient because it can be reused. The parent spawn-to-receipt crash gap remains unknown until verified, never automatic relaunch. Use launch ID in Docker labels/names and verify stopped containers and exit markers before reclaiming them. For cmux/WezTerm, inspect exact workspace/pane metadata where reliable; otherwise block ambiguous launches and expose reconciliation. Exit markers must be tied to an attempt so a prior attempt cannot complete a new one.

Continuation validates the retained checkpoint bindings before archiving files or incrementing the attempt. Prepare the new attempt and recovery intent before any file mutation. A launch error with uncertain remote success must not roll back spec/exit files beneath a potentially running process. Retry as new work and resume from a checkpoint remain distinct operations.

Core recovery endpoints and a core-owned view expose attachment state, missing bindings, protected resources, pending/retrying/blocked/uncertain/completed effects, and affected consumers. Actions are retry attachment, reconcile effect, restore compatible artifact, explicit checkpoint retirement, and stop/abandon with evidence. An unavailable provider may prevent stop; retain the reservation and show that result. Abandonment does not assert that an unknown process stopped. Operator effect resolution is append-only and requires evidence/reason; it never silently changes the operation target. This surface remains available in safe start and does not change header scope.

## Lifecycle, upgrades, and checkpoint migration

Disable immediately removes UI and ordinary polling and rejects new admissions. Retain only services authorized for existing obligations. Persist desired disabled even if a draining provider subsequently fails; recovery may reactivate it only to settle those obligations. A required dependent either blocks disable with an affected-consumer list or is explicitly included in the drain operation. Timeouts never authorize process termination or checkpoint retirement.

Pins include transitive provider dependencies, pending external effects, active/blocked attempts, and every resumable checkpoint. Completion can release an execution pin only after creating any required checkpoint/effect pins atomically. Historical provenance survives eventual executable artifact collection.

Upgrade planning examines the entire affected dependency closure before changing selection. V1 loads one version of each plugin. An old retained checkpoint blocks a conflicting new version even when storage schemas are compatible. Installed candidate bytes may be staged without activating them. A provider-supported checkpoint migration must validate execution state, artifact evidence, contracts, and schemas; append migration provenance and switch effective checkpoint bindings/pins atomically. No migration support means upgrade stays blocked until explicit retirement. Migration validation must not require concurrently activating two versions; use the currently loaded provider's supported migration interface or an offline declarative validator. Uninstall and garbage collection reject all referenced artifacts and cannot bypass dependent pins.

## Storage ownership, migration, and rollback

The host migration coordinator is the sole DDL authority. Feature ownership is recorded now even while legacy adapters remain in core.

| Database / tables | Data owner |
|---|---|
| Main: `runs`, `run_events`, `config_overrides`, new execution/lifecycle/operation/migration records | Core |
| Main: `outcome_usage`, `run_lifecycle`, `run_capabilities` | Core measured usage, telemetry, and scoped credentials |
| Main: `workflow_definitions`, `workflow_snapshots` | Workflow compatibility adapter; core retains execution references |
| Main: `todos` | Todos compatibility adapter |
| Main: `outcome_assessments` | Outcomes compatibility adapter |
| Main: `slack_sources`, `slack_notifications`, `slack_dispatch_claims`, `slack_review_requests` | Slack compatibility adapter, including existing created-PR queue bridge |
| Main: `voyage_notification_reads` | Notifications compatibility adapter |
| Main: `clarifications`, `trusted_contacts` | Clarifications compatibility adapter |
| Main: `campaigns`, `campaign_phases`, `campaign_previews`, `campaign_tasks` | Campaigns compatibility adapter |
| Main: `webhook_deliveries` | Webhook compatibility adapter |
| Catalog: `plugin_packages`, `plugin_bindings` | Core package registry |
| Plugin data: `plugin_storage_versions`, `plugin_storage`, `plugin_settings`, `capability_bindings`, `backend_meta`, `builtin_plugins` | Core namespace/binding authority; each plugin owns its namespaced values |

Inventory actual schemas with `PRAGMA table_info` before recording a legacy baseline; unknown/incompatible schemas block migration rather than being labeled current. Move constructor DDL behind the coordinator so opening an old store cannot bypass migration locking. In-process exclusivity plus SQLite `BEGIN IMMEDIATE` protects each transactional DDL sequence; all host/CLI migration paths honor a shared activation/write barrier, including other processes. Detect conflicting active writers and refuse incompatible maintenance rather than relying on an in-memory flag. Recheck loaded and retained consumer schema ranges under the lock.

Transactional migrations are additive and record the applied checksum/version in the same commit. Stage non-transactional preparation separately, persist resumable steps, and expose failed preparation without activating partial state. Coordinate separate databases through core intents with replayable steps, never a claimed multi-file atomic transaction. Plugins still use namespaced SDK storage and declared migrations; no private shared-table access.

Use SQLite's backup API or another SQLite-consistent snapshot, including WAL content. For an application-wide backup set, stop writes to all three databases before capturing a consistent generation and retain artifact/config metadata without copying credential values into execution records. Test compatible package rollback after a forward data migration. Reject a downgrade outside the declared readable/writable ranges. Never automatically restore the shared database for one plugin; whole-database restoration requires all application writers stopped and an explicit recovery action.

## Durable operation dispatcher and effect inventory

Dispatcher states are pending, leased, retrying, blocked, uncertain, and completed. Keep a stable logical key, immutable payload hash, pinned provider/connection/target, and append-only attempt evidence. Leases use generation-checked acknowledgments; stale workers cannot complete another lease. Lease expiry after invocation requires reconciliation before retry unless the provider supports the same durable idempotency key. A database lease alone cannot fence an in-flight remote request.

Provider adapters declare delivery support and return acknowledged, definitely-not-applied, or unknown outcomes. Unknown becomes uncertain when reconciliation cannot prove delivery or safe non-delivery. Retry only a definite non-delivery or a duplicate-safe invocation, with bounded backoff. Missing providers/credentials block without rebinding. A process can succeed while effects remain unsettled; admission dependencies such as a required source claim remain explicit gates.

| Existing controlled effect | Durable target and reconciliation |
|---|---|
| Jira assign and transitions in `runner.ts` / `jira-actions.ts` | Pin Jira tenant/connection, issue identity, account/status target, and origin revision. Read current issue state before retry. Split assignment and transition into ordered obligations; handle non-2xx responses explicitly instead of fail-soft acknowledgment. An already-satisfied target may settle a state-setting operation; incompatible intervening state needs a conflict decision. |
| GitHub review submission in `inline-review.ts` / `server/github.ts` | Pin host/connection, galleon/PR, reviewed SHA, actor, event, and canonical body/comments. Reconcile an operation marker or exact authenticated receipt/evidence; do not blindly repeat an ambiguous review. Review verdict and publication result stay distinct. |
| Copilot review request | Pin PR/connection/reviewer; inspect requested reviewers and returned receipts. Unknown or conflicting evidence remains visible. |
| Pre-PR push, PR create/edit in `pre-pr-runtime.ts`, scoped gateway push | Persist approved SHA/base/branch/remote identity and immutable publication payload before commands. Query remote ref and matching PR before retry; detect conflicting remote changes. Keep clarification, human publication, clean-tree, review, and exact-revision checks before each write. Submit through a narrow authenticated core operation endpoint used by the coordinator process; expose no general outbox-write permission to agent code. |
| Created-PR review scheduling in `created-pr-reviews.ts` | Reuse existing parent/galleon/PR-derived notification ID and stable child run ID. Couple the core obligation to process finalization, reconcile queue projection by operation ID, and admit through the new prepared execution transaction. Avoid a second queue performing the same write. |
| Todo claim/finish and campaign task dispatch/completion | Where in the same database, commit source state and core obligation/admission together. Preserve task/run identities and prevent `reconcileTodoRuns` from failing tasks whose admission intent is still being recovered. |
| Slack review send in `slack/review-request.ts` and `slack/browser-review.ts` | Adopt existing request ID, pinned workspace/channel/mention, and sent/uncertain receipts. Reconcile matching delivery only with reliable evidence; browser uncertainty never becomes automatic resend. Preserve cooldown semantics. |
| Slack/webhook/campaign incoming launch queues | Preserve their delivery/content hashes and stable run IDs. Recover an admitted/prepared attempt before considering another launch; migrate existing claims through an idempotent bridge. Incoming intake is not itself an outgoing publication. |

Inventory all host-controlled write call sites during integration and add any remaining ones to this table and tests. Arbitrary commands issued by a trusted agent/plugin are not made exactly-once by this host protocol. Do not claim sandboxing or duplicate suppression beyond controlled boundaries. Local display notifications need replayable projection/IDs, not an artificial remote delivery promise.

## Legacy conversion and evidence

Conversion is additive and idempotent. Preserve original run IDs, attempts, task/launch JSON, workflow references, usage identities, source relationships, and publication receipts. Decode known Jira/Todo/freeform/review/pre-PR shapes with validated compatibility adapters; malformed or unknown values remain readable for diagnostics and block execution. Do not invent historical binding hashes or resolve missing connection identity to a current unrelated tenant. Record legacy provenance and any explicitly verified adoption.

| Fixture / fault | Required evidence |
|---|---|
| Active legacy Jira and Todo voyages across detached/cmux/WezTerm/Docker refs | Existing IDs/resources/reservations survive conversion; verified ownership reattaches; missing host/provider blocks without cleanup or substitution. |
| Completed legacy voyage with usage/outcomes and source relationships | History and measured usage are unchanged; no duplicate completion/publication is generated. |
| Failed legacy voyage, with and without a valid pre-PR checkpoint | Only validated resumable checkpoints acquire executable pins; corrupt/missing evidence blocks continuation and preserves files. |
| Terminal completed record retaining a resumable checkpoint | Conflicting upgrade of its provider or transitive dependency is rejected despite compatible data schema; migration or explicit retirement releases the correct pins. |
| Crashes before preparation, before launch, after remote launch/before ref commit, and after ref commit | Exactly one logical attempt/reservation; discovery adopts known launch; unknown launch never starts another process. Include resume/retry paths. |
| Attach rejection, missing credentials/artifact/schema, repeated restart, safe start | Execution status is unchanged without terminal evidence; diagnostic and retry control work; reservations and cleanup exclusions persist. |
| Disable while running, failed drain, restart, re-enable | UI/polling disappear immediately; new work denied; pinned completion settles through the old binding once; desired disable survives failed activation. |
| Remote success before local acknowledgment for each controlled effect | Same logical operation and immutable target; remote evidence settles it or UI shows uncertainty; no blind duplicate publication. Include lease expiry with a still-running worker. |
| Crash during migration/preparation/catalog projection, concurrent CLI change | Restart resumes or blocks coherently; no partial activation; migration lock/checksum and compatibility guards hold. |
| WAL-active backup and compatible/incompatible rollback | Backup restores all acknowledged writes; compatible package rollback keeps migrated data; incompatible downgrade is rejected without shared-database restoration. |

## Parallel implementation partitions

Agree on the persistence and DTO signatures first; each owner adds focused tests alongside owned files. Do not have agents concurrently edit `application.ts`, `router.ts`, `runner.ts`, or the package CLI.

| Owner / work packet | Exclusive files and deliverable | Dependencies |
|---|---|---|
| Persistence and lifecycle | New `persistence.ts`, `migrations.ts`, `execution-store.ts`, `plugins/lifecycle.ts`, associated tests/fixtures. Migration inventory, shared connection, core transactions, snapshot validation, pins, upgrade/checkpoint rules, cross-store intents. | Initial agreed DTOs; then supplies durable primitives. |
| Host recovery | `run-host.ts`, `run-wrapper.mjs`, `docker-host.ts`, `recovery.ts`, `process-manager.ts`, host/recovery tests. Launch IDs/discovery, ownership evidence, attachment handshake, durable reservation integration. | Execution-store API; can implement discovery independently first. |
| Operations | New `operations.ts`, dispatcher and legacy effect adapter modules/tests; `jira-actions.ts`, GitHub review adapter, Slack operation bridge. Leases, receipts, reconciliation, pinned target resolution, crash fixtures. | Shared transaction/operation API; preserve current queues through adapters. |
| Integration owner (main thread) | `application.ts`, `db.ts`, `runner.ts`, `resume.ts`, `workflow-snapshots.ts`, store constructor wiring, `pre-pr-runtime.ts`, `scoped-gateway.ts`, `plugins/store.ts`, `plugins/data.ts`, CLI/backend lifecycle wiring, `router.ts`, core recovery UI and browser tests. | Integrate primitives in that order; prevent dual write paths; own startup/cleanup/admission order. |

With four slots, the main thread owns integration while the three work packets run independently. After the primitives land, reassign completed owners to bounded integration portions only with explicit file ownership transfer. A second review pass must inspect recovery/cleanup and effects/upgrade semantics independently before Phase D starts.

## Phase C completion checklist

- [ ] All new admissions and continuations snapshot exact bindings and acquire durable reservations/pins before launch.
- [ ] Prepared and uncertain launches recover safely; attachment health and process completion are distinct.
- [ ] Disable/drain/failure/restart and required-dependent behavior pass, including safe start and protected cleanup.
- [ ] Artifact/checkpoint/dependency pins block uninstall, collection, and incompatible activation; validated migration preserves provenance.
- [ ] Ownership inventory, coordinated migrations, cross-database intent recovery, WAL-consistent backup, and compatible rollback are implemented and tested.
- [ ] Every controlled effect above uses one durable logical operation, immutable target/binding, and honest reconciliation or uncertainty.
- [ ] Core recovery controls expose diagnostics and actionable obligations while optional plugins are unavailable.
- [ ] Legacy fixtures and every fault matrix row pass; source/run/workflow/usage identities remain intact.
- [ ] TypeScript, production builds, relevant unit/crash/integration suites, core recovery browser/visual tests, and isolated distribution tests pass.
- [ ] Independent architectural reviews have no unresolved material findings; completion ledger records concrete evidence before task-source extraction.

_Helmsman · model not reported - effort not reported_
