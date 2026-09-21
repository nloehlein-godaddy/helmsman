# Experimental page registry and lifecycle

This implements the page metadata and lifecycle portions of [Phase A](plugin-architecture-plan.md). The API is experimental. Standalone declarations ship as `release/sdk`; see [the runnable distribution and SDK](distribution.md).

This guide describes the page lifecycle introduced in Phase A. Current composition and panel services are documented in [panel authoring](panel-authoring.md); E3 task/editor/admin services are in [task-source authoring](task-source-authoring.md). Costs, Helm, Todos, Triage, Bugs and Source settings have selected aliases. Canonical package routes remain available; a disabled or missing selected page remains unavailable without fallback. Core Config links to Source settings. Default task-page cutover is reviewed and pushed. See [current progress](plugin-implementation-progress.md).

## What works

- Runtime validation of page contribution metadata, with immutable defensive copies.
- Atomic registration and removal, namespaced contribution IDs, and explicit slot selection.
- The existing Costs page at `/outcomes` and `/plugins/helmsman.costs/page`.
- Shared browser/server page recognition and canonical links that preserve header galleon scope.
- Explicit unavailable states for missing contributions, without substituting a different provider.
- Generic page modules with scoped mount/update/refresh/dispose lifecycles, immutable host state, and cleanup registration.
- Module replacement/removal, async mount containment, serialized state updates, visibility-aware refresh, and isolated lifecycle failures.
- Costs rendering, reads, period selection, drafts, and assessment saves owned by `src/plugins/costs`, with host-supplied services.
- Cancellation and stale-response protection for Costs reads and writes on scope changes or disposal. Failed saves retain drafts; refresh and period changes preserve edits.

Registering a manifest makes its metadata and routes known. Registering its implementation in the in-process module catalog makes it mountable through the generic host. Metadata without a module shows an unavailable state. External frontend packages can now be installed through the CLI and loaded lazily; see [page packages](plugin-packages.md).

## Manifest prototype

```json
{
  "manifestVersion": 1,
  "id": "example.costs",
  "version": "0.1.0",
  "sdkVersion": 1,
  "pages": [
    {
      "id": "summary",
      "title": "Alternative costs",
      "slots": ["helmsman/costs-page"],
      "panes": ["totals", "history"]
    }
  ]
}
```

The prototype fields shown above are required. Both manifest versions also accept optional `navigation: boolean` on each page; it defaults to `true`. Set it to `false` for auxiliary contributions such as headers that should stay out of page discovery. It does not restrict canonical routes, slot selection, or mounting. Unsupported fields and versions are rejected. Package versions use semantic version syntax. Plugin IDs have a dotted publisher namespace; each segment and local page/pane ID uses lowercase letters, digits, and hyphens, beginning with a letter. Slot IDs use `namespace/local-id`, including core-owned `helmsman/costs-page`.

Contribution IDs combine plugin and local page IDs: `example.costs/summary`. Their canonical URL is `/plugins/example.costs/summary`; plugins cannot choose an arbitrary path that shadows a host route. Host-owned slots define aliases and default contributions separately.

This prototype covers page metadata and known pane IDs only. The enclosing package descriptor supplies frontend entry points and a Node major-version range. The enclosing descriptor also supports the versioned pricing capability and backend settings/storage. General capabilities, arbitrary query-state schemas, and permissions remain later work. They will be introduced alongside their actual consumers, before stabilizing the public manifest.

## Registry behavior

[`PluginPageRegistry`](../src/plugins/registry.ts) takes host-owned slots and reserved paths. [`parsePluginManifest`](../src/plugins/manifest.ts) accepts unknown input and returns a validated, frozen manifest or throws `PluginManifestError`. Shared types are in [`sdk.ts`](../src/plugins/sdk.ts).

| Operation | Behavior |
|---|---|
| `register(manifest)` | Validate the entire package before publishing pages; return an idempotent disposer for that registration. Duplicate plugin IDs fail. |
| `listPages()` | Return a frozen snapshot of immutable registered pages, sorted by contribution ID; registration changes do not mutate earlier snapshots. |
| `getPage(contributionId)` | Return immutable registered metadata, or `null`. |
| `resolvePath(path)` | Resolve a normalized alias or canonical path; valid missing contributions return a resolution with `page: null`. |
| `selected(slotId)` | Resolve the explicit binding, or the host default only when no binding exists. |
| `select(slotId, contributionId)` | Select a contribution that supports the slot. Explicit missing IDs remain selected and unavailable. |
| `select(slotId, null)` | Explicitly reset selection to the host default. |
| `subscribe(listener)` | Observe registry changes; return a disposer. One synchronous listener failure does not prevent others from running. |

Registry selection is in memory, initialized from the persisted installation catalog at startup. The CLI manages external frontend installation, activation, and explicit slot bindings; server restart and browser reload apply the snapshot. Browser and server initialize the same validated metadata. There is no plugin-management UI yet; see [package operations and recovery](plugin-packages.md).

