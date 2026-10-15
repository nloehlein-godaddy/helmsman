# Terminal authoring

Helmsman exposes terminal presentation through the public `helmsman/terminal@1` service. The selected `helmsman/terminal-page` contribution owns `/terminal` and the compatibility `/cmux` alias. It composes panels implementing `helmsman/terminal-panel@1`. The shipped page and panel are an SDK-only author project: they import `@helmsman/plugin-sdk`, own their rendering and browser state, and do not import application internals or call private HTTP endpoints.

Terminal presentation and native implementations are separate packages. The host selects an SDK-only `helmsman/native-terminal@1` provider for native I/O; presentation still uses only the scoped terminal service. See [native terminal authoring](native-terminal-authoring.md).

## Scope and targets

The shipped Terminal page is global. Its panel explicitly selects `All` (`repo: null`) through the public scope service before reading tabs, without changing the header galleon. It includes configured galleon terminals and unassociated surfaces; ambiguous ownership is excluded. The header galleon selector is hidden on this page and returns with its existing selection when navigating elsewhere. Replacement panels may use the public scope service to request a narrower scope.

`TerminalTargetV1` contains the nullable repository, opaque `surfaceRef`, and observed `revision`. The revision binds the selected native provider, settings, selection revision, process/session and the observed surface, window, workspace, working directory, type, repository and inferred agent provider. Pass the complete target returned by `list` to `screen` and `control`. The host revalidates it immediately before reads and controls and rejects stale, ambiguous, or foreign scope rather than silently resolving the same surface against newer state. Titles are display data and never establish repository ownership. Optional `TerminalTabV1.lastPrompt` is bounded display data from the native provider; missing or null means unavailable. It is not part of target identity and must never establish ownership or change a control target.

`list({ version: 1, repo })` returns a bounded snapshot of visible tabs, selection state, labels, and declared server actions. `screen({ target, lines })` returns bounded plain text and reports truncation. The authored panel requests at most 40 lines and polls the visible list and selected screen every two seconds. Hidden, replaced, scope-changed, and disposed panels abort active polling. Keyboard capture starts only after the operator chooses **Control with keyboard** and ends with **Stop keyboard control** or Shift+Escape; ordinary screen polling never captures keys.

The service bounds lists to 512 tabs, terminal text to 64 KiB, screens to 512 KiB and 2,000 requested lines, image data to 2 MiB of base64 (about 1.5 MiB decoded), and serialized responses to 3 MiB. The authored panel uses the smaller 40-line screen window.

The native adapter pins the exact socket used for subprocesses. Target revisions include application startup and socket identity, so socket replacement invalidates prior targets. Configure `socketPath` on the selected cmux package for custom, tagged or debug sockets (`CMUX_SOCKET_PATH` seeds it once); default discovery checks `~/.local/state/cmux/cmux.sock`, `~/.config/cmux/cmux.sock` and `/tmp/cmux.sock`. The WezTerm package owns its socket resolver. `select-native-terminal` changes terminal I/O independently of `select-browser-host`, so WezTerm terminals can coexist with cmux-backed Slack. Native references are opaque bounded strings, including in routes and saved drafts.

## Controls and durable receipts

`control` accepts one bounded operation at a time:

- text with an explicit Enter choice;
- one supported key;
- one server-declared action from the target snapshot; or
- a pasted PNG, JPEG, GIF, or WebP image represented by the public image operation.

The panel serializes controls and bounds its keyboard queue to 32 entries so browser actions cannot race. Before transport, its contribution-scoped browser journal retains the exact request ID, target revision, and operation. The server commits the caller, UUID, input, and an uncertain receipt before native dispatch. Reusing an ID with different input is rejected, and the same ID is never replayed automatically. Transport failure, an exception, or a partially completed declared action remains `recovery-required`; a successful transport has no run-lifecycle effect.

After `succeeded` or `rejected`, the panel saves the terminal result locally before calling `acknowledge`. `pending` and `recovery-required` keep the original journal entry. `receipt` only inspects retained server evidence and never sends terminal input. The service deliberately has no retry API: when the outcome remains unknown, inspect the terminal and exact receipt first, then choose **Resume controls after inspection**. That action calls `inspect` with the retained request. If no server receipt exists, the server atomically records the original command without dispatching it, preventing a delayed original request from sending later. An active native dispatch remains pending. The panel records the inspected uncertain result and acknowledges the original journal entry so later, separately initiated controls can proceed; it never resends the retained input or confirms delivery. If the original journal entry is missing or unreadable, controls remain unavailable and no replacement request is created.

Disabling or replacing presentation prevents new browser admission but does not erase browser evidence or durable server receipts. Restore the original presentation contribution to inspect its retained terminal commands. Disabling a native provider blocks new I/O while recorded receipts remain queryable; uncertain input is never rerouted to another provider.

## Package shape

An authored package declares a page eligible for `helmsman/terminal-page` and one or more panels accepting `helmsman/terminal-panel@1`. The initial layout may contain one panel, but saved composition remains authoritative, including copied, missing, and intentionally empty layouts. A package renamed under a new contribution identity has a separate browser journal. Multiple instances of the same contribution share pending command identity; local drafts and saved results remain instance-specific.

Select an installed replacement with:

```sh
npm run plugins -- select helmsman/terminal-page example.terminal/page
```

Disabled or unavailable selected contributions remain unavailable; Helmsman does not restore a private terminal renderer. Use the standard page/panel lifecycle in [panel authoring](panel-authoring.md), and build/package it using [plugin packages](plugin-packages.md).

## Validation boundary

Package and host tests must use a mock terminal fixture. They may verify scope, stale targets, bounded polling and screen text, control serialization, durable receipts, lost responses, inspection acknowledgment, disablement, replacement, and reload without typing into, selecting, entering keyboard-control mode for, or otherwise mutating a native terminal. A source-denied distribution scenario must prove that the author package compiles against the copied SDK and does not depend on application source.
