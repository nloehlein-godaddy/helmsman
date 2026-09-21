# Experimental plugin packages

Helmsman installs separately authored frontend pages and panels without rebuilding the application. [Composable pages and panels](panel-authoring.md), [backend pricing](plugin-backend.md), and [task sources](task-source-authoring.md) use versioned public contracts. Packages run as explicitly trusted JavaScript in the application's browser context. Installation and enablement validate bytes and metadata without executing plugin code; frontend code runs when an enabled contribution mounts; the backend coordinator controls activation and retained obligations.

## Try the external sample

From the Helmsman checkout:

```sh
cp -R examples/plugins/scope-summary ../my-summary-plugin
npm run plugins -- pack ../my-summary-plugin ../summary.hmp
npm run plugins -- install ../summary.hmp
npm run plugins -- enable example.scope-summary
npm run plugins -- select helmsman/costs-page example.scope-summary/page
npm run plugins -- list
```

Open `/plugins/example.scope-summary/page?repo=org/a`, or `/outcomes` to use the selected replacement. The sample displays the current header galleon, receives scope/theme/Pirate updates, and navigates to Runs with that scope. Change `page.js` and its package version to build your own page; no host-source changes are needed.

The CLI and server use `HELMSMAN_PLUGINS_DIR`, defaulting to `~/.helmsman/plugins`. Both load an optional `.env` in their working directory. A CLI command can override the directory with `npm run plugins -- --dir /absolute/store COMMAND ...`. Use the same directory for the running server. Package directories and archive paths must have real directory ancestors; resolve symlinked temporary paths before packing.

Commands operate on the installation catalog. The server reconciles catalog changes and browsers poll the catalog. Page selection, enablement and disablement apply to open tabs; disabling or replacing a contribution disposes its managed instances and aborts their requests. Already evaluated trusted JavaScript is not a security sandbox. Backend disablement stops new admissions while retained executions and operations drain under their pinned bindings.

```sh
npm run plugins -- disable example.scope-summary
npm run plugins -- select helmsman/costs-page default
```

Disabling preserves the explicit selected contribution and shows it as unavailable. Reset selection to `default` explicitly to restore built-in Costs. To upgrade, disable the package, install the new archive, and enable it again; previous artifacts remain on disk. Packages are installed disabled initially. Reinstalling identical bytes preserves the current activation setting. Uninstallation and artifact collection respect retained execution and operation pins; they cannot remove bytes needed by ongoing work. There is no automatic package update.

## Author contract

Put `plugin-package.json` and prebuilt browser ESM assets in a clean output directory. The packager includes every regular file under that directory except the descriptor. Bundle framework/runtime dependencies before packing. No dependency installation or package scripts run in Helmsman.

```json
{
  "packageVersion": 1,
  "manifest": {
    "manifestVersion": 1,
    "id": "example.scope-summary",
    "version": "0.1.0",
    "sdkVersion": 1,
    "pages": [{ "id": "page", "title": "External scope summary", "slots": ["helmsman/costs-page"], "panes": [] }]
  },
  "node": { "minMajor": 22, "maxMajorExclusive": 26 },
  "entries": { "page": "page.js" }
}
```

Every page must have exactly one entry mapping. Manifest version 2 additionally declares panels and requires a separate exact `panelEntries` map; unchanged version 1 packages remain supported. See [panel authoring](panel-authoring.md) for Helm composition and lifecycle rules. Entries default-export a module implementing the [page lifecycle](plugin-page-registry.md#page-module-lifecycle). The [sample](../examples/plugins/scope-summary/page.js) uses only injected context and browser APIs. Own your styles within your container and bundle framework dependencies; application CSS classes and private host modules are not public APIs. The declared Node compatibility is a range of entire major versions, with an inclusive lower and exclusive upper bound, checked during installation, enablement, and startup. An optional backend descriptor supports pricing, validated settings, and namespaced storage; see [backend authoring](plugin-backend.md). General plugin dependency declarations are not accepted yet.

Static and literal dynamic JavaScript imports must resolve to `.js`/`.mjs` files inside the same archive. Backend-only modules may additionally import Node built-ins with `node:` specifiers. Bare dependencies, private host paths, cross-package imports, missing modules, and computed dynamic imports are rejected. Assets can be addressed relative to `import.meta.url`. Import validation is an authoring boundary, not a sandbox: trusted code can access the shared browser and same-origin APIs. The `helmsman.*` package namespace is reserved for built-ins.

## Storage and startup

The `.hmp` format is versioned UTF-8 JSON containing the descriptor and an array of `{path, base64}` assets. Content hashes cover deterministic canonical encoding of the complete package. Limits are 128 files, 10 MiB decoded content, and 15 MiB serialized data per archive; at most 32 external packages may be installed. Unsafe/duplicate paths, symlinks, special files, malformed base64, missing entries, and incompatible SDK/Node versions are rejected.

Artifacts are published atomically at `artifacts/<sha256>.json`, then installation records and bindings commit transactionally to `catalog.sqlite`. A failed process can leave an unreferenced artifact or staging file; these are never activated automatically. Installed files are verified on startup. A missing/corrupt/incompatible package remains unavailable while other valid packages load. Bindings survive a replacement dropping slot eligibility, without silently restoring a default provider.

The server maintains a reconciled snapshot of enabled packages and persisted selections. `/api/plugins/catalog` returns validated metadata with `Cache-Control: no-store`. Assets are served under `/plugin-assets/<plugin-id>/<sha256>/<path>` with immutable caching and explicit MIME types. Asset misses and malformed asset paths return 404 rather than the application HTML. Browser loading registers page metadata and lazy module proxies; a module is imported only when its page mounts. A retired mount cannot call the newly imported module's mount function, though JavaScript module evaluation itself cannot be cancelled.

For frontend recovery, start the server with `HELMSMAN_PLUGIN_UI_SAFE_MODE=1`. This disables optional frontend contributions, including shipped Costs, Helm and backlog, while preserving selections and saved layouts. Built-in code remains in the application bundle. Core administration and Recovery remain available, and backend scheduling/recovery continue normally. For full recovery use `HELMSMAN_SAFE_START=1` or `--safe-start`; see [safe-start recovery](distribution.md#safe-start-recovery). A damaged installation catalog or a failed browser catalog request also disables optional pages and emits a diagnostic, avoiding a silent fallback to built-in Costs. Restore the catalog or disable the failing package, then restart without the flag.

## Validation and remaining gates

Unit tests cover archive traversal/size/integrity, atomic publication, persisted state, import boundaries, CLI operations, HTTP handling, and browser activation rollback. Chromium tests copy the sample outside the checkout, pack/install it, serve real catalog/assets through the production HTTP handler, and import it into the built frontend. They cover deep-link reload, galleon scope, terminology, slot replacement, disable/re-enable, and UI safe mode.

The preview harness uses a production frontend with mocked legacy domain APIs. A separate [distribution harness](distribution.md#acceptance-evidence) copies the runnable server, compiles an independent SDK page, denies source access, and tests real server installation, route reload, and safe-start recovery. The Phase B harness additionally compiles and swaps standalone full/alternative Costs and standard/flat pricing implementations, verifies settings/storage persistence, and preserves measured usage through disable/restart.

The built-in Costs implementation now uses the same public SDK/services as independently compiled packages. Its rendering, terminology and styles are owned by the plugin; the distribution includes its standalone author project. External packages reject private-host and cross-package imports.
