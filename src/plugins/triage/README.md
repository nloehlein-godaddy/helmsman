# Triage plugin

Independently buildable page and replaceable panel using only `@helmsman/plugin-sdk`. Build with `npm run build` after installing the SDK. Rename the reserved `helmsman.triage` package ID and its self-referencing initial-layout contribution ID before packing the resulting `dist` directory through the plugin CLI. Use the [descriptor rewrite and CLI example](../../../docs/plugin-packages.md#opt-in-task-presentation-packages), choosing `example.triage`. Enable `example.triage` and open `/plugins/example.triage/page`.

This package supplies the built-in `/triage` alias and canonical `/plugins/helmsman.triage/page` route through operator-controlled page selection. Disabling the selected package shows it as unavailable; it does not restore legacy presentation. Alias cutover acceptance is tracked in the [implementation ledger](../../../docs/plugin-implementation-progress.md). The composition identity is `helmsman/triage-page`; replaceable panels implement `helmsman/triage-panel@1`. Saved layouts survive replacement, including intentionally empty layouts; defaults only initialize an absent layout.

Panels inherit the header repository; explicit panel overrides remain scoped by the host. Hidden or suspended panels cancel reads. Source disablement preserves saved selections and reports unavailability.

Three independent groups retain priority, updated-date, page-size, source and collapse settings per panel. Filtering precedes provider pagination; each group retains up to 20 pages under one observation window. Partial and unavailable groups stay explicit. Unknown saved-state versions require an explicit source choice before replacement.

Launches require a concrete repository and ready task. Original durable requests remain available after source changes or response loss. Related-run links use host-provided canonical task references; display keys never establish run identity.

Descriptions load only after a task-specific disclosure is opened. They render as bounded plain text with preserved newlines, retain disclosure state per galleon/source/task, and report source or revision changes without reusing stale content.

See [installation](../../../docs/plugin-packages.md), [task views](../../../docs/task-source-authoring.md#independent-triage-and-bugs-views), and the [isolated production gate](../../../tests/distribution/task-views-host.pw.ts). The gate covers copied-SDK builds with source access denied, canonical route reload, scope, unavailable providers, restart and visual snapshots.

Legacy browser priority, date, page-size and collapsed-group preferences initialize an absent layout through the host migration port; raw preferences and existing layouts stay intact. An explicit group expansion overrides migrated group defaults for that source. Legacy `pane=backlog`, `pane=todo` and `pane=mine` links reveal and focus their group once per route change; refresh does not undo a subsequent user collapse.

Delivery retry requires the host's optional `retry({ repo, requestId }, signal)` operation. It reads only the original caller-owned retained request and never reserves another identity. Missing requests remain unavailable; older hosts disable retry while keeping receipt checks available. New intentional submissions use `submit` separately.

Assign to me appears only in unassigned groups when the selected source declares `assign-self`. The panel declares `helmsman/task-action@1` and feature-detects the optional host service. Sources and hosts without the capability retain task reads and launches. Assignment uses the authenticated source account and never takes over another person's task.

Saved assignment requests are restored before controls become available. Duplicate task actions across groups, pages and reloads retain one request ID; source or task revision changes cannot replace a pending intent. Unknown outcomes keep receipt checks and explicit delivery retry; uncertain mutations require Recovery and cannot be blindly retried or dismissed. Terminal results stay visible until dismissal, which refreshes task rows before another assignment can be submitted. An explicit retry of a request missing from the server redelivers the same retained request ID and input. Scope changes cancel active reads and ignore late UI responses.
