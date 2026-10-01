# Product feedback presentation

Independent SDK-only submission and Config settings pages. The submission entry appears in Feedback settings only when the selected tracker reports a destination. A disabled or unavailable destination keeps existing drafts and pending submissions visible without enabling submission.

Drafts persist per contribution and selected galleon. The core caller journal retains immutable request IDs across reload and response loss. Only an explicit submission or reconciliation action invokes the command service. Uncertain requests cannot be edited or resubmitted as new requests. Terminal requests offer an explicit new/revised submission action.

Config exposes the selected tracker's declared settings and uses optimistic, atomic saves. Selection defaults to Disabled. Tracker changes apply after restarting Helmsman; existing submissions retain their original provider artifact, settings, connection and destination. Credentials remain in core.

Build using the distributed SDK with `node build.mjs`; the package uses no host imports or private HTTP endpoints.
