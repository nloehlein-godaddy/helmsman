# Independent Task Table

This independently implemented panel uses only the public task-read contract. It renders ready tasks as a table, showing the first 25 tasks from each of at most 50 source views. Pagination and unavailable sources remain explicit. It does not import or forward to the shipped backlog implementation.

Build in an isolated directory with the public SDK and TypeScript installed:

```sh
npm install --no-save typescript /absolute/path/to/release/sdk
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./dist ./backlog-alternative.hmp
```

The entry is `panel.ts`; production code imports only public SDK types and its own relative modules. Styles use a package-specific root and supported host theme tokens. The descriptor uses the installable `example` namespace; choose your own namespace before publishing.

Unmounting, hiding or replacing this presentation never alters admitted work. Activity epochs and abort signals fence reads across scope changes, suspension and disposal. Task links come from validated task data; no global Jira URL is inferred.
