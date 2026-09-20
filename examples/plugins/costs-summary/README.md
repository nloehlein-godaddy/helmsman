# Independent Costs sample

This alternative page uses only the public page SDK. Recorded usage and selected-provider estimates remain separate; removing the pricing provider leaves recorded data visible and labels estimates unknown.

Copy this directory outside the application, install `/absolute/path/to/release/sdk` and `typescript` as development dependencies, and run `npm run build`. Use the compiled plugin CLI to pack `dist`, install the archive, enable `example.costs-summary`, and select `example.costs-summary/page` for `helmsman/costs-page`. Restart Helmsman and reload the page.

The sample owns its styles and terminology. It follows header scope, cancels superseded reads, suppresses hidden polling, and removes its listeners on disposal.
