# Repository pull requests panel

This package compiles independently against `@helmsman/plugin-sdk` and uses only `helmsman/pull-request-read@1`. Copy this directory into an author workspace, install the published SDK and TypeScript, and run `npm run build`. Third-party packages must replace the reserved `helmsman.repoprs` identifier with their own identifier while retaining `helmsman/helm-panel@1`.

The repository panel requires one selected repository and reads at most 100 open pull requests. Shipped reads at most 12 recently authored pull requests across its effective repository scope, preserving open, changes-requested, closed, and merged states. It does not represent completed worker runs. Each panel owns one initial, sequential host watch; hidden, replaced, or disposed activity cancels delivery. Provider links come from validated public data. Detail and review-setup links preserve the header scope and exact PR target. Existing review/rerun command entry remains on the linked setup page.

Counts absent from provider evidence remain null and are omitted rather than displayed as zero. Complete empty lists, partial provider windows, degraded results, and unavailable reads are distinct states. A provider browse link is optional; panels never reconstruct a GitHub URL or assume a Jira ticket URL.

## Selected provider reads

The public service captures the selected `helmsman/pull-request@1` provider, connection, settings and selection revision. The shipped GitHub package implements the provider contract and may be replaced independently of either panel. Missing or disabled explicit selections remain unavailable; the old private GitHub read routes return 410.

The provider reports list quality and truncation directly. Core validates the bounded projection and effective galleon scope; a capped window cannot claim complete coverage. Lists coalesce overlapping reads for the same scope and kind, request the maximum public window before applying caller limits, and permit at most 64 outstanding provider operations. A 30-second deadline bounds requests, and cancellation stops delivery to the departing caller without restarting shared work for another caller.

PR detail and review/rerun preparation use the selected provider too. New commands retain exact source and head evidence; historical execution and publication obligations retain their original bindings. See [PR authoring](../../../docs/pull-request-authoring.md) and [retired routes and recovery](../../../docs/plugin-legacy-retirement.md).

The public service provides `list` and `watchList` with `repo-open`, `authored-recent`, and `review-requested` kinds, a maximum page of 100, and no synthetic pagination beyond the provider window. Tests for both packages live in `../repoprs/panel.test.ts`.
