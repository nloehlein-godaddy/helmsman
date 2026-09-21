# Terminal authoring

Helmsman exposes terminal presentation through the public `helmsman/terminal@1` service. The selected `helmsman/terminal-page` contribution owns `/terminal` and the compatibility `/cmux` alias. It composes panels implementing `helmsman/terminal-panel@1`. The shipped page and panel are an SDK-only author project: they import `@helmsman/plugin-sdk`, own their rendering and browser state, and do not import application internals or call private HTTP endpoints.

This Phase E boundary replaces shell-owned terminal presentation while retaining the existing core terminal bridge. Extracting cmux, WezTerm, or another native execution implementation is Phase F work. A presentation package cannot access the native terminal directly.

## Scope and targets

The page inherits the header galleon. An explicit panel `All` selection requests `repo: null` without changing header scope and includes both configured galleon terminals and unassociated surfaces. Ambiguous ownership is excluded.

`TerminalTargetV1` contains the nullable repository, opaque `surfaceRef`, and observed `revision`. The revision binds the bridge process/session and the observed surface, window, workspace, working directory, type, repository and inferred agent provider. Pass the complete target returned by `list` to `screen` and `control`. The host revalidates it immediately before reads and controls and rejects stale, ambiguous, or foreign scope rather than silently resolving the same surface against newer state. Titles are display data and never establish repository ownership.

`list({ version: 1, repo })` returns a bounded snapshot of visible tabs, selection state, labels, and declared server actions. `screen({ target, lines })` returns bounded plain text and reports truncation. The authored panel requests at most 40 lines and polls the visible list and selected screen every two seconds. Hidden, replaced, scope-changed, and disposed panels abort active polling. Keyboard capture starts only after the operator chooses **Control with keyboard** and ends with **Stop keyboard control** or Shift+Escape; ordinary screen polling never captures keys.

The service bounds lists to 512 tabs, terminal text to 64 KiB, screens to 512 KiB and 2,000 requested lines, image data to 2 MiB of base64 (about 1.5 MiB decoded), and serialized responses to 3 MiB. The authored panel uses the smaller 40-line screen window.

The native adapter pins the exact socket used for subprocesses. Target revisions include application startup and socket identity, so socket replacement invalidates prior targets. Set `CMUX_SOCKET_PATH` for custom, tagged or debug cmux sockets; default discovery checks `~/.local/state/cmux/cmux.sock`, `~/.config/cmux/cmux.sock` and `/tmp/cmux.sock`. WezTerm uses its existing socket resolver.

## Controls and durable receipts

`control` accepts one bounded operation at a time:

- text with an explicit Enter choice;
- one supported key;
- one server-declared action from the target snapshot; or
- a pasted PNG, JPEG, GIF, or WebP image represented by the public image operation.

The panel serializes controls and bounds its keyboard queue to 32 entries so browser actions cannot race. Before transport, its contribution-scoped browser journal retains the exact request ID, target revision, and operation. The server commits the caller, UUID, input, and an uncertain receipt before native dispatch. Reusing an ID with different input is rejected, and the same ID is never replayed automatically. Transport failure, an exception, or a partially completed declared action remains `recovery-required`; a successful transport has no run-lifecycle effect.

After `succeeded` or `rejected`, the panel saves the terminal result locally before calling `acknowledge`. `pending` and `recovery-required` keep the original journal entry. `receipt` only inspects retained server evidence and never sends terminal input. The service deliberately has no retry API: when the outcome remains unknown, inspect the terminal and exact receipt first, then choose **Resume controls after inspection**. That action records the inspected uncertain result and acknowledges the original journal entry so later, separately initiated controls can proceed; it never resends the retained input or confirms delivery. If the original journal entry is missing or unreadable, controls remain unavailable and no replacement request is created.

Disabling or replacing presentation prevents new browser admission but does not erase browser evidence or durable server receipts. Restore the original contribution to inspect its retained terminal commands.

## Package shape

An authored package declares a page eligible for `helmsman/terminal-page` and one or more panels accepting `helmsman/terminal-panel@1`. The initial layout may contain one panel, but saved composition remains authoritative, including copied, missing, and intentionally empty layouts. Each copied panel has a distinct contribution identity and therefore separate browser journal and saved results.

Select an installed replacement with:

```sh
npm run plugins -- select helmsman/terminal-page example.terminal/page
```

Disabled or unavailable selected contributions remain unavailable; Helmsman does not restore a private terminal renderer. Use the standard page/panel lifecycle in [panel authoring](panel-authoring.md), and build/package it using [plugin packages](plugin-packages.md).

## Validation boundary

Package and host tests must use a mock terminal fixture. They may verify scope, stale targets, bounded polling and screen text, control serialization, durable receipts, lost responses, inspection acknowledgment, disablement, replacement, and reload without typing into, selecting, entering keyboard-control mode for, or otherwise mutating a native terminal. A source-denied distribution scenario must prove that the author package compiles against the copied SDK and does not depend on application source.
