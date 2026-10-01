# Run viewer and history authoring

The shell keeps a collapsible log drawer below the page's scrolling content, including Config. The selected viewer's saved tabs remain reachable without a run URL. Selecting or following a run opens the drawer, including when reselecting the same run; periodic refresh respects a manual collapse. Collapsing the drawer or hiding the browser tab suspends viewer activity while retaining the session. The standalone viewer uses that same session without a second drawer.

History shows the reviewed PR number and galleon, plus the optional retained `RunReadSummaryV1.title`. It links through the selected PR page using `prRepo` without changing header scope. Older rows without a retained title still identify the PR; listing history does not fetch remote titles. New reviews retain the title already observed during preparation.

E4 introduces separate authored viewer and history packages. Standalone and auxiliary viewer surfaces share one retained session. `/runs` selects an independently buildable composition of history and the public PR panel; its selected run opens in that same auxiliary viewer. Public presentation locators and services are the package boundary; a copied package compiles against the distributed SDK using only type imports. Runtime imports stay inside the package.

| Package | Page slot and composition | Panel contract | Panel services |
| --- | --- | --- | --- |
| `helmsman.runs` | `helmsman/runs-page@1` | accepts run-history-panel and pull-request-panel | composition only |
| `helmsman.run-viewer` | `helmsman/run-viewer-page@1` | `helmsman/run-viewer-panel@1` | run-inspect, run-read, run-command, download |
| `helmsman.run-history` | `helmsman/run-history-page@1` | `helmsman/run-history-panel@1` | run-inspect |

The page entries use composition discovery, saved layout, mounting and activity. They preserve empty layouts and disabled/missing implementation identity. A replacement page may compose compatible panels differently; a replacement panel does not require replacing its page or the other package. The bundled `helmsman.*` IDs are reserved; third parties use their own IDs.

