# Pull request compatibility

This private host bridge mounts the retained PR workflow through the composition registry at `/plugins/helmsman.compat-pr/page`. Its panel shares the Dashboard's `PrCompatibilitySession` with legacy `/prs`, `/runs`, and the run drawer. It is not an authored SDK-only package.

The session owns status/diff caches, in-memory form drafts, manual review request identities, and Slack request outcomes. Each surface holds an independent read lease; hiding or disposing the last interested surface cancels the read. Mounting never submits commands and introduces no polling timer. Lookup persists the selected target through composition state; existing legacy drafts and uncertain request identities remain memory-only. Legacy launch behavior remains unchanged.

The page does not claim a legacy alias. Public PR inspection and durable command contracts must be completed before migrating authored PR commands or the Runs alias.
