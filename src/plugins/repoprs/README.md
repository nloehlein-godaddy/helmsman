# Repository pull requests panel

This package compiles independently against `@helmsman/plugin-sdk` and uses only `helmsman/pull-request-read@1`. Copy this directory into an author workspace, install the published SDK and TypeScript, and run `npm run build`. Third-party packages must replace the reserved `helmsman.repoprs` identifier with their own identifier while retaining `helmsman/helm-panel@1`.

The repository panel requires one selected repository and reads at most 100 open pull requests. Shipped reads at most 12 recently authored pull requests across its effective repository scope, preserving open, changes-requested, closed, and merged states. It does not represent completed worker runs. Each panel owns one initial, sequential host watch; hidden, replaced, or disposed activity cancels delivery. Provider links come from validated public data. Detail and review-setup links preserve the header scope and exact PR target. Existing review/rerun command entry remains on the linked setup page.

Counts absent from provider evidence remain null and are omitted rather than displayed as zero. Complete empty lists, partial provider windows, degraded results, and unavailable reads are distinct states. A provider browse link is optional; panels never reconstruct a GitHub URL or assume a Jira ticket URL.

## Temporary provider adapter

The server currently projects existing GitHub read helpers behind the public service. These private helpers retain their existing repository authorization, cache, concurrency, and review policies until the E3 integration extraction. The recent-authored helper caps and combines results with fail-soft direct scans, so this adapter always reports its coverage as partial (including an empty result). It cannot honestly assert complete results or unknown direct-scan success. It projects only allowlisted fields, supplies GitHub links server-side, and excludes credentials and private provider state.

The server coalesces overlapping provider reads for the same effective repository set and list kind, always requesting the maximum public window before applying each caller's limit. A cancelled subscriber never abandons that shared operation and causes an overlapping provider request. At most 64 provider operations can be outstanding; a 30-second deadline bounds each caller even when the legacy provider ignores cancellation. E3 should replace this adapter with cancellable provider reads that report completeness directly.

The public service provides `list` and `watchList` with `repo-open`, `authored-recent`, and `review-requested` kinds, a maximum page of 100, and no synthetic pagination beyond the provider window. Tests for both packages live in `../repoprs/panel.test.ts`.
