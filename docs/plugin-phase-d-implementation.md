# Phase D: coexisting task sources

Status: implementation and acceptance verification complete; exact-commit review and push pending. Phase C passed its final tests, distribution checks, and independent reviews and was pushed as `2e9bd57`. This document refines [the architecture plan, sections 2, 3, 5, and 6](plugin-architecture-plan.md) and preserves the [Phase C protocols](plugin-phase-c-implementation.md). The signatures below are proposed interfaces, not APIs already available to plugin authors.

## Outcome and scope

Todos and Jira become separately enabled task-source implementations. Both can list and launch work in the same installation. A replacement provider can adopt an existing logical source without changing item identities, duplicating claims, or redirecting already admitted execution and effects.

D extracts source discovery, normalization, claim policy, lifecycle planning, and connection-specific behavior. Existing Todo/Triage/Bugs views become source-aware consumers; replacing every presentation surface belongs to E. Agent, execution-host, and general workflow extension remain in F. Core continues to own admission, concurrency, immutable execution snapshots, operation dispatch, recovery, credentials, and storage coordination.

The external replacement fixture is essential. Todos and Jira exercise different source semantics; passing tests with those two alone does not prove that two implementations can serve the same source.

## Current integration points

| Current seam | D change |
|---|---|
| `src/plugins/backend.ts`, `package.ts` accept only `helmsman/pricing`; backend activation publishes pricing services | Add the provisional task-source capability, validated access declarations, isolated registrations, and obligation-scoped activation. Keep existing pricing packages valid. |
| `application.ts` chooses Todo/Jira before normalization and calls `todos.claim` in the admission transaction | Route a resolved `WorkRef` through a source instance; retain the same admission transaction for local claims. |
| `todo-source.ts` creates an `AgentTask`; `jira-task.ts` snapshots issue requirements | Providers return a neutral `TaskSnapshotV1`. A core compatibility adapter produces the existing execution task. |
| `todos.ts` owns main-DB rows and source/run relationships | Preserve those rows and identities through a public, source-scoped local record service with a private host storage adapter. Provider modules receive no SQL or private store imports. |
| `legacy-run-effects.ts` prepares Jira claims/transitions; `operations.ts` owns durable delivery | New source adapters register source effects through a constrained public protocol. Existing C operations retain their original resolver and binding. |
| `scheduler.ts` uses `ticketId`, optional `todoId`, and one source per galleon | Carry `WorkRef` and instance revision. Enumerate explicitly selected sources in stable order; core still arbitrates capacity and claims. |
| `router.ts`, `src/main.ts`, and `src/render.ts` use `jiraEnabled` to deny Todo writes, hide pages, and redirect routes | Separate source availability from navigation and Todo availability. Remove mutual exclusion and misleading configuration copy. |
| `plugin-data.sqlite` provides asynchronous namespaced settings/storage | Continue using it for package settings and caches. Do not put an authoritative local claim there and claim it is atomic with main-DB admission. |

## D0 decisions

1. Task-source discovery is a multiple-provider capability. Resolving a particular existing item always uses its logical source's explicit binding.
2. A source ID is a host-assigned opaque UUID. It is not a package ID, URL, project key, account email, display label, or active connection ID.
3. An external item ID is canonical within that source. Jira uses the immutable issue ID; the human ticket key is display and lookup data. Existing `TODO-N` values remain valid immutable IDs in the adopted local collection.
4. One source has one current implementation binding. Several configured credentials or filtered views can point to the same verified source. They do not create new task namespaces.
5. Ordinary provider methods can read and prepare plans. Only host-supervised mutation contexts can apply a claim or lifecycle effect. A provider never receives an unrestricted operation-enqueue function or transaction callback.
6. Local source mutations use declarative compare-and-set records and the main connection. Remote source mutations use C's durable operations and reconciliation. Neither path launches a worker before the required claim is acknowledged.
7. Source adoption changes resolution for future admissions. It never rewrites C execution snapshots, operation targets, checkpoints, or their pins.
8. Contract version 1 remains provisional until shipped Todos, Jira, and an independently built compatible replacement pass the shared suites.

## Identity, instances, and selection

```ts
type SourceId = string;
type SourceInstanceId = string;

interface WorkRefV1 {
  readonly sourceId: SourceId;
  readonly externalId: string;
}

interface SourceAuthorityV1 {
  readonly protocol: string;
  readonly authorityId: string;
  readonly identityFormat: string;
}

interface SourceBindingV1 {
  readonly providerId: string;
  readonly pluginId: string;
  readonly artifactHash: string;
  readonly contractVersion: 1;
  readonly connectionId: string | null;
  readonly credentialHandle: string | null;
}

interface SourceInstanceV1 {
  readonly version: 1;
  readonly id: SourceInstanceId;
  readonly sourceId: SourceId;
  readonly label: string;
  readonly revision: number;
  readonly desiredEnabled: boolean;
  readonly identityLevel: 'verified' | 'operator-seeded';
  readonly authority: SourceAuthorityV1 | null;
  readonly binding: SourceBindingV1;
  readonly settings: Readonly<Record<string, PluginJson>>;
  readonly allowedRepos: readonly string[];
}
```

