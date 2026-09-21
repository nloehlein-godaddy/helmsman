# GitHub webhook trigger

This backend-only package registers `helmsman.trigger-github-webhook/github`. It maps an already authenticated, parsed GitHub event to one configured workflow intent or deliberately ignores it.

Helmsman owns raw request limits, credentials, signature and delivery verification, deduplication, persistence, and launch. The package receives no secret, signature, headers, or request object and has no launch authority.
