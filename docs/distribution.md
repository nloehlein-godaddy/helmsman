# Runnable Helmsman distribution

`npm run build:distribution` produces `release/` with compiled server entry points, the browser application, native production dependencies, execution helpers, examples, and the experimental page SDK. Run it with the same OS, CPU architecture, and Node major used to build it. The manifest records those constraints and the native module ABI; build a new distribution for another target. The release does not install dependencies or run package installation scripts at startup.

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

`release/sdk` is a standalone local npm package named `@helmsman/plugin-sdk`, containing declarations for the experimental page lifecycle and a dependency-free runtime entry. Install it as a development dependency in an author project:

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

Use the compiled plugin CLI to disable a failing page package. To restore a retained frontend version, disable it, install its verified `artifacts/<sha256>.json` archive, enable it, and restart. Full backend plugin draining and durable operation recovery are later phases; safe start deliberately does not attempt those operations.

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
