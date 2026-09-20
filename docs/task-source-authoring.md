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

A compatible replacement must independently interpret the public document schema, verify collection identity, load the host's adoption probes, and report the exact unchanged item semantics. A matching identity-format string alone is insufficient. Host-recorded adoption checks the actual registered artifact and current source/instance/collection revisions before changing future resolution. Unsupported identity or schema conversions need a separate validated migration.

Run the shared source contract tests against every implementation. Include malformed and canceled responses, stale revisions, duplicate command replay, concurrent claims, rollback, disabled-source completion, partial remote writes, and restart. The distribution test additionally compiles and installs the independent package outside the checkout, adopts a preserved local collection, commits a claim, restarts in a new process with the original provider disabled, and completes a real durable worker with source access denied.