`SourceAuthorityV1` is verified identity evidence, independent of the currently selected provider. A local collection receives a persisted collection UUID on first conversion, not a new UUID on each application start. Jira first attempts to establish an immutable cloud/server identity through supported identity endpoints. A normalized base URL alone does not prove equivalence after a tenant move. If that API is unavailable, preserve an operator-seeded source namespace with `identityLevel: 'operator-seeded'` and `authority: null`. Existing configured Jira work may continue through its original pinned connection and canonical issue IDs. Cross-connection merging and provider adoption remain blocked until authority verification succeeds; an unavailable identity API alone must not disable an otherwise working Jira integration.

An operator-seeded namespace is persisted once with its original non-secret connection fingerprint and provisioning evidence. It is never recreated on restart, silently equated to another connection, or described as a verified tenant identity. Creating another unverified connection requires an explicit distinct-source decision; it cannot automatically create a duplicate namespace for an apparently similar URL. Credential rotation on the existing connection still requires the same authorized subject and endpoint. A later verified identity must append evidence before enabling adoption. The current implementation deliberately keeps operator-seeded identities unchanged on automatic restart; an explicit evidence-upgrade workflow is not yet available, so these sources remain adoption-ineligible until that workflow is implemented.

`identityFormat` identifies interoperable item semantics, such as `jira.issue-id/v1` or `helmsman.local-task/v1`. It does not contain the plugin name. A provider advertising the same string still has to pass adoption validation.

An instance is a configured access path to a source, including credentials, filters, and galleon permissions. The source record selects a current instance/provider revision for resolving existing `WorkRef`s. Additional connections may be registered only after identity verification associates them with the source. A saved filtered view can use another instance without changing the work identity. Claims deduplicate by `(sourceId, externalId)` across every instance and user interface.

For existing work, an explicit instance must belong to the `WorkRef.sourceId` and match the source's approved provider binding. A conflicting instance is an error. For unbound discovery only, resolve explicit selection, workflow selection, galleon selection, then global selection; an invalid explicit selection never falls through. With no configured selection, only one compatible enabled candidate may be selected automatically. Multi-source discovery returns stable instance-ID order and does not use installation order as priority.

Display ticket keys can be translated to an immutable ID only through a provider lookup with a pinned source instance. Record the verified alias mapping and revision. Never infer a source from a string looking like `TODO-123` or `ABC-123`.

## Neutral task and provider protocol

Add declarations and runtime parsers in `src/plugins/tasks.ts`; re-export them through the plugin SDK entry point. The public types use `PluginJson`, not server `RunRow`, `AppConfig`, `AgentTask`, or SQLite types.

```ts
interface TaskSnapshotV1 {
  readonly version: 1;
  readonly ref: WorkRefV1;
  readonly revision: string;
  readonly displayKey: string;
  readonly title: string;
  readonly repo: string;
  readonly url: string | null;
  readonly state: 'ready' | 'in_progress' | 'review' | 'done' | 'blocked';
  readonly priority: number | null;
  readonly requirements: {
    readonly description: string;
    readonly acceptanceCriteria: readonly string[];
    readonly links: readonly { title: string; url: string }[];
  };
  readonly providerData: PluginJson;
}

interface SourceCallContextV1 {
  readonly instance: SourceInstanceV1;
  readonly signal: AbortSignal;
  readonly repo: string | null;
  readonly local: LocalSourceRecordsV1 | null;
  readonly http: SourceReadHttpV1 | null;
}

interface TaskPageV1 {
  readonly items: readonly TaskSnapshotV1[];
  readonly nextCursor: string | null;
}

interface SourceIdentityEvidenceV1 {
  readonly version: 1;
  readonly level: 'verified' | 'operator-seeded';
  readonly authority: SourceAuthorityV1 | null;
  readonly verifiedAt: string;
  readonly proof: PluginJson;
}

interface TaskSourceProviderV1 {
  identify(context: SourceCallContextV1): Promise<SourceIdentityEvidenceV1>;
  list(input: {
    repo: string;
    state: TaskSnapshotV1['state'] | null;
    cursor: string | null;
    limit: number;
  }, context: SourceCallContextV1): Promise<TaskPageV1>;
  lookup(input: { displayKey: string }, context: SourceCallContextV1): Promise<WorkRefV1 | null>;
  load(ref: WorkRefV1, context: SourceCallContextV1): Promise<TaskSnapshotV1 | null>;
  planClaim(input: SourceClaimRequestV1, context: SourceCallContextV1): Promise<SourceMutationPlanV1>;
  planCompletion(input: SourceCompletionRequestV1, context: SourceCallContextV1): Promise<SourceMutationPlanV1>;
  planAbort(input: SourceAbortRequestV1, context: SourceCallContextV1): Promise<SourceMutationPlanV1>;
  validateAdoption(input: SourceAdoptionProposalV1, context: SourceCallContextV1): Promise<SourceAdoptionEvidenceV1>;
  readonly effects: Readonly<Record<string, SourceEffectHandlerV1>>;
}
```

