# Agents overview

Config → Agents overview opens `/agents-overview`, a read-only guide to Helmsman's agents and workflow roles. It does not fetch run status, change prompts, or start agents. Prompt editing remains under Config → Agent prompts.

This page-only plugin imports the public SDK and its own modules. It requires no host services, backend provider, panels, or composition layout. The shipped page slot is `helmsman/agents-overview-page`; the canonical contribution is `helmsman.agents-overview/page`.

The distribution includes this source at `plugin-sources/agents-overview`. To build an independent copy, first change the source `plugin-package.json` descriptor's `helmsman.*` ID to your own namespace. The built-in namespace is reserved and cannot be packed as an external plugin. Then install the distributed SDK and TypeScript, build, and pack:

```sh
npm install --save-dev /absolute/path/to/release/sdk typescript
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./dist ./agents-overview.hmp
```
