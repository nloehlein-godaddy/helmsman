# GitHub pull request provider

This standalone backend provider implements `helmsman/pull-request` version 1 using only `@helmsman/plugin-sdk`. It registers `example.github/github` and requests the narrow `core-http` capability; the host owns GitHub credentials, endpoint selection, response limits, and cancellation.

Copy this directory to an author workspace, install the released `@helmsman/plugin-sdk` and TypeScript, then run `npm run build`. The build copies the SDK runtime used by the provider into `dist/sdk` and rewrites the provider to a relative import, so pack and install only `dist` with the plugin CLI. The host selects a provider binding separately from package installation, so queued review obligations continue with their exact provider artifact and pinned connection rather than a replacement default.

The provider lists pull requests, reads detail and immutable diff previews, prepares a review against the authenticated actor and expected head, publishes a review whose body is the user text followed by two newlines when nonempty and the canonical `<!-- helmsman-operation:id:contentHash -->` marker, and reconciles that exact body. It never receives a GitHub token.

Reconciliation scans at most 20 pages of 100 reviews and requires a complete history, unique review IDs, and exactly one matching actor/head/body receipt. Invalid or repeated pagination, cancellation, or history beyond the bound leaves the operation unknown. Receipt matching uses the original actor and commit, so a later PR head change, merge, closure or credential actor change does not invalidate proven past delivery. New publication still requires the current authenticated actor and open PR head to match. It never republishes a review to resolve uncertainty.