Define hard parser bounds before implementation: at most 100 list results and 2 MiB per page, bounded opaque cursors, 256 KiB total task snapshot (preserving existing 20,000-character Unicode description and acceptance-criteria fields), 240-character title, 20 KiB description, bounded acceptance criteria/links, finite priority, canonical host galleon identity, and only safe HTTP(S) display links. Validate every result, nested array element, source ID, revision, and instance association. Reject sparse/accessor-bearing data and credential-like fields. An unavailable source, malformed response, cancellation, and empty page remain distinguishable. `providerData` is versioned non-secret evidence, not an alternate unchecked launch payload.

Core stores the exact snapshot and source binding before effects/launch. The execution compatibility adapter maps requirements to the current prompt format and preserves display keys in logs. Source-specific fields no longer decide whether the runner calls Jira. Source lifecycle decisions come from the retained source binding and effect plan.

The registry publishes all declared registrations only after successful module activation. Duplicate local IDs, undeclared handlers, unsupported capability versions, invalid access, and partial registration fail atomically. Extend the existing backend manifest parser with the task-source capability and an optional explicit access declaration; do not relax unknown-field checking for old capabilities. New packages are rejected by older hosts that do not support this capability.

Concretely, extend `backend.provides` with `{ id: 'helmsman/task-source', version: 1, localId }` and add `backend.taskSources` only when that capability is declared. This object is keyed by the declared source local ID; each entry declares `identityFormats`, `effectIds`, `commandIds`, and an access list drawn from `local-records` and `connection-http`. Settings and `storageVersion: 1` retain their current meaning. Add `context.registerTaskSource(localId, provider)` to backend activation; each implementation's `effects` and optional `commands` keys must exactly match its declarations. Each invocation receives only the declared services authorized for the configured instance.

## Storage and credential services

```ts
interface LocalSourceRecordV1 {
  readonly ref: WorkRefV1;
  readonly repo: string;
  readonly revision: string;
  readonly schema: string;
  readonly data: PluginJson;
  readonly claim: SourceClaimReceiptV1 | null;
}

interface LocalSourceRecordsV1 {
  describeCollection(): Promise<{
    sourceId: SourceId;
    collectionId: string;
    schema: string;
    revision: number;
    evidenceId: string;
  }>;
  list(input: { repo: string; cursor: string | null; limit: number }): Promise<{
    records: readonly LocalSourceRecordV1[];
    nextCursor: string | null;
  }>;
  get(externalId: string): Promise<LocalSourceRecordV1 | null>;
}

interface SourceReadHttpV1 {
  get(input: { path: string; query: Readonly<Record<string, string>> }): Promise<{
    status: number;
    body: PluginJson;
  }>;
}
```

These objects are bound to the invocation's source instance and authorized galleon scope. They cannot select another namespace or connection. Local reads filter against host-owned record scope, rather than trusting a plugin's filtering of arbitrary document fields. The HTTP service resolves the configured credential handle at use time, checks the pinned authority/subject, restricts origin and redirects, bounds response size/time, and returns no authorization headers. Credentials never become plugin settings, frontend data, task snapshots, or adoption receipts. Trusted backend code still has Node privileges; this is an API boundary, not a sandbox claim.

`describeCollection` exposes host-recorded local identity and a durable evidence reference without a file path or database handle. Local providers implement `identify` from that response; core matches the evidence reference to the collection before accepting it. For an operator-seeded remote source, the credential broker enforces the original endpoint/subject fingerprint and does not claim to verify a missing remote authority ID.

Introduce a host-owned local-source record service on the main connection. Its public model is a source-owned document and revision; its private initial adapter preserves the existing `todos` table, sequence IDs, timestamps, state, and `runId` links. Record the source's storage layout in the host registry. New local collections may use an additive `source_documents` table; the local provider sees the same interface. Do not copy existing Todos into the package's 8 MiB `plugin-data.sqlite` namespace.

Only the internal storage adapter imports `todos.ts`. The extracted provider owns normalization, validation, ordering, and transition planning through public DTOs. The adapter is a compatibility/data boundary, not a second task implementation. Existing HTTP Todo CRUD becomes a compatibility facade over source commands; application code stops calling the private store directly after cutover. Core enforces source/galleon authorization, record version checks, active-claim protection, and quotas even if a provider emits an invalid plan.

Publish the local document codec in the SDK and author guide. The compatible replacement must not reverse-engineer `todos.ts`. For `schema: 'helmsman.local-task/v1'`, `data` has exactly this public shape:

```ts
interface LocalTaskDocumentV1 {
  readonly version: 1;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: string;
  readonly priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  readonly state: 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}
```

The record envelope owns canonical identity, galleon, revision, and run linkage. The host assigns timestamps/revisions, preserves the first completion timestamp while done, and prevents user CRUD from fabricating a claim or writing `in_progress`. Source claim/completion/abort contexts may propose the documented state transitions, but host verifies the matching owner and expected revision. The private Todo codec maps its existing `runId` column to the envelope's core-owned claim; providers do not write that column. Publish field bounds, allowed transitions, priority ordering, and conversion fixtures alongside this codec. Additional local schemas require their own public codec and verified adoption support; a matching schema string alone grants no access.

Add optional user CRUD commands for the local provider through a typed source command registration:

