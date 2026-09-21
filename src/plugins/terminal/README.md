# Terminal

SDK-only terminal composition page and panel. The page contribution `helmsman.terminal/page` selects `helmsman/terminal-page`, accepts `helmsman/terminal-panel@1`, and initially mounts `helmsman.terminal/panel` as instance `terminal`. The page supports `tabs` and `screen` panes. The panel requires public `helmsman/terminal@1`; no application internals or private endpoints are imported.

The panel follows its effective host scope. “Show all terminals” explicitly requests All through `setScope`; “Use header scope” restores inheritance. Surface navigation preserves the separate header repository. The public typed terminal route hint also works when this package is copied under another contribution identity.

The panel lists terminals and reads a 40-line plaintext screen preview every two seconds while active. Hiding, changing scope or selection, and disposing cancel reads and unsent queued controls. Input and output nodes remain mounted through polling, preserving draft selection, focus and scroll. Keyboard control is enabled only by an explicit click and only sends while the screen has focus; Shift+Escape releases it. Available actions come from the service. Clipboard images are bounded to 2 MiB of base64 and are sent only if the original target and activity still match after the file read.

Controls are ordered with at most 32 unsent operations. There is no retry or automatic replay. A confirmed or rejected receipt is saved before journal acknowledgment. An unknown result offers only “Check original receipt”. A recovery-required receipt blocks further controls on its original surface until explicit “Resume controls after inspection” saves the uncertain evidence and acknowledges it without claiming delivery.

Storage is namespaced by mounted contribution and instance identity. Selected surface, per-repository/surface text drafts and internal collapse preferences survive remount. Saved receipts and inspection records preserve original evidence; malformed or unsupported saved data remains untouched and blocks controls.

From the repository root: `npx vitest run src/plugins/terminal/`. Distribution tooling provides the published SDK for independent `node build.mjs` compilation.
