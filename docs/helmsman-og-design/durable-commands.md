# Durable OG command design

**Scope:** Triage `Assign to me`, configurable in-app feedback, and Underway task/run/PR actions. Assignment and feedback remain design-only. The read-only Underway context in section 3 is implemented in Batch 2. The decisions in the [consolidated design](../helmsman-og-feature-design.md) refine the illustrative shapes below: core owns binding authority, feedback uses a tracker-neutral destination, and assign-self never takes over another actor's assignment.

## Ground rules from the current implementation

- `source-command` is intentionally a local-record editor command: its server coordinator obtains a `LocalSourceCommandPlanV1` and applies it through `LocalSourceAdapter`. Jira declares `connection-http` and no command IDs. It must not be reused to send a Jira mutation.
- Jira already exposes a retained, reconcilable `assign` source effect. It reads the current issue, compares the pinned state, performs the assignment once, and reconciles by rereading the issue. Reuse that effect shape, but do not let a new UI manufacture its payload.
- The operation ledger already provides the needed durable properties: immutable logical key/content hash, captured provider binding and artifact closure, post-commit dispatch, lease fencing, an `invoked` boundary, and `unknown`/operator recovery. Use it for every remote mutation here.
- Browser-side command journals preserve the caller's request ID and receipt across reload. Server-side ledger records protect a request across restart. Both are required; neither substitutes for the other.
- `work_claims` provides the canonical task-to-run association (`WorkRefV1`, `runId`, retained source instance). A run row provides a canonical recorded PR number when Helmsman created or recorded one. `PresentationLocatorV1` already supports canonical `run` and `pull-request` selections. Ticket keys, branch names, and PR titles are display data only and must never establish any association.

## 1. Triage: assign the authenticated Jira actor to one task

### Proposed public contract

Add a source-side *remote action* contract; do not broaden `TaskEditActionV1` or overload editor/local commands.

```ts
interface SourceRemoteActionRequestV1 {
  readonly version: 1;
  readonly action: 'assign-self';
  readonly selection: TaskReadSelectionV1;
  readonly sourceRevision: number;
  readonly target: {
    readonly ref: WorkRefV1;
    readonly repo: string;
    readonly expectedRevision: string;
  };
}

interface SourceRemoteActionPlanV1 {
  readonly version: 1;
  readonly action: 'assign-self';
  readonly target: PluginJson;
  readonly payload: PluginJson;
  readonly effectId: string;
  readonly receipt: PluginJson;
}

interface TaskSourceProviderV1 {
  prepareRemoteAction?(
    request: SourceRemoteActionRequestV1,
    context: SourceCallContextV1,
  ): Promise<SourceRemoteActionPlanV1>;
}
```

Declare actions separately from `commandIds`, for example:

```ts
remoteActions: [{ id: 'assign-self', effectId: 'assign' }]
```

Only declarations with `connection-http` may expose a remote action. The package validator requires its `effectId` to be declared and the provider to implement `prepareRemoteAction`. This keeps a provider's writable surface explicit and lets a copied external package implement the feature without a Jira-specific core route.

Expose a small public client service, `taskActions@1`, with the established journal shape:

```ts
submit(SourceRemoteActionInputV1): Promise<Result<SourceRemoteActionReceiptV1>>
receipt({ repo, requestId }): Promise<Result<SourceRemoteActionReceiptV1 | null>>
retry({ repo, requestId }): Promise<Result<SourceRemoteActionReceiptV1>>
pending(): Promise<readonly SourceRemoteActionPendingV1[]>
acknowledge({ repo, requestId }): Promise<void>
```

`SourceRemoteActionInputV1` adds only a generated `requestId` to the request above. Its receipt is `pending | succeeded | rejected | recovery-required`; a success returns the same canonical task reference plus the observed task revision and actor account ID. The input parser accepts no caller-provided actor, Jira account ID, connection ID, effect ID, or raw target/payload.

The Triage package requests only `assign-self` for an available row. It restores pending commands before enabling a duplicate button, disables the same `(sourceId, externalId, action)` while a receipt exists, displays the retained outcome, and offers receipt/retry/recovery/dismiss using the same semantics as Run, PR, and Communication commands.

### Server preparation and authority

`TaskActionCommandService` belongs in core, beside the existing public command services. On first submit it:

1. Authorizes the frontend caller by a new `helmsman/task-action@1` manifest requirement and applies the captured galleon scope.
2. Resolves the exact source ID, instance ID/revision, source revision, allowed repo, provider registration, connection and artifact closure. The action is rejected if any selection is stale, disabled, unavailable, or outside scope.
3. Loads the exact source item through that retained source instance and rejects a missing task or a changed `revision`. It also rejects an active, incompatible work claim; an action cannot silently change a task being driven by a different retained claim policy.
4. Calls `prepareRemoteAction` outside the write transaction. Before enqueue, rechecks the exact source binding/registration/settings and task revision.
5. Enqueues one ledger operation with key `public-source-action:${hash({caller, requestId})}` and origin `public-source-action`; dispatch begins only after the transaction commits.