```ts
type LocalSourceCommandPlanV1 =
  | { kind: 'create'; schema: string; repo: string; data: PluginJson }
  | { kind: 'update'; ref: WorkRefV1; expectedRevision: string; next: { schema: string; repo: string; data: PluginJson } }
  | { kind: 'delete'; ref: WorkRefV1; expectedRevision: string };

interface SourceCommandHandlerV1 {
  prepare(input: PluginJson, context: SourceCallContextV1): Promise<LocalSourceCommandPlanV1>;
}
```

Each command returns a declarative local mutation; host validates and applies it. The provider optionally exposes a `commands` record of these handlers. Host allocates canonical IDs using the collection's configured allocator, so the existing Todo collection continues its `TODO-N` sequence. Persist command request IDs, input hashes, and result receipts in the same transaction as the mutation; replaying a create after a lost response must return its first allocated ID. The Todos page uses these commands. A read-only or remote source need not advertise CRUD. D does not introduce a generic remote administration API merely to make every source emulate Todo editing.

## Claims, finalization, and durable source effects

```ts
interface SourceClaimRequestV1 {
  readonly admissionId: string;
  readonly runId: string;
  readonly task: TaskSnapshotV1;
  readonly expectedInstanceRevision: number;
  readonly retryOf: string | null;
}

interface SourceCompletionRequestV1 {
  readonly runId: string;
  readonly attempt: number;
  readonly task: TaskSnapshotV1;
  readonly claimReceipt: SourceClaimReceiptV1;
  readonly outcome: 'succeeded' | 'failed' | 'stopped';
  readonly publication: { repo: string; prNumber: number } | null;
}

interface SourceClaimReceiptV1 {
  readonly version: 1;
  readonly claimId: string;
  readonly ref: WorkRefV1;
  readonly admissionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly binding: SourceBindingV1;
  readonly taskSnapshotHash: string;
  readonly localRecordRevision: string | null;
  readonly operations: readonly { operationId: string; receipt: PluginJson }[];
}

interface SourceAbortRequestV1 {
  readonly admissionId: string;
  readonly runId: string;
  readonly task: TaskSnapshotV1;
  readonly claimReceipt: SourceClaimReceiptV1 | null;
  readonly reason: 'cancelled' | 'preflight-failed' | 'stopped-before-launch';
  readonly claimSteps: readonly {
    operationId: string;
    state: 'unsent' | 'acknowledged' | 'uncertain' | 'blocked';
    evidence: PluginJson;
  }[];
}

interface SourceSettlementReceiptV1 {
  readonly version: 1;
  readonly claimId: string;
  readonly claimRevision: number;
  readonly disposition: 'released' | 'completed' | 'retained-for-operator';
  readonly reason: string;
  readonly localRecordRevision: string | null;
  readonly operations: readonly { operationId: string; receipt: PluginJson }[];
}

type SourceMutationPlanV1 =
  | { readonly kind: 'none'; readonly reason: string }
  | {
      readonly kind: 'local-record';
      readonly ref: WorkRefV1;
      readonly expectedRevision: string;
      readonly next: { schema: string; repo: string; data: PluginJson };
    }
  | {
      readonly kind: 'remote-effects';
      readonly effects: readonly {
        readonly localId: string;
        readonly handler: string;
        readonly target: PluginJson;
        readonly payload: PluginJson;
        readonly after: readonly string[];
      }[];
    };

interface SourceEffectContextV1 {
  readonly signal: AbortSignal;
  readonly operationId: string;
  readonly generation: number;
  readonly instance: SourceInstanceV1;
  readonly http: SourceReadHttpV1;
}

interface SourceEffectMutationContextV1 extends SourceEffectContextV1 {
  readonly http: SourceMutationHttpV1;
}

interface SourceMutationHttpV1 extends SourceReadHttpV1 {
  send(input: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    body: PluginJson;
  }): Promise<{ status: number; body: PluginJson }>;
}

interface SourceEffectHandlerV1 {
  readonly delivery: 'reconcile' | 'idempotent';
  invoke(input: { target: PluginJson; payload: PluginJson }, context: SourceEffectMutationContextV1): Promise<SourceEffectResultV1>;
  reconcile(input: { target: PluginJson; payload: PluginJson }, context: SourceEffectContextV1): Promise<SourceEffectResultV1>;
}

type SourceEffectResultV1 =
  | { status: 'acknowledged'; receipt: PluginJson }
  | { status: 'definitely-not-applied'; retryable: boolean; reason: string; evidence: PluginJson }
  | { status: 'unknown'; reason: string; evidence: PluginJson }
  | { status: 'blocked'; reason: string; evidence: PluginJson };
```

The host creates operation IDs, stable keys, origins, artifact closure, connection binding, and bounded retry policy. Providers cannot supply another run ID, resolve a different provider, choose arbitrary dependencies, or mark core operations completed. Validate remote plan handler names against the package declaration, require unique local IDs and an acyclic dependency graph, cap effect count, and expand local dependencies into core operation IDs. Use keys derived from admission/run attempt plus source purpose and plan step, never from current plugin selection.

