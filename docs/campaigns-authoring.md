# Campaign authoring

The SDK-only `helmsman.campaigns` package owns the selected `/campaigns` composition. Its page uses `helmsman/composition@1`; its integrated campaign panel requires `helmsman/campaigns@1`. The composition slot is `helmsman/campaigns-page`, the panel contract is `helmsman/campaigns-panel@1`, and the default panel instance is `campaigns`.

## Scope and reads

`context.services.campaigns.list({ version: 1, repo })` returns configured campaigns and available workflows. `repo: null` requests All through the panel's effective scope. `detail({ version: 1, repo, campaignId })` returns the campaign, phases, tasks and an opaque revision. Concrete header scope is inherited unless the panel explicitly overrides it. A panel override never changes the header.

A campaign belongs to one galleon; imported records may explicitly target other configured galleons. The import preview must show these overrides before confirmation. Opening a task's run uses that task's galleon and exact run ID through the public Runs route and shared viewer, preserving the header scope.

The current contract bounds lists to 500 campaigns and details to 100 phases and 500 total tasks. Imports contain at most 200 records and 1,000,000 UTF-8 bytes; serialized responses are bounded to 3 MiB. Unsupported snapshots remain unavailable without truncating stored data, and mutations that exceed supported bounds roll back.

## Commands and recovery

`submit` accepts version 1 and the campaign's galleon, plus one action:

| Action | Required intent |
|---|---|
| `create` | Name, saved workflow reference and concurrency |
| `add-phase` | Observed campaign target and phase name |
| `preview` | Observed campaign target, phase, CSV/JSONL format and content |
| `confirm` | Observed campaign target, exact preview ID and digest |
| `phase` | Observed campaign target, phase and start/pause/resume/finish/stop operation |
| `retry-task` | Observed campaign target, task ID and expected attempt |

The target contains `campaignId` and the revision returned by `detail`. Changed state rejects stale mutations instead of silently applying an old decision. Previewing does not import tasks; confirming imports queued tasks; starting or resuming a phase enables dispatch. Finish and stop retain their existing confirmation and coordination semantics. A successful command receipt confirms the recorded campaign state change, not that a worker has launched or stopped.

The browser journal retains a caller-owned UUID and complete input before transport. One unresolved command per galleon prevents replacement intent from overwriting pending evidence. Core commits the campaign mutation and validated receipt in one SQLite transaction. An identical request returns its original receipt across response loss and restart; changed input under the same UUID conflicts. A failed transaction cannot leave a mutation without its receipt.

Use `receipt` to inspect the original result and explicit `retry(query)` to redeliver the exact retained command. Retry never reserves a new identity. Save the result before `acknowledge`. Preserve drafts and pending requests when the service, storage, scope or selected plugin becomes unavailable. Restoring the original contribution restores access to its journal. Reads and recovery must not automatically create campaigns, import tasks, change phase state or retry failed work.

## Package and execution boundary

Copy `plugin-sources/campaigns`, rename its manifest and initial-layout contribution IDs, and build against the distributed `@helmsman/plugin-sdk`. Keep the public slot, composition and panel contract IDs. Select the installed replacement with:

```sh
npm run plugins -- select helmsman/campaigns-page example.campaigns/page
```

Saved empty layouts and missing or disabled selected contributions remain authoritative. See [plugin packages](plugin-packages.md) and [panel authoring](panel-authoring.md) for installation and lifecycle conventions.

The existing campaign store and dispatcher remain behind this public service. Durable task claims, stable run IDs, per-galleon writer exclusion, workflow availability, phase ordering and concurrency gates remain in force. Scheduling, execution hosts and workflows are accepted. The selected trigger supplies campaign candidate ordering through `helmsman/trigger@1`. Trigger extraction is reviewed and pushed through `12a62c9`.

Workflow choices come from available coding contributions, not a hardcoded Coding entry. Versioned contribution references use `<plugin-id>/<local-id>@1`; the old `coding@1` reference remains a compatibility alias for new admission. A selected unavailable workflow blocks launch. Each admitted voyage retains its original workflow rather than following a later campaign/default change. See [workflow authoring](workflow-authoring.md).

Acceptance uses an isolated distribution and mocked execution. Campaign UI checks may create, preview, import and finish draft phases without launching real workers. Current completion and review evidence is recorded in the [implementation ledger](plugin-implementation-progress.md).


The selected `campaign` trigger receives only bounded eligible candidate handles and chooses one or defers. It cannot rewrite a task, workflow, attempt or launch identity. Core rechecks the selected candidate and captures policy/settings/source provenance plus dependency pins atomically with its durable claim. Importing a task does not capture a policy decision. Previously unclaimed intents can receive their first capture on claim; already claimed legacy rows remain explicitly legacy and reconcile their original run IDs. Disablement blocks new decisions and admissions while existing-run reconciliation continues. See [trigger authoring](trigger-authoring.md).
