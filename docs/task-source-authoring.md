# Task source authoring

The provisional version 1 source contract lives in the distributed `@helmsman/plugin-sdk`. A source implementation discovers work, normalizes requirements, and prepares claim/completion/cancellation plans. Core owns admission, identity, credentials, durable delivery, local transactions, worker execution, and recovery.

Use `plugin-sources/local-tasks-alternative` in the release as an independently implemented compatible local source. It has no imports from the shipped Todo implementation or server modules. `plugin-sources/todos` implements the existing Todo policy. They use the same public local collection format and may serve the same collection after adoption validation.

## Build and declare a source

Copy a package into an author workspace, then build against the released SDK:

```sh
npm install --save-dev /absolute/path/to/release/sdk typescript
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./dist ./source.hmp
```

Type-only SDK imports disappear during compilation. Bundle runtime dependencies into the archive; backend packages cannot resolve application source imports or arbitrary package-manager dependencies at activation.

Declare `backend.provides: [{id: 'helmsman/task-source', version: 1, localId: 'collection'}]` and a matching `backend.taskSources.collection`. That declaration lists identity formats, effect IDs, command IDs, and the services it needs (`local-records`, `connection-http`). During activation call `context.registerTaskSource('collection', provider)`. Every declared capability and handler must register successfully before any are published. Keep external package IDs outside the reserved `helmsman.*` namespace.

Activation registers handlers. Per-call source contexts carry the selected instance, galleon scope, cancellation signal, and authorized services. The activation signal may already be aborted when a disabled source is loaded solely to settle retained work; source handlers must use their invocation's signal for those obligations. Ordinary activation storage/usage services are unavailable in that state.

## Identity and data

`WorkRefV1` is `{sourceId, externalId}`. The host assigns the source UUID. Display keys are aliases, not item identity. Jira key changes must retain the same immutable issue ID. A local collection exposes its collection UUID and durable identity evidence through `local.describeCollection()`.

An instance pins the provider contribution, exact artifact, settings revision, permitted galleons, and connection/credential handles. Handles are opaque. Package IDs, credentials, and connection URLs do not create a new logical source namespace. Adoption changes future resolution; earlier task snapshots, claims, and effects retain their recorded binding.

For `helmsman.local-task/v1`, the public record consists of:

| Field | Owner / meaning |
|---|---|
| `ref`, `repo`, `revision`, `schema` | Host identity, galleon and compare-and-set version. |
| `data.version` | `1`. |
| `data.title` | Required, at most 240 characters. |
| `data.description`, `data.acceptanceCriteria` | At most 20,000 characters each. |
| `data.priority` | `P0` through `P4`, highest priority first. |
| `data.state` | `todo`, `in_progress`, `in_review`, `done`, or `blocked`. |
| `data.createdAt`, `updatedAt`, `completedAt` | Host timestamps. The first completion time stays stable while done. |
| `claim`, `claimState`, `lastRunId` | Host ownership and last voyage linkage. Providers cannot fabricate these fields. |

Use `LocalTaskInputV1` in mutation plans to omit timestamps. The host assigns canonical IDs; an adopted Todo collection retains its `TODO-N` sequence. A reserved record may have no receipt yet, or retain the previous settled receipt for explicit retry validation. Migrated historical rows may also expose a null receipt with `settling` (protected legacy ownership) or `settled` (terminal `lastRunId` linkage). Keep protected rows visible, block mutation, and require a real receipt to settle source claims. Core verifies the exact active reservation before accepting a claim plan.

Task snapshots contain neutral requirements and versioned non-secret provider data. The host validates association, galleon, nested fields, links, and size. Snapshot/local-document payloads are bounded to 256 KiB to preserve valid legacy Unicode requirements; each task page is bounded to 100 items and 2 MiB. A smaller page is valid. Continue until `nextCursor` is null; an empty filtered page may still have a next cursor. Cursors should detect underlying collection changes rather than silently repeat or skip work.

