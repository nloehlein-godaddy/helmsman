# Independently buildable standard pricing

This is the pricing implementation shipped with Helmsman, using only public SDK types. The distribution includes this author source at `plugin-sources/pricing`.

Copy this directory outside the application and build it against the distributed SDK:

```sh
npm install --save-dev /absolute/path/to/release/sdk typescript
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./dist ./standard-pricing.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js install ./standard-pricing.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js enable example.standard-pricing
node /absolute/path/to/release/server/helmsman/plugins/cli.js select-pricing example.standard-pricing/standard
```

Use the server's `HELMSMAN_PLUGINS_DIR` and restart after enablement. The author descriptor uses `example.standard-pricing`; the built-in `helmsman.*` namespace cannot be installed externally. Change the descriptor namespace before publishing your own implementation.

The provider estimates only unreported usage for supported models. It returns unknown for unsupported models or incomplete token counts, and never changes measured spend or budget limits. Rate provenance travels with every result.
