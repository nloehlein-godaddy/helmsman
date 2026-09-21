# Execution host authoring

Execution host packages are backend-only packages that register one or more `helmsman/execution-host@1` providers. Declare every contribution in `backend.provides` and `backend.executionHosts`, with `access: ["execution"]`. An execution-host package cannot mix other backend capabilities.

Import provider contracts from `@helmsman/plugin-sdk`. Node receipt and process-ownership helpers are available only from `@helmsman/plugin-sdk/node`; the browser SDK entry remains free of Node dependencies. Source packages must not import application modules or another plugin package.

`prepareRun` returns immutable, nonsecret JSON retained with the admitted run. Local providers return `null`. Providers must use the exact `runId`, `launchId`, `attempt`, wrapper path, receipt path, and command paths supplied in `ExecutionHostLaunchSpecV1`. The returned reference carries the same identity and opaque bounded JSON state containing the provider's native PID, socket, pane, workspace, or container evidence.

`discover` distinguishes three results. `found` requires verified ownership and returns matching running or exited evidence. `absent` requires authoritative native inventory showing that the owned target does not exist. Missing, conflicting, malformed, or unavailable evidence is `unknown`; it must not be treated as absence. `isAlive` and `stop` throw when ownership cannot be verified. Providers never select or fall back to another provider.

Providers with `stageExecution: "isolated"` also implement `prepareStage` and `stopStages`. The gateway token is ephemeral input and must not enter settings, retained configuration, snapshots, logs, or returned state. `cleanup(success)` and `stopStages(runId)` must remain scoped to the exact run.

The shipped [`host-local`](../src/plugins/host-local/README.md) package demonstrates detached, cmux, and WezTerm providers. The Docker package demonstrates immutable run configuration and isolated stage execution. Install the released SDK, TypeScript and `@types/node` as development dependencies. Build an authored package against that SDK, then package and install it with the workflow in [Plugin packages](plugin-packages.md).

During graceful shutdown, core releases only the execution leases held by that application instance. Startup retries unresolved attachment for a bounded recovery window so a crashed coordinator’s expiring lease does not permanently strand a live worker. A timed-out attachment retains its deduplication fence until the original ownership check settles; a retry never starts a second concurrent attachment. The host must still prove the original launch identity before stop or finalization.

A terminal receipt means the owned worker execution has settled, including ordinary descendants that could still mutate the workspace. Signalling only the immediate child is insufficient. The shipped local wrapper owns a separate POSIX supervisor group, waits for that group to contain no live members, and only then publishes exit evidence. Process identity remains bound to the original wrapper receipt. Local Windows admission is unavailable until equivalent owned-tree supervision exists; discovery and verified Stop for retained attempts remain available.

PR branch reruns refuse a branch that is already checked out, including a clean leftover Helmsman checkout. They never delete that checkout to make room. Clean up an old checkout explicitly after checking ownership, active execution and any uncommitted work; a matching retained PR head is not proof that Helmsman owns an existing checkout.