The operation binding is the selected source's `ProviderBinding` (`role: 'effect'`, task-source contribution, artifact hash, connection ID, credential handle) and its complete artifact closure. The immutable target/payload are the provider plan; the operation payload contains the original parsed command, caller, action and provider-prepared receipt schema. The system must retain a settings hash or full retained source instance in the payload and revalidate it before invoke/reconcile, matching the existing source effect runtime.

The Jira provider's preparation is specific:

- Read `/myself` under the pinned source HTTP connection; this account ID is the authenticated actor and is never derived from `assigneeAccountId`, search-assignee settings, or an email/display name.
- Read the exact issue and require the source ID, project/repo mapping and revision to match the submitted task.
- Capture its status ID and current assignee account ID. If already assigned to the authenticated account, produce an immediately acknowledged no-write receipt. If the product only permits claiming unassigned work, reject any non-null different assignee here; that policy must be explicit in the provider, not inferred by the UI.
- Otherwise return the existing `assign` effect with `{ issueId, sourceId }`, `{ accountId: authenticatedAccountId, expectedStatusId, expectedAccountId }`. The existing handler's preflight/reconcile behavior then proves the mutation or leaves it uncertain.

Use `source-remote-action.assign-self` as the operation kind rather than the run-owned `jira.assign` kind. The resolver delegates to the selected source effect handler, checks the saved action/effect identity and binding before every invoke/reconcile, and projects a receipt only after a matching effect acknowledgment. The run finalization resolver must not drain these caller-owned actions.

### Uniqueness, retries, and recovery

- Client journal uniqueness is `(caller, repo, sourceId, externalId, action)`: a second click restores the existing request instead of generating a new one. It may create a fresh request only after a terminal receipt is dismissed and the UI has reread the task.
- Server uniqueness is `(caller, requestId)` with immutable content hash. A reused request ID with any changed selection, expected revision, or intent is `409`, never a new assignment.
- The operation key is immutable and persisted before an HTTP write. `markInvoked` occurs immediately before the provider effect invokes Jira.
- A timeout/lost response after invoke is `recovery-required`; retry first reconciles the exact issue. It must not replay the PUT merely because no response arrived. A proven non-application can enter the normal ledger retry path only when the provider says retryable.
- A changed source binding, settings, authenticated connection subject, task revision/status/assignee, or missing artifact blocks/rejects according to whether the remote effect could have been invoked. Never replace it with the newly selected Jira connection.
- Recovery exposes the saved caller, task ref, operation ID/hash, captured actor/account ID, binding, state evidence, and only an explicit operator "not applied" resolution when no retained or provider reconciliation evidence proves a write.

### Backward compatibility

This is additive. Sources with no `remoteActions` remain readable; Triage hides the action. Existing `TaskSourceProviderV1`, task-source manifests, SourceCommand APIs, and source effect plans retain their current behavior. An older host does not expose `taskActions`; an authored Triage package treats the service as unavailable rather than attempting a direct fetch.

## 2. Configurable in-app feedback submission

### Product and plugin shape

Ship a small feedback presentation package, but keep it disabled by default. It shows an entry point only when a selected, configured feedback tracker has a concrete destination. An unconfigured or explicitly `disabled` tracker yields a neutral unavailable state; it must not show a form that discards a draft or hard-code the Helmsman repository.

Add a backend capability `helmsman/feedback-tracker@1`, with a selected `feedback` role analogous to the independent provider selections. Its declaration uses `connection-http`; credentials remain in core. A GitHub Issues implementation can be shipped by the GitHub package, but it is one provider implementation, not a core `fetch` shortcut.

```ts
interface FeedbackDestinationV1 {
  readonly providerId: string;
  readonly artifactHash: string;
  readonly connectionId: string;
  readonly tracker: 'github-issues';
  readonly repo: string;
  readonly labels: readonly string[];
}

interface FeedbackTrackerProviderV1 {
  prepareSubmission(
    input: { title: string; body: string; context: FeedbackContextV1 },
    context: FeedbackTrackerContextV1,
  ): Promise<FeedbackDestinationV1>;
  invokeSubmission(
    input: FeedbackSubmissionOperationV1,
    context: FeedbackTrackerContextV1,
  ): Promise<FeedbackTrackerResultV1>;
  reconcileSubmission(
    input: FeedbackSubmissionOperationV1,
    context: FeedbackTrackerContextV1,
  ): Promise<FeedbackTrackerResultV1>;
}
```

