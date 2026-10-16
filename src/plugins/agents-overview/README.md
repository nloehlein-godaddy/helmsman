# Agents overview

Config → Agents overview opens `/agents-overview`, a guide to Helmsman's agents and workflow roles. Select a role and choose **Edit prompt** to edit its global instructions in a modal. The shared editor retains drafts, checks revisions before saving, and supports restoring the built-in default. Changes apply to new sessions; existing sessions keep their instructions. The page does not fetch run status or start agents.

This page-only plugin imports the public SDK and its own modules. It requires the version 1 `helmsman/agent-prompts` service, with no backend provider, panels, or composition layout. The shipped page slot is `helmsman/agents-overview-page`; the canonical contribution is `helmsman.agents-overview/page`. Its package build bundles the shared SDK prompt editor for independent installation.

The distribution includes this source at `plugin-sources/agents-overview`. To build an independent copy, first change the source `plugin-package.json` descriptor's `helmsman.*` ID to your own namespace. The built-in namespace is reserved and cannot be packed as an external plugin. Then install the distributed SDK and TypeScript, build, and pack:

```sh
npm install --save-dev /absolute/path/to/release/sdk typescript
npm run build
node /absolute/path/to/release/server/helmsman/plugins/cli.js pack ./dist ./agents-overview.hmp
```