For remote mutations the HTTP capability exists only while core invokes the matching pinned operation. Reconciliation gets only the read HTTP service, and core verifies that operation scope again at each service call. No read/discovery/plan method receives a mutation-capable HTTP service. Host-enforced cancellation and disabled ordinary services cannot prevent an already-issued remote request from completing, so C uncertainty rules remain mandatory.

### Local admission transaction

1. Reserve the admission and exact source/runtime artifacts before asynchronous task loading. A new main-DB work claim reservation deduplicates `WorkRef` independently of galleon capacity.
2. Load and normalize the task; prepare the local claim plan outside the transaction. No plugin callback runs inside SQLite's synchronous transaction.
3. Under the same main transaction, recheck lifecycle, source/instance revisions, permission, local record revision, and work reservation. Apply the declarative local mutation through the host adapter; store its receipt and immutable task snapshot; advance admission. A thrown validation or run insert rolls back every local write.
4. Prepare the durable execution before worktree/launch effects, retaining C's launch identity and host discovery behavior. Pending preflight intent keeps the local source claim protected across restart.
5. Complete the source record and terminal run projection together when they share the main database. Use a prepared plan revalidated by record revision; a conflict remains a visible unsettled obligation, not a silently successful completion.

Keep the existing Todo rule that an item cannot be edited/deleted while claimed. Claim replay for the same admission returns its recorded receipt; a second admission conflicts. Retry is explicit and must match the prior claim owner and allowed terminal state. A core `work_claims` row enforces this regardless of provider-specific document contents.

Core creates claim and settlement receipts from committed local mutations and acknowledged operation receipts; callers cannot supply arbitrary receipts to obtain ownership or release it. The shared contract harness exposes these DTOs and their public schema. Provider-specific remote receipt details remain bounded JSON within an exact pinned operation reference.

### Remote admission and completion

Reserve admission/work identity and pins first; persist the immutable task and ordered claim operations before the first write. Jira assignment and transition remain separate operations. Acknowledged claim dependencies unblock execution preparation; pending, blocked, or uncertain claims retain reservation and recovery controls. Never release the source claim because an attachment timeout occurred.

Persist terminal process evidence, required source-completion intents, and other publication obligations in the same C transaction. Invocation follows commit. Claim/finish handlers resolve the original provider artifact, source authority, connection, credential handle, and canonical item target. Desired disable stops discovery and new admission; existing authorized obligations retain a dedicated service context. Revoked credentials or changed subject/tenant block them. Missing completion support is explicit policy declared at admission, not an implicit no-op discovered after execution.

C's Jira/GitHub/Slack/publication operations keep their existing kind, key, immutable payload, resolver, and provenance. Only newly admitted source work uses the new handlers. Replacing a source must not make both legacy and plugin handlers publish the same completion.

### Admission cancellation and failed preparation

Claimed work can fail before there is a worker outcome. Persist an admission abort request with its own stable identity before attempting cleanup; never invent process terminal evidence to call `planCompletion` in this case. Route user cancellation, failed preflight, stop-before-launch, and core recovery's cancel-admission action through the source settlement coordinator.

Under the shared transaction, fence claim operations that are provably unsent from future invocation and record that decision. An expired lease or missing response is not proof that a step was unsent. Reconcile every invoked/uncertain step before deciding which compensation is safe. An acknowledged assignment followed by an unsent transition is different from an entirely unapplied claim.

Call `planAbort` outside the transaction with the exact task, recorded binding, partial receipts, and verified step states. A local abort uses compare-and-set to restore an eligible source state, update the claim receipt, and fail the admission in one main-DB transaction. A remote abort may enqueue ordered compensation/settlement operations through C. Jira must not automatically undo an intervening reassignment or transition; conflicting external state stays blocked for an operator.

Only after the required settlement is acknowledged may core release the work claim and its source operation pins. A policy that deliberately leaves an applied remote claim for manual handling records `retained-for-operator`, keeps source ownership protected, and exposes it in recovery. Proven absence of a worker can release execution capacity separately, but cannot erase the source obligation. Crash/replay uses the same abort and operation IDs, including a second cancellation request. Disabled providers may settle these existing obligations through their retained context; new source commands remain denied.

## Persistence and adoption

Add main-DB owners through the existing migration coordinator:

| Record | Required invariant |
|---|---|
| `task_sources` | Host source UUID, verified authority/identity format, current instance/provider revision, enabled state, storage layout, provenance. |
| `task_source_instances` | Source ID, exact binding, non-secret settings and permissions, connection/credential handles, monotonic revision. |
| `task_aliases` | Verified source-scoped display-key to immutable-ID mapping, evidence/revision; conflicting remaps are detected. |
| `work_claims` | Unique `(sourceId, externalId)` active owner, admission/run IDs, state, immutable snapshot/plan references, receipts. |
| `source_settlements` | Durable completion/abort identity, expected claim revision, partial effect evidence, compensation dependencies, final source disposition. |
| `task_snapshots` | Canonical task hash, binding and instance revision, schema/identity format, observation evidence; immutable content. |
| `source_commands` | Stable user request ID, scoped command/input hash, result receipt; local CRUD and receipt commit atomically. |
| `source_refresh_validations` / `source_refreshes` | Same-provider seeded Jira artifact refresh, pinned connection/configuration evidence, actor/reason, canonical probes, and append-only commit audit. |
| `source_adoption_validations` / `source_adoptions` | Exact proposed source/binding revisions, identity/data evidence, validator artifact, actor/reason, append-only result. |
| `source_documents` if needed | New local collection records keyed by source/item, schema, revision and data; existing Todos can retain their current physical table. |

