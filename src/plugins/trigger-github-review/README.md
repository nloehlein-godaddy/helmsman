# GitHub requested-review trigger

This backend-only package registers `helmsman.trigger-github-review/watch`. It reads requested reviews and exact pull-request details through the scoped selected pull-request provider and proposes open, non-draft targets.

Helmsman owns GitHub credentials, configured repository authority, exact-head checks, deduplication, launch identity, and cursor health. The package has no timers, persistence, private imports, or launch authority.
