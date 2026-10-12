# Helm

The shipped Helm page composes registered panels through `context.composition`. It never imports a panel implementation or a host module. It edits the shared layout through revision-checked updates, retaining state for unavailable implementations.

Before building in an isolated directory, [rename the descriptor](../../../docs/plugin-packages.md#opt-in-task-presentation-packages) from `helmsman.helm` to your own non-reserved ID (for example `example.helm`), including any self-referencing initial-layout contribution IDs. Keep shared contract identifiers and references to other plugins unchanged. Then install the public SDK and TypeScript:

```sh
npm install --no-save typescript /absolute/path/to/release/sdk
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./dist ./helm.hmp
```

The entry is `page.ts`; production code imports only public SDK types and its own relative modules. Styles use a package-specific root and supported host theme tokens. The descriptor uses the reserved `helmsman` namespace for the shipped contribution. External authors should choose their own publisher namespace.

Unmounting, hiding or replacing this presentation never alters admitted work. The page retains mounted children while rearranging layout and delegates cancellation, service scope and module resolution to the host. Instance links are revealed once per incoming locator; missing locators do not reset the layout.

Layout controls are grouped by panel title and full instance ID. Their accessible names carry that identity, so duplicated panels can be moved, scoped, or removed independently without guessing their position.

Stacks can be dragged from their header grip without opening Edit page. Moving a stack preserves all its tabs, selected tab, collapse state, instance scopes and saved panel state. Drop before or after a stack, or into an empty existing column. On narrow screens, panels retain their saved column placement behind the interleaved view. The grip supports mouse and touch; Space or Enter picks up and drops, arrows choose a position, and Escape cancels. Moves use the existing revision-checked layout store and retain mounted panel bodies. Edit page still provides individual-panel movement and stacking controls.