`FeedbackContextV1` is bounded, redacted product context (Helmsman version, selected galleon if any, active page, and optional user-selected run/PR canonical locator). It excludes logs, credentials, task bodies, plugin settings, browser DOM, and arbitrary request headers. The tracker configuration defines target repo and optional approved labels. The user cannot type a destination repository or label into the submission protocol.

The public browser service is `feedbackCommands@1`, deliberately parallel to pull-request and communication commands. `submit`, `receipt`, `retry`, `pending`, and `acknowledge` use an IndexedDB journal keyed by caller and `draftId`; the journal preserves title/body/context and request ID through reload. Editing a retained draft after reserving it requires an explicit "create revised submission" path with a new draft/request ID; it never changes an existing operation's hash.

### Server authority and lifecycle

`FeedbackCommandService` follows the public review-command model:

1. Caller must declare `helmsman/feedback-command@1`; caller identity is included in the key and never trusted from the request body.
2. The current galleon scope constrains only contextual metadata. It does not authorize the external tracker destination; that authority comes from the selected feedback tracker and its configured destination.
3. `prepareSubmission` captures the exact feedback provider registration, destination, core-owned connection/credential identity, artifact closure, and settings hash. Recheck all before enqueue and before dispatch.
4. Enqueue `feedback.submit` with key `public-feedback:${hash({caller, requestId})}`, origin revision hash of the immutable command, no run owner, and a pinned `ProviderBinding`. Persist the normalized title/body/context/destination and an operation marker `{operationId, contentHash}`.
5. The GitHub implementation creates one issue with an invisible durable marker in the body. Its receipt contains the configured repo, issue number and canonical HTML URL. Reconciliation searches/reads by the exact marker in the pinned repo and validates title/body hash and destination before it acknowledges.

The initial settings UX should be a feedback-tracker selection plus tracker-owned fields in Config: provider selection, target repository, labels, and enabled state. Default is `disabled`; changing a configuration affects new drafts only. Pending requests retain the old provider artifact/destination and continue reconciliation when the package is disabled, just as existing durable operations retain their bindings.

### Lost-response semantics

The external create POST is at-most-once from Helmsman after `markInvoked`:

- A returned matching issue receipt completes the operation.
- A 4xx rejection before a possible create is definite; whether it is retryable is provider-defined.
- A network timeout, 5xx, malformed response, or connection change after invocation becomes `unknown`/`recovery-required` and starts with exact-marker reconciliation.
- Do not create another issue while the marker cannot be conclusively found. The user sees the retained draft and recovery state; an operator may resolve "definitely not created" only with evidence, which permits a new delivery generation.

This avoids both OG's hard-coded destination and silent duplicate issue creation. A simple external browser link can remain an optional, non-durable alternative, but it is not the in-app submission contract.

### Backward compatibility

No existing provider is assumed to implement this capability. Existing GitHub/PR behavior and credentials remain unchanged. Unsupported hosts render feedback unavailable; external providers compile against an additive SDK minor contract. Do not add feedback fields to the generic plugin `settings` object that could carry a token.

## 3. Underway canonical task, run, and PR actions

### Canonical context read service

Add read-only `taskContext@1` to host services:

```ts
resolve({
  version: 1,
  selection: TaskReadSelectionV1,
  ref: WorkRefV1,
  taskRevision: string,
  claim: 'active' | 'settled',
}): Promise<Result<{
  version: 1;
  task: { selection: TaskReadSelectionV1; ref: WorkRefV1; url: string | null };
  claim: { id: string; revision: number; state: 'reserved'|'claimed'|'settling'|'settled' } | null;
  run: { repo: string; runId: string; expectedAttempt: number } | null;
  pullRequest: { repo: string; number: number; sourceRunId: string } | null;
}>>
```

Resolution validates current source selection and galleon scope, then reads canonical persisted associations:

- Task identity is exactly `(sourceId, externalId)` and selected source instance/revision.
- Run identity comes only from `work_claims` for that exact work ref. Prefer the active claim; permit a history action to request an explicitly returned settled claim/run, not a guessed "latest ticket" run.
- PR identity comes only from a run that has a recorded `prNumber`, matched to the same run and repo. If publication eventually records a head SHA, include it for later write eligibility; a PR title containing a ticket key is never evidence.
- If a provider cannot prove one edge, return that edge as `null`, while still returning verified neighboring context. Do not fan out into PR search to fill the gap.

Underway requests active claims; callers must explicitly request settled history. The service is read-only and requires no new journal. It should be implemented over `TaskSourceStore.claim/claimForRun` plus the run row/inspection authority, not by exposing private snapshots or task JSON. Every result is bounded and contains no connection, credential, source settings, worktree, or log data.

### Underway UI actions

