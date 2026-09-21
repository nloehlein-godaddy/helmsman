# Experimental usage and pricing plugins

This guide covers the usage/pricing surface introduced in Phase B. The SDK also supports [task-source providers and E3 task services](task-source-authoring.md), [page/panel composition](panel-authoring.md), [communication providers](communication-authoring.md), [terminal presentation](terminal-authoring.md), and durable [execution/plugin recovery](recovery.md). Interchangeable execution primitives remain Phase F work; broader compatibility retirement is still pending.

## Build an independent package

Build the [distribution](distribution.md), then copy `release/examples/plugins/flat-pricing` into an author directory outside the application. Install the SDK and TypeScript there:

```sh
npm install --save-dev /absolute/path/to/release/sdk typescript
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack output flat-pricing.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js install flat-pricing.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js configure example.flat-pricing '{"usdPerMillionTokens":2}'
node /absolute/path/to/release/server/helmsman/plugins/cli.js enable example.flat-pricing
node /absolute/path/to/release/server/helmsman/plugins/cli.js select-pricing example.flat-pricing/flat
```

Use the same `HELMSMAN_PLUGINS_DIR` as the server. Restart after configuration/activation changes. Pricing selection is read on each request. `select-pricing default` clears the explicit binding; it does not select a particular provider. With no binding, exactly one active provider is required. Missing or ambiguous selections return a diagnostic. An explicitly selected disabled provider never falls back to another implementation.

The shipped `helmsman.standard-pricing/standard` provider is explicitly selected once for an unconfigured installation. Disable it with `disable helmsman.standard-pricing`; restore with `enable helmsman.standard-pricing` and `select-pricing helmsman.standard-pricing/standard`. These commands preserve data. The ordinary `list` command lists installed external packages and page bindings.

`release/plugin-sources/costs` contains the full shipped Costs implementation as a standalone author project, and `release/examples/plugins/costs-summary` contains an alternative. Both build with the copied SDK and TypeScript via `npm run build`; pack their `dist` directory. Select their respective `example.full-costs/page` or `example.costs-summary/page` contribution for `helmsman/costs-page`. `release/plugin-sources/pricing` similarly publishes the shipped standard pricing implementation as `example.standard-pricing/standard`. These author builds do not import application source.

## Backend package and context

A package may add a `backend` field to the existing descriptor:

```json
{
  "entry": "backend.js",
  "provides": [{ "id": "helmsman/pricing", "version": 1, "localId": "flat" }],
  "settings": { "usdPerMillionTokens": { "type": "number", "default": 1, "minimum": 0, "maximum": 1000 } },
  "storageVersion": 1
}
```

Backend-only packages declare empty `pages` and `entries`. The ESM entry default-exports `PluginBackendModule`, whose `activate(context)` registers all declared providers. The injected context supplies immutable validated settings, a lifetime abort signal, `onDispose`, `usage.query`, namespaced `storage.get/set/delete`, and `registerPricing`. Import public types from `@helmsman/plugin-sdk`; bundle runtime dependencies. Backend imports may use Node built-ins through `node:` specifiers. Browser-reachable code cannot import Node built-ins. Private host and cross-plugin imports are rejected by the packager and installer.

Settings schemas support bounded numbers, bounded strings, and booleans; unknown keys and invalid values are rejected. `configure` merges validated overrides and prints effective settings. `reset-settings ID [KEY]` removes one or all overrides without deleting owned data, allowing recovery when an upgrade removes a setting. Storage keys belong to the active plugin namespace. JSON values are bounded, storage is limited to 1,024 keys and 8 MiB per plugin, and schema version 1 is currently supported. Settings, storage versions/data, builtin enablement, and pricing bindings live in `plugin-data.sqlite` under the plugin directory. Core usage retains its existing table in the application database. There is no plugin-specific database handle or environment object in the SDK.

Activation stages registrations and storage writes until success. Failure or timeout discards staged writes, aborts the context, and disposes owned resources. A package containing both pages and a backend publishes its pages/assets only after backend activation succeeds; its selected bindings and installation record survive failure. Runtime/provider failures produce diagnostics without substituting a provider. Safe start skips optional backend composition entirely. Disable denies new work while retained execution and operation pins protect existing obligations; see [Recovery](recovery.md). Follow the CLI restart instruction when changing backend configuration or activation. Safe start intentionally performs no draining or effect reconciliation.

These are trusted modules with host privileges. The APIs and import checks provide an authoring boundary, not a sandbox.

## Communication providers

A backend may provide `helmsman/communication@1`, declare the same local ID under `backend.communications` with `access: ["browser-session"]`, and call `registerCommunication`. Core selects one provider with `select-communication`, captures its binding and artifact before a review request, and keeps them with the durable operation. New work is unavailable when the selected provider, connection, destination, or verified artifact is unavailable. Retained obligations resolve through the pinned provider artifact after disablement or replacement.