The host resolves contribution metadata and implementation independently, then mounts through the same lifecycle for Costs and other pages. Generic plugin routes use an explicit `plugin` route case, not a cast into the legacy page union. Costs uses the same shipped-tab definition and slot resolution as the other fixed tabs. Titles remain escaped, and shell element IDs are generated by the host rather than using plugin IDs as CSS selectors.

## Installed page navigation

The header's native **Pages** menu lists enabled registered page contributions from every route, including Config. Contributions already represented by a shipped tab and pages declaring `navigation: false` are omitted. Entries sort by title with contribution ID as a stable tie-break; duplicate titles show their contribution IDs. Metadata can remain discoverable when its implementation is unavailable, so a failed module does not silently choose another page.

Selected supplemental contributions link to their stable host alias. Unselected alternatives link to their exact canonical package route. Links preserve only the header galleon scope; `All` omits the scope parameter. Run, task, pane and panel state from the current route is not copied. Rendering the menu never selects a page or substitutes a default for a missing binding. The current page retains its tab and unavailable state when disabled or removed.

Core owns the neutral greeting text and an auxiliary profile mount. An optional selected profile contribution supplies the personal suffix; profile lookup and rendering belong to that package.

## Page module lifecycle

[`PluginPageModules`](../src/plugins/modules.ts) associates a contribution ID with a `PluginPageModule`. `register(id, module)` returns an idempotent removal callback; `get(id)` returns the stable module wrapper or `null`; `subscribe(listener)` observes catalog changes. It does not load packages. Browser-only built-in composition lives in [`builtin-modules.ts`](../src/plugins/builtin-modules.ts), separately from shared route metadata.

A module implements `mount(container, context)` and returns an instance, synchronously or asynchronously. The instance implements `update(state)` and `dispose()`, and may implement `refresh()`. Context contains the initial frozen state, mount-lifetime `signal`, guarded app navigation, and `onDispose(cleanup)`. Optional `context.contributionId` is the immutable identity of the mounted page contribution, shared with its caller-scoped services; aliases and header scope do not change it. Packages using that identity for saved-state namespaces must fail closed when an older host omits it. Optional `context.services` exposes versioned usage, pricing, reports and assessments; see [public services](plugin-backend.md). State carries the header galleon scope, theme, Pirate mode, visibility, and pane. Updated snapshots arrive through `update`; the initial context snapshot does not mutate.

The host retains the page DOM across shell updates. Switching contributions aborts the old context, invokes cleanup, disposes the instance, and detaches its container. Late mounts are disposed. Retiring a page releases pending host refresh callers even if its lifecycle promise never settles. State updates are serialized and coalesced; refresh calls coalesce while pending. Hidden pages receive visibility updates but are not polled. Mount/update/refresh failures retire the instance and show a generic error.

Modules must make disposal idempotent and cancel or generation-guard their own asynchronous work when scope changes. Refresh does not block new scope updates. The host cannot stop arbitrary trusted code from changing shared globals: this same-context API is not a sandbox or the final external plugin trust boundary. Navigation accepts recognized same-origin application routes only.

Costs consumes public injected services, owns scoped CSS/terminology, and can be compiled outside the host from its distributed author project. Drafts are scoped to the galleon and run for the lifetime of the mounted page; they are not durable across navigation/reload. A successful save only clears the revision it submitted. Cancelling a client PUT does not undo a write already accepted by the server.

## Validation

```sh
npm test
npm run build
npm run test:browser
```

The browser harness uses a production Vite preview with mocked APIs. It checks alias/canonical Costs rendering, header scope and reload, unavailable pages, navigation, a visual baseline, failed-save draft preservation, period changes while editing, and navigation during a pending save. Install its browser on a new development machine with `npx playwright install chromium`. Update snapshots only after reviewing the rendered change.

The external-package browser harness proves frontend installation and import using real catalog/asset handlers. The [isolated distribution harness](distribution.md#acceptance-evidence) also exercises the real compiled server with source access denied. Isolated third-party execution and durable run/provider lifecycle remain later gates.


## E4 auxiliary presentation integration

The working E4 slice introduces `/run-viewer` and `/run-history` selected slots alongside their canonical package routes. Plugin pages can open the selected auxiliary viewer with the optional typed `selectPresentation` callback; the shell forwards captured effective scope without changing the header. Missing selected viewers remain unavailable. Visibility and detachment cancel scoped work while the mounted session is retained. The `/runs` route now selects `helmsman.runs/page` through `helmsman/runs-page`; its composition uses history and a public PR panel with the shared auxiliary viewer. Legacy pane and review/relaunch links retain their targets without changing header scope. Missing/disabled selected pages stay unavailable. The `/prs` composition also uses public PR panels and the shared viewer. See [presentation selection](panel-authoring.md#presentation-selection-and-auxiliary-pages).

Standalone viewer aliases and the auxiliary surface now share one retained session. A canonical viewer route addresses its exact contribution rather than changing the selected alias. The `/clarifications` alias selects `helmsman/clarifications-page`, whose default authored question composition accepts independent question and global-contact panel contracts. Existing composition layouts remain authoritative across alias visits and page replacement. The original compatibility contribution remains at `/plugins/helmsman.compat-clarifications/page` with its recovery identities intact. See [authored questions and contacts](authored-clarifications.md).
