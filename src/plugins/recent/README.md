# Recent panel

This independently compiled panel uses only the public `@helmsman/plugin-sdk` types and the version 1 run-read/run-command services. It does not import the application store, renderer, API helpers, or another plugin.

Copy this directory outside the checkout, install the published SDK and TypeScript in that author workspace, and run `npm run build`. The output contains the panel module and package descriptor. The `helmsman.recent` identifier is reserved for the bundled implementation; third-party replacements must use their own plugin identifier while retaining the `helmsman/helm-panel@1` contract.

The panel watches one bounded page in its host-provided galleon scope. Hidden, disposed, and superseded activity stops the watch. Worker outcomes, review recommendations, and source settlement are displayed separately. Commands target an exact original attempt and retain uncertain outcomes in the host journal. Check request only reads a receipt. Retry delivery explicitly resubmits the same saved intent through the host, which retains its original request ID; it is unavailable for requests requiring Recovery. Accepted and rejected receipts remain visible after reload until the operator dismisses them through the public acknowledgment service. Acknowledgment does not undo a command. Spend is the observed amount or explicitly unknown.

Panel tests live in `../running/panel.test.ts` and exercise both implementations against the same public service mocks.
