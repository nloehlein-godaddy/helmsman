# Phase C implementation design

Status: implementation and post-commit fixes complete; validation and independent architectural reviews pass. Phase B was published as `8652f9e`. This document implements all of [architecture plan section 6](plugin-architecture-plan.md#6-define-lifecycle-persistence-and-recovery-protocols) behind existing providers. It does not extract task sources or generalize execution plugins early. Phase C is complete only when the acceptance matrix below passes.

## Baseline seams and gaps

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

The implemented offline command is `npm run plugins -- --dir STORE --db DATABASE backup DESTINATION`. It acquires immediate locks and checks registered writers across main, catalog, and plugin-data databases, then writes SQLite backups and a manifest containing their hashes and source/runtime metadata. It refuses an existing destination. Preserve the plugin and retained runtime artifact stores alongside this database backup; the command does not copy executable packages or credentials. `plugins --help` documents this requirement.

## Durable operation dispatcher and effect inventory

Dispatcher states are pending, leased, retrying, blocked, uncertain, and completed. Keep a stable logical key, immutable payload hash, pinned provider/connection/target, and append-only attempt evidence. Leases use generation-checked acknowledgments; stale workers cannot complete another lease. Lease expiry after invocation requires reconciliation before retry unless the provider supports the same durable idempotency key. A database lease alone cannot fence an in-flight remote request.

Provider adapters declare delivery support and return acknowledged, definitely-not-applied, or unknown outcomes. Unknown becomes uncertain when reconciliation cannot prove delivery or safe non-delivery. Retry only a definite non-delivery or a duplicate-safe invocation, with bounded backoff. Missing providers/credentials block without rebinding. A process can succeed while effects remain unsettled; admission dependencies such as a required source claim remain explicit gates.

| Existing controlled effect | Durable target and reconciliation |
|---|---|
| Jira assign and transitions in `runner.ts` / `jira-actions.ts` | Pin Jira tenant/connection, issue identity, account/status target, and origin revision. Read current issue state before retry. Split assignment and transition into ordered obligations; handle non-2xx responses explicitly instead of fail-soft acknowledgment. An already-satisfied target may settle a state-setting operation; incompatible intervening state needs a conflict decision. |
| GitHub review submission in `inline-review.ts`, runner finalization, and the manual PR endpoint | Pin host/connection, galleon/PR, reviewed SHA, actor, event, and canonical body/comments. Reconcile an operation marker or exact authenticated receipt/evidence; do not blindly repeat an ambiguous review. Review verdict and publication result stay distinct. Manual reviews retain client request IDs across response loss and check the displayed head SHA before admission. |
| Copilot review request | Pin PR/connection/reviewer; inspect requested reviewers and returned receipts. Unknown or conflicting evidence remains visible. |
| Pre-PR push, PR create/edit in `pre-pr-runtime.ts`, scoped gateway push | Persist approved SHA/base/branch/remote identity and immutable publication payload before commands. Query remote ref and matching PR before retry; detect conflicting remote changes. Keep clarification, human publication, clean-tree, review, and exact-revision checks before each write. Submit through a narrow authenticated core operation endpoint used by the coordinator process; expose no general outbox-write permission to agent code. |
| Created-PR review scheduling in `created-pr-reviews.ts` | Reuse existing parent/galleon/PR-derived notification ID and stable child run ID. Couple the core obligation to process finalization, reconcile queue projection by operation ID, and admit through the new prepared execution transaction. Avoid a second queue performing the same write. |
| Todo claim/finish and campaign task dispatch/completion | Where in the same database, commit source state and core obligation/admission together. Preserve task/run identities and prevent `reconcileTodoRuns` from failing tasks whose admission intent is still being recovered. |
| Slack review send in `slack/review-request.ts` and `slack/browser-review.ts` | Adopt existing request ID, pinned workspace/channel/mention, and sent/uncertain receipts. Reconcile matching delivery only with reliable evidence; browser uncertainty never becomes automatic resend. Preserve cooldown semantics. |
| Local Git cleanup and remote refresh | Local checked Git transactions remain synchronous operator actions. These do not publish to external remotes. All cleanup uses durable execution/checkpoint/effect protection, including terminal and legacy voyages; refresh only updates local tracking refs. |
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

### Agreed internal API handoff

These are proposed TypeScript signatures for C's internal modules, not newly stabilized SDK contracts. Agree on changes before implementing consumers. Use existing `PluginJson`, `HostRef`, `RunRow`, and `RunStatus` types by type-only import; JSON receives execution-specific size limits rather than the small plugin settings quota. Public recovery DTOs redact credential handles and private paths.

`persistence.ts` owns connections. Existing store constructors take `path: string | Database.Database`; a string creates an owned connection through the coordinator, while a borrowed connection is never closed by the store. Stores participating in a transaction must borrow the exact same connection.

```ts
export interface Persistence {
  readonly sql: Database.Database;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openPersistence(path: string): Persistence;

export interface SchemaRange {
  owner: string;
  minimum: number;
  maximum: number;
}

export interface OwnedMigration {
  owner: string;
  version: number;
  checksum: string;
  tables: readonly string[];
  validateLegacy(sql: Database.Database): number | null;
  apply(sql: Database.Database, fromVersion: number): void;
  validateCurrent(sql: Database.Database): void;
}

export function migrateOwned(
  sql: Database.Database,
  migration: OwnedMigration,
  retainedConsumers: readonly SchemaRange[],
): void;
```

`transaction` is synchronous, uses an immediate transaction for its outermost call, and permits nested calls through savepoints on the same connection. Never await inside it. `migrateOwned` acquires the owner/version lock under the host's cross-process maintenance barrier, verifies an existing ledger checksum, validates the schema before recording a baseline, and commits DDL plus version atomically. `validateLegacy` returns `null` only when the owner has no tables, returns a recognized legacy version for a valid existing schema, and throws on partial/unknown schemas. New databases begin at version zero. `apply` must handle the recognized source version, never relabel an unknown baseline. Non-transactional staging stays outside this helper and uses durable migration steps; the helper runs only the final transactional portion.

`execution-store.ts` owns snapshots, attempts, reservations, checkpoints, and pins. Lifecycle is a separate module using the same `Persistence`.

```ts
export interface ArtifactBinding {
  pluginId: string;
  artifactHash: string;
  packageVersion: string;
  requires: readonly string[];
}

export interface ProviderBinding {
  role: 'source' | 'agent' | 'host' | 'workflow' | 'effect';
  capability: string;
  contractVersion: number;
  contributionId: string;
  pluginId: string;
  artifactHash: string;
  connectionId: string | null;
  credentialHandle: string | null;
}

export interface ExecutionSnapshotInput {
  version: 1;
  runId: string;
  attempt: number;
  repo: string;
  logicalWork: { source: string; instance: string; taskId: string };
  task: PluginJson;
  workflowSnapshotId: string | null;
  artifacts: readonly ArtifactBinding[];
  bindings: readonly ProviderBinding[];
  settings: Readonly<Record<string, PluginJson>>;
  schemas: readonly SchemaRange[];
  provenance: { kind: 'admission' | 'legacy-adoption' | 'checkpoint-migration'; evidence: PluginJson };
}

export interface ExecutionSnapshot extends ExecutionSnapshotInput {
  id: string;
  contentHash: string;
  createdAt: string;
}

export interface RecoveryDiagnostic {
  code: string;
  message: string;
  retryable: boolean;
  details: PluginJson;
}

export interface AttemptKey { runId: string; attempt: number }
export interface AttemptLease extends AttemptKey {
  token: string;
  generation: number;
  expiresAt: string;
}

export interface ExecutionAttempt extends AttemptKey {
  snapshotId: string;
  launchId: string;
  preparation: 'prepared' | 'ready' | 'launching' | 'launched';
  attachment: 'pending' | 'attached' | 'blocked' | 'failed';
  hostRef: HostRef | null;
  paths: { worktree: string | null; log: string; exit: string; spec: string };
  outcome: {
    status: Exclude<RunStatus, 'running'>;
    endedAt: string;
    evidence: PluginJson;
  } | null;
  diagnostic: RecoveryDiagnostic | null;
}

export interface ExecutionReservation {
  runId: string;
  repo: string;
  reason: 'prepared' | 'executing' | 'unresolved';
}

export interface ArtifactPin {
  kind: 'admission' | 'execution' | 'checkpoint' | 'operation' | 'dependency';
  ownerId: string;
  pluginId: string;
  artifactHash: string;
}

export interface ExecutionCheckpoint {
  id: string;
  runId: string;
  attempt: number;
  snapshotId: string;
  format: string;
  formatVersion: number;
  artifacts: PluginJson;
  state: 'resumable' | 'retired';
}

export interface ExecutionStore {
  reserveAdmission(input: { runId: string; repo: string; maxConcurrency: number; evidence: PluginJson }): void;
  abandonAdmission(runId: string, evidence: PluginJson): void;
  prepare(input: {
    snapshot: ExecutionSnapshotInput;
    launchId: string;
    paths: ExecutionAttempt['paths'];
    maxConcurrency: number;
  }): ExecutionAttempt;
  snapshot(id: string): ExecutionSnapshot | null;
  attempt(key: AttemptKey): ExecutionAttempt | null;
  recoverable(): readonly ExecutionAttempt[];
  reservations(): readonly ExecutionReservation[];
  lease(key: AttemptKey, ttlMs: number): AttemptLease | null;
  assertLease(lease: AttemptLease): void;
  renew(lease: AttemptLease, ttlMs: number): AttemptLease | null;
  releaseLease(lease: AttemptLease): void;
  setWorktree(lease: AttemptLease, path: string): void;
  ready(lease: AttemptLease): void;
  markLaunching(lease: AttemptLease): void;
  recordLaunch(lease: AttemptLease, ref: HostRef, evidence: PluginJson): void;
  recordAttachment(lease: AttemptLease, health: ExecutionAttempt['attachment'],
    diagnostic: RecoveryDiagnostic | null): void;
  recordOutcome(lease: AttemptLease, outcome: NonNullable<ExecutionAttempt['outcome']>): void;
  retainCheckpoint(checkpoint: ExecutionCheckpoint): void;
  checkpoint(id: string): ExecutionCheckpoint | null;
  retireCheckpoint(id: string, resolution: { actor: string; reason: string }): void;
  pins(pluginId?: string): readonly ArtifactPin[];
  retainPins(pins: readonly ArtifactPin[]): void;
  releasePins(kind: ArtifactPin['kind'], ownerId: string): void;
  cleanupEligibility(runId: string): { allowed: true } | {
    allowed: false; reasons: readonly string[];
  };
  releaseReservation(runId: string, evidence: PluginJson): void;
}

export function openExecutionStore(persistence: Persistence): ExecutionStore;
```

`prepare` hashes/validates immutable input, enforces run/attempt/launch uniqueness, rejects a second unresolved attempt, checks durable concurrency, and acquires execution/closure pins. Repeating the same identity/content returns the existing attempt; differing content is a conflict. For continuation, the same run's existing reservation is reused after verified prior termination, not counted twice. A lifecycle check and any source/run-row changes occur in the surrounding shared transaction. Neither `recordAttachment` nor an expired lease changes `runs.status`. Outcome writes are compare-and-set and reject contradictory terminal evidence. Every lease mutation validates token, generation, and expiry; takeover requires recovery, not a fresh launch. Methods return immutable copies and throw typed conflict/validation errors rather than silently accepting stale writes.

`retainPins`/`releasePins` are internal owner operations, not plugin APIs. Releasing a live checkpoint/operation pin is rejected; its owner must first atomically settle or retire that obligation. Reservation release requires proven process termination (or proof no process launched); it does not release checkpoint/effect pins. Cleanup and reservation release are separate because a stopped process can leave a resumable checkpoint without consuming concurrency.

`plugins/lifecycle.ts` must provide at least these shared entry points:

```ts
export interface LifecycleChange {
  id: string;
  pluginId: string;
  expectedRevision: number;
  desiredEnabled: boolean;
  artifactHash: string;
  drainDependents: readonly string[];
}

export interface LifecycleBlocker {
  kind: 'consumer' | 'execution' | 'checkpoint' | 'operation' | 'schema';
  ownerId: string;
  reason: string;
}

export interface PluginLifecycle {
  assertAdmission(snapshot: ExecutionSnapshotInput): void;
  plan(change: LifecycleChange): { blockers: readonly LifecycleBlocker[] };
  apply(change: LifecycleChange): void;
  canCollect(pluginId: string, artifactHash: string): {
    allowed: boolean; blockers: readonly LifecycleBlocker[];
  };
  validateCheckpointMigration(input: {
    checkpointId: string;
    expectedSnapshotId: string;
    next: ExecutionSnapshotInput;
    provider: ProviderBinding;
  }): Promise<{ validationId: string; receipt: PluginJson }>;
  migrateCheckpoint(input: {
    checkpointId: string;
    expectedSnapshotId: string;
    next: ExecutionSnapshotInput;
    validation: { provider: ProviderBinding; receipt: PluginJson; validationId: string };
    actor: string;
    reason: string;
  }): void;
}

export function openPluginLifecycle(
  persistence: Persistence,
  executions: ExecutionStore,
  validators?: readonly CheckpointMigrationValidator[],
): PluginLifecycle;
```

`assertAdmission` and `apply` recheck live state inside the caller's transaction; a prior `plan` does not authorize a raced change. `apply` writes durable lifecycle/projection intent and rejects blockers before selection changes. `migrateCheckpoint` consumes verified provider validation, appends provenance, and updates effective checkpoint bindings/pins atomically; a JSON receipt from a caller alone is not sufficient validation. All snapshot attempts remain immutable. Lifecycle diagnostics/listing can be added without changing these transaction semantics.

Each registered `CheckpointMigrationValidator` has an exact retained `provider` binding and an asynchronous `validate({ checkpoint, previous, next })` implementation that returns structured evidence or rejects the migration. Validation runs outside the SQLite transaction. Before recording its receipt, core rechecks the old binding and complete checkpoint hash under lock; migration matches that hash, proposed snapshot, provider, and receipt. Providers without this interface cannot migrate checkpoints. C's legacy runtime has no migration validator and therefore requires retirement before an incompatible runtime upgrade.

Operation-store signatures belong to the operations owner; the handoff requires `enqueue(draft)` to synchronously join the caller's transaction on this `Persistence`, acquire operation pins, and reject reuse of a logical key with different payload/binding. Dispatcher invocation is asynchronous after commit. Its settled/blocked/uncertain results update operations, source projections, and pin eligibility through new short transactions. The integration owner composes finalization this way:

```ts
persistence.transaction(() => {
  executions.recordOutcome(lease, outcome);
  db.updateRun(runId, terminalPatch);
  for (const draft of obligations) operations.enqueue(draft);
  if (checkpoint) executions.retainCheckpoint(checkpoint);
});
```

Likewise admission composes `lifecycle.assertAdmission`, source claim state, `db.insertRun` (or continuation update), and `executions.prepare` in one transaction. Legacy store callbacks must not open their own connection inside these blocks. Remote calls, artifact downloads, host discovery, and migration validators run outside transactions, then their versioned results are revalidated under the transaction before committing.

Agree on the persistence and DTO signatures first; each owner adds focused tests alongside owned files. Do not have agents concurrently edit `application.ts`, `router.ts`, `runner.ts`, or the package CLI.

| Owner / work packet | Exclusive files and deliverable | Dependencies |
|---|---|---|
| Persistence and lifecycle | New `persistence.ts`, `migrations.ts`, `execution-store.ts`, `plugins/lifecycle.ts`, associated tests/fixtures. Migration inventory, shared connection, core transactions, snapshot validation, pins, upgrade/checkpoint rules, cross-store intents. | Initial agreed DTOs; then supplies durable primitives. |
| Host recovery | `run-host.ts`, `run-wrapper.mjs`, `docker-host.ts`, `recovery.ts`, `process-manager.ts`, host/recovery tests. Launch IDs/discovery, ownership evidence, attachment handshake, durable reservation integration. | Execution-store API; can implement discovery independently first. |
| Operations | New `operations.ts`, dispatcher and legacy effect adapter modules/tests; `jira-actions.ts`, GitHub review adapter, Slack operation bridge. Leases, receipts, reconciliation, pinned target resolution, crash fixtures. | Shared transaction/operation API; preserve current queues through adapters. |
| Integration owner (main thread) | `application.ts`, `db.ts`, `runner.ts`, `resume.ts`, `workflow-snapshots.ts`, store constructor wiring, `pre-pr-runtime.ts`, `scoped-gateway.ts`, `plugins/store.ts`, `plugins/data.ts`, CLI/backend lifecycle wiring, `router.ts`, core recovery UI and browser tests. | Integrate primitives in that order; prevent dual write paths; own startup/cleanup/admission order. |

With four slots, the main thread owns integration while the three work packets run independently. After the primitives land, reassign completed owners to bounded integration portions only with explicit file ownership transfer. A second review pass must inspect recovery/cleanup and effects/upgrade semantics independently before Phase D starts.

## Phase C completion checklist

Validation: the final full suite passed 3,184 tests across 207 files. TypeScript and production build passed. All 11 browser/visual tests passed; six distribution checks and four source-denied production-server tests passed again after the post-commit fixes. Independent reviews found no unresolved material findings.

Post-commit review fixed a Git URL-rewrite bypass using isolated publication transport with scoped credentials and a final stop check. It also fixed concurrent installation capacity checks and reconciliation of intents arriving during projection. Regression evidence includes real Git source/global/environment rewrites, stop during transport setup, and 33 simultaneous installations yielding exactly 32 accepted packages with no pending intents.

Acceptance audit fixes include synchronized artifact selection/collection, safe-default CLI coordination, writer barriers on every backup database, automatic retained-schema migration guards, registered checkpoint validation with race detection, and package rollback preserving forward-migrated data. Focused evidence is in `plugins/coordinator.test.ts`, `plugins/cli.test.ts`, `persistence-backup.test.ts`, and `plugins/lifecycle.test.ts`. Protected legacy records additionally consume admission capacity and block cleanup and unverified native preparation, covered by `execution-store.test.ts`; unknown historical executable or connection identity is never fabricated as an artifact pin.

- [x] All new admissions and continuations snapshot exact bindings and acquire durable reservations/pins before launch.
- [x] Prepared and uncertain launches recover safely; attachment health and process completion are distinct.
- [x] Disable/drain/failure/restart and required-dependent behavior pass, including safe start and protected cleanup.
- [x] Artifact/checkpoint/dependency pins block uninstall, collection, and incompatible activation; validated migration preserves provenance.
- [x] Ownership inventory, coordinated migrations, cross-database intent recovery, WAL-consistent backup, and compatible rollback are implemented and tested.
- [x] Every controlled effect above uses one durable logical operation, immutable target/binding, and honest reconciliation or uncertainty.
- [x] Core recovery controls expose diagnostics and actionable obligations while optional plugins are unavailable.
- [x] Legacy fixtures and every fault matrix row pass; source/run/workflow/usage identities remain intact.
- [x] TypeScript, production builds, relevant unit/crash/integration suites, core recovery browser/visual tests, and isolated distribution tests pass.
- [x] Independent architectural reviews have no unresolved material findings; completion ledger records concrete evidence before task-source extraction.

_Helmsman · not reported - not reported_
