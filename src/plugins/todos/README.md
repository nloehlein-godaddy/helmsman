# Local Todo source

This package implements `helmsman/task-source` using public local-record services. It has no server, SQLite, or built-in provider imports. The host owns identity, timestamps, ID allocation, claims, and transactions; the package normalizes records and prepares declarative changes.

Build outside the application checkout with the distributed SDK:

```sh
npm install --save-dev /absolute/path/to/release/sdk typescript
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./dist ./todos.hmp
```

The example package ID is `example.local-todos`; the host's built-in source uses a reserved ID. Package installation does not adopt an existing collection automatically.

The commands are `create` (Todo fields), `update` (`{ref, expectedRevision, patch}`), and `delete` (`{ref, expectedRevision}`). Mutable fields are title, description, acceptance criteria, priority, state, and an explicitly authorized target galleon. Starting progress requires a claim. A lost command response is replayed using the original host request ID.

Task lists use priority then numeric `TODO-N` order. Ready discovery excludes tasks without a description so scheduling can reach runnable work; unfiltered lists keep incomplete drafts visible. Cursors bind to collection revision; reload after a conflict. Output pages may contain fewer items than requested to respect encoded-size limits. A failed or stopped voyage becomes blocked, a successful voyage enters review, and an acknowledged preflight cancellation restores the ready state.