Ready discovery is used by the scheduler. Exclude tasks that fail your source's launch prerequisites, such as a local Todo without a description. Unfiltered discovery can still expose incomplete drafts for editing.

## Plans and side effects

`planClaim`, `planCompletion`, and `planAbort` return one of:

- `none`, with a reason when no source mutation is needed.
- `local-record`, with an exact WorkRef, expected revision, and replacement document.
- `remote-effects`, with declared handler IDs, targets, payloads, and an acyclic local dependency graph.

Planning happens outside the database transaction. The host rechecks scope, provider lifecycle, revisions, and claim ownership before applying a local plan together with admission or finalization. Claimed work cannot be edited or deleted. User commands cannot enter `in_progress`; that requires admission. Explicit galleon moves require permission for both the existing and target galleons and do not change the header scope.

The compatible local commands are:

```ts
create: { title, repo, description?, acceptanceCriteria?, priority?, state? }
update: { ref, expectedRevision, patch: { title?, repo?, description?, acceptanceCriteria?, priority?, state? } }
delete: { ref, expectedRevision }
```

Clients provide stable command request IDs. The host commits the result receipt and mutation together; after a lost response, replay the same ID and payload. Do not generate another create request to retry its response.

Remote discovery and reconciliation receive a read-only HTTP capability. Only `invoke` receives the mutation service, bound to its pinned operation. The broker resolves credentials, verifies the recorded endpoint/subject/authority, rejects redirects, and checks authorization immediately before each request. A lost response is `unknown`; it is not proof that a write failed. Reconciliation supplies evidence before any retry. Claim steps can declare dependencies, such as assigning an issue before changing its state.

`planAbort` handles cancellation or failed preparation before a worker outcome exists. It receives partial claim evidence. Already-issued writes may need reconciliation or explicit settlement; never infer that an expired lease means nothing happened. Source ownership remains protected until the host records a verified settlement. Desired disable prevents new work while dedicated obligation contexts may finish retained claims and effects.

## Compatibility and validation

Source declarations may provide `settingsFields`, mapping each editable non-secret key to a label and bounded scalar, string-list or string-map schema. `helmsman/source-admin@1` returns this metadata with only explicitly stored declared values. A schema default is presentation guidance; an absent override remains absent until the user edits it. Connection identities and credential handles are never source-setting fields.

Configuration submits the complete desired explicit declared overrides in `changes.settings`, together with the original source and instance revisions. Keep every unchanged explicit override. Omitting a declared key resets that override to the provider's default behavior; undeclared internal settings are preserved. If the provider artifact is unavailable, the service exposes no editable settings and an empty settings map preserves stored settings while allowing core label, enablement and allowed-galleon changes. Preserve a pending configuration's exact input and request identity after response loss instead of rebuilding it from a newer snapshot.

A compatible replacement must independently interpret the public document schema, verify collection identity, load the host's adoption probes, and report the exact unchanged item semantics. A matching identity-format string alone is insufficient. Host-recorded adoption checks the actual registered artifact and current source/instance/collection revisions before changing future resolution. Unsupported identity or schema conversions need a separate validated migration.

Run the shared source contract tests against every implementation. Include malformed and canceled responses, stale revisions, duplicate command replay, concurrent claims, rollback, disabled-source completion, partial remote writes, and restart. The distribution test additionally compiles and installs the independent package outside the checkout, adopts a preserved local collection, commits a claim, restarts in a new process with the original provider disabled, and completes a real durable worker with source access denied.

## Task editors and durable source commands

Providers can declare a versioned editor contract and supply editor documents through `helmsman/task-edit@1` (`context.services.taskEdit`). A document separates editable values from the canonical target, expected revision, allowed actions, destination repositories and an optional related voyage. The provider supplies the task-to-run association; core verifies that the proposed run exists in the selected galleon and suppresses missing or out-of-scope links. This check does not establish canonical claim ownership. An editor declaration alone does not authorize a mutation. The local Todo editor uses `helmsman/local-task-editor@1`; private storage documents are not browser editor payloads.

