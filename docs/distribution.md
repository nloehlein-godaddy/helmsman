# Runnable Helmsman distribution

`npm run build:distribution` produces `release/` with compiled server entry points, the browser application, native production dependencies, execution helpers, examples, and the experimental page/backend SDK. Run it with the same OS, CPU architecture, and Node major used to build it. The manifest records those constraints and the native module ABI; build a new distribution for another target. The release does not install dependencies or run package installation scripts at startup.

## Run from a separate data directory

Launch the compiled entry point from your preferred working directory:

```sh
node /absolute/path/to/release/server/helmsman/main.js
```

The server resolves application assets and execution helpers relative to its installation. The optional `.env`, default `.helmsman.sqlite`, and default work directories remain relative to the operator's working directory. `HELMSMAN_DB`, `AGENTS_ROOT`, `RUNS_DIR`, and `HELMSMAN_PLUGINS_DIR` override their respective locations. Keep runtime data outside the generated release directory so upgrades are straightforward.

The compiled plugin CLI uses the same authoring and installation protocol described in [page packages](plugin-packages.md):

```sh
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack /absolute/author/output /absolute/author/page.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js install /absolute/author/page.hmp
node /absolute/path/to/release/server/helmsman/plugins/cli.js enable example.scope-summary
```

Its optional `--dir STORE` precedes the command. Restart the server and reload browser tabs after activation/selection changes. Source files, `tsx`, and a host rebuild are unnecessary for installed pages.

Rebuilds only replace a release whose generated inventory is intact. Added runtime databases, run directories, worktrees, changed files, missing files, and symlinks cause a refusal. A prior distribution is retained as `release.previous-<UUID>` after successful replacement, protecting late writes from processes still using it. Inventory-free older outputs also require an explicit move before rebuilding. These backups are never automatically deleted; remove one only after verifying that no process or retained data depends on it.

## Public page SDK

Author READMEs and their linked guides, offline flowcharts and assets ship with the distribution. Local links are rewritten for the copied layout; references to implementation and test files that remain in the source checkout point to the canonical GitHub repository.

`release/sdk` is a standalone local npm package named `@helmsman/plugin-sdk`, containing declarations for page/panel lifecycle and composition, usage/pricing, task reads/views/editors, run inspection, streamed downloads, typed presentation locators, clarification reads, durable answers/global contact administration, durable run/source commands, source administration, legacy Todo receipt recovery, and backend provider context, plus dependency-free runtime modules. The E4 [run-inspection](run-inspect-authoring.md) and [download](download-authoring.md) author guides ship beside the SDK; the browser assets include the narrowly scoped download worker. These foundations do not establish viewer/history cutover. Install the SDK as a development dependency in an author project:

```sh
npm install --save-dev /absolute/path/to/release/sdk typescript
```

```ts
import type { PluginPageModule, PluginPageState } from '@helmsman/plugin-sdk';

const page: PluginPageModule = {
  mount(container, context) {
    const update = (state: PluginPageState) => {
      container.textContent = state.repo ?? 'All';
    };
    update(context.state);
    return { update, dispose() { container.replaceChildren(); } };
  },
};

export default page;
```

Compile to browser ESM and package the clean output directory with `plugin-package.json`. Type-only SDK imports disappear from JavaScript. Runtime dependencies must be bundled inside the package; live host services arrive through context. The SDK is distributed with Helmsman and remains experimental; it is not published to a public npm registry.

## Safe-start recovery

Use either `node /absolute/path/to/release/server/helmsman/main.js --safe-start` or `HELMSMAN_SAFE_START=1` to launch recovery mode. The minimal entry point selects this mode before importing normal provider composition.

Open `/recovery` for server-rendered diagnostics or `/api/recovery` for JSON. These endpoints work even when frontend assets are missing. Diagnostics show stored run/checkpoint metadata, active attachments as blocked, installed page records, and read errors. Stored credentials and raw task/launch payloads are omitted. Run history is bounded and reports truncation; use the read-only run history endpoint for pagination.