For every Underway row, retain the existing external source-task link. Once `taskContext.resolve` completes, show only supported canonical actions:

1. **Open task**: its provider URL, already keyed to the source item.
2. **Open run**: `selectPresentation({ version: 1, kind: 'run', repo, runId })` (or the existing `/runs?run=...&repo=...` navigation fallback). It is only enabled for the returned canonical run.
3. **Open pull request**: `selectPresentation({ version: 1, kind: 'pull-request', repo, number })`, only for the returned canonical PR. It uses the existing PR presentation/inspection chain.

If a future Underway action requests Slack review, it accepts only this returned `{repo, number, sourceRunId}` association and submits the existing `communicationCommands` protocol; it must not construct a request from ticket text. The communication service still captures and validates the PR head, selected communication destination, and its own durable request journal.

The panel caches context by `(sourceId, externalId, source instance revision, task revision)` for the visible generation only, cancels stale requests with activity scope, and renders unavailable/changed states rather than retaining an old button. It does not need persisted panel state for context; run/PR presentation state remains canonical in routing.

### Reconciliation and compatibility

Task context has no side effect. A row that was reassigned, settled, deleted, or crossed a source revision simply loses actions after refresh. Opening a returned run/PR remains safe because the target presentation already revalidates its own repo/ID; a failed target read reports unavailable rather than attempting discovery by title.

`taskContext` is additive and optional. Existing Underway builds still show their current task and launch controls. The upgraded Underway panel hides contextual buttons if the host omits the service, preserving copied-package compatibility. No existing run command, PR read, communication command, or presentation locator changes are required for the first action set.

## Affected paths

| Area | Primary paths |
|---|---|
| Public SDK/contracts | `src/plugins/tasks.ts`, `src/plugins/backend.ts`, `src/plugins/host-services.ts`, new `src/plugins/task-action*.ts`, `src/plugins/feedback-command*.ts`, `src/plugins/task-context*.ts`, SDK baseline declarations/exports |
| Plugin manifest/runtime | `src/plugins/package.ts`, `src/plugins/runtime.ts`, backend registration/registry modules, selection/configuration services and docs |
| Task action server | new `server/helmsman/task-action-*.ts`, `server/helmsman/router.ts`, `server/helmsman/application.ts`, `server/helmsman/task-sources/effects.ts`, recovery projection/routes |
| Jira implementation | `src/plugins/jira/provider.ts`, `src/plugins/jira/effects.ts`, `src/plugins/jira/backend.ts`, `server/helmsman/plugins/builtin-task-sources.ts` |
| Feedback server/provider | new feedback provider registry/effects/command service/routes, `server/helmsman/application.ts`, `src/plugins/github/{backend,provider}.ts` or a separately shipped tracker package |
| Presentation packages | `src/plugins/triage/{panel,page,plugin-package}.ts`, a new feedback frontend package, `src/plugins/underway/{panel,plugin-package}.ts` |
| Context read | new task-context server/read service, `server/helmsman/task-sources/store.ts`, `server/helmsman/run-read-service.ts`, `src/plugins/presentation.ts` only if an explicit task locator is later wanted |
| Validation/docs | focused contract/service/provider/panel/restart/recovery tests; `docs/plugin-packages.md`, a new authoring guide for remote source actions and feedback trackers |

## Delivery and acceptance phases

1. **Contract proof.** Add additive parsers, strict field/size limits, package validation, SDK declarations, copied-consumer compile proof, and no UI behavior. Verify that old packages and hosts remain usable.
2. **Triage durable action.** Implement the action journal, server/ledger bridge, source-effect resolver, Jira preparation and Triage affordance. Test stale selection/revision, disabled source, different authenticated Jira subject, already-self, other assignee policy, duplicate clicks, restart, lost PUT response, exact reconciliation, disabled/replaced provider, and operator recovery.
3. **Feedback capability and one provider.** Implement selection/configuration default-disabled, browser draft journal, command/operation flow, and GitHub Issues provider with an exact marker. Test unconfigured/disabled behavior, bad destination, request-id conflict, draft restore, response loss, marker-found reconciliation, marker-not-found recovery, package disable/restart, and no token/settings/log leakage.
4. **Underway context.** Add canonical task→claim→run→PR read projection and panel actions. Test source instance/revision changes, no claim, active/settled claim policies, run with no PR, PR in another repo rejection, deleted run/PR, galleon scope, and adversarial shared ticket strings/PR titles proving that no inferred action appears.
5. **Settled integration.** Run affected unit/integration tests, TypeScript/build, copied-package/distribution checks for each new SDK surface, and the relevant browser flows. Perform the required architectural review of the implementation commit; verify recovery rows preserve artifact, binding, connection, request, and receipt identities without secrets.

_Helmsman · not reported - not reported_
