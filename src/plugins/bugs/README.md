# Bugs plugin

Independently buildable page and replaceable panel using only `@helmsman/plugin-sdk`. Build with `npm run build` after installing the SDK. Rename the reserved `helmsman.bugs` package ID and its self-referencing initial-layout contribution ID before packing the resulting `dist` directory through the plugin CLI. Use the [descriptor rewrite and CLI example](../../../docs/plugin-packages.md#opt-in-task-presentation-packages), choosing `example.bugs`. Enable `example.bugs` and open `/plugins/example.bugs/page`.

This is an opt-in E3 author package, not a registered built-in default. The legacy `/bugs` route remains active. The composition identity is `helmsman/bugs-page`; replaceable panels implement `helmsman/bugs-panel@1`. Saved layouts survive replacement, including intentionally empty layouts; defaults only initialize an absent layout.

Panels inherit the header repository; explicit panel overrides remain scoped by the host. Hidden or suspended panels cancel reads. Source disablement preserves saved selections and reports unavailability.

Unknown metrics remain unavailable, exact zero remains zero, and approximate counts display an approximation marker. Rows show actual due dates and provider severity. Resolution P75 separates sample size from population and labels partial/capped coverage. Observation time describes current source status and recent windows, not historical reconstruction.

See [installation](../../../docs/plugin-packages.md), [task views](../../../docs/task-source-authoring.md#independent-triage-and-bugs-views), and the [isolated production gate](../../../tests/distribution/task-views-host.pw.ts). The gate covers copied-SDK builds with source access denied, canonical route reload, scope, unavailable providers, restart and visual snapshots.
