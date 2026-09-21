# Slack review trigger

This backend-only package registers `helmsman.trigger-slack-review/watch`. It reads only the scoped communication messages and pull-request details exposed for one invocation, parses GitHub pull-request URLs, filters targets, and returns immutable proposals.

Helmsman owns communication credentials, channel bounds, cursor enforcement, deduplication, launch identity, and publication. The package has no timers, persistence, private imports, or launch authority.
