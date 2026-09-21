# Scheduling policy plugins

`helmsman/scheduling@1` chooses eligible work for automatic starts. The shipped `helmsman.scheduling/round-robin` rotates sorted source instances, then follows each source's ready-work order. An alternative can reorder sources, inspect paginated candidates and choose a different priority policy. Core retains process enablement, galleon scope, eligibility, claims, admission, budgets and concurrency.

## Public contract

Declare the backend capability and matching `scheduling` access declaration:

```json
{
  "entry": "backend.js",
  "provides": [{ "id": "helmsman/scheduling", "version": 1, "localId": "policy" }],
  "scheduling": { "policy": { "access": ["task-discovery"] } },
  "settings": { "intervalMs": { "type": "number", "default": 60000, "minimum": 250, "maximum": 3600000 } },
  "storageVersion": 1
}
```

Activate through `context.registerScheduling('policy', provider)`. A `SchedulingProviderV1` supplies a bounded integer `intervalMs` and `select(input, discovery)`. The input carries the galleon, selected available sources and last selected instance. `discovery.list({ instanceId, cursor, limit })` returns candidate IDs, canonical refs, revisions, display keys, titles and priorities. Limits are 1–100 items. Task fields preserve the task-source contract, including opaque revisions up to 512 characters and permitted whitespace. Cursors are opaque, scoped to this decision and source, and consumed once. Return `{ candidateId }` from a page you actually received, or `null` when no work should start. Never persist candidate IDs or cursors. Respect `discovery.signal` and do not start workers or publish effects from policy code.

Core bounds discovery to 30 seconds, 100 pages per source, 512 pages overall and 10,000 candidates. Exceeding a discovery bound invalidates the whole decision. Source read failures may yield an empty page; policies must tolerate unavailable sources. The host filters claimed, quarantined and non-ready work and rechecks source/policy selection and revisions after asynchronous reads. A settings change invalidates the activated policy until restart. Disabled, missing or incompatible explicit selections remain unavailable; they never silently select another policy.

## Install and select

Copy `release/plugin-sources/scheduling` outside the application, change its reserved manifest ID to `example.scheduling`, install the distributed SDK and build:

```sh
npm install --save-dev /absolute/path/to/release/sdk typescript
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack dist scheduling.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js install scheduling.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js configure example.scheduling '{"intervalMs":15000}'
node /absolute/path/to/release/server/helmsman/plugins/cli.js enable example.scheduling
node /absolute/path/to/release/server/helmsman/plugins/cli.js select-scheduling example.scheduling/round-robin
```

Use the same plugin directory as the server; restart after installation or settings changes. `select-scheduling default` explicitly restores the shipped policy. Configure sources and process-local enablement separately through Source settings. Automatic starts reset to disabled on every restart; policy selection, namespaced settings and source rotation survive restart.

The previous effective `AUTO_CLAIM_INTERVAL_MS` seeds the shipped package's `intervalMs` once, preserving any explicit plugin override. Valid integer legacy values are clamped to 250–3,600,000ms; invalid values use 60,000ms. Later environment edits and `reset-settings` cannot rerun migration. The old generic Config field is retired; configure the selected package instead. A missing policy leaves the core timer idle at a 60-second retry cadence.

## Admission and recovery

A policy returns a proposal, not a reservation. Core issues a short-lived, single-use decision and rechecks its exact task/source, selected provider, settings and source cursor revisions inside the admission transaction. Disabling and reenabling automatic starts during discovery invalidates that discovery. Concurrent discoveries cannot consume the same source rotation revision.

Admission records provider ID, artifact hash, settings hash, policy/source revisions and canonical task identity as provenance. Scheduling finishes at admission; the policy is not a continuing worker or publication obligation. Disabling it later stops new automatic decisions without changing an already admitted run's source, agent, host or workflow bindings. Restart never reuses an in-memory scheduling proposal. Existing Phase C recovery gates remain authoritative for workers and durable effects.
