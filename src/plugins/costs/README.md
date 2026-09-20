# Independently buildable Costs page

This is the same implementation registered by the host. It imports only the public SDK's types and its own modules. The distribution includes this author source at `plugin-sources/costs`.

Copy this directory to your author workspace, install the distributed SDK and TypeScript, then build and package the clean output:

```sh
npm install --save-dev /absolute/path/to/release/sdk typescript
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./dist ./costs.hmp
```

The example descriptor uses `example.full-costs`; change it to your own namespace before publishing. The built-in `helmsman.*` namespace cannot be installed externally.

Measured usage comes from `context.services.usage.query`; assessments and outcome evidence use the versioned public outcomes service. Pricing comes exclusively from the selected pricing service. Missing or failed pricing leaves measured spend available and estimates unknown. Per-record estimates are grouped for daily and run displays without embedding a pricing policy.

Styles belong to `.helmsman-costs-page`. Supported inherited theme tokens are `--sans`, `--mono`, `--text`, `--text-dim`, `--text-faint`, `--panel`, `--face-hi`, `--line`, `--line-strong`, `--radius`, `--accent`, `--accent-bright`, `--accent-plate`, and `--bad`. No host CSS classes or terminology functions are required.
