# Independent flat pricing sample

This backend sample uses only the public SDK. Its configurable token rate demonstrates validated settings, durable plugin storage, and replacement of the selected pricing provider.

Copy this directory outside the application, then run:

```sh
npm install --save-dev /absolute/path/to/release/sdk typescript
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./output ./flat-pricing.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js install ./flat-pricing.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js configure example.flat-pricing '{"usdPerMillionTokens":2}'
node /absolute/path/to/release/server/helmsman/plugins/cli.js enable example.flat-pricing
node /absolute/path/to/release/server/helmsman/plugins/cli.js select-pricing example.flat-pricing/flat
```

Use the server's `HELMSMAN_PLUGINS_DIR` and restart after configuration or enablement changes. Pricing selection takes effect on subsequent requests. The flat rate is a demonstration policy; its estimates stay separate from recorded spend and budget enforcement.
