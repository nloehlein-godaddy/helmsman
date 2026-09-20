# Independent compatible local source

This implementation is authored against `@helmsman/plugin-sdk` and the public `helmsman.local-task/v1` schema. It neither imports nor forwards to Helmsman's Todo provider. It retains source/item identity and requirements while using its own one-record pagination and normalization code.

```sh
npm install --save-dev /absolute/path/to/release/sdk typescript
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./dist ./alternative.hmp
```

The package declares `example.alternative-local-tasks/collection`. Installation and enablement register a provider; adopting an existing verified collection requires a host-recorded compatibility validation. Existing obligations continue using their recorded provider and artifact.

CRUD inputs match the public Todo-compatible command shape: create accepts editable fields, update accepts `{ref, expectedRevision, patch}`, and delete accepts `{ref, expectedRevision}`. The provider returns plans; it never assigns canonical IDs, commits local records, or sets host timestamps. Invocation contexts provide cancellation and scoped local reads, including obligation contexts after ordinary discovery is disabled.
