# Authored agent questions

`helmsman.clarifications` supplies the default `/clarifications` page and an independently replaceable question panel. Its canonical page is `/plugins/helmsman.clarifications/page`; the alias selects `helmsman/clarifications-page` through the public registry. Disabled or missing selections remain unavailable without a compatibility fallback. Its `helmsman/clarifications-page@1` composition accepts `helmsman/clarifications-panel@1` and the separate `helmsman/suggested-contacts-panel@1`. Missing contact implementations retain a placeholder without preventing questions from mounting.

The question panel uses only public clarification reads and durable answer commands. It shows scoped pages of 25 questions, observed totals, proven answerability and explicit read-only reasons. Unknown/prior-attempt required questions retain their blocking status. Run buttons use typed presentation selection. Refresh preserves the current cursor; First page restarts pagination after cursor invalidation.

Editable drafts and compact terminal results use public conditional host state. Exact baseline comparisons prevent a stale instance from overwriting another instance's state. On conflict the local edit and command journal remain; explicit discard-local/reload exposes current saved state. At most 64 drafts, 32 results and 512 KiB are retained per panel. Unsupported state remains untouched and disables writes. State never imports another contribution's storage.

Check receipt and Retry original are separate actions. Retry delivers only the original retained request through the optional exact-request host method. Save result and dismiss request persists the result and all current drafts before acknowledgment; failed persistence retains the request. Cleanup rereads the journal and protects evidence attached to unresolved requests. Accepted answers do not prove worker consumption.

Previous drafts and requests opens the retained compatibility contribution with the invoking header scope. The page toolbar keeps this link available even when its saved layout is empty or question panels are missing. Its original caller and storage remain intact. This package does not migrate, adopt or resend compatibility requests.

Build with `node build.mjs` after installing TypeScript and the distributed `@helmsman/plugin-sdk`. Runtime modules are package-relative; SDK imports are types only. Rename both package IDs and the page's cross-package initial-layout references when copying for independent installation. See [authored clarification authoring](../../../docs/authored-clarifications.md) and [implementation status](../../../docs/plugin-implementation-progress.md).

_Helmsman · not reported - not reported_

Retry requires the host's optional exact-request `retry` method. It never calls `submit` to recreate a missing reservation; older hosts disable retry and retain receipt checks.

Existing canonical composition layouts remain authoritative across alias visits and page replacement, including empty layouts and missing implementations. Defaults initialize only absent layouts. After independently building and installing `example.questions`, select it with `select helmsman/clarifications-page example.questions/page`; select `default` to restore the builtin page. These selections do not adopt compatibility storage or rewrite existing panel instances.

The composed interface owns the single heading, Refresh and compatibility recovery link; standalone question panels retain their own controls. Prompt-first rows keep publication blockers and answerability visible. Observation timestamps use readable UTC dates with exact values retained. Quiet pagination preserves later-page cursor reset. Local Phosphor icons, fonts and their license ship with the independently built package.

Read-only answer forms use native Answer draft disclosures. Accepted answers, publication blockers and read-only reasons remain visible; editable drafts, exact identities and disclosure focus stay intact.
