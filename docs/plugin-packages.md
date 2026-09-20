# Experimental page packages

Helmsman can install separately authored frontend page packages and load them without rebuilding the application. This is an experimental Phase A interface. Packages run as explicitly trusted JavaScript in the application's browser context. Installation and enablement validate bytes and metadata without executing plugin code; code runs when an enabled page is opened.

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

Restart Helmsman and reload its browser tabs. Open `/plugins/example.scope-summary/page?repo=org/a`, or `/outcomes` to use the selected replacement. The sample displays the current header galleon, receives scope/theme/Pirate updates, and navigates to Runs with that scope. Change `page.js` and its package version to build your own page; no host-source changes are needed.

The CLI and server use `HELMSMAN_PLUGINS_DIR`, defaulting to `~/.helmsman/plugins`. Both load an optional `.env` in their working directory. A CLI command can override the directory with `npm run plugins -- --dir /absolute/store COMMAND ...`. Use the same directory for the running server. Package directories and archive paths must have real directory ancestors; resolve symlinked temporary paths before packing.

Commands operate on the installation catalog. Restart and reload are required to apply activation or selection changes. An existing server keeps its startup snapshot, and open browser tabs may keep already evaluated code. Disabling a page does not revoke code already running in a tab. Frontend packages have no backend work or provider obligations in this increment.

```sh
npm run plugins -- disable example.scope-summary
npm run plugins -- select helmsman/costs-page default
```

Disabling preserves the explicit selected contribution and shows it as unavailable. Reset selection to `default` explicitly to restore built-in Costs. To upgrade, disable the package, install the new archive, and enable it again; previous artifacts remain on disk. Packages are installed disabled initially. Reinstalling identical bytes preserves the current activation setting. There is no automatic update, uninstall, or artifact garbage collection yet.

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

Every page must have exactly one entry mapping. Entries default-export a module implementing the [page lifecycle](plugin-page-registry.md#page-module-lifecycle). The [sample](../examples/plugins/scope-summary/page.js) uses only injected context and browser APIs. Own your styles within your container and bundle framework dependencies; application CSS classes and private host modules are not public APIs. The declared Node compatibility is a range of entire major versions, with an inclusive lower and exclusive upper bound, checked during installation, enablement, and startup. Backend entry points and plugin dependencies are not accepted yet.

Static and literal dynamic JavaScript imports must resolve to `.js`/`.mjs` files inside the same archive. Bare dependencies, private host paths, cross-package imports, missing modules, and computed dynamic imports are rejected. Assets can be addressed relative to `import.meta.url`. Import validation is an authoring boundary, not a sandbox: trusted code can access the shared browser and same-origin APIs. The `helmsman.*` package namespace is reserved for built-ins.

## Storage and startup

The `.hmp` format is versioned UTF-8 JSON containing the descriptor and an array of `{path, base64}` assets. Content hashes cover deterministic canonical encoding of the complete package. Limits are 128 files, 10 MiB decoded content, and 15 MiB serialized data per archive; at most 32 external packages may be installed. Unsafe/duplicate paths, symlinks, special files, malformed base64, missing entries, and incompatible SDK/Node versions are rejected.

Artifacts are published atomically at `artifacts/<sha256>.json`, then installation records and bindings commit transactionally to `catalog.sqlite`. A failed process can leave an unreferenced artifact or staging file; these are never activated automatically. Installed files are verified on startup. A missing/corrupt/incompatible package remains unavailable while other valid packages load. Bindings survive a replacement dropping slot eligibility, without silently restoring a default provider.

The server snapshots enabled packages at startup. `/api/plugins/catalog` returns validated metadata with `Cache-Control: no-store`. Assets are served under `/plugin-assets/<plugin-id>/<sha256>/<path>` with immutable caching and explicit MIME types. Asset misses and malformed asset paths return 404 rather than the application HTML. Browser loading registers page metadata and lazy module proxies; a module is imported only when its page mounts. A retired mount cannot call the newly imported module's mount function, though JavaScript module evaluation itself cannot be cancelled.

For frontend recovery, start the server with `HELMSMAN_PLUGIN_UI_SAFE_MODE=1`. This skips external page registrations and disables built-in Costs mounting while preserving selections. Built-in code remains in the application bundle. Legacy pages and backend scheduling/recovery continue normally. For full recovery use `HELMSMAN_SAFE_START=1` or `--safe-start`; see [safe-start recovery](distribution.md#safe-start-recovery). A damaged installation catalog or a failed browser catalog request also disables optional pages and emits a diagnostic, avoiding a silent fallback to built-in Costs. Restore the catalog or disable the failing package, then restart without the flag.

## Validation and remaining gates

Unit tests cover archive traversal/size/integrity, atomic publication, persisted state, import boundaries, CLI operations, HTTP handling, and browser activation rollback. Chromium tests copy the sample outside the checkout, pack/install it, serve real catalog/assets through the production HTTP handler, and import it into the built frontend. They cover deep-link reload, galleon scope, terminology, slot replacement, disable/re-enable, and UI safe mode.

The preview harness uses a production frontend with mocked legacy domain APIs. A separate [distribution harness](distribution.md#acceptance-evidence) copies the runnable server, compiles an independent SDK page, denies source access, and tests real server installation, route reload, and safe-start recovery. Phase B still needs external Costs data/query and pricing providers plus namespaced settings/storage. Phase A is verified by the isolated distribution gate; the combined A/B milestone remains incomplete.

The built-in Costs controller remains a transitional host adapter: it uses the public page lifecycle but receives legacy domain services and retains private rendering/terminology imports. Phase B replaces those dependencies with the published usage-query/service boundary. External packages already reject private-host and cross-package imports.
