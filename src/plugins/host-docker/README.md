# Docker execution host

This package implements `helmsman/execution-host@1` using only the public `@helmsman/plugin-sdk` and its Node entry. It resolves the configured image tag to Docker's immutable image ID when a run is admitted, runs coordinators locally, and isolates agent stages in Docker with a scoped gateway relay.

Build with `npm install @helmsman/plugin-sdk typescript @types/node` and `npm run build`. Third-party copies must use their own package identifier.