Safe start opens existing databases read-only, performs no migrations or reconciliation, loads no optional page plugins, starts no provider watchers/gateway/recovery/cleanup, and rejects mutations and unapproved provider APIs. Worktrees, logs, specifications, plugin artifacts, and active run records remain intact. A small allowlist serves stored history, disabled service summaries, the shell, and recovery diagnostics. Normal execution requires a deliberate restart without safe start.

Use the compiled plugin CLI to disable a failing page package. To restore a retained frontend version, disable it, install its verified `artifacts/<sha256>.json` archive, enable it, and restart. Normal-mode [Recovery](recovery.md) handles retained execution and operation obligations. Safe start deliberately does not activate providers, drain work, or reconcile effects.

`HELMSMAN_PLUGIN_UI_SAFE_MODE=1` remains a narrower option that disables optional page activation while normal backend work continues. Use full safe start for recovery involving persisted work.

## Acceptance evidence

```sh
npm test
npm run test:browser
npm run test:distribution
```

Distribution verification copies the release into temporary installations and starts it from unrelated data directories. Source access is denied through Node filesystem permissions where possible and explicit filesystem/module denial hooks for operations that must inspect ancestor metadata. The tests prove source denial before exercising the application; these are test constraints, not a plugin sandbox.

Checks execute native SQLite, compiled workflow coordinators, the run wrapper, and workflow preparation including prompt/skill hashing. They compile an independent TypeScript page against the copied SDK, install it through the compiled CLI, start the real server, and verify canonical route reload, slot replacement, disable behavior, and legacy navigation in Chromium. No application API mocks are used in this full-server gate; external provider commands are replaced with probes.

Safe-start tests seed active work, launch the compiled server, inspect recovery diagnostics, attempt forbidden APIs, and verify no provider command executed and persisted rows/artifacts remain unchanged. Additional unit tests cover broken/missing frontend assets, malformed catalogs, real process termination during artifact installation, transaction failures, registration rollback, and output rebuild safety.

The E3 gates independently compile the shipped Jira provider and task presentation author projects against the copied SDK. [Task views](../tests/distribution/task-views-host.pw.ts) verify Triage cursors/filter persistence, exact related-voyage scope, honest Bugs metrics, screenshots and restart/disable recovery. [Todos](../tests/distribution/todos-ui-host.pw.ts) verifies editor drafts, durable source mutations and response-loss recovery. [Source settings](../tests/distribution/source-settings-host.pw.ts) verifies revision-checked configuration, explicit overrides/default resets, schedules and process-local automatic-start controls. The separate default task-page cutover gate checks registered aliases, replacement/disablement, legacy preferences and preserved empty layouts. Its acceptance and exact-commit reviews passed; the checkpoint is pushed; see the [E3 status](plugin-phase-e3-implementation.md).

The [Phase B author guide](plugin-backend.md) covers external Costs and pricing packages, persisted settings/storage, and independently usable sources in `release/plugin-sources`.

The E4 foundation gate independently builds a page using the run-inspection and download SDK facets, then installs it against a copied production server with checkout access denied. It checks canonical resolution, scoped history and preview, foreign-scope and stale-attempt rejection, the exact static worker route and a real Unicode log download with byte equality. Run `npx playwright test --config playwright.distribution.config.ts tests/distribution/run-inspect-foundation.pw.ts` after building the distribution. This verifies the foundations; viewer/history replacement remains a separate acceptance gate.


The E4 working slice also ships `plugin-sources/run-viewer` and `plugin-sources/run-history`, built only against the distributed SDK. The bundled clarification compatibility bridge is intentionally absent from author sources because it retains private renderer imports. Do not mistake its catalog entry for an independently buildable plugin. New source-denied presentation and clarification gates must pass before this slice is accepted; see the [implementation ledger](plugin-implementation-progress.md).
