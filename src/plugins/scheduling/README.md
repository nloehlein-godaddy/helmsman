# Round-robin scheduling provider

This standalone SDK-only backend registers `helmsman/scheduling` version 1 as `round-robin` in the builtin `helmsman.scheduling` package. It rotates the sorted source instances after the previously selected instance, then scans each source's bounded cursor pages for the first structurally valid candidate. A failed or malformed source is skipped so another source can provide work; cancellation is propagated to the host.

Build from this directory with `npm run build` after installing the released `@helmsman/plugin-sdk` and TypeScript. The generated `dist` directory contains the backend and package descriptor for the plugin CLI.

The `intervalMs` namespaced setting defaults to 60,000ms and accepts whole numbers from 250 through 3,600,000. Change the reserved manifest ID before installing an external copy. Select it using `plugins select-scheduling example.scheduling/round-robin`; restart after settings or activation changes. Core owns source eligibility, cursor bounds and admission, and rejects undiscovered or stale choices. Scheduling ends at admission and does not own run recovery.
