# helmsman-og feature portability — 2026-09-21

**Several OG improvements fit the plugin architecture cleanly.** The best candidates are Jira description disclosure, compact severity badges and a Firefox browser-provider plugin. Same-galleon parallelism, direct Jira assignment and server-side feedback require explicit architecture or contract work. Do not merge the legacy application wholesale.

This historical evaluation is followed by the [remaining-feature design and delivery status](helmsman-og-feature-design.md). The Triage transport assumption below was corrected during design: summaries omit descriptions; disclosure must call the existing scoped task-load service.

This is an evaluation, not a feature import. It followed integration of the seven second-review fixes. Two independent agents examined the UI/domain and runtime/integration changes; the main reviewer checked their conclusions against current contracts and corrected the distinction between configured and authenticated GitHub identity.

Source: [`nathanloehlein/helmsman-og`](https://github.com/nathanloehlein/helmsman-og) at `4ca712aa69c6e6fff3ac8cd50027b2abdc905212`, confirmed against remote HEAD on 2026-09-22 UTC. The local checkout is named `helmsman-pre-rewrite`. Common ancestor: `e471d86630d78f2285611e81256ff912e5f57d0e`; **23 newer OG commits** were considered. Target: plugin Helmsman at `9ef550d` plus cleanup correction `1b27686`; that correction does not change these feature boundaries.

Evaluation is based on source/contract comparison. No OG feature was imported, no live Firefox/Slack/Jira/GitHub workflow was exercised, and the older application was not started. Effort labels below are relative implementation scope, not delivery estimates.

## Portability decisions

| Feature and OG commits | Decision | Target and required work | Relative scope |
|---|---|---|---|
| Expandable Jira descriptions — `012b420` | **Clean Triage plugin update** | [Triage panel](../src/plugins/triage/panel.ts) already receives `TaskSnapshotV1.requirements.description` through the Jira source. Add per-task disclosure, bounded text and persisted expansion without changing the SDK. | Small |
| Description disclosure in Bugs — `012b420` | **Read-contract extension** | [TaskBugRowV1](../src/plugins/task-views.ts) has no description. Add a bounded optional field with backward-compatible parsing/provider projection before changing [Bugs](../src/plugins/bugs/panel.ts). | Medium |
| Compact Jira severity badges — `2537b91` | **Clean Bugs plugin update** | Existing `severity` data is sufficient. Compact recognized identifiers conservatively; preserve original text for accessible names, tooltips and custom values. | Small |
| Reversing helm loading indicator and unavailable announcement — `6e9d1bf`, `6dcb2ea` | **Clean presentation update with asset packaging** | Bundle the SVG/CSS in each independently built author package or publish an explicit shared presentation asset/helper. Keep `role=status`, reduced motion and unavailable/error announcements. Avoid importing a private root renderer into plugin packages. | Medium if shared across panels |
| Move operator disclaimer to Config — `1e155c7` | **Clean shell presentation change** | Move the [root render](../src/render.ts) disclosure into the full Config view, including unavailable states. Keep Recovery/Pirate controls accessible. It is a product presentation choice, not a required bug fix. | Small |
| Firefox Slack transport/background actions — `87c5dee`, `7439d34`, `901c57c`, `1740021`, `e12e406`, `e18dbeb`, `bc239de` | **Clean new provider plugin; substantial implementation** | Implement `helmsman/native-terminal@1` with `browser: true`, using existing tree/focus/evaluate/click/fill/wait methods. Select it through `select-browser-host`; terminal selection stays independent. Rework OG transport code behind that boundary. | Large implementation, no new SDK capability required |
| Attachment-only Slack messages — `901c57c` | **Already present** | [Slack browser extraction](../src/plugins/slack/browser.ts) recognizes attachment-only rows while retaining message identity checks. Do not duplicate the legacy parser. | None |
| Underway contextual run/PR/Slack actions — `87c5dee` | **Partial equivalent; wider composition needs contracts** | Existing Underway launch receipts already navigate to their accepted canonical run. Broader PR actions need verified task-to-PR associations and the existing durable communication command. Do not infer ownership from ticket strings in PR titles. | Medium–large |
| Skip automatic reviews of own PRs — `4ca712a` | **Identity/policy extension** | Preserve OG's authenticated-actor semantics through the selected PR provider and a captured policy decision before automatic dispatch. Existing `isOwnPr` is based on configured author, which can differ from the credential actor. | Medium |
| Parallel voyages in one galleon — `459a207`, `3e3e593` | **Architecture change; do not transplant the reservation map** | Current capacity and recovery use durable galleon-exclusive reservations. Supporting parallel work requires durable task/branch/PR/workspace collision rules, a reservation migration and changes to admission, scheduling, cleanup and recovery. | Large, cross-cutting |
| Log subscription reconnect race — `8896453` | **Superseded transport; retain the scenario as a test** | The selected run reader uses cursor polling, scope/lifetime fencing and monotonic event validation instead of the old SSE subscription. A not-yet-visible first log page must remain retryable without relaunching work. | No legacy transport port |
| Triage “assign to me” — `012b420` | **New durable source command/effect** | Bind the selected source/task revision, authenticated Jira identity, expected assignee and retained connection. Persist an operation before mutation; reconcile uncertain assignment. The OG direct `/api/tickets/:id/assign-self` route does not provide this boundary. | Large |
| Footer feedback and submission recovery — `8d64111`, `b31e2f4`, `ce2f0c7` | **Small browser-link option, or a new durable submission capability** | A configured external issue link can be a small UI addition. In-app issue creation needs destination authority, retained GitHub credentials/provider, exact request identity, receipt reconciliation and draft preservation. Do not copy the hard-coded destination/direct POST route. | Small link; medium–large submission feature |
| Version/README/flowchart updates — `3a79ee1`, `8b12cb9`, `4daaa5d`, `41365fd` | **Adapt documentation only after feature decisions** | The branches have different architecture and release history. Do not copy the OG version number or diagrams describing legacy execution/Docker restrictions into the plugin release. | Small editorial work |

## Recommended order

1. **Small plugin presentation batch:** Triage descriptions and Bugs severity badges. The disclaimer placement is independent and can be included if that presentation is desired.
2. **Firefox provider:** the strongest larger feature that already fits a public plugin boundary. Build and install it first as an independent package; bundling it with the standard distribution can follow. Existing Slack policy stays in its selected provider.
3. **Automatic own-PR protection:** define authenticated versus configured identity, then add the selected-provider observation and pre-dispatch policy. This prevents behavior drifting with the configured author's display/list settings.
4. **Optional presentation polish:** the loading indicator and richer Bugs descriptions, after deciding whether the latter justifies a read-contract extension.
5. **Separate designs:** direct assignment, in-app feedback, richer task-to-PR actions and same-galleon parallelism. These change authority, recovery or capacity semantics and should not be bundled into a cosmetic port.

## Firefox design constraints

The [native-terminal contract](../src/plugins/native-terminal.ts) and [authoring guide](native-terminal-authoring.md) already support independent browser selection. A browser-oriented provider still implements the required terminal methods and returns explicit unsupported results for operations it cannot perform; it must not pretend to control a terminal. It can be externally installed without changing core registration. Adding a shipped default would additionally update the builtin manifest, distribution author list and documentation.

Reuse the OG bridge's useful behavior: credential-free loopback WebDriver endpoint validation, validation of the returned BiDi endpoint, background browsing-context selection, visible-target scrolling/hit testing, and one trusted pointer action with no automatic replay after ambiguous failure. Adapt those behaviors to opaque provider surface references and `sessionIdentity()`.

Core's [communication browser boundary](../server/helmsman/communication-browser.ts) already fences the retained session, Slack origin/workspace and operation lifetime. A bridge restart may allow fresh discovery under a new identity; it must not silently move a pending send onto a replacement session. Keep lost-send outcomes unknown unless an exact receipt proves delivery.

Acceptance should cover a copied-SDK external author build, install/enable/select/disable/restart, independent terminal/browser selection, invalid endpoints, stale sessions, background focus restoration, one-click behavior, ambiguity without resend and a real Firefox smoke test. Static contract compatibility does not establish operational Firefox compatibility.

## Own-PR identity needs an explicit decision

OG checks `/user` and the PR author. The current [GitHub provider](../src/plugins/github/provider.ts) derives `isOwnPr` from `configuredAuthor`. Its `profile()` operation separately obtains the authenticated login through `/user`, and inspection exposes the PR’s `authorLogin`. These existing observations can support the policy when read under the same retained provider/connection capture; the configured-author flag alone cannot establish authenticated ownership.

To preserve OG behavior, obtain an authenticated actor/ownership observation through the selected provider, bound to the captured connection and exact PR head. Recheck the provider, trigger and credential authority after the asynchronous read. Block an own PR before dispatch; leave unavailable ownership queued for a later check. Persist enough policy evidence for restart and keep the manual review-request eligibility semantics explicit. No direct legacy GitHub fetch should bypass these captures.

## Focused acceptance for the other ports

| Area | Required checks |
|---|---|
| Triage/Bugs presentation | Empty/custom/rich-text descriptions and severities; safe text rendering; disclosure survives refresh without leaking across source/galleon; keyboard and screen-reader identity; existing author package still builds. |
| Loading indicator | Reduced motion, narrow layout, accessible loading label and error/unavailable text retained during refresh; assets available in a copied external package. |
| Task assignment | Stale task/source revision, changed Jira actor, disabled contribution, lost response, no duplicate assignment and canonical source/galleon scope. |
| Feedback | Configured destination, caller authority, exact-input replay/conflict, ambiguous POST without automatic duplicate creation, retained draft and proven terminal receipt before acknowledgement. |
| Contextual actions | Shared ticket keys and PR-title collisions never establish identity; actions use canonical retained work/PR/run references; communication keeps its own durable request journal. |
| Parallelism | Independent branches can run concurrently only after policy/schema changes; identical task/branch/PR conflicts persist; restart and uncertain launch keep each reservation; cleanup cannot remove another run's workspace. |
| Log readiness race | First unavailable/not-found observation followed by a valid cursor page renders each event once, retains the right galleon and never reissues launch. |

## Limits and decisions left open

No feature code was imported in this task. This comparison establishes likely integration paths and the important contract gaps; it does not certify OG's native browser implementation or commercial pricing data. Large-history performance, every Jira response shape and live multi-provider behavior remain outside this evaluation.

The main product choices are whether to allow concurrent work within one galleon, whether feedback should use an external browser link or durable in-app submission, and whether “own PR” means the authenticated GitHub account or an intentionally configured author. These choices do not block completion of the bug fixes.

_Helmsman · not reported - not reported_
