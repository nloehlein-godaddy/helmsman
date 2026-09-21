# Composable pages and panels

Build against the distribution's `@helmsman/plugin-sdk`. Packages bundle their browser dependencies and use public services; private application imports are rejected at installation. The shipped examples are `src/plugins/helm` and `src/plugins/backlog`. Independent implementations live in `src/plugins/helm-alternative` and `src/plugins/backlog-alternative`.

## Package declarations

Existing manifest version 1 packages remain valid. Version 2 adds `panels` and a separate `panelEntries` map, including an empty map for page-only version 2 packages. Page and panel local IDs must be unique across both kinds.

```json
{
  "packageVersion": 1,
  "manifest": {
    "manifestVersion": 2,
    "id": "example.backlog",
    "version": "1.0.0",
    "sdkVersion": 1,
    "pages": [],
    "panels": [{
      "id": "panel",
      "title": "Backlog",
      "contract": { "id": "helmsman/helm-panel", "version": 1 },
      "requires": [{ "id": "helmsman/task-read", "version": 1 }]
    }]
  },
  "node": { "minMajor": 22, "maxMajorExclusive": 30 },
  "entries": {},
  "panelEntries": { "panel": "dist/panel.js" }
}
```

Entries default-export a `PluginPanelModule` or `PluginPageModule`. Helm replacement pages declare `slots: ["helmsman/helm-page"]`, `requires: [{"id":"helmsman/composition","version":1}]`, and `composition: {"id":"helmsman/helm-page","version":1,"accepts":[{"id":"helmsman/helm-panel","version":1}]}`.

Installation makes a contribution available. Operators choose page replacements explicitly; page authors do not overwrite existing layout selections. `/helm` and `/` resolve the selected Helm implementation. Canonical `/plugins/<plugin-id>/<page-id>` routes remain addressable. Disabled selections display unavailable state.

## Page composition

`context.composition` supplies discovery, `readLayout`, revision-checked `updateLayout`, change subscriptions, and `mount(instanceId, container)`. The container must be attached beneath the page container before calling `mount`. Instances cannot share or nest containers. Keep a stable container and managed handle across page updates to preserve drafts.

The host owns module resolution, service access, cancellation, unavailable states and error containment. The page owns arrangement and controls. Call `setActive(false)` when a page-specific presentation hides a mounted instance; the host also suspends hidden/collapsed/inactive stack members according to the saved layout. Dispose removed handles and page subscriptions.

Layouts are browser-local IndexedDB records keyed by composition identity, independent of selected page implementation. Writes use a transactional revision check across tabs. A conflict requires rereading and presenting the latest state; never overwrite it with an old revision. Missing contributions retain position, stack membership, scope and namespaced state. Raw legacy storage is archived during additive migration and is not deleted.

## Panel lifecycle and scope

`context.signal` is the panel lifetime. `context.activity` returns its current effective scope, epoch, activity and abort signal. Each update also receives an immutable activity snapshot. Scope changes, hiding, collapse and inactive tabs abort the previous activity immediately, even when an old update is still pending. Removal, replacement and disablement abort the lifetime.

Use the activity signal for reads and subscriptions. Ignore results belonging to a previous epoch. An update can arrive while an earlier asynchronous update is still pending; do not let the old result replace current content. Hiding retains the mounted instance and its drafts. Register cleanup through `context.onDispose` and return `update`, `dispose`, and optionally `refresh` from `mount`.

Scope is explicit: inherit the header, all permitted galleons, or one galleon. A panel override never changes the header. `context.services.tasks` enforces the effective scope and current source instance revision. All-galleon discovery enumerates permitted galleons; source selection is independent of automatic scheduling. Results distinguish available data from disabled, unavailable, forbidden, changed-selection and transport states. Cancellation rejects. Task DTOs exclude provider-private data.

`context.saveState({version, value})` writes only the current contribution's state namespace through the shared layout transaction. Other implementations' state is retained separately. Handle conflicts without discarding drafts. Disposed panels cannot complete new state writes. State must be bounded JSON; the complete instance state map is limited to 16 KiB.

## Run reads and commands

Declare `helmsman/run-read` version 1 for `context.services.runs`. Its bounded `list`, `load`, and `log` reads enforce effective scope. `watchList`, `watchLoad`, and `watchLog` emit an initial result and use nonoverlapping, cancellable host polling; unsubscribe on suspension or disposal. Cursors belong to their query and expire on server restart. An unavailable response is not an empty list. Worker status and source settlement are separate: a successful worker can still have pending or operator-required source settlement. Logs never establish worker success.

Declare `helmsman/run-command` version 1 for `context.services.runCommands`. Submit fixed launch, exact-attempt stop, or exact-attempt retry intents. Plugins do not choose request IDs or caller identity. The host persists one UUID per unacknowledged intent before transport and reuses it after response loss, reload, or a second mounted instance. The server binds the command content, caller, assigned execution and receipt durably. Retry reserves the original run attempt across callers, so a second UUID cannot create another child voyage. An accepted command means admission or stop intent was recorded; it does not mean a worker succeeded or stopped.

