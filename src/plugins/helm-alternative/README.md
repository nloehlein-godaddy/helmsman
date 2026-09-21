# Independent Workspace

This independently implemented page uses only the public composition contract. It renders the existing shared layout as a linear workspace, preserving each panel instance, selection, scope, hidden state and saved implementation data. It can mount either the shipped backlog or an independently installed panel.

Build in an isolated directory with the public SDK and TypeScript installed:

```sh
npm install --no-save typescript /absolute/path/to/release/sdk
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./dist ./helm-alternative.hmp
```

The entry is `page.ts`; production code imports only public SDK types and its own relative modules. Styles use a package-specific root and supported host theme tokens. The descriptor uses the installable `example` namespace; choose your own namespace before publishing.

Unmounting, hiding or replacing this presentation never alters admitted work. The page retains mounted children while rearranging layout and delegates cancellation, service scope and module resolution to the host. Instance links are revealed once per incoming locator; missing locators do not reset the layout.
