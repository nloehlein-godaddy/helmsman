# GitHub settings frontend package

The independently buildable SDK-only GitHub settings page mounts its panel through `helmsman/github-settings-page`. The panel implements `helmsman/github-settings-panel@1`, requires `helmsman/github-settings@1`, and uses injected `services.githubSettings`. Package-owned labels and bounds identify the global `helmsman.github/settings` namespace.

The panel edits default repository, pull-request author and automatic review-request watching. It displays redacted credential availability only. Saving explicitly targets global scope and an expected revision; choosing a default repository does not change the header repository. Enabling watching may admit automatic review runs through existing runtime gates.

Nonsecret drafts use the actual mounted contribution and instance identity. Refresh, remount and scope changes preserve their original revision and edited values. Rebase and discard require explicit actions. Unsupported saved data remains untouched and blocks writes. Persistence failure keeps the draft visible and disables saving until an explicit draft save succeeds.

Inputs remain mounted through refresh/theme changes, preserving focus and selection. New edits made while a save is pending remain separate from the submitted values. Save results must match the submitted values before replacing a draft. Inactive lifetimes cancel requests; saves never retry automatically, and late results cannot overwrite newer drafts.

Build here with `npm run build`. Focused tests from the repository root: `npx vitest run src/plugins/github-settings/page.test.ts src/plugins/github-settings/panel.test.ts`. Tests use mocked public services and never call providers.