Read `pending()` after mounting and on refresh. Match each entry by exact galleon, action and target attempt. `receipt({repo,requestId})` reconciles delivery without creating work. A null receipt means the host has not recorded that identity yet; preserve it. Offer an explicit retry-delivery action using the same input, which reuses the persisted UUID. Recovery-required receipts must remain visible and direct the operator to Recovery.

Accepted and rejected receipts remain journaled until `acknowledge({repo,requestId})`. Acknowledge only after consuming the result and saving any affected draft, or after explicit user dismissal. Cancellation can occur after acceptance and before a submission result reaches the panel, so never clear drafts or assume rejection from a transport error. Acknowledgment cannot retire an uncertain command. Browser storage failure prevents dispatch.

Core Recovery lists uncertain commands. An operator may resolve a command as not admitted only when core verifies absence of its durable execution or stop intent against unchanged receipt evidence. That audited resolution returns a rejected receipt with a versioned `resolution` marker carrying the original assigned execution identity. The browser accepts that explicit resolution after reload; an ordinary contradictory rejection remains invalid. Ask the operator to check the saved request again before dismissing it. Resolution does not launch work or stop an existing worker.

The v1 runtime trusts same-origin packages. Contribution headers attribute commands to the mounted contribution; they are not a sandbox or authentication boundary. Current enablement and service declarations gate new commands, while retained receipts remain readable after disablement. Safe mode does not admit new work.

## Source views and launch readiness

`tasks.list` supports source task states; `tasks.lookup({ ...selection, displayKey })` resolves a typed key through the selected source and then loads its canonical task. An available null lookup is an unknown key. A nonnull item with `task: null` means the resolved task disappeared before it could be loaded. Preserve the WorkRef across display-key renames, and validate the selected source revision again at launch.

`tasks.underway` is an optional provider view declared by `readViews: ["underway"]`. It is not equivalent to filtering the ordinary list by state. Jira includes the configured assignee's unfinished tasks independently of queue JQL; local Todos include in-progress and in-review records. Missing view declarations remain unavailable, including for existing providers that implement only the original v1 methods.

Backlog, Underway and New Run offer a new source launch only for a currently ready task and an explicit repository. Other unfinished work remains visible with its readiness state. The core provider claim checks are authoritative and may reject a task that changes after reading. Keep saved receipts visible independently of current task state or list membership, and preserve multiple request IDs for the same canonical task when source configuration changed between intents.

## Source activity and completion dates

Declare `helmsman/activity-read` version 1 for `context.services.activity.query(selection)`. Each snapshot belongs to an exact source instance, revision and repository. The server supplies its window: UTC midnight six days ago through the current server time. Providers opt in with `readViews: ["history"]` and `readHistory(query, context)`; undeclared histories are unavailable rather than inferred from ordinary task snapshots.

The seven daily counts mean **currently Done tasks grouped by their retained completion date**. Reopened or deleted tasks are excluded. This preserves the original dashboard metric; it is not a durable count of every historical completion transition. A complete bounded current-source scan with usable completion dates yields numeric counts, including real zeroes. Partial or unavailable count coverage yields null for every day. Keep metrics per source view: overlapping configurations must not be summed into a misleading total.

Events have actual timestamps, canonical references and provider-qualified URLs. Event coverage and count coverage are separate. Todo history contains recorded creation, latest update and current completion observations, with partial history coverage because it has no transition ledger. Jira status transitions come from bounded changelog reads; truncated or unavailable changelogs remain partial even when the current Done-task scan is complete. Worker results, source task state and PR merges remain separate facts.

## Pull request reads

Declare `helmsman/pull-request-read` version 1 for `context.services.pullRequests.list` and `watchList`. Queries select `repo-open`, `authored-recent`, or `review-requested` with a bounded limit. A concrete panel cannot widen its effective repository; `repo-open` requires one repository. Watches emit initially, avoid overlapping reads and stop on cancellation.

The returned quality and truncation flags are part of the result. An empty partial or degraded result must not be presented as proof that no PRs exist. Nullable comments/review counts mean unknown. Recent authored PRs can be open, closed or merged; an open PR is not automatically in review. Use actual `createdAt` and `mergedAt` for activity events, and never invent a review timestamp from creation time. Use returned provider URLs instead of constructing a global GitHub/Jira fallback.

## Links and styling

`?panel=<instance-id>` identifies a panel independently of its contribution. Preserve missing locators; a page can reveal and focus an available target once per navigation. A host-supplied `state.panelContribution` optionally resolves the first instance of a contribution when the instance locator is absent or missing. The shell uses this for legacy pane links; an explicit panel URL never gains that fallback.

`panelState` retains bounded namespaced versioned route data while a contribution is missing. Pages receive that map as `state.panelRouteState`; panels receive only their contribution's value as `state.routeState`, limited to the addressed instance when specified. Route state is ephemeral and separate from `savedState`; validate its version and payload before use. A route change is delivered even when scope and theme stay the same. Source task links use the task's validated URL and canonical WorkRef, never a global Jira fallback. Legacy display keys are unresolved locators until a selected source supplies their canonical identity.

Use package-owned classes and inherited theme variables. Existing application classes are private. Respect `state.pirateMode` in authored copy, preserve user content, and provide keyboard-accessible layout controls, focus restoration, and responsive unavailable/error states.
