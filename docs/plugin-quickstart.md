# Author plugins from a release

You need a runnable Helmsman release, a compatible Node version and npm. No application checkout is required. The public SDK, examples and author guides are inside the release. Choose fresh author directories outside it and use the same `HELMSMAN_PLUGINS_DIR` and `HELMSMAN_DB` as the target server when running the CLI. Use a separate installation for experiments. Package and archive paths must use real directories without symlinked ancestors; for example, resolve macOS `/tmp` to `/private/tmp` before packing.

## Frontend page and panel

Copy `examples/plugins/scope-panel` from the release into a new directory. Inside the copied directory:

```sh
npm install --save-dev /absolute/path/to/release/sdk typescript
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./dist ./scope-panel.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js install ./scope-panel.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js enable example.scope-panel
```

Open `/plugins/example.scope-panel/page?repo=org/example`. The page mounts a panel through the public composition service. Its effective scope follows the header galleon; the panel does not change the header. The small page preserves existing layouts, including empty layouts, and respects hidden/collapsed panel activity. It deliberately provides no layout editor; use the full `plugin-sources/helm-alternative` project when building one.

To replace the selected Helm page explicitly:

```sh
node /absolute/path/to/release/server/helmsman/plugins/cli.js select helmsman/helm-page example.scope-panel/page
```

Open `/helm`. Existing `helmsman/helm-page` layouts remain authoritative, so an existing layout may display its existing panels instead of this example's initial panel. Use the canonical route above in an isolated fresh installation to see the starter's initial layout. Selection changes do not reset layouts. Disable and restore explicitly:

```sh
node /absolute/path/to/release/server/helmsman/plugins/cli.js disable example.scope-panel
node /absolute/path/to/release/server/helmsman/plugins/cli.js select helmsman/helm-page default
```

Before distributing your version, change `manifest.id` to your own nonreserved namespace and update the matching `initialLayout.instances[].contributionId` self-reference. Change the package version whenever publishing changed bytes. Keep shared `helmsman/helm-page` and `helmsman/helm-panel` contract identifiers. The `helmsman.*` package namespace is reserved. `page.ts` and `panel.ts` use SDK types only; their imports disappear during the TypeScript build. Runtime SDK helpers or framework dependencies must be bundled into the output. Pack only `dist`, never your source or `node_modules`.

## Backend replacement

Copy `examples/plugins/flat-pricing` from the release into another fresh author directory. Inside it:

```sh
npm install --save-dev /absolute/path/to/release/sdk typescript
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./output ./flat-pricing.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js install ./flat-pricing.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js configure example.flat-pricing '{"usdPerMillionTokens":2}'
node /absolute/path/to/release/server/helmsman/plugins/cli.js enable example.flat-pricing
node /absolute/path/to/release/server/helmsman/plugins/cli.js select-pricing example.flat-pricing/flat
```

Restart the target server after backend enablement/configuration changes. Open Costs (`/outcomes`) for the current galleon. The provider estimates unreported token usage; actual recorded spend and budgets remain core-owned. With no unpriced token records, there is nothing to estimate. Change `backend.ts` to implement your own rate policy and `plugin-package.json` to declare its namespaced settings. The sample also demonstrates public namespaced storage.

Disable and restore the shipped provider explicitly, then restart:

```sh
node /absolute/path/to/release/server/helmsman/plugins/cli.js disable example.flat-pricing
node /absolute/path/to/release/server/helmsman/plugins/cli.js enable helmsman.standard-pricing
node /absolute/path/to/release/server/helmsman/plugins/cli.js select-pricing helmsman.standard-pricing/standard
```

An unavailable explicit selection does not fall back. `select-pricing default` clears the binding and requires exactly one active provider; it does not mean “choose shipped pricing.” Replacing a backend does not rebind retained work or remove its artifacts.

## Next contracts

See [SDK compatibility](plugin-compatibility.md), [page/panel contracts](panel-authoring.md), [package operations](plugin-packages.md) and [backend capabilities](plugin-backend.md). The release's `plugin-sources/` includes independently buildable task sources, integration settings, communication, PR, scheduling, agent, execution-host, native terminal/browser, workflow and trigger implementations. Their READMEs link their public author guides. Plugins are trusted application code, not sandboxed code; install only packages you trust.
