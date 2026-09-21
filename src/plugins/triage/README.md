# Triage plugin

Independently buildable page and replaceable panel using only `@helmsman/plugin-sdk`. Build with `npm run build` after installing the SDK. Rename the reserved `helmsman.triage` package ID and its self-referencing initial-layout contribution ID before packing the resulting `dist` directory through the plugin CLI. Use the [descriptor rewrite and CLI example](../../../docs/plugin-packages.md#opt-in-task-presentation-packages), choosing `example.triage`. Enable `example.triage` and open `/plugins/example.triage/page`.

This is an opt-in E3 author package, not a registered built-in default. The legacy `/triage` route remains active. The composition identity is `helmsman/triage-page`; replaceable panels implement `helmsman/triage-panel@1`. Saved layouts survive replacement, including intentionally empty layouts; defaults only initialize an absent layout.

Panels inherit the header repository; explicit panel overrides remain scoped by the host. Hidden or suspended panels cancel reads. Source disablement preserves saved selections and reports unavailability.

Three independent groups retain priority, updated-date, page-size, source and collapse settings per panel. Filtering precedes provider pagination; each group retains up to 20 pages under one observation window. Partial and unavailable groups stay explicit. Unknown saved-state versions require an explicit source choice before replacement.

Launches require a concrete repository and ready task. Original durable requests remain available after source changes or response loss. Related-run links use host-provided canonical task references; display keys never establish run identity.

See [installation](../../../docs/plugin-packages.md), [task views](../../../docs/task-source-authoring.md#independent-triage-and-bugs-views), and the [isolated production gate](../../../tests/distribution/task-views-host.pw.ts). The gate covers copied-SDK builds with source access denied, canonical route reload, scope, unavailable providers, restart and visual snapshots.