Use host-recorded schema ranges and C migration barriers. A new storage layout or provider-readable schema version must account for retained source operations and checkpoints. Package rollback never rolls back shared data.

```ts
interface SourceAdoptionProposalV1 {
  readonly sourceId: SourceId;
  readonly expectedSourceRevision: number;
  readonly previousBinding: SourceBindingV1;
  readonly proposedBinding: SourceBindingV1;
  readonly expectedAuthority: SourceAuthorityV1;
  readonly identityFormat: string;
  readonly storageSchema: string | null;
  readonly probes: readonly { ref: WorkRefV1; revision: string }[];
}

interface SourceAdoptionEvidenceV1 {
  readonly compatible: boolean;
  readonly authority: SourceIdentityEvidenceV1;
  readonly identityFormat: string;
  readonly readableSchemas: readonly string[];
  readonly probeResults: readonly { ref: WorkRefV1; matches: boolean; evidence: PluginJson }[];
  readonly diagnostic: string | null;
}
```

The proposed provider validates source identity and item semantics outside the transaction through its registered implementation. Core records a receipt only after checking that validation ran through the exact registered artifact, both identity evidence levels are verified, authority evidence agrees with the existing source and connection, old/new bindings match the proposal, the source revision is current, and schema/probe coverage is sufficient. Providers own protocol-specific evidence interpretation under the trusted-backend model; core does not pretend an arbitrary JSON proof is independently verified remote identity. A caller-supplied `compatible: true` is insufficient. Persist actor/reason and the evidence hash, then atomically change only future source resolution after revalidation under lock.

Probe samples catch incompatible key semantics; they do not prove an arbitrary data migration. A format change needs an explicit complete identifier mapping/data migration with collision checks, coverage validation, durable preparation, and readable retained schemas. V1 adoption initially permits unchanged identity format and compatible local data only. Unsupported conversions remain blocked, while an explicit export/import can create a distinct source without claiming identity continuity.

Operator-seeded Jira sources use a separate explicit artifact-refresh flow after an application/plugin upgrade. It accepts only the same plugin ID, provider ID, contract version, and `jira.issue-id/v1` format, preserving the source namespace, pinned connection/credential handle, settings, galleon permissions, desired enablement, and unverified identity level. The host requires a fresh read-only broker subject probe and canonical work probes from recorded aliases/snapshots. A source with no recorded items requires a validated discovery page in every authorized galleon; an empty page with a continuation token cannot prove emptiness. Missing or unauthorized recorded probes fail closed. Store any newly observed cloud identity in evidence only: refresh does not promote identity, merge namespaces, or adopt a different implementation. Append-only `source_refresh_validations` and `source_refreshes` retain actor/reason, configuration/connection evidence, and probe results. Explicit commit rechecks source/current-instance configuration and exact candidate availability, then switches future resolution atomically; existing claims, operations, artifacts, and explicit scheduler selections retain their recorded bindings.

A new connection with the same verified authority reuses the source namespace. Account rotation must separately verify the authorized subject and permissions; it cannot silently become a different integration merely because the server matches. Pending effects continue using their recorded connection identity, even after future admissions switch to a replacement instance.

### Existing installation conversion

- Create exactly one stable local collection for the existing Todo store. Preserve `TODO-N`, sequence allocation, source/run relationships, timestamps, state, priority, requirements, and header galleon scope. Validate schema/rows before recording the baseline. Repeat conversion idempotently.
- Seed a Jira source from the configured connection with its verified cloud/server identity where available; otherwise preserve an operator-seeded namespace and block adoption/automatic merging. Resolve historical display keys to immutable IDs only when evidence permits; store aliases separately. Existing C task snapshots and Jira operation targets are immutable. Unverified legacy execution rows remain under C's protected recovery behavior; new work on an operator-seeded source does not make those old bindings verified.
- Translate the effective `JIRA_ENABLED` value once into Jira source desired enablement. Local Todos become independently available without changing stored Jira credentials. After the conversion marker commits, source configuration is authoritative: the legacy variable no longer changes selection, availability, or credentials, and startup reports that it has been superseded. Replace callers of the legacy credential-masking config path with instance-scoped credential resolution. Do not repeatedly overwrite source choices from the old toggle.
- Translate auto-claim configuration to explicit source-instance selections. Preserve the prior active source by default; do not start consuming every newly available source automatically. Users can then enable both deliberately.
- Cut admission over to one implementation path. Legacy compatibility endpoints translate to `WorkRef` and source commands; no independent legacy claim loop remains active. Before migrating an authoritative local storage layout, block on any retained legacy writer that cannot participate in the compatibility adapter; do not copy rows while an old implementation can independently update them.

Before marking source conversion ready, import or conservatively fence every existing ownership obligation. Inspect C's pending admissions, active/blocked attempts, resumable checkpoints, unsettled operations, protected legacy execution records, and Todo `runId` links. Record their immutable IDs and original binding evidence in a conversion ledger; do not infer that absent `work_claims` means a task is free.

