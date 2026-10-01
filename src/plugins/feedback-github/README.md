# GitHub Issues feedback tracker

Standalone `helmsman/feedback-tracker@1` implementation using core-owned connection HTTP. Configure `repository`, optional comma-separated `labels`, and `enabled`; select its `issues` provider in Config → Product feedback settings. Default is disabled and no repository is assumed.

GitHub authentication remains in core. The provider prepares an immutable issue creation plan with exactly one durable marker. After a lost response it searches the pinned repository and verifies the exact marker, title, body, authenticated author and canonical issue URL. An absent, incomplete, ambiguous or mismatched search result never causes another create request.

Build using the distributed SDK with `node build.mjs`. Install, enable and select the package using the normal plugin workflow. Settings changes apply after restart; retained commands load the exact archived package and original settings for reconciliation.
