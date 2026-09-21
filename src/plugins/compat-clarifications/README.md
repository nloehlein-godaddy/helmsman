# Clarification recovery

This independently buildable public-SDK package owns the retained question/contact recovery page, controller, draft storage and scoped styles. Its original contribution remains `helmsman.compat-clarifications/page`, at `/plugins/helmsman.compat-clarifications/page`, with separate clarification-read, clarification-command and suggested-contact-admin services. The `/clarifications` composition links here for previous drafts and requests.

The package requires the host's optional readonly `context.contributionId` and all three version-1 services. Missing identity or services fails closed before reading saved drafts or starting work. There are no private host clients or service-factory fallbacks. Visibility, disposal and scope changes cancel activity; navigation and Pirate terminology follow public page context.

The original contribution retains the exact `helmsman.compat-clarifications.drafts.v2:` storage prefix, key formats, limits and caller-owned journals. Renamed copies use `helmsman.clarification-recovery.drafts.v2:<contributionId>:` derived from their actual host identity. Copies cannot read, adopt or mutate original drafts through this store, and their public command journals stay under their own caller. Unknown formats or oversized evidence are retained byte-for-byte with an explicit storage error; no automatic migration, deletion or replay occurs.

Drafts and unsent contact edits remain separate from reserved commands. Retry uses only the optional exact-request method; older hosts disable retry and retain receipt checks. Acknowledgment follows durable draft/result storage. Accepted answers do not prove worker consumption, and saving contact metadata sends no message. Disabling the contribution preserves its journals and drafts for recovery after reenablement.

Explicit cleanup requires fresh successful reads of both journals and preserves unresolved command evidence. Global contact cleanup is separate from scoped answer drafts. Changed drafts remain intact. Discarding an unsaved local edit reloads persisted text for review before a separate deletion action. Storage failure keeps the command pending until the affected draft and result are saved. Local storage cannot provide an atomic transaction across tabs for comparison and deletion.

Build with `node build.mjs` after installing TypeScript and the distributed `@helmsman/plugin-sdk`. Rename `manifest.id` to a nonreserved ID such as `example.recovery`, build, pack and install, then open `/plugins/example.recovery/page`. Keep public service requirements unchanged. The package uses SDK types only and package-relative runtime imports. See [package installation](../../../docs/plugin-packages.md), [clarification contracts](../../../docs/clarification-authoring.md), and [implementation status](../../../docs/plugin-implementation-progress.md).

_Helmsman · not reported - not reported_
