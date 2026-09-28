# Communication

SDK-only notification header, communication composition page, and independent notifications, review-request, and settings panels. The package requires public `helmsman/communication@1`, `helmsman/communication-command@1`, and composition services. It imports no application internals and uses no private HTTP endpoints.

The header selects `helmsman/notification-header`. The page selects `helmsman/communication-page` and accepts `helmsman/communication-panel@1`. Each panel can be hidden, replaced, or copied with a different contribution identity. The package owns notification polling and cancels reads and explicit mark-read operations when hidden or disposed; ordinary polling does not cancel a mark-read operation.

Review requests show their exact workspace, channel, and mention before sending. Only explicit Send or Retry invokes a command. Pending requests retain their original target, destination, and request ID across reload and settings changes. Terminal receipts are saved locally before journal acknowledgment. Unknown or unavailable local evidence prevents new sends without overwriting the original data.

Settings drafts retain their original revision until explicitly saved or discarded. Refresh keeps unsent edits, conflicts keep the draft, and saving settings never sends a message. Browser storage uses the mounted contribution identity, so copied packages receive separate drafts and saved results.

When the selected provider offers account connections, settings show its public connection status and explicit Connect, Check, and Disconnect controls. Actions carry the displayed provider revision. Connecting requires the registered HTTPS origin; local HTTP shows a link to that address. Credentials never enter drafts or browser storage. Providers without account controls keep their existing settings flow.

Run focused checks from the repository root with `npx vitest run src/plugins/communication`. Distribution tooling supplies the published SDK to build this source package using `node build.mjs`.