A panel declares `helmsman/source-command@1` and submits through `context.services.sourceCommands`. The host journals the original source/instance revisions, editor/action, target, values, destination and request UUID before dispatch. Provider `prepareEditorCommand` translates those public values into its declared command plan; core rechecks authority and commits local mutation plus receipt atomically. Preparation is bounded even if a provider ignores cancellation. A lost response or ambiguous preparation must remain pending/recovery-required, never inferred rejected. Use receipt lookup or optional `retry({repo,requestId}, signal?)` for the exact retained request, save the consumed result/draft, then acknowledge a terminal receipt. Retry never reserves new identities; after another tab acknowledges, missing retained requests remain unavailable. Older hosts without retry retain receipt checks and disable redelivery. Never pass saved input to `submit` as a retry. Scope changes and provider replacement must not retarget saved requests.

`helmsman/source-admin@1` (`context.services.sourceAdmin`) supplies redacted configuration metadata, revision-checked source changes and schedules, and process-local automatic-start controls. Configuration and schedule intent receipts are durable. A historical automatic-start receipt describes its original process; it does not prove the current process is enabled. Never rebuild an uncertain toggle with a new UUID. Optional `retry({repo,requestId}, signal?)` uses the original retained administration command, including its process epoch; a missing reservation cannot create a replacement. See [source settings](../src/plugins/source-settings/README.md) for UI handling and [Recovery](recovery.md) for operator boundaries.

## Independent Triage and Bugs views

Declare optional `readViews: ["triage", "bugs"]` and implement the matching provider methods. Panels declare `helmsman/task-views-read@1` and use `context.services.taskViews`; snapshots bind the exact source instance, revision and repository. Unsupported views remain unavailable. DTOs expose allowlisted task identity, links and metrics, without private provider data or connection credentials.

Triage queries select `unassigned-backlog`, `unassigned-todo`, or `mine-open`, priorities 0–4, an optional update cutoff, frozen `until`, bounded limit and cursor. Groups have independent completeness and cursors. Apply filters before the page boundary; a bounded scan can return a partial page with continuation. Freeze the observation window while paging, and bind cursors to selection and filters. Host-enriched related-run links require a canonical task claim and a real run in that same repository; display keys cannot establish that relationship.

Bugs snapshots describe current observations, not historical reconstruction. Keep count quality (`exact`, `approximate`, `unavailable`) separate from row/oldest/sample quality (`complete`, `partial`, `unavailable`). Unknown values remain null. Report actual due dates and severity; resolution P75 exposes sample size, population and capped coverage separately. An empty partial oldest page does not prove that no old bug exists.

The Jira provider uses the fixed read query `jira.approximate-count/v1` with a JQL-only input. The host sends its fixed POST to `/rest/api/3/search/approximate-count` through the authorized read capability. This grants no general POST, arbitrary path, header or mutation authority. See the [Jira package](../src/plugins/jira/README.md), [Triage package](../src/plugins/triage/README.md), and [Bugs package](../src/plugins/bugs/README.md).

## Legacy Todo receipt recovery

`helmsman/todo-legacy-recovery@1` exposes `context.services.todoLegacyRecovery.pending`, `check` and `acknowledge`. Core reads the old session journal and checks its original method, path, input and UUID; packages do not read private browser storage or reissue old mutations through the new source-command service. A nonempty legacy journal requires All-galleon scope. Only a verified terminal receipt can be acknowledged. Missing immutable original authority, an unrecorded request or an ambiguous inner mutation remains blocked or pending. The [Todos author package](../src/plugins/todos-ui/README.md) demonstrates this compatibility path within the default plugin route. The legacy journal remains preserved after shell retirement.

A submitted Todo draft without a request ID is recovery evidence, not authority to dispatch. Reconcile it against an exact-input match in the retained journal and check that original receipt. If no match remains, keep the draft and submission marker and show the unresolved identity; never submit the draft again as a retry.
