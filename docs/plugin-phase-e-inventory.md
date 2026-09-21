# Phase E ownership inventory

This is the accepted Phase E inventory, reviewed and pushed through `85f1fe6`. Aggregate acceptance and correction-only review are recorded in the [completion ledger](plugin-implementation-progress.md).

| Optional feature | Public owner and extension boundary |
|---|---|
| Helm and its panels | Authored Helm composition; independent Backlog, Running, Recent, Underway, New run, galleon PRs, Shipped and Activity panels. Alternate Helm and Backlog packages demonstrate replacement. |
| Costs and outcomes | Independent Costs page and pricing provider. Core owns measured usage and budget enforcement. |
| Jira and Todos | Independent task-source providers plus authored task pages, editors and Source settings. Admission, claim identity and durable obligations stay core-owned. |
| Triage and Bugs | Authored compositions and panels using public task/run services. |
| Runs, history and viewer | Independent Runs/history/viewer packages; standalone and auxiliary views share the public presentation lifecycle. |
| Clarifications and suggested contacts | Authored question/contact panels; old journals reconcile through the separate compatibility package. Required clarification gates remain core. |
| PRs and GitHub | SDK-only PR page/panel and selected GitHub provider; public inspection and durable review commands. Retained review bindings and human publication gates remain core. |
| Slack and notifications | Independent Communication header/page/panels and selected Slack provider. Core supplies bounded browser primitives and durable send/recovery policy. |
| Terminal | Authored terminal composition/panel and public scoped controls. Native execution adapters are explicitly deferred to F. |
| Campaigns | Authored campaign page/panel and atomic public commands. Execution dispatch remains F. |
| Local Git | Authored branches/worktrees/cleanup page and guarded controls. Core retains checkout identity, expected revisions, locks and worktree protection. |
| Jira/GitHub settings | Independent namespaced global forms. Core retains credential storage; live Jira fields belong to source instances. |
| Profile greeting | Independent header contribution and optional selected-provider profile method; core retains neutral salutation. |
| Installed-page discovery | Generic registry enumeration and Pages menu use package-owned title/visibility. Static shipped tab order is core shell policy. |

## Explicit core and deferred ownership

Core retains galleon identity and header scope, theme/terminology preferences, plugin administration, safe start, recovery, credentials, usage recording, concurrency/budget enforcement, required human/clarification gates and guarded publication. A missing plugin cannot remove these safeguards.

Phase F owns agent/custom-command settings and implementations, execution hosts and native terminal adapters, workflow definitions and pre-PR stages, scheduler policy and intervals, campaign dispatch, Slack/GitHub review-launch loops, and webhook parsing/configuration separated from durable workflow dispatch. The webhook inventory includes `HELMSMAN_WEBHOOK_SECRET`, `HELMSMAN_WEBHOOK_ROUTES` and `/api/webhooks/github`.

Phase G owns the remaining compatibility cleanup, private-import exceptions, SDK/template versioning and deprecation guidance, and the repository-wide documentation/flowchart audit. Stable IDs containing `compat` are not evidence of private host imports; inspect actual boundaries before renaming IDs or migrating retained layouts. Compatibility bridges cannot substitute for completing F/G.

The E exit uses one aggregate unit/integration run, the settled TypeScript/app/distribution artifact, the affected browser suite and distribution checks. Existing unchanged feature acceptance is retained; profile/navigation installation specifically proves independent compilation, selected provider identity, header scope, neutral fallback, discovery and disabled selected-page behavior.