For Todos, the preserved collection and `TODO-N` give a direct mapping. Create one migrated claim with the original owner and source/run relationship, including protected legacy rows and pending preflight admissions. Conflicting old owners block cutover for that item; they are not resolved by choosing the most recent timestamp. Explicit retry/continuation transfers ownership only through the existing evidence and settlement rules.

For Jira, use an immutable issue ID already pinned in a C operation or a verified alias lookup through the original connection. Preserve the original source/connection fingerprint and evidence. If only a display key is known, create a durable source/key quarantine that every discovery, manual launch, and scheduler path consults across all galleons and instances. If aliases or a changed key make item-specific fencing unreliable, block admission for that source until ownership can be identified or explicitly settled. This blocker comes from unresolved historical work, not merely an unavailable cloud-ID API.

The final conversion transaction compares the audited ownership revision, installs migrated claim/quarantine rows, records source mappings, and enables the new admission path together. Startup and concurrent CLI mutation barriers prevent another writer from changing legacy ownership mid-conversion. Restart resumes a staged conversion without opening an unfenced source. Historical completed rows without a retained obligation remain history and do not create new active claims. Add conversion fixtures for live C Todo/Jira runs, pending admissions, resumable terminal runs, uncertain source writes, malformed legacy records, renamed Jira keys, and two instances attempting the same old work.

## Application, HTTP, scheduler, and UI cutover

Introduce core endpoints for listing source instances, source-scoped task discovery/details, source command submission, binding/adoption diagnostics, and launch by `WorkRef`. Validate instance revision and galleon permissions server-side. Legacy `/api/todos` and ticket-key launch forms remain temporary adapters with an explicit source selection; ambiguous requests receive a diagnostic instead of guessing.

The default header galleon scope remains the default for every task query and launch. Panel overrides are local and never mutate the header. A route stores source/item identity, not merely `ticketId`; preserve unknown source/provider references with an unavailable placeholder and recovery link.

Remove Todo CRUD/launch restrictions conditioned on `jiraEnabled`. Show Todos independently of Jira; Triage/Bugs availability reflects the relevant Jira capability. Replace configuration language saying that disabling Jira switches the app to Todos. Retain draft input and route state if a provider is disabled while its view is open.

The scheduler selects from explicitly enabled `(galleon, sourceInstance)` bindings. Before each admission recheck the instance revision, enabled state, WorkRef, claim reservation, and shared concurrency. Define deterministic ordering/fairness across multiple sources; do not accidentally prefer the source installed first. Initial policy is stable round-robin source selection per galleon with each provider owning its internal task order. Scheduling retries reuse the same durable admission identity.

## Bounded implementation partitions and order

D0 is a reviewed contract/data-flow checkpoint. Agree on the DTOs, validation bounds, local mutation adapter, effect registration, and adoption restrictions before parallel implementation changes consumers.

| Packet / owner | Exclusive files and deliverable | Start dependency / acceptance |
|---|---|---|
| D1: core sources and public protocol | `src/plugins/tasks.ts`; new `server/helmsman/task-sources/{registry,store,admission,local-records,adoption,effects}.ts`; parsers and contract test harness. Host owner reviews SDK/manifest/backend edits before merge. | C complete + D0 agreed. Exact binding resolution, duplicate WorkRef claims, local transaction rollback, adoption CAS, corrupt payload and disabled-provider tests pass. |
| D2: Todos provider | New `src/plugins/todos/` package following Costs/pricing layout, public-source conversion fixtures, local schema/normalization/CRUD/claim policy. No `application.ts`, `router.ts`, or private server imports in package. | D1 DTOs + local port available. Existing Todo behaviors and IDs preserved through public interface. Same-DB rollback/restart tests pass. |
| D3: Jira provider | New `src/plugins/jira/` package following Costs/pricing layout, authority/item-ID discovery, requirement normalization, source claim/completion handlers, credential broker fixtures. No application/UI edits. | D2 demonstrates the protocol; can explore old Jira shapes during D1/D2 but cutover follows Todos. Non-2xx/malformed/moved-key/rotation/tenant-mismatch and uncertain-write cases pass. |
| D4: root integration | Owns SDK entry exports, `backend.ts`/`package.ts` integration, application/router/scheduler, legacy launch conversion, main/render configuration/navigation, finalization wiring, and progress ledger. | Integrate D1 then Todos then Jira. One live source write path, both sources usable, header scope preserved. |
| D5: compatible external implementation and release evidence | New external fixture package using only published SDK and source services; shared protocol/adoption tests; distribution harness and author guide. Reassign a freed agent after D2 or D3. | Same-source adoption demonstrated with independent implementation, source unavailable at build/install runtime, no private imports or host rebuild. |

With four agent slots, root owns integration, one agent owns D1, one owns Todos fixtures/package preparation, and one audits Jira shapes and prepares tests. Activate Jira extraction after Todos validates the agreed port; reassign a completed owner to the external replacement suite. Separate file ownership is required for manifest/backend changes and every application/UI cutover. Independent reviewers inspect source identity/adoption and effects/claim races after integration.

