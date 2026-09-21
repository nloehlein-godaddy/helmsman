# Run history package

This independently authored package uses type-only imports from `@helmsman/plugin-sdk` and package-relative runtime imports. It contributes `helmsman.run-history/page` to `helmsman/run-history-page` and `helmsman.run-history/panel` through `helmsman/run-history-panel@1`. The page uses only composition; the panel requires `helmsman/run-inspect@1`. A third-party replacement retains the public contract and supplies its own plugin identifier.

Copy this directory outside the checkout and [rename the descriptor](../../../docs/plugin-packages.md#opt-in-task-presentation-packages) before building: change `manifest.id` from the reserved `helmsman.run-history` to your own ID, such as `example.run-history`, and change its initial-layout contribution from `helmsman.run-history/panel` to `example.run-history/panel`. Keep public slot, composition and contract IDs unchanged. Install the distributed SDK as `@helmsman/plugin-sdk` and TypeScript, run `npm run build`, then pack `dist` and install/enable the archive through the plugin CLI as shown in that recipe. The viewer is a separate package and can be replaced independently.

History is an E4 implementation candidate. Existing history remains active until source-denied production, visual and navigation cutover acceptance passes. This package does not import the private run store, HTTP routes or legacy renderer.

The panel reads one page of at most 50 runs in its effective activity scope. Previous/next navigation retains only cursor history, with a maximum of 200 visited pages per observation; changing the filter or refreshing starts a new observation. The displayed total and observation time come from the service, separately from the loaded page length. Unknown totals remain unknown. Status membership can change between pages, so the UI does not describe the result as an immutable snapshot. Worker outcome, source settlement, review recommendation and observed spend remain distinct.

Selection emits a canonical repository/run locator through `selectPresentation`; it does not mutate the header scope or use private navigation fallbacks. Explicit panel scope overrides remain effective. Hiding, disposal and scope changes abort reads; late replies cannot reveal the previous repository. Empty saved layouts remain empty, hidden implementations remain hidden until explicitly opened, and unsupported saved filter state is preserved.

Run `npx vitest run src/plugins/run-history` from the repository for scoped pagination, count, failure and composition tests. See [the run presentation author guide](../../../docs/run-presentation-authoring.md).

_Helmsman · not reported - not reported_
