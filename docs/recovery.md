# Execution and plugin recovery

Open **Recovery** in the footer or `/recovery`. The header galleon is the default scope. A scope selected inside Recovery applies only to that page.

A voyage's execution result and attachment health are separate. A blocked attachment does not prove that its worker stopped. Its reservation, files, and retained providers remain protected until reliable evidence settles ownership. Retry attachment after restoring the exact runtime, host, connection, and compatible schema. Stop requests persist per attempt before the host is signaled; a restart cannot authorize publication by forgetting an earlier stop request.

Pending external effects remain visible after process completion. Reconcile checks the recorded provider, target, identity, and remote receipt. An uncertain Slack browser send or GitHub review never triggers a blind resend. Explicit resolutions require actor, reason, and evidence. Treat a definitely-not-applied resolution as a factual assertion about the remote result, not a way to dismiss an inconvenient error.

Source claims are independent of worker outcomes. A successful voyage can retain a
`settling` source claim when a local update or remote completion fails. The Source
claims table shows its logical source, exact provider, galleon, recorded worker
outcome and settlement reason. Its dependency pins appear in the same scoped view.
**Retry source settlement** invokes recovery against retained requests and verified
execution evidence; it does not accept a replacement outcome, rebind a provider,
or relaunch work. A missing provider or unresolved ownership can still block retry.
Safe start exposes these claims without activating providers or offering actions.

Legacy running voyages and retained pre-PR checkpoints without historical runtime and ownership evidence are blocked. Helmsman does not assign today's provider identity to old work. Their original history, measured usage, workflow references, and workspaces remain intact. The legacy safety audit is not an executable adoption or checkpoint-migration tool.

Plugin disable removes presentation and denies new work. Retained execution, checkpoint, dependency, and operation pins can keep a provider draining and prevent upgrade, uninstall, or collection. A checkpoint migration requires a registered validator for the retained provider and records append-only provenance. Without that validator, restore the retained provider or explicitly retire a verified checkpoint through Recovery.

## Task command and settings recovery

Opt-in E3 task panels retain original browser intent UUIDs before dispatch. A response timeout, navigation, source disablement or replacement does not mean a create, edit, delete or launch was rejected. Reconcile the saved request and retry delivery with its original input; never create a second request merely to recover a response. Consume a verified terminal result and persist the affected draft before acknowledging it. Recovery links preserve the originating repository even when the header or panel scope changes.

Core Recovery exposes source-command evidence alongside retained run commands and effects. It can preserve uncertainty when preparation or original authority is unavailable; it does not invent a successful result or silently rebind a request to the current provider. Source administration similarly pins revisions and command identity. Source configuration and schedules persist, while automatic-start enabled state belongs to the current server process. An old successful toggle receipt is historical evidence, not proof of current enabled state. Reconcile source-admin intents within the source-settings UI through same-ID pending/receipt lookup; prior-process unresolved runtime intent expires. Core Recovery does not resolve that browser journal.

For an older Todo mutation, the host checks the original legacy session journal's method, path, payload and UUID through the legacy recovery port. Select All galleons to inspect a nonempty legacy journal. A definite terminal receipt may be acknowledged; missing authority, an unrecorded request or inner-only mutation evidence stays unresolved. The new editor does not replay that request as a new source command, and Core Recovery does not resolve the legacy browser journal. See [task-source authoring](task-source-authoring.md) and the [Todos package](../src/plugins/todos-ui/README.md).

## Clarification channels and unresolved questions

Each new execution attempt retains its clarification channel ID and question/answer paths in the immutable execution snapshot. Admission commits that binding with the prepared attempt. Automatic retry and pre-PR continuation receive new channels; recovery verifies and reuses the retained channel. Keep these files with the runs directory and matching database. Missing or changed channel evidence blocks recovery rather than creating replacement provenance.

Existing shared-file questions have unknown attempt provenance. They remain visible, and new answers are rejected even through the compatibility HTTP route. Complete unread legacy records are ingested as unknown; neither the current attempt number nor a timestamp assigns them to a new worker. Required unanswered questions from prior or unknown attempts continue to block publication. This foundation adds no operator action that resolves, discards or reassigns those obligations. Preserve the original run for investigation; a new run has its own question history.

After verified worker exit, the host drains complete clarification records before terminal processing or retry. A non-whitespace suffix without a newline in either the bound or legacy shared question file blocks processing and retains the current attempt/channel, even if that suffix is valid JSON. Active polling tolerates partial writes; terminal effect authorization does not. Preserve the original files when investigating an incomplete-record error. Exact already-ingested records can replay after success without changing their answers or revisions; this does not permit new terminal questions or restore answer eligibility.

Only an attempt's own terminal question records are published to its answer file. Durable answer acceptance and worker consumption are separate facts. The current compatibility answer endpoint has no durable request receipt; the forthcoming public answer-command service supplies that recovery protocol. Disabling a presentation plugin does not suspend ingestion, timeout handling, answer delivery or publication gates.

## Startup and endpoint ownership

Normal startup claims exclusive application ownership before reconciliation or plugin activation. A second application cannot mutate the same main database. Catalog operations may run alongside an initialized application, but startup and maintenance barriers prevent conflicting initialization and migration.

Local coordinator publication uses a loopback port selected on first startup and retained in `RUNS_DIR/.gateway-port.json`. Keep that file with the runs directory so surviving coordinators can reach the same endpoint after restart. A conflicting configured port fails startup. Docker uses its configured gateway listener. Coordinator publication credentials are separate from model-service capabilities and are excluded from execution snapshots.

## Offline backup

Stop all application and plugin-data writers, then run:

```sh
npm run plugins -- --dir /path/to/plugins --db /path/to/state.sqlite backup /path/to/new-backup
```

The CLI refuses live writers and existing destinations. It locks the main, catalog, and plugin-data databases together, captures committed WAL contents with SQLite's backup API, and writes a manifest with hashes and runtime metadata. Backup files have owner-only permissions. Retain the matching plugin artifacts, runtime artifacts, runs/worktrees, and required configuration separately; the database backup does not bundle those files.

Compatible package rollback retains migrated data. An incompatible schema downgrade is rejected. Restoring a whole backup is application-wide recovery with writes stopped; it is never an automatic response to one plugin failing.

## Safe start

Start with `--safe-start` when normal startup cannot load required state. Safe start exposes read-only diagnostics using private copies of SQLite/WAL files. It does not migrate data, activate plugins, start workers, poll providers, reconcile effects, or clean up workspaces. Return to normal mode only after restoring the missing prerequisites.