## Shared contract suite and completion evidence

Run the same task-source suite against shipped Todos, shipped Jira with an HTTP fixture server, and the external compatible local provider. The replacement fixture must implement the contract independently using public local records; importing the built-in provider or forwarding to a private host function is not evidence of interchangeability.

| Scenario | Required evidence |
|---|---|
| Coexistence | Create/edit/launch a Todo while Jira is enabled; discover/launch a Jira issue with Todos enabled. Disabling either leaves the other usable. |
| Canonical identity | Jira key rename retains its immutable issue WorkRef. Same verified source through another connection does not create a second claim namespace. Cross-tenant same-key tasks remain different. |
| Unavailable identity endpoint | Configured Jira remains usable through its persisted operator-seeded source; credential/endpoint identity is still pinned, adoption/automatic merging is rejected, and no second namespace appears after restart. |
| Provider replacement | Adopt the local collection into the independent provider; identical WorkRefs and row relationships remain. Existing execution/effects retain the original artifacts and targets. |
| Invalid selection/adoption | Unknown explicit provider, wrong source instance, changed authority/subject, incompatible schema, unsupported identifier mapping, stale revision, and false compatibility evidence block without fallback or partial writes. |
| Local atomicity | Crash/throw between Todo claim and admission rolls back both; restart after committed claim preserves the admission. Concurrent instances cannot claim the same WorkRef. |
| Pre-D ownership | Existing C active/pending/checkpoint claims remain fenced across conversion, all instances, and galleons; unverified Jira aliases quarantine work rather than admitting a duplicate. |
| Remote claim ordering | Assignment and transition remain one ordered logical set; launch waits for acknowledgment. Remote success before local acknowledgment reconciles without a duplicate write. |
| Admission abort | Cancel before a claim, after local claim, between remote claim steps, and after ambiguous remote success; restart and repeat cancellation preserve stable settlement identity and release ownership only after verified disposition. |
| Lifecycle | Disable aborts discovery and rejects new commands/admissions; retained operation contexts can drain. Failure/restart preserves desired disable and pins. Missing credentials do not rebind. |
| Completion | Process success with failed source completion stays successful with a visible unsettled effect. A duplicate finalizer reuses its key. Continuation cannot race an unresolved prior publication. |
| Validation/cancellation | Null/malformed responses, oversized pages, cursors, sparse arrays, unexpected source IDs, revision drift, cancellation, and late provider results produce bounded errors and no partial registration/admission. |
| Compatibility/rollback | Pre-D Todo rows and run/task/usage history survive conversion; incompatible downgrade is rejected; compatible provider rollback preserves data and source identity. |
| UI/scope | Both source views and deep links work; header galleon is default, panel overrides stay local; unavailable providers preserve routes/layout/drafts. Update affected visual tests. |
| Distribution | Independently build/pack/install the replacement using public docs against isolated production distribution; load/adopt/launch/restart without application source or a host rebuild. |

Exit only after TypeScript, production build, affected unit/integration/crash suites, browser/visual checks, and isolated distribution tests pass, and independent reviews have no unresolved material findings. Record concrete commands/results and commits in the implementation progress ledger. D does not relax a failed C gate or declare the task-source SDK stable before the compatible implementation test passes.

## Application integration evidence

The application now constructs the source registry, connection broker, admission coordinator, scheduling facade, effect coordinator, and Recovery source diagnostics before accepting launches. Todo compatibility routes use the public local-source service while Jira remains enabled. Known WorkRefs reserve shared capacity and ownership before asynchronous preparation; Jira aliases reserve capacity before lookup and canonical ownership before claim mutations. Workers start only after acknowledged source receipts.

Terminal execution projection preserves the actual worker outcome when a provider is missing or source settlement fails. Durable requested and staged settlement records retain source ownership and exact artifact pins, survive restart, and reuse the original plan. Preflight aborts release proven-unstarted capacity but retain uncertain remote ownership. Resumable checkpoints preserve claims until explicit retirement; continuation checks the saved claim, instance, and snapshot identity. Recovery can retry terminal or proven-unstarted source settlement without inventing execution outcomes.

The isolated application HTTP smoke used temporary database, plugins, runs, and agent directories with detached command execution. With Jira enabled but credentials unavailable, it discovered the local source, created and accepted a Todo launch, restored the Todo after intentional command preflight failure, and served source dashboard data. Targeted regression coverage includes provider disappearance during finalization, no re-planning of staged completion, uncertain abort reconciliation, retained C admissions, and retry/continuation ownership. Jira fixtures additionally verify bot-owned In Progress retry acknowledgement without another mutation and configured workflow state normalization. Final production, browser, and distribution gate results belong in the implementation progress ledger.

Independent adapter review found and corrected remote adoption comparing a candidate revision against its own returned value. Adoption now compares the candidate with the current original provider observation, including a disabled original instance through its retained read context. If the original artifact is unavailable, recorded alias revisions and retained snapshots supply the baseline; missing or differing evidence blocks adoption with a diagnostic. Four regressions cover these paths. The adoption, application runtime, and Jira provider suites passed 54 tests together, followed by `npm run build` including TypeScript.

_Helmsman · not reported - not reported_
