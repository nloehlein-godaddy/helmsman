# Execution settings

This SDK-only page composes replaceable `helmsman/execution-settings-panel@1` panels. Its panel uses `helmsman/execution-policy@1` to read and change the effective galleon's concurrency policy. The header scope is inherited unless the composition supplies an explicit panel scope.

The default is one run per galleon. Before enabling parallel runs, the panel displays the global limit, current local limit, active run count and per-run cost cap. Parallel changes require explicit opt-in and compatible execution ownership. Retained schema blockers remain visible; the service remains unavailable until backend admission and cleanup safety are enabled.

Every write includes a request ID and expected policy revision. The panel saves that command locally before sending and retries the same command after an uncertain response. The server stores exact replay receipts and rejects stale revisions. Policy changes affect future admission; shared tickets, branches and pull requests remain exclusively reserved.

Run `npm run build` after installing the distribution's SDK and TypeScript. Package unit tests live in `panel.test.ts`; browser coverage verifies desktop/mobile rendering and explicit opt-in.