The provider prepares a destination, explicitly invokes or reconciles a retained request, and scans incoming review messages. Preparation and scans cannot send. Invocation must cross `beforeSend()` immediately before its mutation; reconciliation remains read-only. Only an exact workspace/channel/mention/connection receipt proves acknowledgment. A matching PR URL elsewhere in Slack is not a request receipt and cannot justify replay or completion.

Core supplies bounded Slack-browser tree, focus, evaluation, click, fill, and wait primitives with workspace, surface, timeout, and cancellation guards. The standalone Slack package owns DOM selectors, drafts, navigation, group resolution, message policy, receipt recognition, and scanning. This preserves a future Phase F execution-adapter seam without placing Slack policy in core. See [Communication authoring](communication-authoring.md) for the full contract and independent build flow.

## Terminal bridge boundary

`helmsman/terminal@1` is a host service for authored frontend presentation, not a backend provider contract. The Phase E implementation adapts the existing core terminal coordination to bounded, revision-checked list, screen, control, receipt, pending, and acknowledgment methods. Installed packages cannot register a native terminal implementation or access cmux/WezTerm directly.

The selected page preserves header scope; explicit panel `All` includes configured galleon terminals and unassociated surfaces. Controls retain the exact target revision and durable request identity. Receipt lookup is read-only and the service exposes no retry method. An unknown outcome requires inspection and explicit acknowledgment before later controls resume; the retained input is never resent. Phase F owns extracting replaceable cmux, WezTerm, and other execution implementations. See [Terminal authoring](terminal-authoring.md).

## Campaign coordination boundary

Campaign presentation uses `helmsman/campaigns@1`. Core commits each validated campaign mutation and its exact-request receipt atomically in the existing campaign database. Revision, preview-digest, task-attempt and configured-galleon checks preserve user intent. The existing dispatcher retains phase ordering, durable claims, stable run IDs and concurrency gates; a command receipt confirms recorded state, not worker execution. Phase F owns replacing scheduling and execution implementations. See [Campaign authoring](campaigns-authoring.md).

## Measured usage and estimates

`UsageQuery` identifies version 1, a galleon (or `null` for all), and an inclusive-start/exclusive-end UTC window of at most 366 days. `UsageSnapshot` exposes measured records, public run summaries, and reported totals. Unknown costs stay `null`; estimates never update recorded spend or budget caps. Core telemetry owns recording independently of Costs and pricing activation.

A pricing provider receives that snapshot and returns `PricingEstimate` or `null`. Estimates contain currency, rate source/version/as-of, an amount or unknown, and coverage counts. Optional per-record details identify `(runId, attempt, eventId)` and must cover every unpriced record, including unknown amounts. The host rejects duplicate/foreign identities, estimates for already reported costs, invalid amounts, and inconsistent sums/counts. UI presentation matches record identities to its displayed usage snapshot when records change between queries.

Pages obtain `context.services` (version 1): `usage.query`, `pricing.estimate`, `outcomes.summary`, and `outcomes.assessment`. Every call combines the page lifetime with the caller's optional abort signal. Public reports omit legacy fixed-policy estimates. A missing pricing service leaves measured usage and assessments usable. Header scope reaches pages via `update(state)`; changing a page must not change header scope.

HTTP equivalents are `GET /api/usage/v1`, `GET /api/pricing/v1` (query parameters `version=1`, `repo`, `from`, `to`), and the versioned report/assessment endpoints under `/api/reports/outcomes/v1`. Prefer injected services for lifecycle cancellation and response validation.

## Validation

`npm run test:distribution` compiles both Costs implementations and both pricing implementations outside the source tree, installs through the compiled CLI, and runs the real compiled server with source access denied. It verifies scope, deep links, explicit replacement, settings/storage across restart, unavailable selections, and unchanged measured usage. Unit tests cover activation rollback, disposal/timeouts, storage isolation/quotas, malformed results, legacy recording, and capability selection. Browser tests preserve the Costs draft, navigation, cancellation, and visual flows.

## Local Git presentation

The independently buildable `local-git` author package provides the selected `/local-git` page and replaceable panel through `helmsman/local-git@1`. Core retains checkout validation, active-worktree protection and durable command receipts. Lost responses require inspection; no retry operation is exposed. See [Local Git authoring](local-git-authoring.md) and the [implementation ledger](plugin-implementation-progress.md) for delivery evidence.

## Integration settings ownership

Jira and GitHub settings have independent authored page/panel packages with namespaced schemas, redacted reads and revision-checked global saves. Jira token input never enters browser persistence or response bodies; live Jira configuration stays in Source settings. Core retains configuration storage and credential binding. See [integration settings authoring](integration-settings-authoring.md) for the contracts and [delivery evidence](plugin-implementation-progress.md).
