# Run viewer and history authoring

E4 introduces separate authored viewer and history packages. Standalone and auxiliary viewer surfaces share one retained session; the legacy `/runs` surface and its PR workflows remain active pending their separate cutover. Public presentation locators and services are the package boundary; a copied package compiles against the distributed SDK using only type imports. Runtime imports stay inside the package.

| Package | Page slot and composition | Panel contract | Panel services |
| --- | --- | --- | --- |
| `helmsman.run-viewer` | `helmsman/run-viewer-page@1` | `helmsman/run-viewer-panel@1` | run-inspect, run-read, run-command, download |
| `helmsman.run-history` | `helmsman/run-history-page@1` | `helmsman/run-history-panel@1` | run-inspect |

The page entries use composition discovery, saved layout, mounting and activity. They preserve empty layouts and disabled/missing implementation identity. A replacement page may compose compatible panels differently; a replacement panel does not require replacing its page or the other package. The bundled `helmsman.*` IDs are reserved; third parties use their own IDs.

Before building a copied package, rename both `manifest.id` and its self-referencing initial-layout contribution IDs, for example `helmsman.run-viewer` to `example.run-viewer` and `helmsman.run-viewer/panel` to `example.run-viewer/panel`. Keep shared slot, composition and panel-contract identifiers unchanged. Follow the [descriptor rewrite, pack and install recipe](plugin-packages.md#opt-in-task-presentation-packages), then select or open the independently installed page. A descriptor retaining a reserved package ID is rejected by installation.

`PluginPageState.presentation` also reaches panels. The optional `context.selectPresentation(locatorOrNull)` callback returns synchronously and can reject invalid, inactive or out-of-scope selections. Its locator is a canonical `{ version: 1, kind: 'run', repo, runId }`, compatibility `{ version: 1, kind: 'legacy-run', runId }`, or `{ version: 1, kind: 'pull-request', repo, number }`. The host captures effective scope; packages cannot widen a concrete repository scope by emitting another repository. An explicit panel scope may select within that scope without changing the header. A legacy run ID must resolve within the current scope before becoming canonical.

The generic auxiliary host owns attachment and page lifetime. `/run-viewer` follows the selected viewer slot; a canonical `/plugins/<plugin>/<page>` viewer route opens that exact contribution independently of the slot selection. Navigation between the same viewer contribution's standalone and auxiliary surfaces moves its existing DOM and preserves route pane/panel state, tabs, focus, scroll, paused log windows and command receipts. A synchronous move between visible destinations preserves active reads; hiding, detachment, scope changes and disposal revoke activity. Replacing or disabling a contribution disposes its session and never falls back to another implementation. The host mounts lazily when first attached, so a direct canonical route does not initialize the selected viewer first.

The viewer package owns tabs, selection, focus, scroll, bounded log windows, attempt revalidation and command receipts. PR details, review actions and Slack coupling now live in a private compatibility session shared by legacy surfaces and the canonical `helmsman.compat-pr/page` composition. The registered panel is an explicit private bridge, not an SDK-only replacement; its in-memory drafts and pending request identities do not gain restart durability. Disabling the contribution governs the canonical surface while legacy routes remain active. Public detail/diff reads are separately exposed by [PR inspection](pull-request-inspect-authoring.md); public review/Slack actions and legacy `/runs` cutover remain pending. Authored packages do not import private PR clients or renderers.

```mermaid
flowchart TD
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

Package state/lifecycle and composition tests cover these behaviors. Both packages compile against a copied distributed SDK under the source-denial loader, pack and install as independent replacements. The package browser gate recompiles those copied sources and verifies canonical selection, paused-window preservation, desktop/mobile rendering and absence of horizontal overflow. The full-shell source-denied production scenario verifies exact viewer/log DOM identity, retained tabs and focused paused logs across history, standalone alias, canonical viewer and Helm navigation, followed by one polling loop. An unresolved retry keeps its original request and attempt without resubmission. A separately installed canonical viewer opens independently of the selected alias. Canonical `runRepo` survives reload independently of header scope, explicit selection reveals/focuses the viewer, hidden/resumed logs remain correct, passive shell polling preserves history pagination and paused standalone logs, disabled selected pages remain unavailable, and logs stay reachable on mobile. Replacing legacy `/runs` and retiring the private PR compatibility boundary remain pending. Track completion in the [E4 implementation plan](plugin-phase-e4-implementation.md) and [implementation ledger](plugin-implementation-progress.md).

_Helmsman · not reported - not reported_
