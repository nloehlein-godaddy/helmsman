# Authored agent questions

`helmsman.clarifications` is an opt-in, independently compiled page and question panel. The canonical page is `/plugins/helmsman.clarifications/page`; it does not replace `/clarifications`. Its `helmsman/clarifications-page@1` composition accepts `helmsman/clarifications-panel@1` and the separate `helmsman/suggested-contacts-panel@1`. Missing contact implementations retain a placeholder without preventing questions from mounting.

The question panel uses only public clarification reads and durable answer commands. It shows scoped pages of 25 questions, observed totals, proven answerability and explicit read-only reasons. Unknown/prior-attempt required questions retain their blocking status. Run buttons use typed presentation selection. Refresh preserves the current cursor; First page restarts pagination after cursor invalidation.

Editable drafts and compact terminal results use public conditional host state. Exact baseline comparisons prevent a stale instance from overwriting another instance's state. On conflict the local edit and command journal remain; explicit discard-local/reload exposes current saved state. At most 64 drafts, 32 results and 512 KiB are retained per panel. Unsupported state remains untouched and disables writes. State never imports another contribution's storage.

Check receipt and Retry original are separate actions. Retry submits the retained immutable input through the caller-owned journal. Save result and dismiss request persists the result and all current drafts before acknowledgment; failed persistence retains the request. Cleanup rereads the journal and protects evidence attached to unresolved requests. Accepted answers do not prove worker consumption.

Previous drafts and requests opens the retained compatibility contribution with the invoking header scope. Its original caller and storage remain intact. This package does not migrate, adopt or resend compatibility requests.

Build with `node build.mjs` after installing TypeScript and the distributed `@helmsman/plugin-sdk`. Runtime modules are package-relative; SDK imports are types only. Rename both package IDs and the page's cross-package initial-layout references when copying for independent installation. See [authored clarification authoring](../../../docs/authored-clarifications.md) and [implementation status](../../../docs/plugin-implementation-progress.md).

_Helmsman · not reported - not reported_
