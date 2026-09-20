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
