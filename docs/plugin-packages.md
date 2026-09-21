# Experimental plugin packages

Helmsman installs separately authored frontend pages and panels without rebuilding the application. [Composable pages and panels](panel-authoring.md), [backend pricing](plugin-backend.md), and [task sources](task-source-authoring.md) use versioned public contracts. Packages run as explicitly trusted JavaScript in the application's browser context. Installation and enablement validate bytes and metadata without executing plugin code; frontend code runs when an enabled contribution mounts; the backend coordinator controls activation and retained obligations.

## E4 foundations and work in progress

The reviewed foundation (`e788774`) includes separate [run inspection](run-inspect-authoring.md) and [streamed download](download-authoring.md) facets. Run inspection preserves run-wide log provenance and fences reads/exports by the expected attempt. Download results distinguish a closed writable file from delivery to the browser. The existing run viewer and history remain active while authored replacements are built and validated; this foundation does not complete the E4 cutover.

Authored `runs`, `run-viewer` and `run-history` projects provide `/runs`, `/run-viewer` and `/run-history` after builtin catalog activation. Their public panel contracts and compositions use `helmsman/run-viewer-panel@1` / `helmsman/run-viewer-page` and `helmsman/run-history-panel@1` / `helmsman/run-history-page`. The generic auxiliary host honors the selected viewer page on plugin-page selections. The `/runs` alias selects `helmsman.runs/page` in `helmsman/runs-page`, composing history and the public PR panel while using the shared auxiliary viewer. Copying the Runs page requires renaming only its package ID; its initial layout deliberately references separately registered panel packages. The `/prs` and `/pr` aliases use the independently buildable PR composition and the shared viewer; see [PR plugins](pull-request-authoring.md).

The independently buildable `helmsman.compat-clarifications/page` recovery package owns its renderer, styles and legacy draft store while using durable public services. Its original identity preserves existing requests and raw drafts; renamed copies use their own draft namespace and caller journals. See [the backend clarification boundary](clarification-backend.md), [panel lifecycle and typed selection](panel-authoring.md), and [current acceptance status](plugin-implementation-progress.md).

The independently buildable Communication package supplies the selected notification header and `/communication` composition with replaceable notifications, review-request, and settings panels. It uses scoped notification projection, revision-checked global settings, and a caller-owned durable command journal. The separately built Slack backend owns Slack DOM and delivery policy while core retains the provider artifact, destination, operation, and bounded browser primitives. See [Communication authoring](communication-authoring.md).

Terminal extraction supplies a selected `helmsman/terminal-page` composition for `/terminal` and `/cmux`, accepting `helmsman/terminal-panel@1`. Its page and panel use only the public `helmsman/terminal@1` service. Header scope remains authoritative; an explicit panel `All` selection includes configured galleon terminals and unassociated surfaces without changing the header. Reads and controls retain exact surface revisions. See [Terminal authoring](terminal-authoring.md).

The Campaign package selects `helmsman/campaigns-page` for `/campaigns` and composes `helmsman/campaigns-panel@1`. It uses public scoped reads and atomic campaign command receipts while the existing dispatcher retains execution coordination. See [Campaign authoring](campaigns-authoring.md).

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

Use the header **Pages** menu to discover enabled pages from any route. Open `/plugins/example.scope-summary/page?repo=org/a`, or `/outcomes` to use the selected replacement. The sample displays the current header galleon, receives scope/theme/Pirate updates, and navigates to Runs with that scope. Change `page.js` and its package version to build your own page; no host-source changes are needed.

The CLI and server use `HELMSMAN_PLUGINS_DIR`, defaulting to `~/.helmsman/plugins`. Both load an optional `.env` in their working directory. A CLI command can override the directory with `npm run plugins -- --dir /absolute/store COMMAND ...`. Use the same directory for the running server. Package directories and archive paths must have real directory ancestors; resolve symlinked temporary paths before packing.

Commands operate on the installation catalog. The server reconciles catalog changes and browsers poll the catalog. Frontend page selection, enablement and disablement apply to open tabs; disabling or replacing a contribution disposes its managed instances and aborts their requests. Already evaluated trusted JavaScript is not a security sandbox. Backend disablement stops new admissions while retained executions and operations drain under their pinned bindings. Follow the CLI restart/reload instruction for backend activation or configuration changes, including re-enabling a provider; catalog reconciliation alone does not guarantee backend reactivation.

After a completed CLI selection, the next catalog read reconciles committed changes and loads the current binding before the browser can initialize an alias composition. It cannot initialize the previous default from a stale server snapshot. A failed reconciliation returns unavailable instead of a fallback catalog; existing saved layouts remain authoritative.

