# Backlog

The shipped backlog panel discovers task sources through `context.services.tasks`, then reads each permitted galleon with an exact source instance revision. Manual source selection is saved per panel instance and does not depend on automatic scheduling. Reads show at most 50 source views, with 25 tasks per page and ten pages per selected source.

Build in an isolated directory with the public SDK and TypeScript installed:

```sh
npm install --no-save typescript /absolute/path/to/release/sdk
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./dist ./backlog.hmp
```

The entry is `panel.ts`; production code imports only public SDK types and its own relative modules. Styles use a package-specific root and supported host theme tokens. The descriptor uses the reserved `helmsman` namespace for the shipped contribution. External authors should choose their own publisher namespace.

Unmounting, hiding or replacing this presentation never alters admitted work. Activity epochs and abort signals fence reads across scope changes, suspension and disposal. Task links come from validated task data; no global Jira URL is inferred.