Before building a copied package, rename both `manifest.id` and its self-referencing initial-layout contribution IDs, for example `helmsman.run-viewer` to `example.run-viewer` and `helmsman.run-viewer/panel` to `example.run-viewer/panel`. Keep shared slot, composition and panel-contract identifiers unchanged. Follow the [descriptor rewrite, pack and install recipe](plugin-packages.md#opt-in-task-presentation-packages), then select or open the independently installed page. A descriptor retaining a reserved package ID is rejected by installation.

`PluginPageState.presentation` also reaches panels. The optional `context.selectPresentation(locatorOrNull)` callback returns synchronously and can reject invalid, inactive or out-of-scope selections. Its locator is a canonical `{ version: 1, kind: 'run', repo, runId }`, compatibility `{ version: 1, kind: 'legacy-run', runId }`, or `{ version: 1, kind: 'pull-request', repo, number }`. The host captures effective scope; packages cannot widen a concrete repository scope by emitting another repository. An explicit panel scope may select within that scope without changing the header. A legacy run ID must resolve within the current scope before becoming canonical.

The generic auxiliary host owns attachment and page lifetime. `/run-viewer` follows the selected viewer slot; a canonical `/plugins/<plugin>/<page>` viewer route opens that exact contribution independently of the slot selection. Navigation between the same viewer contribution's standalone and auxiliary surfaces moves its existing DOM and preserves route pane/panel state, tabs, focus, scroll, paused log windows and command receipts. A synchronous move between visible destinations preserves active reads; hiding, detachment, scope changes and disposal revoke activity. Replacing or disabling a contribution disposes its session and never falls back to another implementation. The host mounts lazily when first attached, so a direct canonical route does not initialize the selected viewer first.

The [public PR package](pull-request-authoring.md) supplies PR details, comparisons, manual reviews and review/rerun launch controls to both Runs and the selected PR page. The shared viewer owns selected runs. Optional Slack controls open the selected [Communication page](communication-authoring.md), preserving header and explicit PR scopes.


```mermaid
flowchart TD
    Runs[Runs alias: selected composition] --> History
    Runs --> PR[Public PR panel]
    Runs --> Host
    History[History panel: 50 runs per page] --> Count[Observation-time total or explicit unknown]
    History --> Selection[Canonical repo/run selection callback]
    External[Run or legacy run locator] --> Host[Retained page host: effective scope and lifetime]
    Selection --> Host
    Alias[Standalone alias: selected slot] --> Host
    Canonical[Canonical viewer route: exact contribution] --> Host
    Host --> Surface[Move existing DOM between standalone and auxiliary surfaces]
    Host --> Viewer[Authored viewer panel: at most 12 tabs]
    Viewer --> Resolve[Resolve canonical run and current attempt]
    Resolve --> Logs[Run-wide preview: 50 events per request<br/>300 retained; 4,000 characters per event]
    Logs --> Older[Pause follow; independent older cursor]
    Logs --> Follow[Drain follow cursor; retain backpressure]
    Resolve --> Commands[Stop or retry exact attempt<br/>Host retains immutable request identity]
    Commands --> Receipt[Read original receipt or retry retained request ID]
    Receipt -->|Original journal entry missing| Unavailable[Unavailable; no replacement identity]
    Receipt --> Save[Save terminal result in panel state]
    Save -->|Saved successfully| Ack[Acknowledge original journal request]
    Viewer --> Download[Click invokes download sink]
    Download --> Ready[Destination ready]
    Ready --> Export[Open bounded full-log export and capture watermark]
    Inactive[Hidden, disposed or changed scope] --> Cancel[Cancel reads and source/sink streams]
```

History retains a cursor stack rather than every page of runs. Counts share the insertion bound and filters but describe mutable state at observation time. Viewer log pagination keeps backward and follow cursors separate. Browsing earlier logs pauses following; releasing an end of the 300-event window is disclosed, and returning to that end rebases to a bounded latest window. Preview clipping never changes full export text.

Closing a viewer tab never clears its journal entries. Unknown receipts and recovery-required results remain visible independently of tabs. Reading a receipt is distinct from redelivery. Redelivery calls optional `runCommands.retry({repo,requestId}, signal?)`. The host reads the exact retained command and never reserves a new request. Missing or acknowledged requests cannot create work; a concurrent acknowledgment after lookup still delivers only original IDs. Older hosts without retry retain receipt checks and disable redelivery. This is separate from an intentional new Retry run action against a failed attempt. Terminal results persist before acknowledgment; a failed save prevents acknowledgment. Saved result removal is an explicit local action, not reversal of a command.

Copy uses only the bounded preview. Full download follows [download authoring](download-authoring.md): open the export after destination readiness, retain scope/attempt fences, and distinguish disk-save confirmation from delivery to the browser. Cancellation cannot promise that every browser dismisses its native download UI.

Package state/lifecycle and composition tests cover these behaviors. Both packages compile against a copied distributed SDK under the source-denial loader, pack and install as independent replacements. The package browser gate recompiles those copied sources and verifies canonical selection, paused-window preservation, desktop/mobile rendering and absence of horizontal overflow. The full-shell source-denied production scenario verifies exact viewer/log DOM identity, retained tabs and focused paused logs across history, standalone alias, canonical viewer and Helm navigation, followed by one polling loop. An unresolved retry keeps its original request and attempt without resubmission. A separately installed canonical viewer opens independently of the selected alias. Canonical `runRepo` survives reload independently of header scope, explicit selection reveals/focuses the viewer, hidden/resumed logs remain correct, passive shell polling preserves history pagination and paused standalone logs, disabled selected pages remain unavailable, and logs stay reachable on mobile. The Runs composition preserves legacy `pane=recent`, `pane=newrun`, review/relaunch mode, PR target and run locators. Explicit `prRepo` and `runRepo` do not change the header. Saved empty layouts and missing contributions remain intact. The package does not mount another viewer; the PR panel uses public inspection and durable review commands. Track completion in the [E4 implementation plan](plugin-phase-e4-implementation.md) and [implementation ledger](plugin-implementation-progress.md).

_Helmsman · not reported - not reported_