```sh
npm run plugins -- disable example.scope-summary
npm run plugins -- select helmsman/costs-page default
```

Disabling preserves the explicit selected contribution and shows it as unavailable. Reset selection to `default` explicitly to restore built-in Costs. To upgrade, disable the package, install the new archive, and enable it again; previous artifacts remain on disk. Packages are installed disabled initially. Reinstalling identical bytes preserves the current activation setting. Uninstallation and artifact collection respect retained execution and operation pins; they cannot remove bytes needed by ongoing work. There is no automatic package update.

## Opt-in task presentation packages

The distribution includes `plugin-sources/todos-ui`, `triage`, `bugs`, and `source-settings`. Copy an author project outside the checkout, install the distributed SDK and TypeScript, and build its `dist` directory. Rename its reserved `helmsman.*` package ID and any self-referencing initial-layout contribution IDs before packing. Install and enable it through the same CLI, then open `/plugins/<your-package-id>/page`.

For example, in the copied Triage author directory, rename the descriptor before building:

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const file = 'plugin-package.json';
const descriptor = JSON.parse(readFileSync(file, 'utf8'));
const previousId = descriptor.manifest.id;
const packageId = 'example.triage';
descriptor.manifest.id = packageId;
for (const page of descriptor.manifest.pages ?? []) {
  for (const instance of page.composition?.initialLayout?.instances ?? []) {
    if (instance.contributionId?.startsWith(previousId + '/')) {
      instance.contributionId = packageId + instance.contributionId.slice(previousId.length);
    }
  }
}
writeFileSync(file, JSON.stringify(descriptor, null, 2) + '\n');
JS
npm install --save-dev /absolute/path/to/release/sdk typescript
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./dist ./triage.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js install ./triage.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js enable example.triage
```

Open `/plugins/example.triage/page`. For another package, choose its own non-reserved ID and archive name; retain the shared `helmsman/...` contract and composition identifiers. References to other packages remain unchanged. The Jira author descriptor already uses the installable `example.jira` namespace.

These E3 packages are registered builtin defaults for `/todos`, `/triage`, `/bugs` and `/source-settings`. Their aliases follow explicit page selections; disabled or unavailable selections remain unavailable without fallback. Core `/config` links to Source settings and retains its own runtime controls. External variants remain independently buildable and installable using the renamed descriptors above. Default task-page cutover is reviewed and pushed. See [panel contracts](panel-authoring.md), [task-source services](task-source-authoring.md), and the [completion ledger](plugin-implementation-progress.md).

Communication uses two frontend slots and one backend selection. Use `select helmsman/communication-page ID`, `select helmsman/notification-header ID`, and `select-communication ID`. The page accepts `helmsman/communication-panel@1`; copied panels keep separate contribution-scoped drafts and journals. Disabled or missing selections remain unavailable, while admitted operations keep their pinned backend artifact for recovery.

Terminal uses one frontend page slot. Use `select helmsman/terminal-page ID`; `/terminal` and `/cmux` resolve that same selection. The page accepts `helmsman/terminal-panel@1`. Copied panels keep separate control journals and saved results. A disabled or missing selection remains unavailable, while server receipts and unresolved obligations remain retained.

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

Both manifest versions accept optional `navigation: false` on a page to hide auxiliary/header contributions from the Pages menu. Omission or `true` makes enabled page metadata discoverable, unless the same contribution is already represented by a shipped tab. The flag does not restrict canonical routes or slot selection. Selected supplemental pages use their host alias; unselected alternatives use canonical URLs. Menu navigation keeps the header galleon scope without carrying page-specific state, and never changes a saved selection. Duplicate titles display contribution IDs.

Every page must have exactly one entry mapping. Manifest version 2 additionally declares panels and requires a separate exact `panelEntries` map; unchanged version 1 packages remain supported. See [panel authoring](panel-authoring.md) for Helm composition and lifecycle rules. Entries default-export a module implementing the [page lifecycle](plugin-page-registry.md#page-module-lifecycle). The [sample](../examples/plugins/scope-summary/page.js) uses only injected context and browser APIs. Own your styles within your container and bundle framework dependencies; application CSS classes and private host modules are not public APIs. The declared Node compatibility is a range of entire major versions, with an inclusive lower and exclusive upper bound, checked during installation, enablement, and startup. An optional backend descriptor supports pricing, validated settings, and namespaced storage; see [backend authoring](plugin-backend.md). General plugin dependency declarations are not accepted yet.

Static and literal dynamic JavaScript imports must resolve to `.js`/`.mjs` files inside the same archive. Backend-only modules may additionally import Node built-ins with `node:` specifiers. Bare dependencies, private host paths, cross-package imports, missing modules, and computed dynamic imports are rejected. Assets can be addressed relative to `import.meta.url`. Import validation is an authoring boundary, not a sandbox: trusted code can access the shared browser and same-origin APIs. The `helmsman.*` package namespace is reserved for built-ins.

## Authored question and contact packages

The [authored question/contact packages](authored-clarifications.md) use separate public panel contracts and conditional instance-state saves. Independently installed copies must rewrite both the question page's own panel reference and its cross-package contact reference to the chosen nonreserved IDs. Keep the shared contracts unchanged. Select an installed page for `/clarifications` with `select helmsman/clarifications-page example.questions/page`. Existing composition layouts, compatibility drafts and original caller-owned requests remain intact; recovery stays available through the original compatibility contribution, which now owns its renderer and storage through the public package boundary.

## Storage and startup

The `.hmp` format is versioned UTF-8 JSON containing the descriptor and an array of `{path, base64}` assets. Content hashes cover deterministic canonical encoding of the complete package. Limits are 128 files, 10 MiB decoded content, and 15 MiB serialized data per archive; at most 32 external packages may be installed. Unsafe/duplicate paths, symlinks, special files, malformed base64, missing entries, and incompatible SDK/Node versions are rejected.

Artifacts are published atomically at `artifacts/<sha256>.json`, then installation records and bindings commit transactionally to `catalog.sqlite`. A failed process can leave an unreferenced artifact or staging file; these are never activated automatically. Installed files are verified on startup. A missing/corrupt/incompatible package remains unavailable while other valid packages load. Bindings survive a replacement dropping slot eligibility, without silently restoring a default provider.

The server maintains a reconciled snapshot of enabled packages and persisted selections. `/api/plugins/catalog` returns validated metadata with `Cache-Control: no-store`. Assets are served under `/plugin-assets/<plugin-id>/<sha256>/<path>` with immutable caching and explicit MIME types. Asset misses and malformed asset paths return 404 rather than the application HTML. Browser loading registers page metadata and lazy module proxies; a module is imported only when its page mounts. A retired mount cannot call the newly imported module's mount function, though JavaScript module evaluation itself cannot be cancelled.

For frontend recovery, start the server with `HELMSMAN_PLUGIN_UI_SAFE_MODE=1`. This disables optional frontend contributions, including shipped Costs, Helm and backlog, while preserving selections and saved layouts. Built-in code remains in the application bundle. Core administration and Recovery remain available, and backend scheduling/recovery continue normally. For full recovery use `HELMSMAN_SAFE_START=1` or `--safe-start`; see [safe-start recovery](distribution.md#safe-start-recovery). A damaged installation catalog or a failed browser catalog request also disables optional pages and emits a diagnostic, avoiding a silent fallback to built-in Costs. Restore the catalog or disable the failing package, then restart without the flag.

## Validation and remaining gates

Unit tests cover archive traversal/size/integrity, atomic publication, persisted state, import boundaries, CLI operations, HTTP handling, and browser activation rollback. Chromium tests copy the sample outside the checkout, pack/install it, serve real catalog/assets through the production HTTP handler, and import it into the built frontend. They cover deep-link reload, galleon scope, terminology, slot replacement, disable/re-enable, and UI safe mode.

The preview harness uses a production frontend with mocked legacy domain APIs. A separate [distribution harness](distribution.md#acceptance-evidence) copies the runnable server, compiles an independent SDK page, denies source access, and tests real server installation, route reload, and safe-start recovery. The Phase B harness additionally compiles and swaps standalone full/alternative Costs and standard/flat pricing implementations, verifies settings/storage persistence, and preserves measured usage through disable/restart.

The built-in Costs and Communication implementations use the same public SDK/services as independently compiled packages. Their rendering, terminology and styles are owned by the packages; the distribution includes their standalone author projects and the standalone Slack backend provider. External packages reject private-host and cross-package imports.

## Local Git presentation

The independently buildable `local-git` author package provides the selected `/local-git` page and replaceable panel through `helmsman/local-git@1`. Core retains checkout validation, active-worktree protection and durable command receipts. Lost responses require inspection; no retry operation is exposed. See [Local Git authoring](local-git-authoring.md) and the [implementation ledger](plugin-implementation-progress.md) for delivery evidence.

## Integration settings ownership

Jira and GitHub settings have independent authored page/panel packages with namespaced schemas, redacted reads and revision-checked global saves. Jira token input never enters browser persistence or response bodies; live Jira configuration stays in Source settings. Core retains configuration storage and credential binding. See [integration settings authoring](integration-settings-authoring.md) for the contracts and [delivery evidence](plugin-implementation-progress.md).

Scheduling backends declare `helmsman/scheduling@1`, matching `scheduling` access metadata and an SDK-only `registerScheduling` implementation. Select independently through `select-scheduling`; provider absence blocks automatic decisions without changing existing run bindings. See [scheduling authoring](scheduling-authoring.md).

Agent backends declare `helmsman/agent@1` with only process-description access and register an SDK-only provider. A selection retains its exact writer, ordered reviewers, settings, artifact closure and metadata for recovery. Use `select-agent` and `select-agent-reviewers`; package configuration is namespaced. The shipped Codex, Claude Code and command packages are extracted and have passed focused and installed acceptance checks, execution hosts and native terminal/browser providers are accepted, workflow extraction is accepted and pushed through `eb8ad1a`, and trigger extraction is active, pending final acceptance.

Execution-host packages declare `helmsman/execution-host@1` with `executionHosts` execution access and register through the restricted `ExecutionHostBackendModuleV1` context. Use `select-execution-host`; missing or disabled selections block new work without fallback. Captured bindings, settings and run configuration govern recovery and isolated stages. The local and Docker author packages bundle the public Node receipt helpers separately from the browser SDK. See [execution host authoring](execution-host-authoring.md).

Native implementations declare `helmsman/native-terminal@1` and register through `NativeTerminalBackendModuleV1`. The independent cmux and WezTerm packages provide terminal I/O; cmux also provides browser primitives. Use `select-native-terminal` for terminal controls and `select-browser-host` for communication browsing. The frontend Terminal package remains independently selectable. See [native terminal authoring](native-terminal-authoring.md).

Workflow packages declare `helmsman/workflow@1` and `workflows: { localId: { access: ['workflow-policy'] } }`, then register through the restricted `WorkflowBackendModuleV1`. The accepted implementation ships `helmsman.workflow-coding/coding` (staged coding), `helmsman.workflow-coding/branch` (direct branch feedback), and `helmsman.workflow-review/review` (direct PR review). Use `select-workflow coding|review|branch <plugin/id>` and `configure` on the owning package; `default` or `null` restores the shipped default for that mode. Explicit unavailable selections block admission. Original prompts/policy, settings and artifacts remain bound to a running or resumed voyage, including after disablement.

Use `select-agent-reviewers ID[,ID...]` for the complete ordered reviewer list. Legacy reviewer count migrates into that list once; legacy rounds and stage timeout migrate into coding workflow settings once. Explicit values and subsequent resets are preserved. Workflow implementation, installed acceptance and independent review are complete; see [workflow authoring](workflow-authoring.md).


## Trigger selection and settings

Trigger extraction is active, pending final acceptance. Each role has an independent persisted selection:

| Role | Shipped contribution | Policy settings |
|---|---|---|
| `campaign` | `helmsman.trigger-campaign/dispatch` | `enabled`, `intervalMs` (default 5,000) |
| `slack-review` | `helmsman.trigger-slack-review/watch` | `enabled`, `intervalMs` (default 300,000), `overlapSeconds` (default 300), `repoFilterJson` (default `[]`) |
| `github-review` | `helmsman.trigger-github-review/watch` | `enabled`, `intervalMs` (default 300,000) |
| `github-webhook` | `helmsman.trigger-github-webhook/github` | `enabled`, `routesJson` (default `[]`) |

```sh
helmsman plugins select-trigger campaign helmsman.trigger-campaign/dispatch
helmsman plugins configure helmsman.trigger-campaign '{"intervalMs":5000}'
helmsman plugins select-trigger slack-review disabled
helmsman plugins select-trigger github-review default
```

`default` restores the shipped role selection; `disabled` or `null` explicitly disables it. These are distinct persisted states. An explicit unavailable selection blocks new work without fallback. Package activation and its `enabled` setting also gate decisions. Follow the CLI restart instruction after changing settings or activation.

Legacy Slack/GitHub watch flags initialize their trigger enablement once; an unconfigured installation retains disabled watches. Later selections, explicit settings and resets survive restart. The old watch forms show read-only status and direct operators to the selected plugin. Webhook route environment configuration likewise seeds once; credentials stay in core and never enter plugin settings. See [webhook setup](webhooks.md) for credential rotation and [trigger authoring](trigger-authoring.md) for the public contract.

Disablement stops new scans, proposals and admissions while receipts and existing-run reconciliation continue. Event dedupe identities exclude policy versions and settings. Persisted proposals retain original settings, source bindings and dependency pins; replacing a policy does not re-run it over queued work. Rows predating capture stay explicitly legacy.
