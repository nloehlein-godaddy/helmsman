# Scope page and panel starter

A minimal TypeScript manifest-2 package using only public SDK types and injected composition services. The panel shows its effective galleon scope; the page preserves saved layouts and manages panel disposal/activity. It has no private application imports or layout editor.

Copy this directory outside the release, then follow the [release-only quickstart](../../../docs/plugin-quickstart.md). Run `npm install --save-dev /absolute/path/to/release/sdk typescript`, `npm run build`, and pack `dist` using the compiled plugin CLI.

Rename `manifest.id` and its initial panel self-reference together. Keep shared composition/panel contracts unchanged. An existing saved Helm layout wins over this package's initial layout. Use an isolated fresh installation to see the initial scope panel without changing existing layouts.
